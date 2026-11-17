import crypto from 'node:crypto';
import { getDb } from './db.ts';
import type { AuthenticatedUser } from './auth.ts';

export interface ChaincodeResult {
  ok: boolean;
  statusCode: number;
  errorCode?: string;
  errorMessage?: string;
  event?: Record<string, unknown>;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function isFabricNetworkAvailable(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT config_value FROM system_config WHERE config_key = 'fabric_network_available'")
    .get() as { config_value: string } | undefined;
  return !row || row.config_value !== 'false';
}

export function setFabricNetworkAvailability(available: boolean, actorId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO system_config (config_key, config_value, updated_by, updated_at)
     VALUES ('fabric_network_available', ?, ?, ?)
     ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(available ? 'true' : 'false', actorId, new Date().toISOString());
}

/**
 * Local Simulated Hyperledger Fabric Chaincode Execution Engine
 * Enforces permissioned identity checks, approval status checks, optimistic parcel version control,
 * duplicate transaction prevention, minimal metadata privacy, and hash-linked event persistence.
 */
export function submitApprovedApplicationToLedger(params: {
  applicationId: string;
  actor: AuthenticatedUser;
  expectedParcelVersion?: number;
}): ChaincodeResult {
  const db = getDb();
  const now = new Date().toISOString();

  // 1. Verify simulated consortium network availability (supports TC-12)
  if (!isFabricNetworkAvailable()) {
    const appRow = db
      .prepare('SELECT parcel_id, approval_reference FROM applications WHERE application_id = ?')
      .get(params.applicationId) as { parcel_id: string; approval_reference: string | null } | undefined;

    if (appRow) {
      const latestEvent = db
        .prepare('SELECT event_hash, COALESCE(MAX(block_number), 0) as max_block FROM ledger_events')
        .get() as { event_hash: string | null; max_block: number };
      const failedId = `EVT-FAIL-${Date.now()}`;
      db.prepare(
        `INSERT INTO ledger_events (
          event_id, parcel_id, application_id, tx_id, block_number, event_type,
          event_hash, previous_event_hash, parcel_version, approval_reference,
          doc_hash_refs_json, endorser_orgs_json, msp_identity, is_simulated,
          status, error_message, payload_json, timestamp
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED_MUTATION', ?, ?, 0, ?, '[]', '[]', ?, 1, 'FAILED', ?, ?, ?)`
      ).run(
        failedId,
        appRow.parcel_id,
        params.applicationId,
        `SIM-TX-FAILED-${Date.now()}`,
        latestEvent?.max_block || 0,
        '0'.repeat(64),
        latestEvent?.event_hash || '0'.repeat(64),
        appRow.approval_reference,
        `${params.actor.email}@RegistrarAuthorityMSP.demo.fabric`,
        'SIMULATED_FABRIC_PEER_UNAVAILABLE: Endorsement peers unreachable.',
        JSON.stringify({ applicationId: params.applicationId, reason: 'NETWORK_UNAVAILABLE' }),
        now
      );
    }

    return {
      ok: false,
      statusCode: 503,
      errorCode: 'BLOCKCHAIN_UNAVAILABLE',
      errorMessage:
        'Simulated Hyperledger Fabric peers are currently unavailable. Transaction was not recorded on the ledger; operational record remains safely queued in the database.'
    };
  }

  // 2. Verify authorized identity & active MSP certificate
  const authorizedRole = params.actor.roles.find((r) => r === 'APPROVING_OFFICER' || r === 'ADMIN');
  if (!authorizedRole) {
    return {
      ok: false,
      statusCode: 403,
      errorCode: 'UNAUTHORIZED_MSP_IDENTITY',
      errorMessage: 'Only authorized Approving Officers or Consortium Admins may submit ledger transactions.'
    };
  }

  const activeCert = db
    .prepare(
      `SELECT common_name, org_msp FROM fabric_identities
       WHERE role_name = ? AND cert_status = 'ACTIVE' LIMIT 1`
    )
    .get(authorizedRole) as { common_name: string; org_msp: string } | undefined;

  if (!activeCert) {
    return {
      ok: false,
      statusCode: 403,
      errorCode: 'REVOKED_OR_MISSING_CERTIFICATE',
      errorMessage: 'No active Fabric X.509 certificate found for the submitting organization identity.'
    };
  }

  // 3. Load application and enforce APPROVED + approval_reference mandatory rule
  const app = db
    .prepare('SELECT * FROM applications WHERE application_id = ?')
    .get(params.applicationId) as
    | {
        application_id: string;
        parcel_id: string;
        applicant_id: string;
        type: string;
        status: string;
        proposed_transferee_name: string | null;
        expected_parcel_version: number;
        approval_reference: string | null;
      }
    | undefined;

  if (!app) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: 'APPLICATION_NOT_FOUND',
      errorMessage: `Application ${params.applicationId} does not exist.`
    };
  }

  if (app.status !== 'APPROVED') {
    return {
      ok: false,
      statusCode: 400,
      errorCode: 'APPLICATION_NOT_APPROVED',
      errorMessage: `Only APPROVED applications can be submitted to the blockchain. Current status: ${app.status}.`
    };
  }

  if (!app.approval_reference) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: 'MISSING_APPROVAL_REFERENCE',
      errorMessage: 'Mandatory official approval reference is missing.'
    };
  }

  // 4. Duplicate event submission check (TC-10)
  const existingCommitted = db
    .prepare(
      `SELECT event_id, tx_id FROM ledger_events
       WHERE application_id = ? AND status = 'COMMITTED' LIMIT 1`
    )
    .get(app.application_id) as { event_id: string; tx_id: string } | undefined;

  if (existingCommitted) {
    return {
      ok: false,
      statusCode: 409,
      errorCode: 'DUPLICATE_TRANSACTION',
      errorMessage: `Duplicate event rejected: Application ${app.application_id} has already been committed to the ledger under transaction ${existingCommitted.tx_id}.`
    };
  }

  // 5. Parcel existence & optimistic version check (TC-11)
  const parcel = db
    .prepare('SELECT * FROM parcels WHERE parcel_id = ?')
    .get(app.parcel_id) as
    | {
        parcel_id: string;
        version: number;
        status: string;
        owner_display_name: string;
      }
    | undefined;

  if (!parcel) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: 'PARCEL_NOT_FOUND',
      errorMessage: `Parcel ${app.parcel_id} does not exist.`
    };
  }

  const versionToCheck =
    typeof params.expectedParcelVersion === 'number'
      ? params.expectedParcelVersion
      : app.expected_parcel_version;

  if (versionToCheck !== parcel.version) {
    return {
      ok: false,
      statusCode: 409,
      errorCode: 'STALE_PARCEL_VERSION',
      errorMessage: `Stale parcel version conflict: expected version ${versionToCheck}, but current on-chain parcel version is ${parcel.version}. Refresh parcel state and re-verify.`
    };
  }

  // 6. Gather minimal metadata only (document SHA-256 hashes, NO PII, NO raw deeds, NO detailed GIS coordinates)
  const docRows = db
    .prepare('SELECT sha256_hash FROM documents WHERE application_id = ? ORDER BY version ASC')
    .all(app.application_id) as Array<{ sha256_hash: string }>;
  const docHashes = docRows.map((d) => d.sha256_hash);

  const eventTypeMap: Record<string, string> = {
    LAND_TRANSFER: 'APPROVED_TRANSFER',
    LAND_MUTATION: 'APPROVED_MUTATION',
    RECORD_CORRECTION: 'CORRECTION_EVENT',
    DOCUMENT_VERIFICATION: 'DOCUMENT_HASH_REGISTRATION'
  };
  const eventType = eventTypeMap[app.type] || 'APPROVED_MUTATION';
  const newParcelVersion = parcel.version + 1;

  // Fetch latest committed block/event hash to link chain
  const latestCommitted = db
    .prepare(
      `SELECT event_hash, block_number FROM ledger_events
       WHERE status = 'COMMITTED' ORDER BY block_number DESC LIMIT 1`
    )
    .get() as { event_hash: string; block_number: number } | undefined;

  const previousEventHash = latestCommitted ? latestCommitted.event_hash : '0'.repeat(64);
  const nextBlockNumber = (latestCommitted ? latestCommitted.block_number : 0) + 1;

  // Minimal privacy-preserving payload
  const minimalPayload = {
    parcelId: parcel.parcel_id,
    applicationId: app.application_id,
    eventType,
    parcelVersion: newParcelVersion,
    approvalReference: app.approval_reference,
    documentHashes: docHashes,
    timestamp: now
  };

  const eventHash = sha256Hex(previousEventHash + JSON.stringify(minimalPayload));
  const txId = `SIM-TX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const eventId = `EVT-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const endorserOrgs = ['RevenueDeptMSP', 'SurveyGISMSP', 'RegistrarAuthorityMSP'];
  const mspIdentity = `${activeCert.common_name} (${activeCert.org_msp})`;

  // Commit atomically in SQLite transaction
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `INSERT INTO ledger_events (
        event_id, parcel_id, application_id, tx_id, block_number, event_type,
        event_hash, previous_event_hash, parcel_version, approval_reference,
        doc_hash_refs_json, endorser_orgs_json, msp_identity, is_simulated,
        status, error_message, payload_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'COMMITTED', NULL, ?, ?)`
    ).run(
      eventId,
      parcel.parcel_id,
      app.application_id,
      txId,
      nextBlockNumber,
      eventType,
      eventHash,
      previousEventHash,
      newParcelVersion,
      app.approval_reference,
      JSON.stringify(docHashes),
      JSON.stringify(endorserOrgs),
      mspIdentity,
      JSON.stringify(minimalPayload),
      now
    );

    const newOwnerDisplay =
      app.type === 'LAND_TRANSFER' && app.proposed_transferee_name
        ? app.proposed_transferee_name
        : parcel.owner_display_name;

    db.prepare(
      `UPDATE parcels SET version = ?, status = 'ACTIVE', owner_display_name = ?, updated_at = ?
       WHERE parcel_id = ?`
    ).run(newParcelVersion, newOwnerDisplay, now, parcel.parcel_id);

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    ok: true,
    statusCode: 201,
    event: {
      event_id: eventId,
      parcel_id: parcel.parcel_id,
      application_id: app.application_id,
      tx_id: txId,
      block_number: nextBlockNumber,
      event_type: eventType,
      event_hash: eventHash,
      previous_event_hash: previousEventHash,
      parcel_version: newParcelVersion,
      approval_reference: app.approval_reference,
      doc_hashes: docHashes,
      endorser_orgs: endorserOrgs,
      msp_identity: mspIdentity,
      is_simulated: true,
      simulation_notice: 'LOCAL SIMULATED HYPERLEDGER FABRIC TRANSACTION (ACADEMIC PROTOTYPE)',
      timestamp: now
    }
  };
}

