# Staff loan agreements (English)

The Staff Personal Loan and Staff Car Loan agreements are kept in the system's template
markup in `seed/data/agreements/`:

- `staff-personal-loan.en.md`: template version `2026.12a`, 6 declarations
- `staff-car-loan.en.md`: template version `2026.12b`, 8 declarations

The legal text is as written in the Word documents. Two parts are added and filled in by
the system for each loan, as the agreements describe: an agreement-number line under the
title, and the **Loan Details** section with the repayment schedule (the car loan's also
lists the vehicle and seller fields from the application).

## Template language

Each template is English or Swahili. An English template is filled with English values:
amounts (`TZS 4,500,000`), amounts in words, dates (`25 December 2026`), the request and
effect clauses, and the repayment schedule headings.

## Declarations

A line starting `[ ] ` is a declaration. When an agreement has declarations, the staff
member ticks exactly those at signing (and again when accepting revised terms) instead of
the four standard statements, and the ticked declarations are saved with the application.

## Loading

```bash
npm run agreements:load -- --dry-run
```

```bash
npm run agreements:load -- --approved-by <Head of Legal username> --confirm
```

The script replaces the in-app approval steps, so `--approved-by` must name a user who
can approve agreement templates; that person is recorded as the approver and in the
audit log. Each product gets a new live version, a copy of its current one with the
agreement set. The script stops, changing nothing, if a product has a change waiting,
if a template version already exists with other text, or if the text fails the template
check. Use `--personal <CODE>` and `--car <CODE>` if the products cannot be found by name.

The interest rate (6%), maximum amounts and periods in clauses 2.1 and 3.1 are fixed in the
legal text. If pricing or product limits change, Legal must issue a new version.
