'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, details: err.details });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const details = {};
    Object.values(err.errors).forEach((e) => {
      details[e.path] = [e.message];
    });
    return res.status(400).json({ success: false, code: 'VALIDATION_FAILED', message: 'Check the highlighted fields.', details });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
  }
  if (err && err.code === 11000) {
    return res.status(409).json({ success: false, code: 'DUPLICATE', message: 'That record already exists.', details: err.keyValue });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, code: 'BAD_JSON', message: 'The request body is not valid JSON.' });
  }
  logger.error('Unhandled error', { error: err.message, stack: err.stack, correlationId: req.correlationId });
  return res.status(500).json({ success: false, code: 'INTERNAL', message: 'Something went wrong. Try again, or contact the IT Service Desk.', correlationId: req.correlationId });
}

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
}

module.exports = { errorHandler, notFoundHandler };
