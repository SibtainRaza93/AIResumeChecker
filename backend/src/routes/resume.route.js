const express = require("express");
const { z } = require("zod");
const mongoose = require("mongoose");

const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { requireAuth } = require("../middleware/auth.middleware");
const { validate } = require("../middleware/validate");
const { uploadPdf } = require("../middleware/upload.middleware");

const Resume = require("../models/Resume");
const ResumeVersion = require("../models/ResumeVersion");

const { analyzeLimiter } = require("../middleware/rateLimit");
const Analysis = require("../models/Analysis");
const { analyzeResume } = require("../services/gemniService");

const { diffText, summarize } = require("../services/diffService");
const { extractText } = require("../services/pdfService");
const { parseResume: parseStructured } = require("../services/structuredParser");

const router = express.Router();
router.use(requireAuth);

const objectIdSchema = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v), {
    message: "Invalid id",
  });

const idParam = z.object({
  id: objectIdSchema,
});

async function loadOwnedResume(req) {
  const resume = await Resume.findOne({
    _id: req.params.id,
    userId: req.user._id,
  });
  if (!resume) throw ApiError.notFound("Resume not found");
  return resume;
}

async function loadVersion(resumeId, versionId) {
  const version = await ResumeVersion.findOne({
    _id: versionId,
    resumeId,
  });
  if (!version) throw ApiError.notFound("Version not found");
  return version;
}

// UPLOAD
router.post(
  "/",
  uploadPdf("file"),
  asyncHandler(async (req, res) => {
    const { text, meta } = await extractText(req.file.buffer);
    const parsedSections = await parseStructured(text);

    const title =
      (req.body.title || "").trim() ||
      req.file.originalname.replace(/\.pdf$/i, "") ||
      "Untitled Resume";

    const resume = await Resume.create({
      userId: req.user._id,
      title,
      latestVersionNumber: 1,
    });

    const version = await ResumeVersion.create({
      resumeId: resume._id,
      versionNumber: 1,
      label: "V1",
      rawText: text,
      parsedSections,
      sourceType: "upload",
      parentVersionId: null,
    });

    resume.currentVersionId = version._id;
    await resume.save();

    res.status(201).json({ resume, version, meta });
  })
);

// GET ALL
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const resumes = await Resume.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ resumes });
  })
);

// GET SINGLE
router.get(
  "/:id",
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    const versions = await ResumeVersion.find({ resumeId: resume._id })
      .sort({ versionNumber: 1 })
      .select("-rawText")
      .lean();
    res.json({ resume, versions });
  })
);

// GET VERSION
router.get(
  "/:id/versions/:versionId",
  validate(z.object({ id: objectIdSchema, versionId: objectIdSchema }), "params"),
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    const version = await loadVersion(resume._id, req.params.versionId);
    res.json({ version });
  })
);

// DELETE
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    await ResumeVersion.deleteMany({ resumeId: resume._id });
    await Analysis.deleteMany({ resumeId: resume._id });
    await resume.deleteOne();
    res.json({ ok: true });
  })
);

// ANALYZE
const analyzeBody = z.object({
  versionId: objectIdSchema.optional(),
  targetRole: z.string().trim().max(120).optional(),
});

router.post(
  "/:id/analyze",
  analyzeLimiter,
  validate(idParam, "params"),
  validate(analyzeBody, "body"),
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    const versionId = req.body.versionId || resume.currentVersionId;
    if (!versionId) throw ApiError.badRequest("No version to analyze");

    const version = await loadVersion(resume._id, versionId);

    const { analysis, model, promptTokens, responseTokens } = await analyzeResume({
      rawText: version.rawText,
      targetRole: req.body.targetRole,
    });

    const saved = await Analysis.create({
      userId: req.user._id,
      resumeId: resume._id,
      versionId: version._id,
      targetRole: req.body.targetRole || null,
      atsScore: analysis.atsScore,
      scoreBreakdown: analysis.scoreBreakdown,
      issues: analysis.issues,
      strengths: analysis.strengths,
      bulletRewrites: analysis.bulletRewrites,
      keywordsPresent: analysis.keywordsPresent,
      keywordsMissing: analysis.keywordsMissing,
      summary: analysis.summary,
      model,
      promptTokens,
      responseTokens,
    });

    version.latestAnalysisId = saved._id;
    await version.save();

    res.status(201).json({ analysis: saved });
  })
);

