'use strict';

// Tanzania's regions, districts and wards (D-93), copied from the MMS reference data
// (mms-backend prisma/reference-data/tanzania-locations.json) and loaded by
// seed/referenceData.js. One document per region; the hierarchy is read-only at run
// time and backs the profile address dropdowns and their server-side check.

const mongoose = require('mongoose');

const wardSchema = new mongoose.Schema({ name: { type: String, required: true }, postcode: String }, { _id: false });
const districtSchema = new mongoose.Schema({ name: { type: String, required: true }, wards: { type: [wardSchema], default: [] } }, { _id: false });

const regionSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  districts: { type: [districtSchema], default: [] },
});

module.exports = mongoose.model('LocationRegion', regionSchema);
