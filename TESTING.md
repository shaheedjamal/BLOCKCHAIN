# CivicLedger — Test Execution Report

Automated test runner: `npm run test:tc` (`tests/run_test_cases.ts`)

| Test ID | Test Scenario | Expected Outcome | Observed Execution Result |
| :--- | :--- | :--- | :--- |
| **TC-01** | Valid login | Authenticated JWT & session returned for all roles | **PASS** — HTTP 200 across Citizen, Citizen 2, Clerk, Surveyor, Approving Officer, and Admin |
| **TC-02** | Invalid password | Rejected with HTTP 401 and failed attempt tracked | **PASS** — HTTP 401 `Invalid email or password.` |
| **TC-03** | Citizen attempts officer approval | Blocked with HTTP 403 Forbidden | **PASS** — HTTP 403 `Access denied. Your role does not have permission for this operation.` |
| **TC-04** | Complete application submission | Application created & document SHA-256 stored | **PASS** — HTTP 201 created application & registered private document SHA-256 |
| **TC-05** | Missing mandatory field | Validation error HTTP 400 | **PASS** — HTTP 400 rejected `LAND_TRANSFER` missing `proposed_transferee_name` |
| **TC-06** | Unsupported document upload | Rejected unsupported `.sh` extension/MIME | **PASS** — HTTP 400 `Unsupported file type (.sh / application/x-sh)` |
| **TC-07** | Original document hash verification | Exact SHA-256 byte comparison returns `MATCH` | **PASS** — HTTP 200 `result: MATCH` |
| **TC-08** | Modified document hash verification | Altered bytes return `NO_MATCH` | **PASS** — HTTP 200 `result: NO_MATCH` |
| **TC-09** | Approved application ledger submission | Simulated Fabric commit returns TX ID & increments parcel version | **PASS** — HTTP 201 committed simulated transaction and incremented parcel to `v3` |
| **TC-10** | Duplicate event submission | Idempotency rule rejects second commit with HTTP 409 | **PASS** — HTTP 409 `DUPLICATE_TRANSACTION` |
| **TC-11** | Stale parcel version | Optimistic concurrency rejects stale expected version | **PASS** — HTTP 409 `STALE_PARCEL_VERSION` |
| **TC-12** | Blockchain unavailable | Returns HTTP 503 without fabricating confirmation | **PASS** — HTTP 503 `BLOCKCHAIN_UNAVAILABLE` |
| **TC-13** | Unauthorized parcel access | Citizen 2 blocked from viewing Citizen 1 parcel | **PASS** — HTTP 403 `Unauthorized parcel access` |
| **TC-14** | Database and document backup restoration | Snapshot checksum verified & database/files restored | **PASS** — HTTP 201 backup + HTTP 200 restore with checksum verification |

**Summary:** `14/14` automated end-to-end test cases passed (`exit code 0`).