// GET ANALYSES
router.get(
  "/:id/analyses",
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    const analyses = await Analysis.find({ resumeId: resume._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ analyses });
  })
);

router.get(
  "/:id/versions/:versionId/analysis",
  validate(z.object({ id: objectIdSchema, versionId: objectIdSchema }), "params"),
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    const version = await loadVersion(resume._id, req.params.versionId);
    const analysis = await Analysis.findOne({
      resumeId: resume._id,
      versionId: version._id,
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ analysis: analysis || null });
  })
);

// REWRITE HELPERS
const rewriteBody = z.object({
  analysisId: objectIdSchema,
  rewriteIds: z.array(objectIdSchema).optional(),
  label: z.string().trim().max(40).optional(),
});

function normalizeBulletText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s•\-*]+|[\s•\-*]+$/g, "")
    .trim()
    .toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyRewritesToText(rawText, rewrites) {
  let result = rawText;
  for (const r of rewrites) {
    if (!r?.original?.trim() || !r?.rewritten?.trim()) continue;
    const original = r.original.trim();
    const rewritten = r.rewritten.trim();

    // 1. Exact
    const exactIndex = result.indexOf(original);
    if (exactIndex !== -1) {
      result = result.slice(0, exactIndex) + rewritten + result.slice(exactIndex + original.length);
      continue;
    }

    // 2. Flexible whitespace
    try {
      const flexiblePattern = escapeRegex(original).replace(/\s+/g, "\\s+");
      const flexibleRegex = new RegExp(flexiblePattern, "i");
      if (flexibleRegex.test(result)) {
        result = result.replace(flexibleRegex, () => rewritten);
        continue;
      }
    } catch {}

    // 3. Normalized line
    const lines = result.split(/\r?\n/);
    const target = normalizeBulletText(original);
    const lineIndex = lines.findIndex((line) => normalizeBulletText(line) === target);
    if (lineIndex !== -1) {
      lines[lineIndex] = lines[lineIndex].replace(lines[lineIndex].trim(), rewritten);
      result = lines.join("\n");
      continue;
    }

    console.warn("Rewrite skipped: original bullet not found:", original.slice(0, 100));
  }
  return result;
}

function patchBulletsInSections(sections, rewrites) {
  if (!sections) return null;
  const cloned = JSON.parse(JSON.stringify(sections));
  for (const r of rewrites) {
    if (!r?.original?.trim() || !r?.rewritten?.trim()) continue;
    const target = normalizeBulletText(r.original);
    for (const exp of cloned.experience || []) {
      if (!Array.isArray(exp.bullets)) continue;
      exp.bullets = exp.bullets.map((bullet) =>
        normalizeBulletText(bullet) === target ? r.rewritten.trim() : bullet
      );
    }
  }
  return cloned;
}

function looksEmpty(sections) {
  if (!sections) return true;
  const basics = sections.basics || {};
  const hasIdentity = basics.name || basics.email || basics.title;
  const hasBody =
    sections.summary ||
    sections.experience?.length ||
    sections.education?.length ||
    sections.skills?.length;
  return !hasIdentity && !hasBody;
}

