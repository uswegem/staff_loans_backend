# Test staff

Ten **fictional** staff for testing the full journey on a non-production system. The data
is in `seed/data/testStaff.js` and the loader is `scripts/test-staff.js`. Staff numbers use
the `TST` prefix so they can never match a real payroll employee code. Each one's payslip
therefore passes the employee code check only for that test account.

## Load into a test database

```bash
npm run test-staff -- load --dry-run
RESET_TEMP_PASSWORD='<temporary password>' npm run test-staff -- load
```

- Refuses `NODE_ENV=production`.
- Stops, changing nothing, if a `TST` staff number already belongs to someone else.
- Safe to run again: records are reset to the dataset, accounts keep their password,
  roles and the November 2026 salary are added once.
- Sign-in user name is the staff number in lower case (for example `tst101`). The
  temporary password must be changed at first sign-in.

## Payslips

One November 2026 payslip per person, watermarked "SAMPLE - TEST DATA", is in
`tests/fixtures/payslips/test-staff/`. To regenerate them:

```bash
npm run test-staff -- payslips
```

Upload each payslip while signed in as the matching staff member.

## The people

Amounts are in TZS. Tax and pension follow the seeded pricing (10% pension, PAYE bands).

| Staff No | Name | Title | Department / Station | Employment | Roles | Basic | Allowances | Tax | Pension | Staff loan lines | Net pay |
|---|---|---|---|---|---|---:|---:|---:|---:|---|---:|
| TST101 | Bahati Mfano | Chief Executive Officer | Executive Office, Head Office, Dar es Salaam | Permanent | Staff, CEO | 18,000,000 | 0 | 4,688,000 | 1,800,000 | none | 11,512,000 |
| TST102 | Halima Mfano | Head of People and Culture | People and Culture, Head Office, Dar es Salaam | Permanent | Staff, Head of People and Culture | 9,500,000 | 0 | 2,393,000 | 950,000 | STAFF LOAN 650,000 | 5,507,000 |
| TST103 | Amani Mfano | Relationship Officer | Business, Arusha Branch | Permanent | Staff | 2,400,000 | 250,000 | 476,000 | 240,000 | none | 1,934,000 |
| TST104 | Rehema Mfano | Teller | Branch Network, Dodoma Branch | Permanent | Staff | 1,200,000 | 120,000 | 152,000 | 120,000 | STAFF LOAN 150,000 | 898,000 |
| TST105 | Juma Mfano | Credit Officer | Credit, Head Office, Dar es Salaam | Permanent | Staff | 3,200,000 | 0 | 692,000 | 320,000 | STAFF LOAN 420,000 | 1,768,000 |
| TST106 | Neema Mfano | Operations Officer | Central Operations, Head Office, Dar es Salaam | Permanent | Staff | 2,600,000 | 0 | 530,000 | 260,000 | STAFF LOAN 300,000; LFB LOAN 100,000 | 1,410,000 |
| TST107 | Daudi Mfano | Branch Manager | Branch Network, Mwanza Branch | Permanent | Staff | 5,000,000 | 0 | 1,178,000 | 500,000 | STAFF LOAN 800,000 | 2,522,000 |
| TST108 | Zawadi Mfano | Customer Service Officer | Branch Network, Mbeya Branch | Probation (to 2026-12-01) | Staff | 1,500,000 | 100,000 | 233,000 | 150,000 | none | 1,217,000 |
| TST109 | Faraji Mfano | IT Support Officer | IT and Cybersecurity, Head Office, Dar es Salaam | Contract (to 2027-12-31) | Staff | 3,800,000 | 0 | 854,000 | 380,000 | none | 2,566,000 |
| TST110 | Upendo Mfano | Senior Accountant | Finance, Head Office, Dar es Salaam | Permanent | Staff | 4,100,000 | 0 | 935,000 | 410,000 | STAFF LOAN 1,200,000 | 1,555,000 |


Each staff loan line is also declared as an existing LFB loan on the person's profile.
Every profile is complete, with a verified date of birth, NIDA, address, bank details,
next of kin and date joined, so each person can apply straight away. The exceptions are
the rules being tested on purpose: Zawadi is on probation and Faraji is on a fixed-term
contract.
