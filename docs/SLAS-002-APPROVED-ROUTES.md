# SLAS-002 — Approved management approval route

**Decision recorded 11 November 2026:** The user approved retaining the **current** management route:

- Management: Credit Analyst → Head of People and Culture (HR) → CEO → Operations.
- Non-management: Credit Analyst → Head of People and Culture (HR) → CEO → Operations.

No route-code change is required for these categories. The current code in `src/services/workflow/routes.js` already implements both sequences; the management route limits Credit Analyst visibility as designed.

**Separate business sign-off still required:** The exceptional routes for the CEO (Credit Analyst → HR → OPS) and Head of HR (Credit Analyst → People and Culture Manager → CEO → OPS) were not explicitly decided by the user and must be validated with authorized stakeholders.

**Release acceptance tests:** routeFor() selects the correct route for each staff category and role; reviewers cannot approve their own applications; the same individual cannot approve multiple protected stages; management confidentiality and reviewer queue visibility are enforced; OPS segregation of duties is enforced.

**Deployment:** This document does not authorize merge or production deployment.

## D-103 — People and Culture stage (25 November 2026)

**Decision:** for every application except the CEO's own, the stage after the Credit
Analyst can be decided by **either** the People and Culture Manager **or** the Head of
People and Culture, whoever acts first. This replaces the routes above for applications
submitted (or resubmitted after a return) from this change on:

| Applicant | Route |
|---|---|
| Non-management staff | Credit Analyst → People and Culture (P&C Manager or Head of P&C) → CEO → OPS |
| Management staff | Credit Analyst (limited view) → People and Culture → CEO → OPS |
| Head of P&C's own | Credit Analyst (limited view) → People and Culture (in practice the P&C Manager) → CEO → OPS |
| CEO's own | Unchanged: Credit Analyst (limited view) → Head of People and Culture (final) → OPS |

- Both see the application in their queue and are notified; the first decision moves it on,
  and the other can no longer act. Nobody decides their own application, so the P&C
  Manager's own goes to the Head of P&C and the Head of P&C's own to the P&C Manager.
- Segregation of duties and delegation apply as before. The decision records which role
  acted (`details.permission`), and the history shows, for example, "People and Culture
  (P&C Manager)".
- Applications submitted before the change keep the route stored on them: one waiting for
  the Head of HR stays with the Head of HR.
- No roles or permissions changed: the P&C Manager keeps `review.pcm` and the Head of P&C
  `review.hr`; the People and Culture stage (`pc`, status `pending_pc`) accepts either.