// REWRITE
router.post(
  "/:id/rewrite",
  validate(idParam, "params"),
  validate(rewriteBody, "body"),
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    const analysis = await Analysis.findOne({
      _id: req.body.analysisId,
      resumeId: resume._id,
    });
    if (!analysis) throw ApiError.notFound("Analysis not found");

    const baseVersion = await loadVersion(resume._id, analysis.versionId);

    const selected = req.body.rewriteIds?.length
      ? analysis.bulletRewrites.filter((r) => req.body.rewriteIds.includes(r._id.toString()))
      : analysis.bulletRewrites;

    if (!selected.length) throw ApiError.badRequest("No rewrites selected to apply");

    const newRaw = applyRewritesToText(baseVersion.rawText, selected);
    const patchedFromBase = patchBulletsInSections(baseVersion.parsedSections, selected);
    const reparsed = await parseStructured(newRaw);

    let finalParsed;
    if (looksEmpty(reparsed)) {
      finalParsed = patchedFromBase;
    } else {
      finalParsed = {
        ...reparsed,
        basics: patchedFromBase?.basics || reparsed.basics,
        experience: patchedFromBase?.experience?.length ? patchedFromBase.experience : reparsed.experience,
        summary: reparsed.summary || patchedFromBase?.summary,
      };
    }

    const nextNumber = resume.latestVersionNumber + 1;

    const newVersion = await ResumeVersion.create({
      resumeId: resume._id,
      versionNumber: nextNumber,
      label: req.body.label?.trim() || `V${nextNumber}`,
      rawText: newRaw,
      parsedSections: finalParsed,
      sourceType: "rewrite",
      parentVersionId: baseVersion._id,
    });

    const { analysis: newAnalysisData, model, promptTokens, responseTokens } = await analyzeResume({
      rawText: newRaw,
      targetRole: analysis.targetRole,
    });

    const savedAnalysis = await Analysis.create({
      userId: req.user._id,
      resumeId: resume._id,
      versionId: newVersion._id,
      targetRole: analysis.targetRole || null,
      atsScore: newAnalysisData.atsScore,
      scoreBreakdown: newAnalysisData.scoreBreakdown,
      issues: newAnalysisData.issues,
      strengths: newAnalysisData.strengths,
      bulletRewrites: newAnalysisData.bulletRewrites,
      keywordsPresent: newAnalysisData.keywordsPresent,
      keywordsMissing: newAnalysisData.keywordsMissing,
      summary: newAnalysisData.summary,
      model,
      promptTokens,
      responseTokens,
    });

    newVersion.latestAnalysisId = savedAnalysis._id;
    await newVersion.save();

    resume.latestVersionNumber = nextNumber;
    resume.currentVersionId = newVersion._id;
    await resume.save();

    res.status(201).json({
      version: newVersion,
      analysis: savedAnalysis,
      appliedCount: selected.length,
    });
  })
);

// DIFF
const diffQuery = z.object({
  from: objectIdSchema,
  to: objectIdSchema,
  mode: z.enum(["words", "lines"]).optional(),
});

router.get(
  "/:id/diff",
  validate(idParam, "params"),
  validate(diffQuery, "query"),
  asyncHandler(async (req, res) => {
    const resume = await loadOwnedResume(req);
    const [fromV, toV] = await Promise.all([
      loadVersion(resume._id, req.query.from),
      loadVersion(resume._id, req.query.to),
    ]);
    const parts = diffText(fromV.rawText, toV.rawText, req.query.mode);
    res.json({
      from: { id: fromV._id, label: fromV.label, versionNumber: fromV.versionNumber },
      to: { id: toV._id, label: toV.label, versionNumber: toV.versionNumber },
      parts,
      stats: summarize(parts),
    });
  })
);

module.exports = router;



// const express = require("express");
// const { z } = require("zod");
// const mongoose = require("mongoose");

// const asyncHandler = require("../utils/asyncHandler");
// const ApiError = require("../utils/apiError");
// const { requireAuth } = require("../middleware/auth.middleware");
// const { validate } = require("../middleware/validate");
// const { uploadPdf } = require("../middleware/upload.middleware");

// const Resume = require("../models/Resume");
// const ResumeVersion = require("../models/ResumeVersion");

// const { analyzeLimiter} = require("../middleware/rateLimit")
// const Analysis = require("../models/Analysis");
// const { analyzeResume} = require("../services/gemniService")

// // diff
// const {diffText, summarize } = require("../services/diffService")

// const { extractText } = require("../services/pdfService");
// const { parseResume: parseStructured } = require("../services/structuredParser");



// const router = express.Router();
// router.use(requireAuth);

// const objectIdSchema = z
//   .string()
//   .refine((v) => mongoose.isValidObjectId(v), { message: "Invalid id" });

// const idParam = z.object({ id: objectIdSchema });

// async function loadOwnedResume(req) {
//   const resume = await Resume.findOne({
//     _id: req.params.id,
//     userId: req.user._id,
//   });
//   if (!resume) throw ApiError.notFound("Resume not found");
//   return resume;
// }

