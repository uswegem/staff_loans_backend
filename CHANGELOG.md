# Changelog

## 0.1.0 – Milestone 1: Foundation (29 Oct 2026)

- Express API under `/api/v1` with helmet, a JSON body limit, correlation ids, a uniform error format and an OpenAPI spec (`/api/v1/docs`, `npm run openapi`).
- Authentication ported from ESS (`authController`, `auth` routes, `RefreshToken`, `authMiddleware`, `User`) and adapted:
  - sign-in by staff number (LFB0000); remaining attempts shown; lockout after 5 failures (configurable); admin unlock
  - TOTP MFA (RFC 6238) for review, disbursement, administration and checker permissions, with QR enrolment and admin reset
  - refresh token in an httpOnly, Secure, SameSite=Strict cookie, rotated on every refresh, with reuse detection and CSRF double-submit
  - server-side sessions: logout, deactivation, MFA reset and the inactivity timeout end access at once
  - a credential-provider interface (local bcrypt now; LDAP or AD later)
  - password policy: minimum 8 characters, 3 character classes, no reuse of the last 5; temporary passwords must be changed
- User management ported from ESS: list, detail, create from a staff record, activate and deactivate, unlock, MFA reset, password reset.
- RBAC: permission catalogue, the seven system roles plus Product Checker and Risk and Audit Viewer, custom roles, the role-by-permission matrix, multiple roles per user with end dates, three segregation-of-duties rules checked on every save, and permissions resolved on every request.
- Append-only audit log with before and after values; security events are logged as audit entries.
- Working calendar: working hours between two instants, due times, overdue flags; settings and holidays screens' API.
- Staff and salary-history models; seed of the prototype's sample people.
