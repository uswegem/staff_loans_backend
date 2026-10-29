'use strict';

// Blocks every update and delete path Mongoose offers, so an append-only
// collection can only grow (BRD NFR-05: logs cannot be edited or deleted from the
// application). Production should also give the app's DB user insert/find only
// on these collections (README).

const { AppError } = require('../../utils/errors');

const QUERY_OPS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'replaceOne',
  'deleteOne',
  'deleteMany',
];

function refuse(name) {
  return new AppError(405, 'APPEND_ONLY', `${name} records cannot be changed or deleted.`);
}

module.exports = function appendOnly(schema, { name }) {
  for (const op of QUERY_OPS) {
    schema.pre(op, { document: false, query: true }, function block() {
      throw refuse(name);
    });
  }
  schema.pre('deleteOne', { document: true, query: false }, function block() {
    throw refuse(name);
  });
  schema.pre('save', function block() {
    if (!this.isNew) throw refuse(name);
  });
  schema.pre('bulkWrite', function block() {
    throw refuse(name);
  });
};