// async function loadVersion(resumeId, versionId) {
//   const version = await ResumeVersion.findOne({ _id: versionId, resumeId });
//   if (!version) throw ApiError.notFound("Version not found");
//   return version;
// }
// router.post(
//   "/",
//   uploadPdf("file"),
//   asyncHandler(async (req, res) => {
//     const { text, meta } = await extractText(req.file.buffer);
//     const parsedSections = await parseStructured(text);

//     const title =
//       (req.body.title || "").trim() ||
//       req.file.originalname.replace(/\.pdf$/i, "") ||
//       "Untitled Resume";

//     const resume = await Resume.create({
//       userId: req.user._id,
//       title,
//       latestVersionNumber: 1,
//     });

//     const version = await ResumeVersion.create({
//       resumeId: resume._id,
//       versionNumber: 1,
//       label: "V1",
//       rawText: text,
//       parsedSections,
//       sourceType: "upload",
//       parentVersionId: null,
//     });

//     resume.currentVersionId = version._id;
//     await resume.save();

//     res.status(201).json({ resume, version, meta });
//   })
// );


// router.get(
//   "/",
//   asyncHandler(async (req, res) => {
//     const resumes = await Resume.find({ userId: req.user._id })
//       .sort({ updatedAt: -1 })
//       .lean();
//     res.json({ resumes });
//   })
// );

// router.get(
//   "/:id",
//   validate(idParam, "params"),
//   asyncHandler(async (req, res) => {
//     const resume = await loadOwnedResume(req);
//     const versions = await ResumeVersion.find({ resumeId: resume._id })
//       .sort({ versionNumber: 1 })
//       .select("-rawText")
//       .lean();
//     res.json({ resume, versions });
//   })
// );

// router.get(
//   "/:id/versions/:versionId",
//   validate(
//     z.object({ id: objectIdSchema, versionId: objectIdSchema }),
//     "params"
//   ),
//   asyncHandler(async (req, res) => {
//     const resume = await loadOwnedResume(req);
//     const version = await loadVersion(resume._id, req.params.versionId);
//     res.json({ version });
//   })
// );

// router.delete("/:id", asyncHandler(async(req, res)=>{
//     const resume = await loadOwnedResume(req);
//     await ResumeVersion.deleteMany({ resumeId: resume._id});
//     await Analysis.deleteMany({ resumeId: resume._id});
//     await resume.deleteOne();
//     res.json({ ok: true });
// })
// );


// const analyzeBody = z.object({
//   versionId: objectIdSchema.optional(),
//   targetRole: z.string().trim().max(120).optional(),
// });

// router.post(
//   "/:id/analyze",
//   analyzeLimiter,
//   validate(idParam, "params"),
//   validate(analyzeBody, "body"),
//   asyncHandler(async (req, res) => {
//     const resume = await loadOwnedResume(req);

//     const versionId = req.body.versionId || resume.currentVersionId;
//     if (!versionId) throw ApiError.badRequest("No version to analyze");
//     const version = await loadVersion(resume._id, versionId);

//     const { analysis, model, promptTokens, responseTokens } =
//       await analyzeResume({
//         rawText: version.rawText,
//         targetRole: req.body.targetRole,
//       });

//     const saved = await Analysis.create({
//       userId: req.user._id,
//       resumeId: resume._id,
//       versionId: version._id,
//       atsScore: analysis.atsScore,
//       scoreBreakdown: analysis.scoreBreakdown,
//       issues: analysis.issues,
//       strengths: analysis.strengths,
//       bulletRewrites: analysis.bulletRewrites,
//       keywordsPresent: analysis.keywordsPresent,
//       keywordsMissing: analysis.keywordsMissing,
//       summary: analysis.summary,
//       model,
//       promptTokens,
//       responseTokens,
//     });
//     version.latestAnalysisId = saved._id;
//     await version.save();

//     res.status(201).json({ analysis: saved });
// })
// )
// router.get(
//   "/:id/analyses",
//   validate(idParam, "params"),
//   asyncHandler(async (req, res) => {
//     const resume = await loadOwnedResume(req);
//     const analyses = await Analysis.find({ resumeId: resume._id })
//       .sort({ createdAt: -1 })
//       .lean();
//     res.json({ analyses });
//   })
// );

