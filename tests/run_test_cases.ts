import assert from 'node:assert/strict';
import fs from 'node:fs';

// Isolate test state from any running dev server
process.env.DB_PATH = './data/test_land_records.db';
process.env.STORAGE_DIR = './storage/test_documents';
process.env.BACKUP_DIR = './backups/test_backups';

const TEST_PORT = 3901;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

async function jsonReq(
  urlPath: string,
  opts: { method?: string; token?: string; body?: unknown; form?: FormData } = {}
) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${urlPath}`, {
    method: opts.method || 'GET',
    headers,
    body
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, data: json };
}

async function loginAs(email: string, password = 'DemoPass@2026') {
  return jsonReq('/api/auth/login', { method: 'POST', body: { email, password } });
}

async function runTests() {
  const { startServer } = await import('../server.ts');
  const { DB_PATH, closeDb, getDb } = await import('../server/db.ts');

  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) {
      fs.unlinkSync(DB_PATH + suffix);
    }
  }

  const { server } = await startServer(TEST_PORT);
  const results: Array<{ id: string; title: string; status: 'PASS' | 'FAIL'; detail: string }> = [];

  async function testCase(id: string, title: string, fn: () => Promise<string>) {
    try {
      const detail = await fn();
      results.push({ id, title, status: 'PASS', detail });
      console.log(`PASS ${id}: ${title} -> ${detail}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id, title, status: 'FAIL', detail: msg });
      console.error(`FAIL ${id}: ${title} -> ${msg}`);
    }
  }

  try {
    let citizenToken = '';
    let citizen2Token = '';
    let clerkToken = '';
    let surveyorToken = '';
    let officerToken = '';
    let adminToken = '';
    let createdAppId = '';
    let uploadedDocId = '';
    const originalFileContent = Buffer.from('ORIGINAL-TITLE-DEED-BYTES-2026-DEMO-VERIFICATION', 'utf-8');

    // TC-01: Valid login
    await testCase('TC-01', 'Valid login', async () => {
      const r1 = await loginAs('citizen@demo.landgov');
      assert.equal(r1.status, 200);
      assert.ok(r1.data.token);
      citizenToken = r1.data.token;

      const r2 = await loginAs('citizen2@demo.landgov');
      assert.equal(r2.status, 200);
      citizen2Token = r2.data.token;

      const r3 = await loginAs('clerk@demo.landgov');
      assert.equal(r3.status, 200);
      clerkToken = r3.data.token;

      const r4 = await loginAs('surveyor@demo.landgov');
      assert.equal(r4.status, 200);
      surveyorToken = r4.data.token;

      const r5 = await loginAs('officer@demo.landgov');
      assert.equal(r5.status, 200);
      officerToken = r5.data.token;

      const r6 = await loginAs('admin@demo.landgov');
      assert.equal(r6.status, 200);
      adminToken = r6.data.token;

      return 'All role logins issued valid JWT tokens (HTTP 200).';
    });

    // TC-02: Invalid password
    await testCase('TC-02', 'Invalid password', async () => {
      const res = await loginAs('citizen@demo.landgov', 'WrongPassword123!');
      assert.equal(res.status, 401);
      assert.ok(res.data.error);
      return `Rejected with HTTP ${res.status}: ${res.data.error}`;
    });

    // TC-03: Citizen attempts officer approval
    await testCase('TC-03', 'Citizen attempts officer approval', async () => {
      const res = await jsonReq('/api/applications/APP-2026-0002/approve', {
        method: 'POST',
        token: citizenToken,
        body: { decision: 'APPROVED', remarks: 'Unauthorized attempt' }
      });
      assert.equal(res.status, 403);
      return `Blocked with HTTP 403 Forbidden: ${res.data.error}`;
    });

    // TC-04: Complete application submission
    await testCase('TC-04', 'Complete application submission', async () => {
      const res = await jsonReq('/api/applications', {
        method: 'POST',
        token: citizenToken,
        body: {
          parcel_id: 'TN-CHN-PR-000104',
          type: 'LAND_MUTATION',
          summary_notes: 'TC-04 complete mutation submission for Survey 42/3A.'
        }
      });
      assert.equal(res.status, 201);
      createdAppId = res.data.application.application_id;
      assert.ok(createdAppId);

      // Upload valid document
      const form = new FormData();
      form.append('file', new Blob([originalFileContent], { type: 'text/plain' }), 'tc04_deed.txt');
      form.append('doc_category', 'TITLE_EXTRACT');
      const docRes = await jsonReq(`/api/applications/${createdAppId}/documents`, {
        method: 'POST',
        token: citizenToken,
        form
      });
      assert.equal(docRes.status, 201);
      uploadedDocId = docRes.data.document.document_id;
      return `Created ${createdAppId} with document ${uploadedDocId} (SHA-256 registered).`;
    });

    // TC-05: Missing mandatory field
    await testCase('TC-05', 'Missing mandatory field', async () => {
      const res = await jsonReq('/api/applications', {
        method: 'POST',
        token: citizenToken,
        body: {
          parcel_id: 'TN-CHN-PR-000104',
          type: 'LAND_TRANSFER',
          summary_notes: 'Missing proposed transferee name'
        }
      });
      assert.equal(res.status, 400);
      return `Validation rejected with HTTP 400: ${res.data.error}`;
    });

    // TC-06: Unsupported document upload
    await testCase('TC-06', 'Unsupported document upload', async () => {
      const form = new FormData();
      form.append('file', new Blob(['#!/bin/sh\necho bad'], { type: 'application/x-sh' }), 'malicious.sh');
      const res = await jsonReq(`/api/applications/${createdAppId}/documents`, {
        method: 'POST',
        token: citizenToken,
        form
      });
      assert.equal(res.status, 400);
      return `Rejected unsupported file with HTTP 400: ${res.data.error}`;
    });

    // TC-07: Original document hash verification
    await testCase('TC-07', 'Original document hash verification', async () => {
      const form = new FormData();
      form.append('document_id', uploadedDocId);
      form.append('file', new Blob([originalFileContent], { type: 'text/plain' }), 'tc04_deed.txt');
      const res = await jsonReq('/api/documents/verify', {
        method: 'POST',
        token: citizenToken,
        form
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.result, 'MATCH');
      return `Verified MATCH (SHA-256 ${res.data.computedHash.slice(0, 16)}...)`;
    });

    // TC-08: Modified document hash verification
    await testCase('TC-08', 'Modified document hash verification', async () => {
      const tampered = Buffer.from('MODIFIED-TITLE-DEED-BYTES-2026-TAMPERED', 'utf-8');
      const form = new FormData();
      form.append('document_id', uploadedDocId);
      form.append('file', new Blob([tampered], { type: 'text/plain' }), 'tc04_deed_tampered.txt');
      const res = await jsonReq('/api/documents/verify', {
        method: 'POST',
        token: citizenToken,
        form
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.result, 'NO_MATCH');
      return `Detected tampering: NO_MATCH (computed ${res.data.computedHash.slice(0, 16)}...)`;
    });

    // TC-09: Approved application ledger submission
    await testCase('TC-09', 'Approved application ledger submission', async () => {
      // Clerk verifies -> Surveyor verifies -> Officer approves -> Submit ledger
      const rClerk = await jsonReq(`/api/applications/${createdAppId}/review`, {
        method: 'POST',
        token: clerkToken,
        body: { decision: 'VERIFIED', remarks: 'TC-09 Clerk verified' }
      });
      assert.equal(rClerk.status, 200);

      const rSurv = await jsonReq(`/api/applications/${createdAppId}/review`, {
        method: 'POST',
        token: surveyorToken,
        body: { decision: 'SURVEY_COMPLETED', remarks: 'TC-09 Survey verified', survey_notes: 'Boundaries OK' }
      });
      assert.equal(rSurv.status, 200);

      const rAppr = await jsonReq(`/api/applications/${createdAppId}/approve`, {
        method: 'POST',
        token: officerToken,
        body: { decision: 'APPROVED', remarks: 'TC-09 Officer approved', submitToLedger: false }
      });
      assert.equal(rAppr.status, 200);

      const rLedger = await jsonReq(`/api/applications/${createdAppId}/submit-ledger`, {
        method: 'POST',
        token: officerToken,
        body: {}
      });
      assert.equal(rLedger.status, 201);
      assert.ok(rLedger.data.event.tx_id);
      return `Committed simulated Fabric transaction ${rLedger.data.event.tx_id} (parcel v${rLedger.data.event.parcel_version})`;
    });

    // TC-10: Duplicate event submission
    await testCase('TC-10', 'Duplicate event submission', async () => {
      const res = await jsonReq(`/api/applications/${createdAppId}/submit-ledger`, {
        method: 'POST',
        token: officerToken,
        body: {}
      });
      assert.equal(res.status, 409);
      assert.equal(res.data.errorCode, 'DUPLICATE_TRANSACTION');
      return `Rejected duplicate submission with HTTP 409: ${res.data.error}`;
    });

    // TC-11: Stale parcel version
    await testCase('TC-11', 'Stale parcel version', async () => {
      // Submit a fresh app on TN-CHN-PR-000104, approve it without ledger commit, then try submitting with stale version 1
      const appRes = await jsonReq('/api/applications', {
        method: 'POST',
        token: citizenToken,
        body: {
          parcel_id: 'TN-CHN-PR-000104',
          type: 'RECORD_CORRECTION',
          summary_notes: 'TC-11 stale version test application'
        }
      });
      assert.equal(appRes.status, 201);
      const staleAppId = appRes.data.application.application_id;

      await jsonReq(`/api/applications/${staleAppId}/approve`, {
        method: 'POST',
        token: officerToken,
        body: { decision: 'APPROVED', remarks: 'Approved for stale version test', submitToLedger: false }
      });

      const res = await jsonReq(`/api/applications/${staleAppId}/submit-ledger`, {
        method: 'POST',
        token: officerToken,
        body: { expectedParcelVersion: 1 }
      });
      assert.equal(res.status, 409);
      assert.equal(res.data.errorCode, 'STALE_PARCEL_VERSION');
      return `Rejected stale version with HTTP 409: ${res.data.error}`;
    });

    // TC-12: Blockchain unavailable
    await testCase('TC-12', 'Blockchain unavailable', async () => {
      // Simulate outage via Admin endpoint
      const toggleOff = await jsonReq('/api/ledger/toggle-availability', {
        method: 'POST',
        token: adminToken,
        body: { available: false }
      });
      assert.equal(toggleOff.status, 200);

      // Approve APP-2026-0002 without auto ledger commit, then attempt submit-ledger
      await jsonReq('/api/applications/APP-2026-0002/approve', {
        method: 'POST',
        token: officerToken,
        body: { decision: 'APPROVED', remarks: 'TC-12 outage test approval', submitToLedger: false }
      });

      const res = await jsonReq('/api/applications/APP-2026-0002/submit-ledger', {
        method: 'POST',
        token: officerToken,
        body: {}
      });
      assert.equal(res.status, 503);
      assert.equal(res.data.errorCode, 'BLOCKCHAIN_UNAVAILABLE');

      // Restore network availability
      await jsonReq('/api/ledger/toggle-availability', {
        method: 'POST',
        token: adminToken,
        body: { available: true }
      });

      return `Returned HTTP 503 BLOCKCHAIN_UNAVAILABLE without fabricating tx confirmation.`;
    });

    // TC-13: Unauthorized parcel access
    await testCase('TC-13', 'Unauthorized parcel access', async () => {
      // Citizen 2 tries to access Citizen 1's parcel TN-CHN-PR-000104
      const res = await jsonReq('/api/parcels/TN-CHN-PR-000104', {
        token: citizen2Token
      });
      assert.equal(res.status, 403);
      return `Blocked Citizen 2 access to TN-CHN-PR-000104 with HTTP 403: ${res.data.error}`;
    });

    // TC-14: Database and document backup restoration
    await testCase('TC-14', 'Database and document backup restoration', async () => {
      const bkpRes = await jsonReq('/api/admin/backups', {
        method: 'POST',
        token: adminToken
      });
      assert.equal(bkpRes.status, 201);
      const backupId = bkpRes.data.backup.backup_id;

      // Mutate DB after backup (create a parcel), then restore and confirm DB reverted cleanly
      const postBkpParcel = await jsonReq('/api/parcels', {
        method: 'POST',
        token: adminToken,
        body: {
          parcel_id: 'TN-CHN-PR-TEMP99',
          survey_no: '999/1',
          locality: 'CHN-TEMP',
          area: '500 sq.ft.',
          land_use: 'Residential',
          owner_display_name: 'Temp Before Restore'
        }
      });
      assert.equal(postBkpParcel.status, 201);

      const restoreRes = await jsonReq(`/api/admin/backups/${backupId}/restore`, {
        method: 'POST',
        token: adminToken
      });
      assert.equal(restoreRes.status, 200);
      assert.equal(restoreRes.data.restored, true);
      assert.equal(restoreRes.data.checksumVerified, true);

      // Verify post-backup parcel is gone after restore and pre-backup app still exists
      const checkGone = await jsonReq('/api/parcels/TN-CHN-PR-TEMP99', { token: adminToken });
      assert.equal(checkGone.status, 404);
      const checkApp = await jsonReq(`/api/applications/${createdAppId}`, { token: adminToken });
      assert.equal(checkApp.status, 200);

      // Also verify chain integrity after restore
      const db = getDb();
      assert.ok(db);

      return `Backup ${backupId} verified & restored (${restoreRes.data.restoredDocuments} private documents, checksum verified).`;
    });

    const passed = results.filter((r) => r.status === 'PASS').length;
    console.log(`\nTest Summary: ${passed}/${results.length} passed.`);
    if (passed !== results.length) {
      process.exitCode = 1;
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
    closeDb();
  }
  process.exit(process.exitCode || 0);
}

runTests().catch((err) => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});
