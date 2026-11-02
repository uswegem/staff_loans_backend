'use strict';

// Read-only lookups over the location hierarchy (D-93), and the check that an address
// names a real region, a district in it and a ward in that district (as MMS's
// ReferenceDataService.validateLocation does).

const LocationRegion = require('../../models/LocationRegion');

const byName = (a, b) => a.localeCompare(b);

async function listRegions() {
  const rows = await LocationRegion.find().select('name').lean();
  return rows.map((r) => r.name).sort(byName);
}

/** Districts of a region, or null when the region is unknown. */
async function listDistricts(region) {
  const r = await LocationRegion.findOne({ name: region }).select('districts.name').lean();
  return r ? r.districts.map((d) => d.name).sort(byName) : null;
}

/** Wards of a district, or null when the region or district is unknown. */
async function listWards(region, district) {
  const r = await LocationRegion.findOne({ name: region }).lean();
  const d = r?.districts.find((x) => x.name === district);
  return d ? d.wards.map((w) => w.name).sort(byName) : null;
}

/**
 * Problems with an address's region, district and ward, by field: {} when they are
 * consistent. Blank parts are left to the completeness check; a part given below a
 * blank parent is a problem.
 */
async function checkAddress({ region, district, ward } = {}) {
  const out = {};
  if (!region) {
    if (district) out.district = ['Choose the region first.'];
    if (ward) out.ward = ['Choose the region and district first.'];
    return out;
  }
  const r = await LocationRegion.findOne({ name: region }).lean();
  if (!r) return { region: ['Choose a region from the list.'] };
  if (!district) {
    if (ward) out.ward = ['Choose the district first.'];
    return out;
  }
  const d = r.districts.find((x) => x.name === district);
  if (!d) return { district: [`Choose a district in ${region}.`] };
  if (ward && !d.wards.some((w) => w.name === ward)) out.ward = [`Choose a ward in ${district}.`];
  return out;
}

/** One line for documents: House/Plot, Street, Ward, District, Region (blank parts left out). */
function addressLine(a) {
  if (!a) return '';
  return [a.house, a.street, a.ward, a.district, a.region].map((x) => (x || '').trim()).filter(Boolean).join(', ');
}

module.exports = { listRegions, listDistricts, listWards, checkAddress, addressLine };
