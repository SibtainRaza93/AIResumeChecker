const express = require("express");
const { z } = require("zod");

const env = require("../config/env");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { signToken, cookieOptions } = require("../utils/jwt");
const { validate } = require("../middleware/validate");
const { requireAuth } = require("../middleware/auth.middleware");
const { authLimit } = require("../middleware/rateLimit");
const User = require("../models/user.schema");

const router = express.Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

function issueSession(res, user) {
  const token = signToken({ sub: user._id.toString() });
  res.cookie(env.cookieName, token, cookieOptions);
}