'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const { config } = require('./config/env');
const requestContext = require('./middleware/requestContext');
const { errorHandler, notFoundHandler } = require('./middleware/error');
const { i18nResponses } = require('./i18n');

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestContext);
  app.use(i18nResponses); // Swahili messages when asked for (D-94)
  app.use(helmet());
  if (config.corsOrigin) {
    app.use(cors({ origin: config.corsOrigin.split(','), credentials: true }));
  }
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  if (config.nodeEnv !== 'production') {
    const spec = require('./config/swagger');
    app.get('/api/v1/openapi.json', (req, res) => res.json(spec));
    app.use('/api/v1/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(spec));
  }

  app.use('/api/v1', require('./routes/v1'));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { buildApp };
