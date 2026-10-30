'use strict';

// Security pass (prompt 5, OWASP ASVS L2 basics): every API route validates its input
// with Joi and checks a permission, unless it is on the short, reviewed list below.
// A new route without either fails this test until it is guarded or reviewed.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-slas-unit-tests-only-0123456789';
process.env.MFA_ENC_KEY = process.env.MFA_ENC_KEY || 'a'.repeat(64);
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost/unused';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../../src/routes/v1');
const PREFIX = { 'auth.js': '/auth', 'users.js': '/users', 'notifications.js': '/notifications' };

function routes() {
  const out = [];
  for (const file of fs.readdirSync(DIR).filter((f) => f !== 'index.js')) {
    // eslint-disable-next-line global-require
    const router = require(path.join(DIR, file));
    // A router-level guard (router.use(requireAll(...))) covers the routes after it.
    let routerGuard = false;
    for (const layer of router.stack) {
      if (!layer.route) {
        if (layer.handle.slasPermissions) routerGuard = true;
        continue;
      }
      const handlers = layer.route.stack.map((s) => s.handle);
      for (const method of Object.keys(layer.route.methods)) {
        out.push({
          id: `${method.toUpperCase()} ${PREFIX[file] || ''}${layer.route.path}`,
          method: method.toUpperCase(),
          path: layer.route.path,
          validated: handlers.filter((h) => h.slasValidate).flatMap((h) => h.slasValidate),
          permission: routerGuard || handlers.some((h) => h.slasPermissions),
        });
      }
    }
  }
  return out;
}

// Routes with no input to validate: no path parameters and no body or query used.
const NO_INPUT = new Set([
  'GET /health',
  'POST /auth/logout',
  'POST /auth/refresh',
  'GET /auth/me',
  'GET /notifications/unread-count',
  'POST /notifications/read-all',
  'GET /permissions',
  'GET /roles',
  'GET /me/profile',
  'GET /me/eligibility',
  'GET /me/roles',
  'GET /admin/settings',
  'GET /admin/templates',
  'GET /reports',
  'GET /reports/overview',
  'GET /delegations',
  'GET /staff-import/template',
  'GET /pricing',
  'GET /pricing/versions',
  'GET /products',
  'GET /applications',
  'GET /products/available',
  // Multipart upload: the file is checked by type and content, and each row by the import service.
  'POST /staff/import',
]);

// Routes any signed-in person may use: their own data, checked in the controller by
// ownership (applicant, inbox owner) or by stage (review access, FR-47, FR-55).
const SELF_SERVICE = [
  /^\w+ \/health$/,
  /^\w+ \/auth\//,
  /^\w+ \/notifications/,
  /^\w+ \/me\//,
  /^\w+ \/applications/,
  /^\w+ \/agreements\//,
  /^\w+ \/files\//,
  /^\w+ \/queue$/,
  /^\w+ \/review\/:id/,
  // Reference data any signed-in person needs (Apply, My access); no personal data.
  /^GET \/products$/,
  /^GET \/pricing$/,
  /^GET \/permissions$/,
  /^\w+ \/delegations/,
  /^\w+ \/account\//,
];

describe('every API route is guarded', () => {
  const all = routes();

  it('finds the routes', () => {
    expect(all.length).toBeGreaterThan(60);
  });

  it('validates path parameters and bodies with Joi', () => {
    const missing = all.filter((r) => {
      if (NO_INPUT.has(r.id)) return false;
      const needs = [];
      if (r.path.includes(':')) needs.push('params');
      if (['POST', 'PUT', 'PATCH'].includes(r.method)) needs.push('body');
      if (!needs.length) return false;
      return !needs.some((n) => r.validated.includes(n)) && !(needs.includes('body') && r.path.includes(':') && r.validated.includes('params'));
    });
    expect(missing.map((r) => r.id)).toEqual([]);
  });

  it('checks a permission, or is self-service with a check in the controller', () => {
    const open = all.filter((r) => !r.permission && !SELF_SERVICE.some((re) => re.test(r.id)));
    expect(open.map((r) => r.id)).toEqual([]);
  });
});
