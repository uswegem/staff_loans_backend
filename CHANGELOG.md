# Changelog

## Unreleased

- Cancelling a draft that was never submitted no longer returns a server error, and the withdrawn application can be opened again: it falls back to the pricing in force because pricing is pinned only at signing.

## 0.12.0 – Profile formats, address, language and theme (2 Nov 2026)

- Phone numbers stored as +255 and nine digits; NIDA stored with hyphens; nationality from a country list (`GET /reference-data/countries`) (D-93).
- Region → District → Ward list copied from MMS (`LocationRegion`, `seed/referenceData.js`), served by `GET /reference-data/regions…` and checked on save; P.O. Box and free-text residence no longer asked for or counted; `{{residence}}` uses the structured address (D-93).
- Completeness returns the required keys; a stored value in the wrong format counts as missing. Branch and account number checks.
- `npm run upgrade` loads the location list and normalises existing values (`scripts/profile-formats.js`, `--fix-phone`).
- Swahili API messages for `Accept-Language: sw`; notifications shown in the reader's language; `PATCH /auth/preferences` saves language and theme (D-94).
- `npm run staff:load` adds staff without deleting anything (D-95). RP-05 is "Report Filter".
- A missing salary blocks applying; `GET /me/eligibility` returns `blockers` and `GET /me/profile` returns `applyBlockers` (unverified date of birth, employment record, salary) (D-97).
- The retirement date is worked out from the verified date of birth and is no longer taken by the staff form, the API or the Excel upload; the template example row lines up with its headings again (D-98).

## 0.11.0 – Salary deduction, combined cap, Legal and product approvals (2 Nov 2026)

- Every loan is repaid by salary deduction; account debit, required and optional documents and disbursement conditions are removed from products (dropped from the schema), applications, disbursement and reports (D-84).
- Payslip: "Staff Code in the Payslip doesn't match your staff number, upload correct Pay Slip"; PDF only; refused at upload when older than 45 days.
- First Name and Surname for staff and next of kin; `scripts/split-names.js` splits existing names and logs those it cannot (D-85).
- The Credit Analyst gets only first name, surname, NIDA number and mobile on every route, in every response and notification; recommendations are refused (D-86).
- One combined 50% cap on Net Pay across all Staff Loans loans, approved-not-disbursed included, with top-up add-back and a payslip mismatch flag; re-checked at every approval and before disbursement; a top-up draft can start at the product's concurrent limit (D-87).
- Agreement templates: Legal Officer uploads and edits, Head of Legal approves or rejects with a reason; no self-approval; only approved versions are used; editing an approved one makes a new version (D-88).
- Products and pricing: Draft → Head of Credit → Head of Risk and Compliance → Published; rejection returns to Draft with the reason (D-89). New system roles (D-90). Gender on staff records; employment type and date joined optional (D-91).
- Seeders hold system data only; demo products and applications moved to `tests/fixtures`; `npm run reset:staff` loads the staff table with roles and a forced password change; `npm run upgrade` (D-92).
- Tests use secure cookies whatever the local `.env` says.

## 0.10.0 – Date of birth verification and retirement cutoff (2 Nov 2026)

- Date of birth changes wait for People and Culture (`DobChange`, permission `staff.verifyDob`): queue, approve, reject with a reason, withdraw by the submitter; no self-verification; audited and notified (D-82).
- Retirement cutoff = verified date of birth + 60 years − 60 days (settings `retirementAge`, `retirementBufferDays`); the tenor is capped by the instalments that fit before it, affordability uses the capped tenor, and a longer tenor is refused with the cutoff and the maximum. Re-checked at every approval and when revised terms are accepted.
- No verified date of birth, or no room before the cutoff: not eligible, with the reason. Settings `dobMinAge` and `dobMaxAge` check entered dates.
- Deployment script `scripts/dob-verification-setup.js`. Loan rules no longer use the typed retirement date (D-83).

## 0.9.1 – Staff numbers are employee codes (1 Nov 2026)

- Staff numbers follow Payroll's employee codes (for example AT637), one rule for sign-in, users, staff records and the Excel upload (C-07, D-81).
- The payslip must show the applicant's staff number as a whole code; the name alone is not enough.
- C-06 confirmed: LFB deductions raise the limit.

## 0.9.0 – Affordability from the payslip (31 Oct 2026)