export function verifyLedgerChain(): {
  valid: boolean;
  totalCommittedEvents: number;
  brokenLinks: Array<{ event_id: string; block_number: number; reason: string }>;
} {
  const db = getDb();
  const events = db
    .prepare(
      `SELECT event_id, block_number, event_hash, previous_event_hash, payload_json
       FROM ledger_events WHERE status = 'COMMITTED' ORDER BY block_number ASC`
    )
    .all() as Array<{
    event_id: string;
    block_number: number;
    event_hash: string;
    previous_event_hash: string;
    payload_json: string;
  }>;

  const brokenLinks: Array<{ event_id: string; block_number: number; reason: string }> = [];
  let expectedPrev = '0'.repeat(64);

  for (const evt of events) {
    if (evt.previous_event_hash !== expectedPrev) {
      brokenLinks.push({
        event_id: evt.event_id,
        block_number: evt.block_number,
        reason: 'previous_event_hash does not match prior block event_hash'
      });
    }
    const recomputed = sha256Hex(evt.previous_event_hash + evt.payload_json);
    if (recomputed !== evt.event_hash) {
      brokenLinks.push({
        event_id: evt.event_id,
        block_number: evt.block_number,
        reason: 'event_hash mismatch against payload_json'
      });
    }
    expectedPrev = evt.event_hash;
  }

  return {
    valid: brokenLinks.length === 0,
    totalCommittedEvents: events.length,
    brokenLinks
  };
}
