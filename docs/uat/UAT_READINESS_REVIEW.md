# SLAS UAT readiness review

Date: 7 November 2026. Scope: `staff_loans_backend` and `staff_loans_frontend` at `main`
(backend `993cb7d`, frontend `157dba5`), plus the fixes on the branches listed in section 6.
Test accounts named here are the synthetic seed accounts (`seed/data/people.js`); no real
staff data is used.

## 1. MFA root cause analysis

### What was reported
After deployment, a sign-in completed without asking for an authenticator code.

### What the code does
MFA is required by **permission, not by job title** (FR-49, `src/constants/permissions.js`
`MFA_KINDS`): anyone holding a permission of kind `approve`, `disburse`, `admin` or `check`
(every reviewer, OPS, the System Administrator, product checkers), and anyone who is an active
review delegate. Staff who hold only the Staff role (`loan.apply`, `loan.viewOwn`) sign in with
a password alone. This is the approved policy and was not changed.

| Step | Where | Behaviour verified |
|---|---|---|
| Password check, then MFA decision | `authController.login` | Privileged users get `mfaRequired` (enrolled) or `enrolRequired` (not enrolled) and an MFA token. No access token or cookie is issued. |
| Enrolment | `mfaEnrolStart`, `mfaEnrolConfirm` | The secret is AES-encrypted (`MFA_ENC_KEY`) and confirmed with a code before a session opens. |
| Code check | `mfaVerify` | TOTP check with replay protection (`lastUsedStep`). Wrong codes count toward lockout. Rate-limited by `signInLimiter`. |
| Session | `Session.mfaVerified` | Set only by the two MFA endpoints. |
| Every privileged API call | `middleware/permission.js` | Refuses a session without `mfaVerified` with `403 MFA_STEP_UP`, even if the role was granted after sign-in. |
| Review decisions | `reviewController` | Same check, which also covers delegates. |
| Token refresh | `authController.refresh` | Renews the session but cannot set `mfaVerified`, so privileged calls stay refused. |
| Frontend | `SignIn.jsx` | Shows the code step or the enrolment step from the API response. |

Commit `a70aba8` (username sign-in) changed only how the account is looked up
(`User.findOne({ userName })`). The MFA decision that follows it is unchanged. **No code path
lets a privileged user reach a privileged function without a code.**

Evidence (local environment, 7 November 2026):
- In the audit log, every privileged sign-in (35) was "signed in with MFA". Sign-ins without a
  code were by Staff-only accounts.
- A privileged account received `mfaRequired` from the API after the username change.
- New regression suite `tests/integration/mfaStepUp.test.js` (7 tests, all passing):
  - username sign-in, including upper-case or padded usernames, never returns a token to a
    privileged user;
  - an MFA token is refused as an access token;
  - a role granted mid-session stays blocked before and after a refresh;
  - signing in again after the grant forces enrolment;
  - an administrator's password reset keeps MFA.
- The existing suites `auth.test.js`, `rbac.test.js` and `review.test.js` also cover MFA, and
  all pass.

### Most likely cause on the deployed environment
I had no access to the deployed server or its database, so this must be confirmed there. The
code points to one of these:

1. **The account used holds only the Staff role.** Accounts created in bulk or by the System
   Administrator start with the Staff role only (by design: importing a staff record grants no
   permissions). Such an account correctly gets no code request until a privileged role is
   assigned.
2. **The privileged role was assigned after that sign-in.** The session then shows
   privileged menus, but every privileged action answers `MFA_STEP_UP` until the user signs in
   again, and that next sign-in asks for enrolment or a code.
3. **The deployed build is not the reviewed code.** GitHub has no deployment records, so
   compare the deployed commit with `main` (section 7).

**Confirm with:** `node scripts/mfa-report.js --days 7` on the deployed API server (new,
read-only). It lists:
- every account that needs MFA and whether it has enrolled;
- accounts without a username;
- every sign-in without a code in the period, flagging any by a privileged account.

If the account you used appears under `mfaRequired` and has a recent sign-in without a code,
send me the output, because that would be a defect this review did not reproduce.

### Security impact
On the reviewed code: none found. Privileged data and actions are protected by the API, not
only by the screens.

Until the deployed environment is confirmed, apply this temporary safeguard: run the report
above, then assign privileged roles before UAT users first sign in, or ask them to sign out and
in again after a role change.

## 2. Code review findings

