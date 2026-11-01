'use strict';

const express = require('express');
const Joi = require('joi');
const { STAFF_NO, STAFF_NO_MESSAGE } = require('../../constants/staffNo');
const multer = require('multer');
const ProfileController = require('../../controllers/profileController');
const StaffController = require('../../controllers/staffController');
const { requireAll, requireAny } = require('../../middleware/permission');
const { validate } = require('../../middleware/validate');
const { badRequest, asyncHandler } = require('../../utils/errors');

const router = express.Router();
const objectId = Joi.string().hex().length(24);
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Use a date like 2026-11-01.' });
const text = (max) => Joi.string().trim().max(max).allow('');
const phone = Joi.string().trim().max(30).pattern(/^[+\d][\d\s()-]{5,}$/).allow('').messages({ 'string.pattern.base': 'Enter a phone number, for example +255 713 448 902.' });
const money = Joi.number().integer().min(0).max(10_000_000_000);
const staffNo = Joi.string().trim().uppercase().pattern(STAFF_NO).messages({ 'string.pattern.base': STAFF_NO_MESSAGE });

// ---------- own profile ----------

/**
 * @openapi
 * /me/profile:
 *   get: { tags: [Profile], summary: "My profile, employment (read-only), salary, approval route and completeness", security: [{ bearer: [] }], responses: { 200: { description: Profile } } }
 * /me/profile/completeness:
 *   get: { tags: [Profile], summary: "Profile completeness gate (decision 7, FR-05)", security: [{ bearer: [] }], responses: { 200: { description: Done, total and missing fields } } }
 * /me/eligibility:
 *   get: { tags: [Profile], summary: "Per product: can I apply, why not, and days until I can apply again or top up (NS-02, NS-03)", security: [{ bearer: [] }], responses: { 200: { description: Eligibility } } }
 * /me/profile/personal:
 *   patch: { tags: [Profile], summary: "Save personal details; NIDA with or without dashes", security: [{ bearer: [] }], responses: { 200: { description: Profile } } }
 * /me/profile/bank:
 *   patch: { tags: [Profile], summary: "Save bank details", security: [{ bearer: [] }], responses: { 200: { description: Profile } } }
 * /me/profile/kin:
 *   patch: { tags: [Profile], summary: "Save next of kin (one to three)", security: [{ bearer: [] }], responses: { 200: { description: Profile } } }
 * /me/profile/pay:
 *   patch: { tags: [Profile], summary: "Save existing staff loans taken outside SLAS (BR-07, NS-02)", security: [{ bearer: [] }], responses: { 200: { description: Profile } } }
 */
router.get('/me/profile', asyncHandler(ProfileController.get));
router.get('/me/profile/completeness', asyncHandler(ProfileController.completeness));
router.get('/me/eligibility', requireAll('loan.apply'), asyncHandler(ProfileController.eligibility));
router.patch(
  '/me/profile/personal',
  validate({
    body: Joi.object({
      maritalStatus: Joi.string().valid('Single', 'Married', 'Divorced', 'Widowed', ''),
      dob: day.allow('', null),
      nida: Joi.string().trim().max(30).allow(''),
      nationality: text(60),
      mobile: phone,
      homePhone: phone,
      workPhone: phone,
      poBox: text(80),
      residence: text(160),
    }).min(1),
  }),
  asyncHandler(ProfileController.personal)
);
router.patch('/me/profile/bank', validate({ body: Joi.object({ bank: text(80), branch: text(80), accountName: text(120), accountNo: text(40) }).min(1) }), asyncHandler(ProfileController.bank));
router.patch(
  '/me/profile/kin',
  validate({
    body: Joi.object({
      nextOfKin: Joi.array()
        .items(Joi.object({ name: text(120), relationship: Joi.string().valid('Spouse', 'Parent', 'Child', 'Sibling', 'Other relative', 'Guardian', ''), phone, address: text(200), employer: text(120) }))
        .max(3)
        .required(),
    }),
  }),
  asyncHandler(ProfileController.kin)
);
router.patch(
  '/me/profile/pay',
  validate({
    body: Joi.object({
      existingLfbLoans: Joi.array().items(Joi.object({ description: text(120), instalment: money.allow(null), outstanding: money, productId: objectId.allow(null), disbursedOn: day.allow('', null) })).max(20).default([]),
    }),
  }),
  asyncHandler(ProfileController.pay)
);

// ---------- staff records (People and Culture) ----------

const hrBody = {
  firstName: Joi.string().trim().min(1).max(60),
  middleName: text(60),
  lastName: Joi.string().trim().min(1).max(60),
  title: Joi.string().trim().min(2).max(100),
  department: text(100),
  station: Joi.string().trim().min(2).max(100),
  stationHead: Joi.object({ name: text(120), phone }),
  lineManagerStaffNo: staffNo.allow('', null),
  category: Joi.string().valid('Management', 'Non-management'),
  employmentType: Joi.string().valid('Permanent', 'Probation', 'Contract'),
  dateJoined: day,
  probationEndDate: day.allow('', null),
  contractEndDate: day.allow('', null),
  retirementDate: day,
  email: Joi.string().trim().lowercase().email({ tlds: false }).max(120).allow(''),
  workPhone: phone,
  lfbAccountNo: text(40),
  incomeClass: Joi.string().valid('fixed', 'commission'),
};
const salaryBody = Joi.object({ basic: money.min(1).required(), allowances: money.default(0), commission: money.default(0), gross: money.allow(null), net: money.allow(null), effectiveFrom: day.required() });
const idParams = { params: Joi.object({ id: objectId.required() }) };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls|csv)$/i.test(file.originalname)) return cb(null, true);
    return cb(badRequest('Upload an .xlsx, .xls or .csv file.', { file: ['Upload an .xlsx, .xls or .csv file.'] }, 'FILE_TYPE'));
  },
});
const uploadOne = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return next(badRequest('The file is larger than 5 MB.', { file: ['The file is larger than 5 MB.'] }, 'FILE_TOO_LARGE'));
    return next(err);
  });

