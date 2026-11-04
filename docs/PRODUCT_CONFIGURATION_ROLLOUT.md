# Product Configuration: Readiness, Activation and Rollback

This document covers the product-specific supporting documents, legally approved
agreement assignments and authorized reviewer/Operations document viewing.

## Safe rollout

**Do not activate enforcement by merging the code.** The setting
`Settings.productConfigEnforcementEnabled` defaults to `false` and is changed
only through an authenticated, explicitly confirmed administration endpoint.
Existing signed agreements, submitted loans, pricing and approval routing are unchanged.

1. Deploy and verify the frontend/backend feature release together, with enforcement **off**.
2. Visit Products and Pricing to see readiness for each live product, or call
   `GET /api/v1/admin/products/config-readiness` with an authorized product role.
3. For each live product, create a new product version with:
   - `requiredDocuments` explicitly present. An empty list means the maker
     consciously configured zero additional supporting requirements. Legacy
     versions without this field are **not** ready.
   - `agreementTemplateId` referencing one approved, effective, **non-sample**
     template. Legal must load and approve the real product-specific agreement.
   - Existing pricing/eligibility values unchanged unless separately approved.
4. Submit the draft through the existing Head of Credit and Head of Risk
   maker-checker process; wait until its effective date is reached.
5. Repeat `GET /api/v1/admin/products/config-readiness`. Activation is refused
   while `incomplete > 0`; inspect each `products[].missing` value.
6. Perform UAT of the uploads, staff signing, reviewer access, special routes
   and disbursement. Obtain separate user authorization to activate.
7. An administrator with `admin.workflow` permission can activate by sending:

```http
POST /api/v1/admin/products/config-enforcement
Content-Type: application/json

{
  "enabled": true,
  "confirmation": "ACTIVATE_PRODUCT_CONFIG_ENFORCEMENT"
}
```

After activation, only ready live products are listed for new applications.
Existing drafts cannot sign unless their current live product version is ready
and mandatory categories are satisfied. Applications already submitted
continue on their pinned product version and recorded agreement.

## Rollback

An administrator can turn enforcement **off** without modifying product data:

```http
POST /api/v1/admin/products/config-enforcement
Content-Type: application/json

{
  "enabled": false,
  "confirmation": "DEACTIVATE_PRODUCT_CONFIG_ENFORCEMENT"
}
```

Both actions are audited. Recheck the readiness report after rollback.
Do not delete existing product versions, attachments or signed agreements.

## Document contract

Document requirements are configured inside `ProductVersion.requiredDocuments`
with `code`, `name`, `description`, `mandatory`, `minFiles`, `maxFiles`,
`allowedTypes` (pdf/jpg/jpeg/png), `maxFileMb`, `displayOrder` and `active`.
Document codes are unique within a product version. Do not use loan product
names/codes as special cases in application code.

`POST /api/v1/applications/:id/documents` accepts `multipart/form-data`
with `file`, optional `label` and `documentCode` for configured categories.
Files must pass the existing signature-sniffing and malware-scan hooks.
`StoredFile.documentCode` retains the category, with authorized downloads via
`GET /api/v1/files/:id`. Authorized in-app PDF/image preview uses
`GET /api/v1/files/:id?preview=1` with the same authentication and RBAC.
No publicly accessible storage links are used.

Full-access reviewers receive `documents` and `documentChecklist` from
`GET /api/v1/review/:id`; Operations receives them from its existing
disbursement-detail endpoint. Credit Analysts with an active limited credit-stage review can view only
supporting attachments and their checklist; their existing restrictions on
payslips, agreements and financial/application terms remain in force.

## Acceptance and operations

- Validate Car Loan invoice, front, side and rear image categories separately.
- Confirm all missing mandatory categories block signature after activation.
- Verify Personal Loan uses its own approved agreement and accepted SHA-256
  remains unchanged after later product configuration changes.
- Verify Credit, HR, CEO and Operations can view/preview/download attachments
  only when authorized for the application.
- Verify existing submitted applications and revised agreements remain valid.
- Run backend tests, frontend lint/tests/build and coordinated end-to-end UAT.
- **Production security prerequisite:** the current malware scanning hook
  (`src/services/files/malwareScanner.js`) defaults to a scanner stub.
  A real scanner must be configured and verified before processing real
  customer documents in production.
- Review dependency audit advisories; do not apply forced dependency upgrades
  without a separate compatibility/security assessment.

## No automatic data migration

The readiness endpoint inspects existing products without changing them.
It does not create legal agreements, auto-classify legacy files, or silently
set empty document requirements. Product makers must configure and obtain
approval for each live product version before activation.
