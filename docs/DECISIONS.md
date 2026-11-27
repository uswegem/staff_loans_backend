# Decisions

Decisions cited in the code as `D-nnn`. Earlier decisions (up to D-104) are recorded in
the changelog, the BRD and the documents in this folder; this file starts with the
December 2026 release.

## D-105 – Several credit bureau report files, at least one to approve (Nov 2026)

The Credit Analyst attaches one or more bureau report files to an application
(`Application.crb.fileIds`; PDF, JPG or PNG; up to 10 MB each; at most 10 files). Each
`POST /review/:id/crb-report` adds a file; `DELETE /review/:id/crb-report/:fileId` removes
a file the same person attached, before the stage is decided. Approving at the credit
stage needs the outcome, the report date and at least one file; returning and rejecting
do not. Every file is listed for later reviewers and auditors. Adding and removing are
audited (`review.crb_report_add`, `review.crb_report_remove`). The single `crb.fileId`
kept before this decision still counts and is moved into the list by the upgrade.

## D-106 – Return to the applicant or to an earlier stage (Nov 2026)

A reviewer returning an application chooses where it goes: the applicant (as before) or
any earlier stage it has passed in the current cycle (`returnTo`; the web app proposes the
stage just before the current one). A comment is required. Returning to a stage sets the
stage, status and a new due date. Approvals from that stage on are cancelled: decisions
are append-only, so they stay in the history marked `superseded`, are not printed on the
in-force agreement, and no longer count for segregation of duties, so the same people
may approve again. History, audit and reports read "returned by <stage> to
<stage or the applicant>: <comment>".

## D-107 – People and Culture book the loan; OPS disburses (Nov 2026)

*The booking step in SLAS is superseded by D-112: booking now happens outside SLAS.*

After final approval a loan is Pending Booking. Holders of `loan.book` (added to the
P&C Manager and Head of P&C system roles) record the core banking loan account number,
the booking date (not in the future, not before final approval) and an optional note;
the loan then goes to OPS as Pending Disbursement. Both teams see the whole queue
(`GET /disbursements`, tabs booking, ready, done) and each acts only on its own step.
Segregation of duties: the person who booked a loan cannot confirm its disbursement,
nobody books or disburses their own loan, and the rule `sod4` keeps `loan.book` and
`disb.confirm` apart on roles. The waiting time (Outside SLA) still counts from final
approval. The upgrade sends finally approved loans not yet booked to Pending Booking.

## D-108 – Data protection notice before signing (Nov 2026)

The agreement step shows the Legal-approved data protection notice with its own
unticked box; signing is refused until it is ticked (`dataProtection: true`). The
notice is kept in a versioned store (`LegalNotice`, key `data_protection`, first version
DP-2026-1) in English and Swahili, approved like agreement templates. The application
keeps `consents.dataProtection { accepted, version, language, at }`; the notice and the
acceptance time are printed after the agreement in the signed and in-force PDFs, and the
acceptance is in the audit log. The notice is shown in the agreement's language.

## D-109 – One language at a time (Nov 2026)

Every message the API shows people has an English and a Swahili entry with a stable code
(`src/i18n/sw.js`: code, English, Swahili). Responses with a message carry
`messageCode` and `messageParams`; notifications are stored as code and params and
rendered in the reader's language when read. A message without a Swahili entry is
logged as `i18n.missing` (never silent); `tests/unit/i18nCoverage.test.js` fails CI when
an API message has no Swahili entry or an entry lacks a language, and the web app has the
same check for its interface text. Free text is shown as typed.

Each product holds its agreement in each language (`agreementTemplateId`,
`agreementTemplateSwId`). The applicant reads, signs and keeps the agreement in their
language; until the Head of Legal approves the Swahili agreement, the English one is
shown with a one-line Swahili note. An agreement never mixes languages: the evidence,
approvals, title and page footer of its PDFs, and the data protection notice, are in the
language signed, saved as `Application.agreementLanguage` and `Agreement.language`.
The interface language stays saved on the account (D-94).

