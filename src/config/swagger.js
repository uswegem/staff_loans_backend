'use strict';

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');
const pkg = require('../../package.json');

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'LFB Staff Loan Application System (SLAS) API',
      version: pkg.version,
      description: 'REST JSON API for SLAS. Requirement IDs refer to BRD v0.8. Responses use { success, data } or { success: false, code, message, details }.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
  },
  // Glob patterns need forward slashes, also on Windows.
  apis: [path.join(__dirname, '../routes/v1/*.js').split(path.sep).join('/')],
});

module.exports = spec;
