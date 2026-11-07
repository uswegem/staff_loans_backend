# SLAS UAT test matrix

Use synthetic test accounts only. The seed accounts below exist in a seeded test database
(`npm run seed`), all with the seed password. On a UAT database, create equivalent test staff
with the same roles.

| Account | Role(s) | Category |
|---|---|---|
| LFB0412 Neema Mushi | Staff | Non-management |
| LFB0377 Salma Hamisi | Staff | Non-management |
| LFB0010 Asha Mfinanga | Staff, Head of Credit | Management |
| LFB0233 Juma Kassim | Credit Analyst | Non-management |
| LFB0051 Grace Mollel | Head of People and Culture | Management |
| LFB0129 Upendo Massawe | P&C Manager | Non-management |
| LFB0002 Joseph Mwakalinga | CEO | Management |
| LFB0318 Halima Said | OPS | Non-management |
| LFB0274 Peter Lyimo | System Administrator | Non-management |
| LFB0067 Daniel Mrema | Head of Risk, Risk and Audit viewer | Management |

Priority: **P1** blocks UAT sign-off; **P2** must pass before go-live; **P3** desirable.
Record evidence as a screenshot plus the audit log entry (Audit trail screen) where one is
written. Fill in the Result column (Pass / Fail plus evidence reference) during execution.

## Authentication and session

| ID | Module | Scenario | Prerequisites | Steps | Expected result | Pri | Result |
|---|---|---|---|---|---|---|---|
| AUTH-01 | Sign-in | Staff signs in with a username | LFB0412 active | Enter `lfb0412` and the password, then Sign in | Home opens. No code is asked for (Staff role only). Audit entry "signed in". | P1 | |
| AUTH-02 | Sign-in | Wrong password | — | Enter a wrong password | "The username or password is not right" with the remaining attempts. Nothing reveals whether the username exists. | P1 | |
| AUTH-03 | Sign-in | Unknown username | — | Enter `nobody1` | Same message as AUTH-02, with no hint that the account does not exist. | P1 | |
| AUTH-04 | Lockout | Five wrong attempts | — | Enter a wrong password 5 times | Account locked screen. The System Administrator can unlock it. | P1 | |
| AUTH-05 | Sign-in | Username in capitals or with spaces | — | Enter ` LFB0412 ` | Signs in (usernames are not case-sensitive). | P2 | |
| AUTH-06 | Logout | Sign out | Signed in | Account menu, then Sign out | Returns to sign-in. Back button does not reopen pages. Other tabs sign out too. | P1 | |
| AUTH-07 | Session expiry | Inactivity | Signed in | Leave idle longer than the timeout setting | Signed out with the inactivity notice. | P1 | |
| AUTH-08 | Account switch | Two people, same browser | — | Sign in as LFB0412, sign out, sign in as LFB0377 | No draft or data from the first person appears. | P1 | |

## MFA

| ID | Module | Scenario | Prerequisites | Steps | Expected result | Pri | Result |
|---|---|---|---|---|---|---|---|
| MFA-01 | Enrolment | Privileged first sign-in | LFB0233 not enrolled | Sign in | QR code and setup key shown. Scan, enter the code, and the session opens. Audit entry "enrolled an authenticator app". | P1 | |
| MFA-02 | Verification | Enrolled privileged user | MFA-01 done | Sign out, sign in | A 6-digit code is asked for before any page opens. | P1 | |
| MFA-03 | Verification | Wrong code | MFA-01 done | Enter a wrong code | Refused with remaining attempts. Counts toward lockout. | P1 | |
| MFA-04 | Replay | Reuse a code | MFA-01 done | Sign in with a code, sign out, reuse the same code within 30 s | Refused. | P1 | |
| MFA-05 | Policy | Each privileged role | Accounts in the table above | Sign in as each reviewer, OPS, System Administrator and Head of Risk | Each is asked for a code or enrolment. | P1 | |
| MFA-06 | Step-up | Role granted mid-session | LFB0377 signed in | As LFB0274, give LFB0377 the Credit Analyst role. As LFB0377, open the review queue. | "Sign in again with your one-time code" is shown and no data opens. After signing in again, enrolment is asked for. | P1 | |
| MFA-07 | API bypass | Direct API call | Tester with an API tool | Call `/api/v1/review/queue` with a token from a session opened without a code | 403 `MFA_STEP_UP`. | P1 | |
| MFA-08 | Reset | Admin resets MFA | LFB0233 enrolled | As LFB0274, Users, then Reset MFA | The next sign-in asks for enrolment again. Audit entry written. | P2 | |
| MFA-09 | Report | Deployed MFA status | Server shell | `node scripts/mfa-report.js` | Every privileged account is listed with its enrolment status. No privileged sign-in without a code. | P1 | |

