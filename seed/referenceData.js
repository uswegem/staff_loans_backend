'use strict';

// Loads the Region → District → Ward hierarchy (D-93) from seed/data/tanzania-locations.json,
// a copy of the MMS reference data. Like the MMS seed, it skips once regions exist: the
// data does not change from one deployment to the next. Safe to run again.

const path = require('path');
const LocationRegion = require('../src/models/LocationRegion');

const FILE = path.join(__dirname, 'data', 'tanzania-locations.json');

/** Returns { regions, districts, wards, loaded } — loaded is false when it was already there. */
async function seedReferenceData() {
  // eslint-disable-next-line global-require
  const data = require(FILE);
  const count = (rows) => ({ regions: rows.length, districts: rows.reduce((n, r) => n + r.districts.length, 0), wards: rows.reduce((n, r) => n + r.districts.reduce((m, d) => m + d.wards.length, 0), 0) });
  if (await LocationRegion.exists({})) return { ...count(data), loaded: false };
  // Some names in the source have line breaks inside them ("Dodoma\nCbd"); spaces are tidied.
  const tidy = (x) => x.replace(/\s+/g, ' ').trim();
  await LocationRegion.insertMany(data.map((r) => ({ name: tidy(r.region), districts: r.districts.map((d) => ({ name: tidy(d.name), wards: d.wards.map((w) => ({ name: tidy(w.name), postcode: w.postcode })) })) })));
  return { ...count(data), loaded: true };
}

module.exports = { seedReferenceData };
