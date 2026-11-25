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
