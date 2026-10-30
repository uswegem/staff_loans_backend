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
   npm run seed      # sample people from the prototype, all fictional
   npm run dev       # http://localhost:4000/api/v1, API docs at /api/v1/docs
   ```

Sample accounts all use `SEED_PASSWORD`. Reviewers, OPS, administrators and the product checker enrol an authenticator app at first sign-in.

| Staff no. | Person | Roles |
| --- | --- | --- |
| LFB0412 | Neema Mushi | Staff |
| LFB0233 | Juma Kassim | Credit Analyst |
| LFB0051 | Grace Mollel | Head of People and Culture |
| LFB0129 | Upendo Massawe | People and Culture Manager |
| LFB0002 | Joseph Mwakalinga | CEO |
| LFB0318 | Halima Said | OPS |
| LFB0274 | Peter Lyimo | System Administrator (product maker) |
| LFB0010 | Asha Mfinanga | Product Checker (Head of Operations) |
| LFB0067 | Daniel Mrema | Risk and Audit Viewer |
| LFB0596 | Rehema Ally | Staff, profile incomplete |
| LFB0188, LFB0451, LFB0377 | Faraji Nyoni, Aisha Kombo, Salma Hamisi | Staff |

## Scripts

| Script | What it does |
| --- | --- |
| `npm test` | All tests. They start an in-memory MongoDB replica set; the first run downloads a `mongod` binary. |
| `npm run test:unit` | Unit tests only |
| `npm run lint` | ESLint |
| `npm run ci` | Lint, calculator check, then all tests |
| `npm run openapi` | Writes `openapi.json` from the route annotations; this is the API contract the frontend follows |
| `npm run calc:check` | Checks the web app's copy of the loan calculator matches this one (`calc:sync` regenerates it) |
| `node scripts/e2e-server.js` | API for the Playwright runs: in-memory replica set, sample data, port 4100. The web app's `npm run e2e` starts it for you. |

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
