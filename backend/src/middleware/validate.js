const ApiError = require("../utils/apiError");

const validate =
    (schema, source = "body") =>
        (req, res, next) => {
            const result = schema.safeParse(req[source]); // it automaticallu become req.body

            if (!result.success) {
                return next(ApiError.badRequest("Validation failed", result.error.issues),
                );
            }
            req[source] = result.data; //if data is valid is replace with req.body with the cleaned data
            next();
        };

module.exports = { validate }