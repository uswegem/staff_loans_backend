'use strict';

// Ported from Ess-Backend/src/routes/auth.js (commit 522bdbd), adapted for SLAS:
// login-with-api-key and select-tenant removed; MFA routes added; Joi validation;
// refresh and logout read the httpOnly cookie and need the CSRF header.

const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const AuthController = require('../../controllers/authController');
const { authenticate } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { requireCsrf } = require('../../middleware/csrf');
const audit = require('../../services/audit/auditService');
const { config } = require('../../config/env');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();

const staffNo = Joi.string().trim().uppercase().pattern(/^LFB\d{4}$/).required().messages({
  'string.pattern.base': 'Staff numbers look like LFB0412.',
  'string.empty': 'Enter your staff number.',
  'any.required': 'Enter your staff number.',
});
const code = Joi.string().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'Enter the 6-digit code from your authenticator app.' });
const mfaToken = Joi.string().max(2000).required();

const signInLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => config.loginRateLimitPerMin,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    audit.security('rate_limit_exceeded', { req, description: 'Too many sign-in requests' });
    res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute and try again.' });
  },
});

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in with staff number and password (FR-53)
 *     description: Returns a session, or an mfaToken when a one-time code (or enrolment) is needed. Failures return remainingAttempts; the 5th failure locks the account (423).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [staffNo, password], properties: { staffNo: { type: string, example: LFB0412 }, password: { type: string } } }
 *     responses:
 *       200: { description: Session opened, or MFA step required }
 *       401: { description: Wrong staff number or password, with remainingAttempts }
 *       423: { description: Account locked }
 */
router.post('/login', signInLimiter, validate({ body: Joi.object({ staffNo, password: Joi.string().max(128).required() }) }), asyncHandler(AuthController.login));

/**
 * @openapi
 * /auth/mfa/verify:
 *   post: { tags: [Auth], summary: Complete sign-in with a 6-digit TOTP code, responses: { 200: { description: Session opened } } }
 * /auth/mfa/enrol/start:
 *   post: { tags: [Auth], summary: Start authenticator enrolment (QR code), responses: { 200: { description: otpauth URI and QR data URL } } }
 * /auth/mfa/enrol/confirm:
 *   post: { tags: [Auth], summary: Confirm enrolment with a first code and open the session, responses: { 200: { description: Session opened } } }
 */
router.post('/mfa/verify', signInLimiter, validate({ body: Joi.object({ mfaToken, code }) }), asyncHandler(AuthController.mfaVerify));
router.post('/mfa/enrol/start', signInLimiter, validate({ body: Joi.object({ mfaToken }) }), asyncHandler(AuthController.mfaEnrolStart));
router.post('/mfa/enrol/confirm', signInLimiter, validate({ body: Joi.object({ mfaToken, code }) }), asyncHandler(AuthController.mfaEnrolConfirm));

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate the refresh cookie and get a new access token
 *     parameters: [{ in: header, name: X-XSRF-TOKEN, required: true, schema: { type: string } }]
 *     responses: { 200: { description: New access token }, 401: { description: Session ended }, 403: { description: CSRF rejected } }
 * /auth/logout:
 *   post: { tags: [Auth], summary: End the current session, responses: { 200: { description: Signed out } } }
 */
router.post('/refresh', requireCsrf, asyncHandler(AuthController.refresh));
router.post('/logout', requireCsrf, asyncHandler(AuthController.logout));

/**
 * @openapi
 * /auth/me:
 *   get: { tags: [Auth], summary: "Current user, roles and permissions (FR-52)", security: [{ bearer: [] }], responses: { 200: { description: Profile } } }
 * /auth/change-password:
 *   post: { tags: [Auth], summary: Change own password (policy Q2), security: [{ bearer: [] }], responses: { 200: { description: Changed } } }
 */
router.get('/me', authenticate, asyncHandler(AuthController.me));
router.post(
  '/change-password',
  authenticate,
  validate({ body: Joi.object({ currentPassword: Joi.string().max(128).required(), newPassword: Joi.string().max(128).required() }) }),
  asyncHandler(AuthController.changePassword)
);

module.exports = router;
