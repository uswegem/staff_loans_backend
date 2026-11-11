# SLAS-002 — Approved management approval route

**Decision recorded 11 November 2026:** The user approved retaining the **current** management route:

- Management: Credit Analyst → Head of People and Culture (HR) → CEO → Operations.
- Non-management: Credit Analyst → Head of People and Culture (HR) → CEO → Operations.

No route-code change is required for these categories. The current code in `src/services/workflow/routes.js` already implements both sequences; the management route limits Credit Analyst visibility as designed.

**Separate business sign-off still required:** The exceptional routes for the CEO (Credit Analyst → HR → OPS) and Head of HR (Credit Analyst → People and Culture Manager → CEO → OPS) were not explicitly decided by the user and must be validated with authorized stakeholders.

**Release acceptance tests:** routeFor() selects the correct route for each staff category and role; reviewers cannot approve their own applications; the same individual cannot approve multiple protected stages; management confidentiality and reviewer queue visibility are enforced; OPS segregation of duties is enforced.

**Deployment:** This document does not authorize merge or production deployment.
