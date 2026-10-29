'use strict';

const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info'),
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: 'slas-api' },
  transports: [new winston.transports.Console({ silent: process.env.NODE_ENV === 'test' && !process.env.LOG_LEVEL })],
});

module.exports = logger;