## D-110 – The agreement as a numbered contract; the schedule on request (Nov 2026)

New agreements are laid out as a contract on the LFB letterhead (logo top left, the bank's
legal name and address top right, a yellow rule; a small logo and "Staff Loan Agreement" on
later pages; a footer with the agreement number, application reference and "Page X of Y",
in the agreement's language only). The PDF embeds Source Sans 3 (OFL) instead of Helvetica,
so Swahili and any name print as written; A4, 20 mm margins, 10 pt body, numbers in their own
column, a heading never left alone at the bottom of a page, and no single line left alone.
The logo is stored at assets/agreement/lfb-logo.png; a System Administrator may replace it
under Settings (audited).

Templates number themselves: "## Heading" is a numbered section, "+ " a numbered clause,
"(a) " a lettered sub-clause, "##* Heading" an unnumbered section and "| Label | Value" a
Loan Details row. Cross-references use labels ({#salary-deduction}, {{ref:salary-deduction}}
prints "clause 4.2"), so renumbering never breaks them; an unknown or repeated label is
refused. The canonical text of a numbered agreement (format 2) carries its numbers, sections
and Loan Details table, so the fingerprint covers the structure; the blocks are stored with
the agreement and the PDF is rebuilt from them.

The repayment schedule is no longer part of the agreement: templates may not contain
{{schedule}}, and a clause says the schedule is available on request. Operations
(disb.confirm) and the Credit department (review.credit, products.approveCredit) download it
for an approved or disbursed loan (`GET /applications/:id/repayment-schedule.pdf`), in the
language of the signed agreement, with the letterhead, a table whose header repeats on every
page and a totals row; the applicant cannot download it, and every download is audited.

Agreements signed before keep their text, fingerprint and schedule; legacy templates render
as before, without the schedule, until Legal approves the numbered versions (2026.12e
personal, 2026.12f car, loaded by `npm run agreements:load -- --approved-by <username>`).

## D-111 – A payslip is at most 30 days old (Nov 2026)

The payslip attached to an application may be at most 30 days old, counted from its pay
date, when it is attached and again at submission. 30 days is the default and the ceiling:
Settings may set a shorter limit but not a longer one, and a longer value stored before this
decision (the earlier default was 45 days) counts as 30 and is lowered by
`npm run upgrade:2026-12`.

## D-112 – One Disbursement queue after final approval (Nov 2026)

Supersedes the booking step of D-107. People and Culture book the loan in the loan
management system outside SLAS, so nobody enters booking details here.

**Flow.** Final approval, and acceptance of revised terms, set Pending Disbursement
directly. Pending Booking, `POST /disbursements/:id/book`, the To book tab and the booking
form are gone. `npm run upgrade:2026-12b` (dry run by default, `--apply` to change) moves
any loan still in Pending Booking to Pending Disbursement, keeps the date of final approval
(stageEnteredAt), and audits each move as `application.status_migrated` ("booking step
removed, D-112"). It is safe to run again. Bookings recorded before this decision stay on
the loans and are shown read-only. The status name stays only for old data and audit history.
The booking part of `upgrade-2026-12` was taken out before the release.

**Who.** The queue is called Disbursement (Swahili "Malipo ya Mkopo") and has two tabs,
Ready to disburse and Disbursed. It is open to holders of `disb.confirm`: OPS, the Head of
People and Culture and the P&C Manager. The two People and Culture system roles get
`disb.confirm` (also by the upgrade, audited as `role.update`), and `loan.book` is removed
from the roles and from the permission catalogue. Everyone with `disb.confirm` is told when
a loan has final approval. Route descriptions end "then Disbursement (People and Culture or
OPS)".

**Separation of duties.** The role rule "approving is kept apart from confirming
disbursement" (sod2) no longer counts the two People and Culture review permissions
(`review.pcm`, `review.hr`), so their roles may hold `disb.confirm`. It still applies to
Credit and the CEO stage, including through delegation. Instead, on each loan, nobody marks
as disbursed: their own loan; a loan they approved, themselves or as a delegate; or one
approved on their behalf. The message names the reason and says "Another People and Culture
or OPS officer marks it as disbursed." The rule "you booked this loan" and sod4 are gone.

**Papers.** For loans in Pending Disbursement or Disbursed, anyone with `disb.confirm`
downloads:

- the Agreement (`GET /agreements/:id/pdf`): the in-force PDF, else the signed one, in its
  language, named "<agreement number>.pdf";
- the Loan Summary (`GET /disbursements/:id/summary.pdf`): one page on the letterhead in the
  agreement's language. It has the reference, agreement number, product, status, final
  approval (when, by whom); the staff member and the account to credit; the approved terms
  and payslip deduction label; any top-up (loan cleared, settlement, net to credit); the
  approval trail without comments; the disbursement once done. The footer reads "Generated
  by <user> on <date/time>" with the page number. It has no schedule (on request, D-110),
  no bureau report and no payslip figures.

Both downloads are audited (`agreement.download`, `summary.download`) with the application
reference and the language. The applicant is refused the Loan Summary (403 `OWN_LOAN`), and
the web app shows no download buttons on their own loan. They keep their own agreement under
My applications (FR-25).

**Mark as disbursed.** Available in Ready to disburse, subject to the rules above:

- Date: required, not in the future, not before final approval.
- Transaction reference: letters, digits, / and - only, at most 40 characters, unique across
  loans ignoring case (409 `DUPLICATE_TRANSACTION_REF`, "This reference is already
  recorded on <ref>.").
- Comment: 5 to 1000 characters ("Add a comment for the disbursement record.").
- The checklist and top-up settlement stay.

The loan becomes Disbursed, the disbursement is saved, and the schedule is regenerated from
its date. The applicant is told. The audit entry `loan.disbursed` carries the reference and
comment. The record is read-only, and the Disbursed register and its CSV include the comment.

## D-113 – Credit Underwriting (Nov 2026)

The credit stage, formerly named after the Credit Analyst, is **Credit Underwriting**
(Swahili "Tathmini ya Mikopo"); its status reads "Pending Credit Underwriting". The stage
key (`credit`), the status code (`pending_credit`) and the permission (`review.credit`) do
not change, so stored applications, decisions and notifications are untouched.

Three system roles hold `review.credit` and so see Credit Underwriting in the Review queue
and decide there (bureau reports, approve, return, reject), each with the identity-only view
of D-86:

- Credit Analyst (as before);
- Credit Manager (new role, the same permissions as the Credit Analyst);
- Head of Credit, who keeps product preparation and first product approval.

The Head of Credit's combination would breach sod1 (administration or product checking kept
apart from approving loans). The business accepted it: sod1 now lets through exactly
`products.make` and `products.approveCredit` with `review.credit`, and nothing wider. Any
other administration or checking permission (for example `products.approveRisk`,
`admin.users`) with `review.credit`, or those product permissions with any other approval
or with disbursement, still breaches sod1. The rule that nobody decides two stages of one
application is unchanged. Because the Head of Credit now holds `review.credit` without a
full-review permission, reports show them the identity-only rows as for the Credit Analyst.

`npm run upgrade:2026-12c` (dry run by default, `--apply` to change) adds `review.credit`
and `review.delegate` to an existing Head of Credit role and creates the Credit Manager role
if missing, each change audited; it is safe to run again. People still need the Credit
Manager role assigned under Users and roles.

### D-113 (continued) – Credit Underwriting recommends; People and Culture or the CEO decides

Credit Underwriting no longer approves or rejects. At the credit stage the actions are
**return** (to the applicant, reason required, as before), **recommend approval** and
**recommend rejection**. The later stages on every route (People and Culture, the Head of
P&C, the CEO) keep approve, return and reject. The server enforces this whoever acts,
delegates included: any other action is 403 `NOT_ALLOWED_AT_STAGE` ("Credit Underwriting
recommends; People and Culture or the CEO decides.").

- **Recommend approval**: the bureau outcome and report date, at least one report file
  (D-105), and the eligibility checks of an approval (retirement cutoff, combined loan
  limit). A failed check is 409 "This application cannot be recommended for approval: <reason>.
  Recommend rejection or return it." (a generic reason: Credit Underwriting sees identity
  only). Comment optional.
- **Recommend rejection**: the bureau outcome, date and file; a reason of 10 to 1000
  characters. Eligibility does not block it.

Either recommendation moves the application to the next stage, open and signed, exactly as a
Credit approval did. It is stored as `creditRecommendation` (outcome, reason, bureau outcome,
by, on behalf of, when, cycle; the latest only, so a return to Credit and a new
recommendation replace it), as a Decision `recommend_approval` or `recommend_rejection`, and
audited as `application.recommended`.

The deciding stages see the recommendation (who, when, reason, bureau result) and the
history. Approving after a recommended rejection, or rejecting after a recommended approval,
needs a reason of at least 10 characters (400 `COMMENT_REQUIRED_AGAINST_RECOMMENDATION`) from
every deciding stage that does so; the decision is marked `againstRecommendation` and the
audit description says "against Credit's recommendation". Approving still runs the
eligibility checks.

The applicant is never shown or told the recommendation: their history shows the credit
row as "reviewed" with no outcome or reason, and notifications only say where the
application moved. The agreement's list of employer approvals (FR-36) holds the deciding
stages only, not the recommendation.

The approval trail (review history, Loan Summary PDF) names "Recommended approval" or
"Recommended rejection" and marks decisions against it. The application register and its CSV
gain "Credit recommendation" and "Final decision against recommendation (Yes/No)".

No migration: applications waiting at Credit get the new actions; an earlier Credit approval
stays "Approved" in the history, has no `creditRecommendation`, and the deciding stages then
show no recommendation and need no "against" reason.

## D-114 – An uploaded date of birth needs no verification (Nov 2026)

Changes D-82 and D-100 for the staff upload only. A date of birth in a People and Culture
staff upload (`staff.manage`) is stored as the verified date of birth when the upload is
applied, with no verification step, and is used at once for the retirement cutoff and loan
eligibility. It is recorded as an approved DobChange (source `staff_upload`, submitted and
decided by the uploader) and audited as `dob.upload`; the commit no longer notifies the
verifiers. A date of birth waiting for verification for that staff member is withdrawn
("Replaced by a People and Culture staff upload.") and the uploaded one takes its place.

Dates of birth entered by a staff member in their profile, or by People and Culture on a
single staff record, still go to Date of birth checks and are verified by someone else
(D-82). The backend staff loader (`npm run staff:load`) has no date-of-birth column and sets
none.

## D-115 – Loan data is kept for ten years after the loan ends (Nov 2026)

Every application, its documents and its record are kept for ten years from the day the loan
ends, then the uploaded files are deleted and the record is anonymised. The loan ends:

- rejected, withdrawn or declined: on the day it was closed;
- disbursed: on the last repayment due date in its schedule, or on the day a top-up settled it;
- any other status (still open): never; nothing is purged while an application is open.

When the ten years are over (`npm run retention -- --apply`, or the nightly `retention-purge`
job) the uploaded files of the application are deleted from `UPLOAD_DIR`. The application keeps
its reference, product, amounts, dates, statuses and decisions for statistics, and its
department, station and category for reports. The applicant's link, names, NIDA, mobile,
payslip figures, bank details, purpose, comments and reasons, the agreement text and its
acceptance details, and the application's notifications are removed. Decisions keep their
action and date, without comment or IP address. The audit log is kept unchanged. Each purge
is audited (`retention.purge`). A purged application is no longer found in the app; reports
show it as "Anonymised".

A legal hold (`npm run retention -- --hold <ref> --reason "<text>" --by <user>`, released with
`--release`) stops the purge of one application until released; both are audited. Staff upload
files older than ten years are deleted too.

`RETENTION_YEARS` cannot be set below ten. `RETENTION_PURGE_ENABLED=false` stops the nightly
job (the script still works). Staff records of people who have left and the audit log are not
purged; the data protection notice wording ("kept for as long as the law requires") is
unchanged.
