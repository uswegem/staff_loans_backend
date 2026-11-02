'use strict';

/* eslint-disable no-console */
// Brings existing staff records to the D-93 formats. Safe to run again; part of
// `npm run upgrade`.
//
//  1. Loads the Region → District → Ward list if it is not there yet.
//  2. NIDA numbers with 20 digits are stored with their hyphens (19800630-13140-00004-20).
//  3. Phone numbers (mobile, home, work, head of station, next of kin) that normalise
//     unambiguously are stored as +255 and nine digits. Anything else is left as it is
//     and listed: the staff member sees it as invalid and corrects it.
//  4. Nationality "Tanzanian" becomes Tanzania; other values that name a country on the
//     list are tidied; the rest are listed.
//  5. Settings that list the required profile fields swap the free-text residence and
//     P.O. Box for region, district, ward and street.
//  P.O. Box and the free-text residence stay in the database; nothing is mapped into the
//  new address fields.
//
// A number confirmed as entered wrongly can be corrected with
//   npm run upgrade -- --fix-phone <as stored>=<correct number>
// (repeatable). Only exact matches change; the correct number must normalise.
//
// Usage: node scripts/profile-formats.js [--dry-run] [--fix-phone a=b ...]

const mongoose = require('mongoose');
const { config } = require('../src/config/env');
const { connect } = require('../src/config/db');
const { normaliseNida, normalisePhone } = require('../src/utils/formats');
const { normaliseCountry } = require('../src/constants/countries');
const { seedReferenceData } = require('../seed/referenceData');

const ADDRESS_KEYS = ['personal.address.region', 'personal.address.district', 'personal.address.ward', 'personal.address.street'];

/** --fix-phone a=b pairs from argv: { 'a': '+255…' }. */
function phoneFixes(argv = process.argv) {
  const out = {};
  argv.forEach((a, i) => {
    if (a !== '--fix-phone') return;
    const [from, to] = String(argv[i + 1] || '').split('=');
    const fixed = normalisePhone(to || '');
    if (!from || !fixed) throw new Error(`--fix-phone needs <as stored>=<correct number>, got "${argv[i + 1]}"`);
    out[from.trim()] = fixed;
  });
  return out;
}

/**
 * opts: { dryRun, fixes: { asStored: correct } }. Returns counts and the values left
 * for their owners to correct ({ staffNo, field, value }).
 */
async function run(db, { dryRun = false, fixes = {} } = {}) {
  const out = { reference: null, nida: 0, phones: 0, fixed: [], nationality: 0, settings: false, invalid: [] };
  out.reference = dryRun ? null : await seedReferenceData();

  const staff = await db.collection('staffs').find({}).project({ staffNo: 1, personal: 1, workPhone: 1, stationHead: 1, nextOfKin: 1 }).toArray();
  for (const s of staff) {
    const set = {};
    const phone = (path, value, label) => {
      if (!value) return;
      const exact = fixes[String(value).trim()];
      if (exact) {
        set[path] = exact;
        out.fixed.push({ staffNo: s.staffNo, field: label, from: value, to: exact });
        return;
      }
      const p = normalisePhone(value);
      if (!p) out.invalid.push({ staffNo: s.staffNo, field: label, value });
      else if (p !== value) {
        set[path] = p;
        out.phones += 1;
      }
    };
    const nida = s.personal?.nida;
    if (nida) {
      const n = normaliseNida(nida);
      if (!n) out.invalid.push({ staffNo: s.staffNo, field: 'NIDA number', value: nida });
      else if (n !== nida) {
        set['personal.nida'] = n;
        out.nida += 1;
      }
    }
    phone('personal.mobile', s.personal?.mobile, 'Mobile phone');
    phone('personal.homePhone', s.personal?.homePhone, 'Home phone');
    phone('workPhone', s.workPhone, 'Work phone');
    phone('stationHead.phone', s.stationHead?.phone, 'Head of station phone');
    (s.nextOfKin || []).forEach((k, i) => phone(`nextOfKin.${i}.phone`, k.phone, `Next of kin ${i + 1} phone`));
    const nat = s.personal?.nationality;
    if (nat) {
      const c = normaliseCountry(nat);
      if (!c) out.invalid.push({ staffNo: s.staffNo, field: 'Nationality', value: nat });
      else if (c !== nat) {
        set['personal.nationality'] = c;
        out.nationality += 1;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    if (Object.keys(set).length && !dryRun) await db.collection('staffs').updateOne({ _id: s._id }, { $set: set });
  }

  const settings = await db.collection('settings').findOne({ _id: 'global' });
  const list = settings?.mandatoryProfileFields;
  if (list?.length && list.some((k) => k === 'personal.residence' || k === 'personal.poBox')) {
    const next = [...new Set(list.flatMap((k) => (k === 'personal.residence' ? ADDRESS_KEYS : k === 'personal.poBox' ? [] : [k])))];
    if (!dryRun) await db.collection('settings').updateOne({ _id: 'global' }, { $set: { mandatoryProfileFields: next } });
    out.settings = true;
  }
  return out;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  connect(config.mongoUri)
    .then(() => run(mongoose.connection.db, { dryRun, fixes: phoneFixes() }))
    .then((r) => {
      console.log(`${dryRun ? 'Dry run: ' : ''}NIDA hyphenated ${r.nida}; phone numbers normalised ${r.phones}; nationality mapped ${r.nationality}; settings updated: ${r.settings ? 'yes' : 'no'}.`);
      r.fixed.forEach((x) => console.log(`  corrected ${x.staffNo} ${x.field}: ${x.from} → ${x.to}`));
      if (r.invalid.length) console.log('Left for the staff member to correct:');
      r.invalid.forEach((x) => console.log(`  ${x.staffNo} ${x.field}: "${x.value}"`));
      return mongoose.disconnect();
    })
    .catch(async (err) => {
      console.error(err.message);
      await mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { run, phoneFixes };