// router.get(
//   "/:id/versions/:versionId/analysis",
//   validate(
//     z.object({ id: objectIdSchema, versionId: objectIdSchema }),
//     "params"
//   ),
//   asyncHandler(async (req, res) => {
//     const resume = await loadOwnedResume(req);
//     const version = await loadVersion(resume._id, req.params.versionId);
//     const analysis = await Analysis.findOne({
//       resumeId: resume._id,
//       versionId: version._id,
//     })
//       .sort({ createdAt: -1 })
//       .lean();
//     res.json({ analysis: analysis || null });
//   })
// );

// // diff
// const rewriteBody = z.object({
//   analysisId: objectIdSchema,
//   rewriteIds: z.array(objectIdSchema).optional(), // omit/empty = apply all
//   label: z.string().trim().max(40).optional(),
// });

// function applyRewritesToText(rawText, rewrites) {
//   let result = rawText;
//   for (const r of rewrites) {
//     if (!r.original || !r.rewritten) continue;
//     const idx = result.indexOf(r.original);
//     if (idx >= 0) { // any
//       result = result.slice(0, idx) + r.rewritten + result.slice(idx + r.original.length);
//     } else {
//       // Fallback: append as a strengthened alternative line
//       result += `\n${r.rewritten}`;
//     }
//   }
//   return result;
// }

// function patchBulletsInSections(sections, rewrites) {
//   if (!sections) return null;
//   const cloned = JSON.parse(JSON.stringify(sections));
//   for (const r of rewrites) {
//     if (!r?.original || !r?.rewritten) continue;
//     for (const exp of cloned.experience || []) {
//       if (!Array.isArray(exp.bullets)) continue;
//       exp.bullets = exp.bullets.map((b) =>
//         b === r.original ? r.rewritten : b
//       );
//     }
//   }
//   return cloned;
// }

// function looksEmpty(sections) {
//   if (!sections) return true;
//   const b = sections.basics || {};
//   const hasIdentity = b.name || b.email || b.title;
//   const hasBody =
//     sections.summary ||
//     sections.experience?.length ||
//     sections.education?.length ||
//     sections.skills?.length;
//   return !hasIdentity && !hasBody;
// }

// // router.post(
// //   "/:id/rewrite",
// //   validate(idParam, "params"),
// //   validate(rewriteBody),
// //   asyncHandler(async (req, res) => {
// //     const resume = await loadOwnedResume(req);

// //     const analysis = await Analysis.findOne({
// //       _id: req.body.analysisId,
// //       resumeId: resume._id,
// //     });
// //     if (!analysis) throw ApiError.notFound("Analysis not found");

// //     const baseVersion = await loadVersion(resume._id, analysis.versionId);

// //     const selected = req.body.rewriteIds?.length
// //       ? analysis.bulletRewrites.filter((r) =>
// //           req.body.rewriteIds.includes(r._id.toString())
// //         )
// //       : analysis.bulletRewrites;

// //     if (!selected.length) {
// //       throw ApiError.badRequest("No rewrites selected to apply");
// //     }

// //     const newRaw = applyRewritesToText(baseVersion.rawText, selected);

// //     // Safety net: pre-build a structured copy from the base version with the
// //     // chosen bullets swapped in, so V2 never lands with empty sections even if
// //     // Gemini's re-parse fails.
// //     const patchedFromBase = patchBulletsInSections(
// //       baseVersion.parsedSections,
// //       selected
// //     );
// //     const reparsed = await parseStructured(newRaw);
// //     const finalParsed = looksEmpty(reparsed) ? patchedFromBase : reparsed;

// //     const nextNumber = resume.latestVersionNumber + 1;

// //     const newVersion = await ResumeVersion.create({
// //       resumeId: resume._id,
// //       versionNumber: nextNumber,
// //       label: req.body.label?.trim() || `V${nextNumber}`,
// //       rawText: newRaw,
// //       parsedSections: finalParsed,
// //       sourceType: "rewrite",
// //       parentVersionId: baseVersion._id,
// //     });

