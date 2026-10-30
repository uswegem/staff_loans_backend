'use strict';

// Joi validation for body, query and params. Unknown keys are stripped.

const { badRequest } = require('../utils/errors');

function validate(schemas) {
  const mw = (req, res, next) => {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const { value, error } = schemas[part].validate(req[part] ?? {}, { abortEarly: false, stripUnknown: true, convert: true });
      if (error) {
        const details = {};
        for (const d of error.details) {
          const key = d.path.join('.') || part;
          (details[key] = details[key] || []).push(d.message.replace(/"/g, ''));
        }
        return next(badRequest('Check the highlighted fields.', details));
      }
      if (part === 'query') {
        // Express 4 query is a getter-less plain object; replace keys in place.
        Object.keys(req.query).forEach((k) => delete req.query[k]);
        Object.assign(req.query, value);
      } else {
        req[part] = value;
      }
    }
    return next();
  };
  mw.slasValidate = Object.keys(schemas); // lets the route guard test see what is validated
  return mw;
}

module.exports = { validate };
