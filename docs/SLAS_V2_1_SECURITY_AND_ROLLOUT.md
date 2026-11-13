# SLAS v2.1 security and rollout review

## Scope
This feature branch changes upload storage, required-document validation, staff name/import handling, approval MFA policy and application submission. The frontend branch must be deployed in lockstep after review.

## Antivirus removal — residual risk
New uploads are no longer scanned by ClamAV. PDF/JPG/PNG magic-byte allowlisting, random non-web-root storage and authorization on downloads remain, but **none is malware detection**. Before production approval, Security should accept the residual risk, validate offline document-handling procedures, and consider isolated viewing and endpoint protection. Historical `StoredFile.scan` values are retained for backward compatibility and are not interpreted as proof of safety for new uploads.

## MFA policy
Approval-only actions are exempt from MFA; disbursement, administrative and checker permissions still require MFA. Authorization, segregation of duties and audit logging remain mandatory. Security must approve this reduced assurance before deployment.

## Staff import
The staff template includes an optional middle name; missing HR fields remain incomplete. No user accounts are provisioned by staff import. Source workbooks without staff numbers and usernames cannot be committed as authoritative staff records. Never infer staff number, username or management category from a name.

## Agreement submission
The applicant remains required to read the exact agreement and acknowledge all consents; the password re-entry was removed. Signing evidence and transaction controls remain in the existing service. The separate agreement/consent view has not yet been consolidated into the review step.

## Required pre-merge gates
- Confirm no active ClamAV references remain outside legacy code/tests/docs.
- Run unit, integration and browser end-to-end tests, including payslip-reader regression.
- Verify Credit Analyst cannot retrieve payslip files or salary details by API, export or audit log.
- Confirm full agreement text and evidence survive automatic name-signature changes.
- Verify all import columns with an approved roster containing unique staff numbers and usernames.
- Obtain Security, Operations and HR sign-off before merging or deployment.
