# Malware scanning deployment gate (SLAS-001)

The API now uses ClamAV clamd INSTREAM scanning and **rejects uploads if scanning is not configured, times out, or returns an error**. Configure `SLAS_CLAMD_HOST` and optionally `SLAS_CLAMD_PORT` (default 3310). Run clamd on a private network; never expose its TCP port publicly. Ensure signature updates, health monitoring, resource limits and a scanner restart procedure.

**Before release:** Provision clamd; validate a clean PDF, a test EICAR sample (rejected), scanner down (rejected), timeout (rejected), large-file limits, and document/agreement flows. Verify no production upload path bypasses scanning. This change intentionally blocks all uploads if clamd is unavailable. Tests inject an explicit fixture scanner in `tests/setup.js` and must never be used as evidence that real ClamAV scanning works.

**Operational warning:** The scanner may not be available in existing environments. Deploying the backend before clamd is provisioned would interrupt uploads. Do not merge or deploy until infrastructure and UAT sign-off.