/**
 * @openapi
 * /staff:
 *   get: { tags: [Staff], summary: "Staff records with salary in force and profile completeness (FR-01)", security: [{ bearer: [] }], responses: { 200: { description: Page of staff } } }
 *   post: { tags: [Staff], summary: "Add a staff record with its first salary", security: [{ bearer: [] }], responses: { 201: { description: Created } } }
 * /staff/{id}:
 *   get: { tags: [Staff], summary: "Staff record with salary history; the view is audited (NFR-05)", security: [{ bearer: [] }], responses: { 200: { description: Staff record } } }
 *   patch: { tags: [Staff], summary: "Change employment details", security: [{ bearer: [] }], responses: { 200: { description: Saved } } }
 * /staff/{id}/status:
 *   post: { tags: [Staff], summary: "Activate, deactivate or record an exit; inactive staff cannot sign in (FR-04)", security: [{ bearer: [] }], responses: { 200: { description: Saved } } }
 * /staff/{id}/salaries:
 *   post: { tags: [Staff], summary: "Add an effective-dated salary (FR-03)", security: [{ bearer: [] }], responses: { 201: { description: Added } } }
 * /staff/import/template:
 *   get: { tags: [Staff], summary: "Excel template with an Instructions sheet (FR-02)", security: [{ bearer: [] }], responses: { 200: { description: xlsx file } } }
 * /staff/import:
 *   post: { tags: [Staff], summary: "Upload .xlsx, .xls or .csv; every row is checked; nothing changes yet (FR-02)", security: [{ bearer: [] }], responses: { 201: { description: Preview of new, updated, unchanged and error rows } } }
 * /staff/import/{id}:
 *   get: { tags: [Staff], summary: "An upload's preview", security: [{ bearer: [] }], responses: { 200: { description: Preview } } }
 * /staff/import/{id}/errors.xlsx:
 *   get: { tags: [Staff], summary: "Error rows with reasons, in template columns, to fix and upload again", security: [{ bearer: [] }], responses: { 200: { description: xlsx file } } }
 * /staff/import/{id}/commit:
 *   post: { tags: [Staff], summary: "Apply the valid rows in one transaction", security: [{ bearer: [] }], responses: { 200: { description: Result } } }
 * /staff/import/{id}/discard:
 *   post: { tags: [Staff], summary: "Discard an upload", security: [{ bearer: [] }], responses: { 200: { description: Discarded } } }
 */
router.get('/staff/import/template', requireAll('staff.manage'), asyncHandler(StaffController.template));
router.post('/staff/import', requireAll('staff.manage'), uploadOne, asyncHandler(StaffController.upload));
router.get('/staff/import/:id', requireAll('staff.manage'), validate(idParams), asyncHandler(StaffController.getImport));
router.get('/staff/import/:id/errors.xlsx', requireAll('staff.manage'), validate(idParams), asyncHandler(StaffController.importErrors));
router.post('/staff/import/:id/commit', requireAll('staff.manage'), validate(idParams), asyncHandler(StaffController.commit));
router.post('/staff/import/:id/discard', requireAll('staff.manage'), validate(idParams), asyncHandler(StaffController.discardImport));

router.get(
  '/staff',
  requireAny('staff.view', 'staff.manage'),
  validate({
    query: Joi.object({
      q: Joi.string().max(80).allow(''),
      status: Joi.string().valid('active', 'exited', 'deactivated'),
      category: Joi.string().valid('Management', 'Non-management'),
      department: Joi.string().max(100),
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(25),
    }),
  }),
  asyncHandler(StaffController.list)
);
router.post(
  '/staff',
  requireAll('staff.manage'),
  validate({ body: Joi.object({ ...hrBody, staffNo: staffNo.required(), mobile: phone, salary: salaryBody.required() }).fork(['firstName', 'lastName', 'title', 'station', 'category', 'employmentType', 'dateJoined', 'retirementDate'], (s) => s.required()) }),
  asyncHandler(StaffController.create)
);
router.get('/staff/:id', requireAny('staff.view', 'staff.manage'), validate(idParams), asyncHandler(StaffController.get));
router.patch('/staff/:id', requireAll('staff.manage'), validate({ ...idParams, body: Joi.object(hrBody).min(1) }), asyncHandler(StaffController.update));
router.post(
  '/staff/:id/status',
  requireAll('staff.manage'),
  validate({ ...idParams, body: Joi.object({ status: Joi.string().valid('active', 'deactivated', 'exited').required(), exitDate: day.when('status', { is: 'exited', then: Joi.required() }), reason: text(400) }) }),
  asyncHandler(StaffController.setStatus)
);
router.post('/staff/:id/salaries', requireAll('staff.manage'), validate({ ...idParams, body: salaryBody }), asyncHandler(StaffController.addSalary));

module.exports = router;
