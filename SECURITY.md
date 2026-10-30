# SLAS security review (milestone 8, 30 Oct 2026)

A pass over the API and web app against the prompt's non-functional rules (section 5: OWASP ASVS level 2 basics) and BRD 13. Each item says what is in place and how it is checked. Items marked **Action** need the bank's infrastructure team before go-live.

## Authentication and sessions (ASVS V2, V3)

| Control | In place | Checked by |
| --- | --- | --- |
| Sign-in by staff number and password; credential provider behind an interface for LDAP/AD later (Q2) | `services/auth/credentialProvider` | `tests/integration/auth.test.js` |
| Password policy: 8+ characters, 3 character classes, last 5 not reused; temporary passwords must be changed | `services/auth/passwordPolicy` | `tests/unit/passwordPolicy.test.js` |
| Lockout after 5 failures (configurable), remaining attempts shown, admin unlock | `authController` | auth tests |
| Rate limit on sign-in and MFA endpoints | `express-rate-limit` per IP | auth tests |
| TOTP MFA (RFC 6238) for every review, disbursement, administration and checker permission; each code accepted once; secrets encrypted at rest (AES-256-GCM with `MFA_ENC_KEY`) | `services/auth/mfaService` | `tests/unit/mfa.test.js`, auth tests, Playwright enrolment |
| Privileged actions need an MFA-verified session, including a delegate's decisions (FR-49) | `middleware/permission`, `reviewController.decide` | rbac and review tests |
| Access token in memory only; refresh token in an httpOnly, Secure, SameSite=Strict cookie on `/api/v1/auth`, rotated on every use, reuse ends the session | `authController`, `RefreshToken` | auth tests |
| CSRF double-submit on refresh and logout | `XSRF-TOKEN` cookie + header, hashed on the session | auth tests |
| Server-side sessions: logout, deactivation, MFA reset and inactivity end access at once (NFR-04) | `Session` model, `middleware/auth` | auth and users tests |

## Access control (ASVS V4)

- Permissions are resolved from the database on every request; code checks permissions, never role names (FR-44, FR-51).
- Every route validates its input with Joi and checks a permission, or is on a short reviewed list of self-service routes whose controllers check ownership or stage. `tests/unit/routeGuards.test.js` walks every route and fails when a new one has neither.
- Segregation of duties (FR-48) is enforced when roles and assignments are saved, at decision time (no self-review), at delegation, and at disbursement (OPS cannot confirm their own loan or one they approved, directly or through a delegate).
- FR-55 (limited details) is enforced in the API by an allow-list projection for the queue, review screen, files, agreements, reports and every export. Tests scan responses, CSV and Excel files for hidden values.

## Input, output and files (ASVS V5, V12)

- Joi on body, query and params with unknown keys stripped; JSON body limit 1 MB.
- Regular expressions built from user input are escaped; MongoDB queries take typed values only.
- Uploads: PDF, JPG and PNG, checked by content, not just the name; size limit from settings; stored outside the web root under random names with a SHA-256; a malware-scan hook (`services/files/malwareScanner`). **Action:** connect the hook to the bank's antivirus engine.
- Exports: CSV and Excel cells that start with `=`, `+`, `-` or `@` are neutralised (formula injection); the PDF uses standard fonts only.
- Errors return a code, a plain message and a correlation id; stack traces are only logged.

## Data protection and audit (ASVS V7, V8; NFR-05)

- `Cache-Control: no-store` on every API response; helmet headers; `x-powered-by` off.
- The audit log and decision history are append-only in code (update and delete paths throw). It records user, time, IP, user agent, before and after values, and on-behalf-of. Views of personal data, downloads and exports are audited.
- **Action:** give the application's MongoDB user a role that can only `insert` and `find` on `auditlogs` and `decisions` (see README).
- No secrets in git: `.env` is ignored, `.env.example` documents each variable, the seed password comes from `SEED_PASSWORD`, and sample data is fictional.

## Dependencies

- Backend `npm audit --omit=dev`: no known vulnerabilities (30 Oct 2026). SheetJS comes from the official CDN build 0.20.3, not the unmaintained npm package.
- Web app `npm audit --omit=dev`: two moderate advisories in React Router 6, fixed only in v7:
  - GHSA-337j-9hxr-rhxg (SSR hydration): does not apply; SLAS renders in the browser only.
  - GHSA-wrjc-x8rr-h8h6 (open redirect via a backslash in `<Link>`/`navigate`): mitigated. Every navigation to a data-driven path (notification links, return after sign-in) goes through `src/lib/safePath.js`, which allows in-app paths only (tested). Moving to React Router 7 is a follow-up (DECISIONS D-76).

## Deployment checklist (Action)

1. Serve the web app (`dist/`) and the API under one host name over HTTPS behind the reverse proxy, so the SameSite=Strict cookie works. Set `TRUST_PROXY` to the proxy's address.
2. Keep `COOKIE_SECURE=true` and `NODE_ENV=production` (this also hides `/api/v1/docs`).
3. Add these headers to the web app's responses at the proxy:
   `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
   `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.
   (MUI injects style tags, hence `'unsafe-inline'` for styles only.)
4. Generate `JWT_SECRET` and `MFA_ENC_KEY` per environment and keep them in the server's secret store; rotating `MFA_ENC_KEY` requires every MFA user to enrol again.
5. MongoDB: replica set with authentication and TLS, the append-only role above, and backups (the audit log is evidence).
6. Run one API instance, or several: every scheduled job is idempotent (DECISIONS D-22).