- New affordability method (DECISIONS A-01 to A-05, D-78): Pension 10% of Basic Pay; PAYE on Basic Pay less Pension; Net Pay = Basic Pay − Pension − PAYE; Adjusted Net Pay = Net Pay + LFB deductions; Maximum Instalment = 50%. Medical aid, other deductions, other-bank loans and commission no longer count.
- Maximum amount by reverse calculation over the longest allowed tenor, capped at the product maximum; the salary multiple is dropped from products and rules.
- Latest payslip required on every application (`POST /applications/{id}/payslip`, PDF only): Basic Pay, LFB deductions and the pay date are read with PDF.js 6.4.299; the payslip must name the applicant and be at most 45 days old (setting). Labels are settings, so a new payroll layout needs no code change (D-79).
- Reviewers see the payslip and its figures; a Basic Pay that differs from the staff record is flagged.
- Profile Pay tab keeps only existing staff loans (D-80). Seeds attach fictional payslips. `npm test` runs Jest with `--experimental-vm-modules` for PDF.js.

## 0.8.0 – Milestone 8: Hardening (30 Oct 2026)

- E2E API (`scripts/e2e-server.js`): in-memory replica set with the sample data, for the Playwright runs in the web app repo.
- Route guard test: every route must validate input and check a permission, or be on the reviewed self-service list.
- Security review with the go-live checklist (SECURITY.md); README troubleshooting and scheduled jobs.
- Jest test time limit raised to 60 s for slower machines.

## 0.7.0 – Milestone 7: Reports, admin screens and exports (30 Oct 2026)

- Reports RP-01 to RP-07 and RP-10 with filters (dates, product, department, branch, category, status, grouping) and an overview for the dashboard.
- Exports to CSV, Excel and PDF from the same builder as the screen; formula-safe; every export audited.
- FR-55 in every report and export: Credit-only viewers get name only for management-route applications, and filters on hidden fields leave them out; tested across screen, CSV and Excel.
- Agreement template versions: list, preview with a fictional applicant, load after Legal approval with a start date (FR-40).
- Workflow settings return the four routes; dates in report filters are checked as real dates.

## 0.6.0 – Milestone 6: Disbursement and notifications (30 Oct 2026)

- OPS disbursement API (FR-20 to FR-22): ready and disbursed queues, loan summary for recovery set-up, confirmation with date, optional reference, mandatory comment, product checklist and top-up settlement; regenerates the schedule from the disbursement date (FR-21, FR-24); a decision, an audit entry and an applicant notification.
- SoD: OPS cannot confirm their own loan or one they approved, directly or through a delegate (FR-48).
- Outside SLA flag for loans waiting longer than approvalSlaDays; nothing expires (Q3).
- Disbursed loans register as CSV, safe against formula injection and audited (FR-26).
- Remaining BRD 12 notifications: stage overdue (reviewer and delegate, once per stage), profile incomplete, disbursement confirmed; first-stage notices go to a delegate in place of an absent holder.
- Applicant view returns the schedule and disbursement details (FR-25); OPS can open agreements and documents, not the bureau report.
- Seeds the disbursed sample SL-2026-00015.

## 0.5.0 – Milestone 5: Review (30 Oct 2026)

- Workflow: each stage goes to every active holder of its review permission except the applicant (FR-47); delegates act on the holder's behalf (FR-19). Queue with waiting, overdue (working hours) and handled tabs (FR-13).
- FR-55 projector: on the management, CEO and Head of P&C routes a Credit-only viewer gets an allow-list of name, mobile and NIDA in the queue, review screen and decision response; documents, agreements and files are refused. Tested by scanning every response as the Credit Analyst.
- Decisions with the prototype's checks: comment to return or reject, bureau outcome and optional report (FR-42), recommendations that only lower terms and pass affordability (FR-16, BR-11), the three staff-record checks and probation verification (FR-17, NS-01), arrears comments (BR-10). Concurrent decisions are refused.
- Final approval per route (FR-56): agreement in force with a PDF listing the approvers (FR-36), schedule regenerated (FR-24), reapply wait started (NS-02), OPS notified; or Revised Terms to Accept with accept (new agreement), decline and expiry (FR-38, FR-39, FR-54).
- Delegation with SoD checks; decisions need an MFA-verified session, including a delegate's.
- Seeds the prototype's sample applications on an empty system.

## 0.4.0 – Milestone 4: Apply (29 Oct 2026)

- One pure loan calculator (BRD 10, BR-14, BR-15) in integer shillings and basis points, tested against the prototype worked example; the web app uses a generated copy (npm run calc:sync, calc:check).
- Application rules: BR-01 to BR-09 and BR-12 with the prototype's messages, product fields, probation applications with a reason (NS-01) and the reapply wait (NS-02).
- Application API: drafts, live checks and quote, documents (PDF, JPG, PNG checked by content; size limit setting; malware-scan hook), withdraw.
- Agreement: versioned Swahili template (2026.11 sample), renderer with filled values, amounts in Swahili words, Jedwali schedule, SHA-256 of the exact text.
- Sign and submit is the only way to submit: consents, acceptance, read to the end, password and the text fingerprint; stores the evidence, locks a PDF with an evidence page, pins versions, snapshots salary, fixes the route and enters the first stage with notifications (prompt 4.3).
- Append-only decision history per application.

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
