# SLAS API: LFB Staff Loan Application System

Backend for the Letshego Faidika Bank staff loan system: a REST JSON API under `/api/v1`. Requirements are in `docs\BRD_v0.8.md` in the parent workspace, and build decisions are in `docs\DECISIONS.md`.

Stack: Node.js 22 LTS, Express 4, MongoDB (replica set) with Mongoose 8, Joi, helmet, winston, and Jest with supertest and mongodb-memory-server.

## Set up on Windows (Laragon)

1. **Node.js 22 LTS.** Laragon ships Node under `C:\laragon\bin\nodejs`. Check the version with `node -v` (it must print `v22.x`). If it doesn't, install Node 22 LTS and select it in Laragon (Menu → Node.js).
2. **MongoDB 7 or later as a replica set.** Laragon doesn't include MongoDB.
   - Install MongoDB Community Server (MSI) and clear the "Install as a service" box, or stop the service afterwards.
   - Create the data folder and start a single-node replica set:
     ```powershell
     New-Item -ItemType Directory -Force C:\slas-data\db
     & "C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe" --dbpath C:\slas-data\db --replSet rs0 --bind_ip 127.0.0.1 --port 27017
     ```
   - In a second window, run this once to initiate the set:
     ```powershell
     & "C:\Program Files\MongoDB\Server\7.0\bin\mongosh.exe" --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
     ```
   Workflow changes use transactions, which need a replica set; a single node is enough. The API logs a warning at start-up if it's missing.
3. **Configure.** Copy `.env.example` to `.env` and fill in `JWT_SECRET`, `MFA_ENC_KEY` and `SEED_PASSWORD`. The file shows the commands that generate the secrets. For plain-http local development, set `COOKIE_SECURE=false`.
4. **Install, seed and run.**
   ```powershell
   npm install
   npm run seed                 # system data: roles, settings, holidays, pricing, the sample agreement
   npm run reset:staff -- --dry-run
   $env:RESET_TEMP_PASSWORD = '<a temporary password that meets the policy>'
   npm run reset:staff          # loads seed/data/lfb-staff.csv with roles (D-92)
   npm run dev                  # http://localhost:4000/api/v1, API docs at /api/v1/docs
   ```

Every account loaded by `reset:staff` uses `RESET_TEMP_PASSWORD` and must change it at first sign-in. Reviewers, OPS, administrators, product approvers and the Head of Legal also enrol an authenticator app. No products are loaded: the Head of Credit (or the System Administrator) drafts them, then the Head of Credit and the Head of Risk and Compliance approve them (D-89).

| Staff no. | Roles beyond Staff |
| --- | --- |
| AT656 | System Administrator (the administrator login kept by the reset) |
| AT648 | CEO |
| AT697 | Head of Credit |
| AT727 | Head of Risk and Compliance |
| AT700 | Legal Officer |
| AT534 | Head of Legal |
| AT646 | Credit Analyst |
| AT663 | Head of People and Culture |
| AT540 | Auditor |
| AT144 | OPS |

The fictional sample people of the prototype (LFB0412 and others) are now only in the tests and the e2e server (`tests/fixtures`, `seed/data/people.js`).

## Scripts

| Script | What it does |
| --- | --- |
| `npm test` | All tests. They start an in-memory MongoDB replica set; the first run downloads a `mongod` binary. |
| `npm run test:unit` | Unit tests only |
| `npm run lint` | ESLint |
| `npm run ci` | Lint, calculator check, then all tests |
| `npm run openapi` | Writes `openapi.json` from the route annotations; this is the API contract the frontend follows |
| `npm run calc:check` | Checks the web app's copy of the loan calculator matches this one (`calc:sync` regenerates it) |
| `npm run reset:staff` | Replaces staff and products with the staff table (D-92). `-- --dry-run` lists the counts only. Refuses production or a remote database; backs up first to `<upload dir>/../backups/reset-<time>`. Needs `RESET_TEMP_PASSWORD`. Safe to run again. |
| `npm run upgrade` | Brings an existing database up to this release (names, templates, product approvals, roles, date of birth setup, location list, profile formats). `-- --fix-phone <as stored>=<correct>` corrects a confirmed wrong number. Safe to run again. |
| `npm run staff:load` | Adds new staff from the staff table without deleting anything (D-95). `-- --dry-run` lists them. Needs `RESET_TEMP_PASSWORD`. Safe to run again. |
| `node scripts/e2e-server.js` | API for the Playwright runs: in-memory replica set, sample data, port 4100. The web app's `npm run e2e` starts it for you. |

## Upgrading an existing installation