// //     resume.latestVersionNumber = nextNumber;
// //     resume.currentVersionId = newVersion._id;
// //     await resume.save();

// //     res.status(201).json({
// //       version: newVersion,
// //       appliedCount: selected.length,
// //     });
// //   })
// // );


// router.post(
//   "/:id/rewrite",
//   validate(idParam, "params"),
//   validate(rewriteBody),
//   asyncHandler(async (req, res) => {
//     const resume = await loadOwnedResume(req);

//     const analysis = await Analysis.findOne({
//       _id: req.body.analysisId,
//       resumeId: resume._id,
//     });
//     if (!analysis) throw ApiError.notFound("Analysis not found");

//     const baseVersion = await loadVersion(resume._id, analysis.versionId);

//     const selected = req.body.rewriteIds?.length
//       ? analysis.bulletRewrites.filter((r) =>
//           req.body.rewriteIds.includes(r._id.toString())
//         )
//       : analysis.bulletRewrites;

//     if (!selected.length) {
//       throw ApiError.badRequest("No rewrites selected to apply");
//     }

//     const newRaw = applyRewritesToText(baseVersion.rawText, selected);
//     const patchedFromBase = patchBulletsInSections(
//       baseVersion.parsedSections,
//       selected
//     );
//     const reparsed = await parseStructured(newRaw);
//     const finalParsed = looksEmpty(reparsed) ? patchedFromBase : reparsed;

//     const nextNumber = resume.latestVersionNumber + 1;

//     const newVersion = await ResumeVersion.create({
//       resumeId: resume._id,
//       versionNumber: nextNumber,
//       label: req.body.label?.trim() || `V${nextNumber}`,
//       rawText: newRaw,
//       parsedSections: finalParsed,
//       sourceType: "rewrite",
//       parentVersionId: baseVersion._id,
//     });

//     // NEW: Analyze the rewritten resume version.
//     const {
//       analysis: newAnalysisData,
//       model,
//       promptTokens,
//       responseTokens,
//     } = await analyzeResume({
//       rawText: newRaw,
//       targetRole: analysis.targetRole,
//     });

//     // NEW: Save the analysis for V2.
//     const savedAnalysis = await Analysis.create({
//       userId: req.user._id,
//       resumeId: resume._id,
//       versionId: newVersion._id,
//       atsScore: newAnalysisData.atsScore,
//       scoreBreakdown: newAnalysisData.scoreBreakdown,
//       issues: newAnalysisData.issues,
//       strengths: newAnalysisData.strengths,
//       bulletRewrites: newAnalysisData.bulletRewrites,
//       keywordsPresent: newAnalysisData.keywordsPresent,
//       keywordsMissing: newAnalysisData.keywordsMissing,
//       summary: newAnalysisData.summary,
//       model,
//       promptTokens,
//       responseTokens,
//     });

//     // NEW: Connect V2 to its analysis.
//     newVersion.latestAnalysisId = savedAnalysis._id;
//     await newVersion.save();

//     resume.latestVersionNumber = nextNumber;
//     resume.currentVersionId = newVersion._id;
//     await resume.save();

//     res.status(201).json({
//       version: newVersion,
//       analysis: savedAnalysis,
//       appliedCount: selected.length,
//     });
//   })
// );

// const diffQuery = z.object({
//   from: objectIdSchema,
//   to: objectIdSchema,
//   mode: z.enum(["words", "lines"]).optional(),
// });

// router.get(
//   "/:id/diff",
//   validate(idParam, "params"),
//   validate(diffQuery, "query"),
//   asyncHandler(async (req, res) => {
//     const resume = await loadOwnedResume(req);
//     const [fromV, toV] = await Promise.all([
//       loadVersion(resume._id, req.query.from),
//       loadVersion(resume._id, req.query.to),
//     ]);

//     const parts = diffText(fromV.rawText, toV.rawText, req.query.mode);
//     res.json({
//       from: { id: fromV._id, label: fromV.label, versionNumber: fromV.versionNumber },
//       to: { id: toV._id, label: toV.label, versionNumber: toV.versionNumber },
//       parts,
//       stats: summarize(parts),
//     });
//   })
// );

// module.exports = router;
// module.exports = router;