## Passwords

| ID | Module | Scenario | Prerequisites | Steps | Expected result | Pri | Result |
|---|---|---|---|---|---|---|---|
| PWD-01 | First sign-in | Temporary password | Admin issues a temporary password | Sign in | Only Change password opens. Other pages are blocked until it is changed. | P1 | |
| PWD-02 | Change | Policy enforced | PWD-01 | Try `password`, then the staff number, then a valid new password | Policy messages for the first two. The third is accepted and other sessions end. | P1 | |
| PWD-03 | Change | Passwords do not match | — | Different new and repeated passwords | "The two new passwords do not match." | P2 | |
| PWD-04 | Reset | Admin issues a temporary password | LFB0274 signed in | Users, then Issue temporary password | The user must change it at the next sign-in. MFA is still required for privileged users. Audit entry written. | P1 | |
| PWD-05 | Show/Hide | Each password field | — | On sign-in, change password (3 fields), application signing and revised-terms signing: type, click the eye, click it again | Hidden by default. The eye shows the text, then hides it. The value is unchanged. Each field toggles on its own. | P2 | |
| PWD-06 | Show/Hide | Keyboard and mobile | — | Tab to the eye and press Enter or Space. Repeat on a phone by tapping. | Same as PWD-05. The screen reader announces "Show password" or "Hide password". | P2 | |

## Staff and users

| ID | Module | Scenario | Prerequisites | Steps | Expected result | Pri | Result |
|---|---|---|---|---|---|---|---|
| STF-01 | Import | Template | People and Culture role | Staff, Import, then Download template | Columns include Username. Instructions list the required fields. | P2 | |
| STF-02 | Import | Valid file | Template filled with 3 test staff | Upload, preview, then Apply | Preview shows 3 new. After applying, the records exist with no login account. Audit entries written. | P1 | |
| STF-03 | Import | Errors | A file with a duplicate username, a missing surname and a bad staff number | Upload | Rows flagged with reasons. The error workbook downloads. Nothing is applied. | P1 | |
| STF-04 | Import | No permissions granted | STF-02 | Check Users | Imported staff have no account and no roles. | P1 | |
| STF-05 | Profile | Incomplete HR record | STF-02 | Open the staff record | Date joined, NIDA and date of birth are flagged as incomplete. An application is blocked with reasons. | P2 | |
| USR-01 | Users | Create an account | STF-02, LFB0274 | Users, Create, with a temporary password | Account created with the Staff role only. Must change the password at first sign-in. | P1 | |
| USR-02 | Roles | Assign a role | USR-01 | Assign Credit Analyst | Applies on the next request. MFA is needed (see MFA-06). | P1 | |
| USR-03 | Roles | Segregation of duties | — | Give one user System Administrator and CEO | Refused with the rule name. | P1 | |
| USR-04 | Users | Deactivate | USR-01 | Deactivate | The user's sessions end and sign-in is refused. | P1 | |

## Loans

