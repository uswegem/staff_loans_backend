'use strict';

const crypto = require('crypto');

/** Correlation id for logs and audit entries. */
module.exports = function requestContext(req, res, next) {
  const incoming = req.get('X-Correlation-Id');
  req.correlationId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Correlation-Id', req.correlationId);
  next();
};