| # | Severity | Area / file | Finding | Impact | Correction | Status |
|---|---|---|---|---|---|---|
| 1 | Medium | `middleware/csrf.js` | `POST /auth/refresh` from a signed-out browser (every page load before sign-in) was logged as `security.csrf_rejected`, 169 times locally. | Security monitoring is flooded with false alarms, hiding real CSRF attempts. | Skip the CSRF check when there is no refresh cookie. There is no session to act on, so refresh answers `401 NO_REFRESH` and logout only clears cookies. | **Fixed**, test added |
| 2 | Medium | Requirements vs code | Your UAT brief describes the management route as Head of HR → CEO → OPS. The code and the BRD (v0.5 and later, §7.2, decision D-86) send management staff through the Credit Analyst first, with limited details. | UAT testers could log a correct behaviour as a defect. | No code change. Confirm the BRD route is the approved one before UAT. | **Needs your decision** |
| 3 | Medium | Frontend `api/client.js` | `403 MFA_STEP_UP` (role granted mid-session) shows the API message as an error banner on the page. It does not offer to sign in again. | Usability: the tester must sign out manually. Security is unaffected because the API refuses the action. | Treat `MFA_STEP_UP` like an ended session and route to sign-in with a notice. | Recommended |
| 4 | Medium | UAT data | Three privileged accounts in the local database have not enrolled an authenticator yet. One account holds both the Head of People and Culture and the P&C Manager review roles. | The first sign-in asks for enrolment, which is expected. Holding two review roles in one person blurs the Head of P&C route. | Check roles with the report and the User access report before UAT. | Recommended |
| 5 | Low | Frontend `react-router-dom` 6.x | Moderate advisories (GHSA-wrjc-x8rr-h8h6 open redirect, GHSA-337j-9hxr-rhxg SSR only). | Mitigated: `lib/safePath.js` refuses backslashes, `//` and spaces. The SSR issue does not apply (client-only app). | Plan the React Router 7 upgrade after UAT. | Accepted for UAT |
| 6 | Low | Backend `swagger-jsdoc` → `glob`/`minimatch` | Moderate advisories in the API-docs generator. | The API docs are not served in production (`app.js`), so these only affect development. | Upgrade with the docs tooling. | Accepted for UAT |
| 7 | Low | Password screens | The change-password, signing and revised-terms password fields could not be revealed. | Users mistype new passwords, which leads to IT Service Desk calls. | Shared `PasswordField` with an eye button. | **Fixed**, tests added |
| 8 | Low | Branding | The tab icon was a 498×78 wordmark, unreadable at 16px. There was no manifest or Apple touch icon. | Unprofessional tab icon. | New icon set from the supplied logo. | **Fixed**, test added |
| 9 | Low | Test stability | Under heavy machine load, one full-suite run (backend or frontend) can fail on timeouts. Rerunning the suite alone passes. | Noisy CI. | Run suites one at a time in CI (already the case), and raise timeouts for PDF-heavy suites. | Recommended |

Reviewed and found sound, with no change needed:
- **Authentication:** lockout and admin unlock; rotating refresh tokens with reuse detection;
  httpOnly, Secure, SameSite=Strict cookies; access tokens last 15 minutes.
- **Sessions:** inactivity timeout enforced on the server, and the user and staff status are
  re-checked on every request.
- **Authorisation:** permissions resolved per request and never cached in the token;
  segregation-of-duties rules sod1–sod3 apply to role changes.
- **Limited details:** the Credit Analyst view is limited by one server-side projector (D-57,
  D-86).
- **Uploads:** checked by file content (`fileStore.sniff`), not only the extension, with size
  limits. Files are served only to their owner or to authorised reviewers.
- **Staff import:** creates staff records only. Login accounts are created separately by the
  System Administrator, with the Staff role and a temporary password that must be changed.
  Usernames are unique on both the Staff and User records.
- **Data integrity:** imports, decisions and disbursement run in transactions. The import
  commit re-checks every row. Audit entries are written in the same transaction.
- **Secrets:** no secret has ever been committed. The `MFA_ENC_KEY` format is validated at
  start-up. The API docs are disabled in production.
- **Approval routes** (`services/workflow/routes.js`), which match BRD §7:
  - non-management: Credit Analyst → Head of HR → CEO → OPS;
  - management: Credit Analyst (limited) → Head of HR → CEO → OPS;
  - CEO: Credit Analyst (limited) → Head of HR → OPS;
  - Head of People and Culture: Credit Analyst (limited) → P&C Manager → CEO → OPS.

## 3. Implemented changes

| Repository | Branch | Change |
|---|---|---|
| backend | `fix/uat-readiness-mfa-audit` | MFA regression tests, `scripts/mfa-report.js`, CSRF false-alarm fix, these UAT documents |
| frontend | `feature/uat-password-visibility-favicon` | Show/hide password on every password field; favicon set, manifest and theme colour |

## 4. UAT test matrix

See [UAT_TEST_MATRIX.md](UAT_TEST_MATRIX.md).

## 5. Readiness decision: **conditionally ready for UAT**

The application is functionally complete for the UAT scope, and its security controls hold
when tested directly against the API. Start UAT once these conditions are met:

1. **Confirm MFA on the deployed environment.** Run `scripts/mfa-report.js` there and check
   that the reported sign-in account and every UAT approver appear as expected.
2. **Approve the management route** (finding 2): the BRD route through the Credit Analyst,
   or a change request.
3. **Deploy and smoke test the two branches** (section 7).
4. **Prepare UAT accounts:**
   - use synthetic or designated test staff;
   - give each tester exactly one review role;
   - enrol authenticators on first sign-in.

## 6. Change summary

Commit hashes, draft PR links and test results are listed in the draft pull requests.

## 7. Deployment guidance (do not deploy without approval)

1. **Find out what is deployed:** `git rev-parse HEAD` in each deployed checkout. Compare it
   with `main` and with the two branches above.
2. **Configuration:** no new environment variables. Check these existing ones:
   - `MFA_ENC_KEY` (64 hex characters, the same value as before, or every enrolment breaks);
   - `COOKIE_SECURE=true` behind HTTPS;
   - `CORS_ORIGIN` set to the web address;
   - `TRUST_PROXY` set for the reverse proxy;
   - `NODE_ENV=production`.
3. **Order:** deploy the backend first (it is backward compatible), then the frontend. Clear
   the CDN or browser cache for `index.html` so the new icons appear.
4. **Smoke tests:**
   1. `GET /api/v1/health` returns ok.
   2. A Staff-only account signs in without a code and is asked to change a temporary password.
   3. A privileged account is asked for enrolment or a code.
   4. Every password field shows and hides its value with the eye button.
   5. The browser tab shows the new icon.
   6. `scripts/mfa-report.js` runs.
5. **Rollback:** redeploy the previous commit of each repository. No database migration is
   involved, so no data rollback is needed.