| ID | Module | Scenario | Prerequisites | Steps | Expected result | Pri | Result |
|---|---|---|---|---|---|---|---|
| LN-01 | Application | Create a draft | LFB0412 complete profile | Apply, then choose a product | Draft saved. Product limits shown. | P1 | |
| LN-02 | Payslip | Upload | LN-01 | Attach a synthetic payslip PDF | Basic Pay and deductions read. Another person's payslip is refused. | P1 | |
| LN-03 | Affordability | Room | LN-02 with staff loan deductions | Enter an amount and tenor | Room = combined limit − payslip deductions − SLAS loans not yet on the payslip. Over-limit amounts blocked. | P1 | |
| LN-04 | Affordability | Retirement cutoff | Verified date of birth near retirement | Choose a long tenor | Refused with the cutoff and the longest tenor allowed. | P2 | |
| LN-05 | Sign and submit | Agreement | LN-03 | Review, enter the password, sign | Submitted. Agreement PDF available. Routed to the Credit Analyst. | P1 | |
| WF-01 | Non-management route | Full approval | LN-05 by LFB0412 | Credit Analyst, then Head of HR, then CEO approve; OPS confirms disbursement | Status moves through each stage. Notifications sent. Audit trail complete. | P1 | |
| WF-02 | Management route | Full approval | Application by LFB0010 | Credit Analyst (limited details), then Head of HR, then CEO; OPS confirms | The Credit Analyst sees only name, mobile and NIDA. Others see everything. | P1 | |
| WF-03 | CEO route | Own application | Application by LFB0002 | Credit Analyst (limited), then Head of HR; OPS confirms | No CEO stage. Nobody approves their own application. | P1 | |
| WF-04 | Head of P&C route | Own application | Application by LFB0051 | Credit Analyst (limited), then P&C Manager, then CEO; OPS confirms | P&C Manager replaces the Head of HR. | P1 | |
| WF-05 | Rejection | Reject at any stage | WF-01 in progress | Reject with a reason | Closed as rejected. Applicant notified with the reason. | P1 | |
| WF-06 | Return | Return for correction | WF-01 at the Credit Analyst | Return with a comment; applicant corrects and signs a new agreement | Back to the first stage. New agreement version. | P1 | |
| WF-07 | Delegation | Planned absence | LFB0233 delegates to a colleague | Delegate signs in and decides | Code required. Decision recorded "on behalf of". | P2 | |
| WF-08 | SLA | Overdue stage | Stage older than the target | Open the queue | Overdue flag. Reports show it outside the SLA. | P3 | |
| TU-01 | Top-up | Top up a running loan | Running SLAS loan on the payslip | Apply with top-up, choosing the payslip line | That line is not counted in Room. Top-up fee shown. On disbursement the old loan is marked replaced. | P1 | |
| DSB-01 | Disbursement | OPS confirms | WF-01 approved | OPS, then Disbursements, then Confirm | Disbursed. No approver can disburse (segregation of duties). Audit entry written. | P1 | |

## Cross-cutting

| ID | Module | Scenario | Prerequisites | Steps | Expected result | Pri | Result |
|---|---|---|---|---|---|---|---|
| SEC-01 | Access | Another person's application | Two applicants | Open another applicant's application URL or file link | "Not found". No data shown. | P1 | |
| SEC-02 | Access | Admin pages as Staff | LFB0412 | Browse to `/admin/...` and `/users` | Not shown in the menu. Direct URL is refused. | P1 | |
| SEC-03 | Upload | Disguised file | — | Upload a `.pdf` that is really an executable | Refused. | P1 | |
| NOT-01 | Notifications | Stage change | WF-01 | Watch the bell | The next approver and the applicant are notified. Limited-route notices carry no amounts. | P2 | |
| AUD-01 | Audit trail | Who did what | After WF-01 | Audit screen as LFB0067 | Every sign-in, decision, role change and import is listed with user, time and IP. | P1 | |
| RPT-01 | Reports | Each report and export | Data from the tests above | Open each report and export CSV, Excel and PDF | Totals match the screens. Limited rows stay limited in exports. | P2 | |
| UX-01 | Mobile | Phone width | — | Sign in, apply and review on a 390 px wide screen | No sideways scrolling. Buttons reachable. | P2 | |
| UX-02 | Language | Swahili | — | Switch EN/SW | All screens are translated. Your choice is remembered. | P3 | |
| BR-01 | Branding | Favicon | — | Open the site in Chrome, Edge and Safari, and add it to an iPhone home screen | The yellow triangle icon appears in the tab, bookmarks and home screen. | P3 | |