### Profile formats, address, language and theme (0.12.0)

1. Back up the database and the upload folder.
2. Deploy the API and the web app, then run `npm run upgrade` once. It loads the Region → District → Ward list (26 regions, 158 districts, 3,964 wards), hyphenates NIDA numbers, normalises phone numbers, maps "Tanzanian" to Tanzania, and lists values it could not fix; staff correct those on their profile.
3. Staff with an earlier residence must enter region, district, ward and street before they can apply.
4. Add new staff with `npm run staff:load` (dry run first).
5. People and Culture record each staff member's date joined, employment type and salary (Staff records, or Upload from Excel). Without them nobody can apply (D-97). No retirement date is needed: it comes from the verified date of birth (D-98).

### Salary deduction, combined cap, Legal and product approvals (0.11.0)

1. Back up the database (`mongodump`) and the upload folder.
2. Deploy the API and the web app, then run once, with the API's `.env`:
   ```powershell
   npm run upgrade
   ```
   It splits names into First Name and Surname and lists names to check (D-85), marks the Legal-approved templates as approved (D-88), sends product and pricing changes waiting for approval to the Head of Credit (D-89), syncs the system roles (new: Head of Credit, Head of Risk and Compliance, Legal Officer, Head of Legal, Auditor; Product Checker removed), and runs the date of birth setup below.
3. Assign the new roles in Users and roles (or run `npm run reset:staff` outside production).
4. People and Culture must enter or verify every staff member's date of birth: without a verified date nobody can apply (D-82).
5. Correct the names the upgrade listed, and fill in gender and date joined where missing (D-91).

### Date of birth verification (0.10.0)

MongoDB needs no schema migration; run this once after deploying, with the API's `.env`:

```powershell
node scripts/dob-verification-setup.js
```

It gives the Head of People and Culture and People and Culture Manager roles the new permission `staff.verifyDob` (seeded roles are never updated automatically), and sends every date of birth entered before this release to People and Culture's queue as a pending change. It is safe to run again. Until People and Culture verify a staff member's date of birth, that person cannot start or submit a loan application. Loans and applications already in the system are not changed; applications still in review are checked against the cutoff at their next approval.

## Troubleshooting

- **Tests time out or MongoDB says "server monitor timeout".** The in-memory `mongod` stalls when the machine is busy. Close other heavy jobs and run one suite with `npx jest tests/integration/review.test.js`. A stray `mongod.exe` from an interrupted run can be stopped in Task Manager.
- **The first test run is slow.** mongodb-memory-server downloads `mongod` once into `node_modules/.cache`. Behind the bank proxy, set `MONGOMS_SYSTEM_BINARY` to an installed `mongod.exe` instead.
- **"MongoDB is not running as a replica set".** Start `mongod` with `--replSet rs0` and run `rs.initiate` once (step 2).
- **Sign-in works but a reload signs you out.** On plain http, set `COOKIE_SECURE=false`; the browser drops Secure cookies on http.

## Scheduled jobs

The API runs these in-process (`src/jobs/scheduler.js`); each is safe to run on several instances at once:

| Job | Every | What it does |
| --- | --- | --- |
| product-go-live | 1 min | Moves approved product and pricing versions to live at their exact time (FR-62) |
| revised-terms-expiry | 5 min | Lapses revised terms not accepted in time and tells the applicant and OPS (FR-39) |
| stage-overdue-reminders | 5 min | Tells the reviewer, and their delegate, once a stage is overdue (BRD 12) |
| disbursement-outside-sla | 1 h | Keeps the Outside SLA flag current for reports (Q3) |

## Security notes

The full review, with the go-live checklist, is in [SECURITY.md](SECURITY.md).


- The access token lives only in the browser's memory. The refresh token sits in an httpOnly, Secure, SameSite=Strict cookie on `/api/v1/auth`, and is rotated on every refresh. Reusing a rotated token ends the session.
- CSRF: refresh and logout need the `X-XSRF-TOKEN` header to match the `XSRF-TOKEN` cookie and the session.
- Permissions are loaded from the database on every request, so role changes take effect immediately (FR-51).
- The audit log and decision records are append-only in code. In production, also give the application's database user a role that can only `insert` and `find` on `auditlogs`:
  ```js
  db.createRole({ role: 'slasAuditAppendOnly', privileges: [{ resource: { db: 'slas', collection: 'auditlogs' }, actions: ['insert', 'find'] }], roles: [] })
  ```
- There are no secrets in git. `.env` is ignored.
- Every route validates input and checks a permission, or is on a reviewed self-service list; `tests/unit/routeGuards.test.js` enforces this for new routes.
