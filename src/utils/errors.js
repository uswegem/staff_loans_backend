'use strict';

/** An error with an HTTP status and a stable code the frontend can switch on. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details, code = 'VALIDATION_FAILED') => new AppError(400, code, message, details);
const unauthorized = (message = 'Authentication required.', code = 'UNAUTHENTICATED', details) => new AppError(401, code, message, details);
const forbidden = (message = 'You do not have permission to do this.', code = 'FORBIDDEN', details) => new AppError(403, code, message, details);
const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);
const conflict = (message, code = 'CONFLICT', details) => new AppError(409, code, message, details);

/** Wraps an async route handler so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, asyncHandler };
