'use strict';

module.exports = async function globalTeardown() {
  if (globalThis.__MONGO_REPLSET__) await globalThis.__MONGO_REPLSET__.stop();
};
