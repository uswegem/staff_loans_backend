'use strict';

// Atomic sequences for references such as SL-2026-00031 and MKT-2026-00014 (FR-12, D-21).

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

counterSchema.statics.next = async function next(key, session) {
  const doc = await this.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  return doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
