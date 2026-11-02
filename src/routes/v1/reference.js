'use strict';

// Read-only lookup data for forms (D-93), as in MMS's reference-data controller: every
// signed-in user may read it, so no permission is needed beyond a session.

const express = require('express');
const Joi = require('joi');
const { COUNTRIES, DEFAULT_COUNTRY } = require('../../constants/countries');
const locations = require('../../services/reference/locationService');
const { validate } = require('../../middleware/validate');
const { asyncHandler, notFound } = require('../../utils/errors');

const router = express.Router();
const name = Joi.string().trim().max(80).required();

/**
 * @openapi
 * /reference-data/countries:
 *   get: { tags: [Reference data], summary: "Countries for the nationality list; Tanzania is the default", security: [{ bearer: [] }], responses: { 200: { description: Countries } } }
 * /reference-data/regions:
 *   get: { tags: [Reference data], summary: "Tanzania regions", security: [{ bearer: [] }], responses: { 200: { description: Region names } } }
 * /reference-data/regions/{region}/districts:
 *   get: { tags: [Reference data], summary: "Districts in a region", security: [{ bearer: [] }], responses: { 200: { description: District names }, 404: { description: Unknown region } } }
 * /reference-data/regions/{region}/districts/{district}/wards:
 *   get: { tags: [Reference data], summary: "Wards in a district", security: [{ bearer: [] }], responses: { 200: { description: Ward names }, 404: { description: Unknown region or district } } }
 */
router.get('/reference-data/countries', (req, res) => res.json({ success: true, data: { countries: COUNTRIES, default: DEFAULT_COUNTRY } }));
router.get('/reference-data/regions', asyncHandler(async (req, res) => res.json({ success: true, data: await locations.listRegions() })));
router.get(
  '/reference-data/regions/:region/districts',
  validate({ params: Joi.object({ region: name }) }),
  asyncHandler(async (req, res) => {
    const rows = await locations.listDistricts(req.params.region);
    if (!rows) throw notFound('That region is not on the list.');
    res.json({ success: true, data: rows });
  })
);
router.get(
  '/reference-data/regions/:region/districts/:district/wards',
  validate({ params: Joi.object({ region: name, district: name }) }),
  asyncHandler(async (req, res) => {
    const rows = await locations.listWards(req.params.region, req.params.district);
    if (!rows) throw notFound('That district is not on the list.');
    res.json({ success: true, data: rows });
  })
);

module.exports = router;
