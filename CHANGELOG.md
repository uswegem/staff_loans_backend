# Changelog

## 0.3.0 – Milestone 3: Staff records (29 Oct 2026)

- Own profile API in the prototype's sections (personal, bank, next of kin, pay and deductions with the confirmation tick); employment, salary and approval route shown read-only. Every save is audited.
- Completeness gate with a field catalogue and configurable mandatory fields (decision 7, FR-05). NIDA accepted with or without dashes and checked for a real date.
- Eligibility view per product: profile gate, the reapply cooling period and the days until a top-up (NS-02, NS-03), counting declared paper loans with a product and payout date.
- Route resolver for the four approval routes (BRD 7.3) and probation calculation (NS-01).
- Staff records for People and Culture: list, detail (view audited), create, edit, effective-dated salary history, inactive and exited status that signs the person out (FR-01, FR-03, FR-04).
- Excel bulk upload with SheetJS 0.20.3 (official CDN build): template with Instructions and Lists sheets; .xlsx, .xls and .csv; per-row checks; preview of new, updated, unchanged and error rows; error rows as Excel in template columns; transactional commit that re-checks rows (FR-02).

## 0.2.0 – Milestone 2: Products and pricing (29 Oct 2026)

- Products are data: Product plus versioned, effective-dated ProductVersion holding every FR-57 parameter, including the months before reapplying (NS-02). Nothing in src/ branches on a product (tested).
- Global pricing (interest, fees, insurance, affordability, pension, rounding, PAYE bands) as versioned PricingVersion, in basis points.
- Maker-checker engine shared by both: draft with validation and a field-by-field comparison with the live version, submit, take back, discard, approve, and reject with a reason. The checker must be someone other than every editor. One open change per chain. Every action is audited with before and after values (FR-58 to FR-63).
- Exact go-live: liveFrom is the later of the effective date and the approval time; versions resolve by date; the old version stays live until then; a scheduler keeps display states current. Deactivation follows the same flow and hides the product from new applications (FR-62).
- In-app notification service with a channel interface; checkers are notified on submit and editors on decisions (FR-59). Inbox endpoints.
- Seed: the four launch products (TZS 500,000 to 300,000,000) and launch pricing (6%, 1% / 0.5%, 0.60%, 50%).

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
