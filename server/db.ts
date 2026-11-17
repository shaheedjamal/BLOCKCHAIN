import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.join(DATA_DIR, 'land_records.db');
export const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.cwd(), process.env.STORAGE_DIR)
  : path.resolve(process.cwd(), 'storage', 'documents');
export const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.cwd(), process.env.BACKUP_DIR)
  : path.resolve(process.cwd(), 'backups');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA journal_mode = WAL;');
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore if already closed
    }
    dbInstance = null;
  }
}

export function resetDbConnection(): DatabaseSync {
  closeDb();
  return getDb();
}

export type RoleName =
  | 'CITIZEN'
  | 'CLERK'
  | 'SURVEYOR'
  | 'APPROVING_OFFICER'
  | 'ADMIN'
  | 'AUDITOR';

export function initDatabase(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      contact TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'SUSPENDED')),
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      mfa_code TEXT,
      mfa_expires_at TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      role_id TEXT PRIMARY KEY,
      role_name TEXT NOT NULL UNIQUE CHECK (role_name IN ('CITIZEN', 'CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR')),
      description TEXT NOT NULL,
      permissions_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      assigned_by TEXT,
      assigned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS parcels (
      parcel_id TEXT PRIMARY KEY,
      survey_no TEXT NOT NULL,
      locality TEXT NOT NULL,
      area TEXT NOT NULL,
      land_use TEXT NOT NULL,
      geometry_ref TEXT NOT NULL,
      geojson_boundary TEXT NOT NULL,
      centroid_lat REAL NOT NULL,
      centroid_lng REAL NOT NULL,
      owner_user_id TEXT,
      owner_display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'UNDER_MUTATION', 'DISPUTED', 'ARCHIVED')),
      version INTEGER NOT NULL DEFAULT 1,
      is_demo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS applications (
      application_id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      applicant_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('LAND_TRANSFER', 'LAND_MUTATION', 'RECORD_CORRECTION', 'DOCUMENT_VERIFICATION')),
      status TEXT NOT NULL CHECK (status IN (
        'SUBMITTED',
        'CLERK_VERIFIED',
        'RETURNED_FOR_CORRECTION',
        'SURVEY_IN_PROGRESS',
        'SURVEY_VERIFIED',
        'AWAITING_APPROVAL',
        'ESCALATED',
        'APPROVED',
        'REJECTED'
      )),
      assigned_clerk_id TEXT,
      assigned_surveyor_id TEXT,
      assigned_officer_id TEXT,
      proposed_transferee_name TEXT,
      summary_notes TEXT NOT NULL,
      expected_parcel_version INTEGER NOT NULL,
      approval_reference TEXT,
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (parcel_id) REFERENCES parcels(parcel_id) ON DELETE RESTRICT,
      FOREIGN KEY (applicant_id) REFERENCES users(user_id) ON DELETE RESTRICT,
      FOREIGN KEY (assigned_clerk_id) REFERENCES users(user_id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_surveyor_id) REFERENCES users(user_id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_officer_id) REFERENCES users(user_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      document_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      sha256_hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      doc_category TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (application_id) REFERENCES applications(application_id) ON DELETE CASCADE,
      FOREIGN KEY (parcel_id) REFERENCES parcels(parcel_id) ON DELETE RESTRICT,
      FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS reviews (
      review_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      reviewer_role TEXT NOT NULL,
      stage TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('VERIFIED', 'RETURNED', 'SURVEY_COMPLETED', 'APPROVED', 'REJECTED', 'ESCALATED', 'ASSIGNED')),
      remarks TEXT NOT NULL,
      survey_notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (application_id) REFERENCES applications(application_id) ON DELETE CASCADE,
      FOREIGN KEY (reviewer_id) REFERENCES users(user_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ledger_events (
      event_id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      application_id TEXT,
      tx_id TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,
      parcel_version INTEGER NOT NULL,
      approval_reference TEXT,
      doc_hash_refs_json TEXT NOT NULL,
      endorser_orgs_json TEXT NOT NULL,
      msp_identity TEXT NOT NULL,
      is_simulated INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('COMMITTED', 'FAILED')),
      error_message TEXT,
      payload_json TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (parcel_id) REFERENCES parcels(parcel_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      log_id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      details_json TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      notification_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL,
      related_object_id TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_config (
      config_key TEXT PRIMARY KEY,
      config_value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      reset_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS backup_records (
      backup_id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      db_backup_path TEXT NOT NULL,
      storage_backup_path TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      document_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fabric_identities (
      identity_id TEXT PRIMARY KEY,
      org_msp TEXT NOT NULL,
      role_name TEXT NOT NULL,
      common_name TEXT NOT NULL,
      cert_serial TEXT NOT NULL,
      cert_status TEXT NOT NULL CHECK (cert_status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
      expires_at TEXT NOT NULL,
      issued_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_parcels_survey ON parcels(survey_no);
    CREATE INDEX IF NOT EXISTS idx_applications_parcel ON applications(parcel_id);
    CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_documents_app ON documents(application_id);
    CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(sha256_hash);
    CREATE INDEX IF NOT EXISTS idx_ledger_parcel ON ledger_events(parcel_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_app ON ledger_events(application_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_events(tx_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  `);

  const userCountRow = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (userCountRow.cnt === 0) {
    seedDemoData(db);
  }
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function seedDemoData(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const demoPasswordHash = bcrypt.hashSync('DemoPass@2026', 10);

  const roles: Array<{ id: string; name: RoleName; desc: string; perms: string[] }> = [
    {
      id: 'ROLE-CITIZEN',
      name: 'CITIZEN',
      desc: 'Submit land applications, upload documents, view permitted parcels, verify hashes, track status.',
      perms: ['parcel:read_permitted', 'application:create', 'application:read_own', 'document:upload_own', 'document:verify']
    },
    {
      id: 'ROLE-CLERK',
      name: 'CLERK',
      desc: 'Check application completeness, verify fields/documents, add remarks, return or forward to Surveyor.',
      perms: ['parcel:read', 'application:read_all', 'application:verify_clerk', 'application:assign', 'document:read', 'document:verify']
    },
    {
      id: 'ROLE-SURVEYOR',
      name: 'SURVEYOR',
      desc: 'Review assigned parcels, GIS boundary references, survey evidence, upload survey reports and findings.',
      perms: ['parcel:read', 'parcel:update_survey_meta', 'application:read_all', 'application:verify_surveyor', 'document:upload', 'document:verify']
    },
    {
      id: 'ROLE-OFFICER',
      name: 'APPROVING_OFFICER',
      desc: 'Final review of clerk/surveyor findings, approve/reject/escalate applications, record approved ledger events.',
      perms: ['parcel:read', 'parcel:update', 'application:read_all', 'application:approve', 'ledger:submit', 'document:verify']
    },
    {
      id: 'ROLE-ADMIN',
      name: 'ADMIN',
      desc: 'Full system administration: users, roles, parcel management, ledger health, backups, and config.',
      perms: ['*']
    },
    {
      id: 'ROLE-AUDITOR',
      name: 'AUDITOR',
      desc: 'Read-only oversight of audit logs, ledger chain integrity, applications, and compliance reports.',
      perms: ['audit:read', 'ledger:read', 'ledger:verify', 'report:export', 'application:read_all', 'parcel:read']
    }
  ];

  const insertRole = db.prepare(
    'INSERT INTO roles (role_id, role_name, description, permissions_json) VALUES (?, ?, ?, ?)'
  );
  for (const r of roles) {
    insertRole.run(r.id, r.name, r.desc, JSON.stringify(r.perms));
  }

  const users: Array<{ id: string; name: string; email: string; contact: string; roleId: string; mfa: number }> = [
    { id: 'USR-DEMO-CIT-01', name: 'Arun Kumar (DEMO Citizen)', email: 'citizen@demo.landgov', contact: '+91-90000-00101', roleId: 'ROLE-CITIZEN', mfa: 0 },
    { id: 'USR-DEMO-CIT-02', name: 'Meera Nair (DEMO Citizen 2)', email: 'citizen2@demo.landgov', contact: '+91-90000-00102', roleId: 'ROLE-CITIZEN', mfa: 0 },
    { id: 'USR-DEMO-CLK-01', name: 'Priya Sharma (DEMO Clerk)', email: 'clerk@demo.landgov', contact: '+91-90000-00201', roleId: 'ROLE-CLERK', mfa: 0 },
    { id: 'USR-DEMO-SRV-01', name: 'Vikram Rao (DEMO Surveyor)', email: 'surveyor@demo.landgov', contact: '+91-90000-00301', roleId: 'ROLE-SURVEYOR', mfa: 0 },
    { id: 'USR-DEMO-OFF-01', name: 'Dr. Kavitha Subramanian (DEMO Approving Officer)', email: 'officer@demo.landgov', contact: '+91-90000-00401', roleId: 'ROLE-OFFICER', mfa: 0 },
    { id: 'USR-DEMO-ADM-01', name: 'Rajan Deshmukh (DEMO Administrator)', email: 'admin@demo.landgov', contact: '+91-90000-00501', roleId: 'ROLE-ADMIN', mfa: 0 },
    { id: 'USR-DEMO-AUD-01', name: 'Lakshmi Menon (DEMO Auditor)', email: 'auditor@demo.landgov', contact: '+91-90000-00601', roleId: 'ROLE-AUDITOR', mfa: 0 }
  ];

  const insertUser = db.prepare(
    'INSERT INTO users (user_id, name, email, contact, password_hash, status, mfa_enabled, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
  );
  const insertUserRole = db.prepare(
    'INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)'
  );

  for (const u of users) {
    insertUser.run(u.id, u.name, u.email, u.contact, demoPasswordHash, 'ACTIVE', u.mfa, now, now);
    insertUserRole.run(u.id, u.roleId, 'SYSTEM_SEED', now);
  }

  // Synthetic DEMO parcels (synthetic bounding coordinates in Chennai for academic GIS visualization only)
  const parcels = [
    {
      parcel_id: 'TN-CHN-PR-000104',
      survey_no: '42/3A',
      locality: 'CHN-ZN-05 (DEMO)',
      area: '1200 sq.ft.',
      land_use: 'Residential',
      geometry_ref: 'GIS-PARCEL-000104',
      centroid_lat: 13.0418,
      centroid_lng: 80.2341,
      geojson_boundary: JSON.stringify({
        type: 'Feature',
        properties: { parcel_id: 'TN-CHN-PR-000104', label: 'DEMO Synthetic Boundary' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[80.2336, 13.0414], [80.2346, 13.0414], [80.2346, 13.0422], [80.2336, 13.0422], [80.2336, 13.0414]]]
        }
      }),
      owner_user_id: 'USR-DEMO-CIT-01',
      owner_display_name: 'Arun Kumar (DEMO)',
      status: 'ACTIVE',
      version: 2
    },
    {
      parcel_id: 'TN-CHN-PR-000105',
      survey_no: '42/3B',
      locality: 'CHN-ZN-05 (DEMO)',
      area: '1850 sq.ft.',
      land_use: 'Mixed Commercial',
      geometry_ref: 'GIS-PARCEL-000105',
      centroid_lat: 13.0427,
      centroid_lng: 80.2355,
      geojson_boundary: JSON.stringify({
        type: 'Feature',
        properties: { parcel_id: 'TN-CHN-PR-000105', label: 'DEMO Synthetic Boundary' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[80.2349, 13.0423], [80.2361, 13.0423], [80.2361, 13.0431], [80.2349, 13.0431], [80.2349, 13.0423]]]
        }
      }),
      owner_user_id: 'USR-DEMO-CIT-01',
      owner_display_name: 'Arun Kumar (DEMO)',
      status: 'UNDER_MUTATION',
      version: 1
    },
    {
      parcel_id: 'TN-CHN-PR-000201',
      survey_no: '118/1C',
      locality: 'CHN-ZN-02 (DEMO)',
      area: '2400 sq.ft.',
      land_use: 'Residential',
      geometry_ref: 'GIS-PARCEL-000201',
      centroid_lat: 13.0604,
      centroid_lng: 80.2496,
      geojson_boundary: JSON.stringify({
        type: 'Feature',
        properties: { parcel_id: 'TN-CHN-PR-000201', label: 'DEMO Synthetic Boundary' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[80.2490, 13.0599], [80.2502, 13.0599], [80.2502, 13.0609], [80.2490, 13.0609], [80.2490, 13.0599]]]
        }
      }),
      owner_user_id: 'USR-DEMO-CIT-02',
      owner_display_name: 'Meera Nair (DEMO)',
      status: 'ACTIVE',
      version: 1
    },
    {
      parcel_id: 'TN-CHN-PR-000312',
      survey_no: '77/2A',
      locality: 'CHN-ZN-08 (DEMO)',
      area: '3600 sq.ft.',
      land_use: 'Agricultural',
      geometry_ref: 'GIS-PARCEL-000312',
      centroid_lat: 13.0124,
      centroid_lng: 80.2215,
      geojson_boundary: JSON.stringify({
        type: 'Feature',
        properties: { parcel_id: 'TN-CHN-PR-000312', label: 'DEMO Synthetic Boundary' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[80.2208, 13.0118], [80.2222, 13.0118], [80.2222, 13.0130], [80.2208, 13.0130], [80.2208, 13.0118]]]
        }
      }),
      owner_user_id: 'USR-DEMO-CIT-02',
      owner_display_name: 'Meera Nair (DEMO)',
      status: 'ACTIVE',
      version: 1
    },
    {
      parcel_id: 'TN-CHN-PR-000409',
      survey_no: '19/4D',
      locality: 'CHN-ZN-03 (DEMO)',
      area: '1500 sq.ft.',
      land_use: 'Institutional',
      geometry_ref: 'GIS-PARCEL-000409',
      centroid_lat: 13.0521,
      centroid_lng: 80.2128,
      geojson_boundary: JSON.stringify({
        type: 'Feature',
        properties: { parcel_id: 'TN-CHN-PR-000409', label: 'DEMO Synthetic Boundary' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[80.2122, 13.0516], [80.2134, 13.0516], [80.2134, 13.0526], [80.2122, 13.0526], [80.2122, 13.0516]]]
        }
      }),
      owner_user_id: 'USR-DEMO-CIT-01',
      owner_display_name: 'Arun Kumar (DEMO)',
      status: 'ACTIVE',
      version: 1
    }
  ];

  const insertParcel = db.prepare(`
    INSERT INTO parcels (
      parcel_id, survey_no, locality, area, land_use, geometry_ref, geojson_boundary,
      centroid_lat, centroid_lng, owner_user_id, owner_display_name, status, version, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  for (const p of parcels) {
    insertParcel.run(
      p.parcel_id, p.survey_no, p.locality, p.area, p.land_use, p.geometry_ref,
      p.geojson_boundary, p.centroid_lat, p.centroid_lng, p.owner_user_id,
      p.owner_display_name, p.status, p.version, now, now
    );
  }

  // Create real synthetic document files in private storage so downloads and SHA-256 verification work out of the box
  const demoDoc1Content = Buffer.from(
    'DEMO ACADEMIC RECORD - REGISTERED SALE DEED EXTRACT\nParcel: TN-CHN-PR-000104\nSurvey No: 42/3A\nLocality: CHN-ZN-05\nNote: Synthetic demonstration document only. Not a legal title instrument.\n',
    'utf-8'
  );
  const demoDoc2Content = Buffer.from(
    'DEMO ACADEMIC RECORD - SURVEY FIELD SKETCH NOTES\nParcel: TN-CHN-PR-000105\nSurvey No: 42/3B\nArea: 1850 sq.ft.\nNote: Synthetic demonstration survey record.\n',
    'utf-8'
  );

  const storageKey1 = `demo-${crypto.randomUUID()}.txt`;
  const storageKey2 = `demo-${crypto.randomUUID()}.txt`;
  fs.writeFileSync(path.join(STORAGE_DIR, storageKey1), demoDoc1Content);
  fs.writeFileSync(path.join(STORAGE_DIR, storageKey2), demoDoc2Content);

  const docHash1 = sha256Hex(demoDoc1Content);
  const docHash2 = sha256Hex(demoDoc2Content);

  // Seed applications
  const insertApp = db.prepare(`
    INSERT INTO applications (
      application_id, parcel_id, applicant_id, type, status, assigned_clerk_id,
      assigned_surveyor_id, assigned_officer_id, proposed_transferee_name,
      summary_notes, expected_parcel_version, approval_reference, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertApp.run(
    'APP-2026-0001',
    'TN-CHN-PR-000104',
    'USR-DEMO-CIT-01',
    'LAND_MUTATION',
    'APPROVED',
    'USR-DEMO-CLK-01',
    'USR-DEMO-SRV-01',
    'USR-DEMO-OFF-01',
    'Arun Kumar (DEMO)',
    'DEMO mutation record update for Survey 42/3A boundary alignment.',
    1,
    'APR-REV-2026-0001',
    now,
    now
  );

  insertApp.run(
    'APP-2026-0002',
    'TN-CHN-PR-000105',
    'USR-DEMO-CIT-01',
    'LAND_TRANSFER',
    'AWAITING_APPROVAL',
    'USR-DEMO-CLK-01',
    'USR-DEMO-SRV-01',
    'USR-DEMO-OFF-01',
    'Suresh Balasubramanian (DEMO)',
    'DEMO transfer request for parcel TN-CHN-PR-000105 pending final officer review.',
    1,
    null,
    now,
    now
  );

  insertApp.run(
    'APP-2026-0003',
    'TN-CHN-PR-000201',
    'USR-DEMO-CIT-02',
    'RECORD_CORRECTION',
    'SUBMITTED',
    'USR-DEMO-CLK-01',
    null,
    null,
    null,
    'DEMO clerical spelling correction on locality metadata for Survey 118/1C.',
    1,
    null,
    now,
    now
  );

  // Seed documents
  const insertDoc = db.prepare(`
    INSERT INTO documents (
      document_id, application_id, parcel_id, uploaded_by, original_filename, mime_type,
      file_size, storage_key, sha256_hash, version, doc_category, is_demo, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  insertDoc.run(
    'DOC-2026-0001',
    'APP-2026-0001',
    'TN-CHN-PR-000104',
    'USR-DEMO-CIT-01',
    'demo_sale_deed_extract_000104.txt',
    'text/plain',
    demoDoc1Content.length,
    storageKey1,
    docHash1,
    1,
    'TITLE_EXTRACT',
    now
  );

  insertDoc.run(
    'DOC-2026-0002',
    'APP-2026-0002',
    'TN-CHN-PR-000105',
    'USR-DEMO-CIT-01',
    'demo_survey_sketch_000105.txt',
    'text/plain',
    demoDoc2Content.length,
    storageKey2,
    docHash2,
    1,
    'SURVEY_SKETCH',
    now
  );

  // Seed reviews
  const insertReview = db.prepare(`
    INSERT INTO reviews (
      review_id, application_id, reviewer_id, reviewer_role, stage, decision, remarks, survey_notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReview.run(
    'REV-2026-0001',
    'APP-2026-0001',
    'USR-DEMO-CLK-01',
    'CLERK',
    'CLERK_VERIFICATION',
    'VERIFIED',
    'DEMO Clerk Check: All mandatory fields and supporting document extract present.',
    null,
    now
  );
  insertReview.run(
    'REV-2026-0002',
    'APP-2026-0001',
    'USR-DEMO-SRV-01',
    'SURVEYOR',
    'SURVEY_VERIFICATION',
    'SURVEY_COMPLETED',
    'DEMO Survey Verification: Boundary reference GIS-PARCEL-000104 verified against synthetic cadastre.',
    'Survey No 42/3A matches 1200 sq.ft. residential footprint.',
    now
  );
  insertReview.run(
    'REV-2026-0003',
    'APP-2026-0001',
    'USR-DEMO-OFF-01',
    'APPROVING_OFFICER',
    'OFFICER_APPROVAL',
    'APPROVED',
    'DEMO Official Approval granted under reference APR-REV-2026-0001.',
    null,
    now
  );

  insertReview.run(
    'REV-2026-0004',
    'APP-2026-0002',
    'USR-DEMO-CLK-01',
    'CLERK',
    'CLERK_VERIFICATION',
    'VERIFIED',
    'DEMO Clerk Check: Application package complete.',
    null,
    now
  );
  insertReview.run(
    'REV-2026-0005',
    'APP-2026-0002',
    'USR-DEMO-SRV-01',
    'SURVEYOR',
    'SURVEY_VERIFICATION',
    'SURVEY_COMPLETED',
    'DEMO Survey Check: GIS-PARCEL-000105 dimensions consistent with synthetic registry.',
    '1850 sq.ft. Mixed Commercial boundary confirmed.',
    now
  );

  // Seed hash-linked simulated Hyperledger Fabric ledger events
  const genesisPrevHash = '0'.repeat(64);
  const insertLedger = db.prepare(`
    INSERT INTO ledger_events (
      event_id, parcel_id, application_id, tx_id, block_number, event_type,
      event_hash, previous_event_hash, parcel_version, approval_reference,
      doc_hash_refs_json, endorser_orgs_json, msp_identity, is_simulated,
      status, error_message, payload_json, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'COMMITTED', NULL, ?, ?)
  `);

  let prevHash = genesisPrevHash;
  let blockNum = 1;

  for (const p of parcels) {
    const payload = {
      parcelId: p.parcel_id,
      surveyNo: p.survey_no,
      locality: p.locality,
      geometryRef: p.geometry_ref,
      eventType: 'PARCEL_GENESIS',
      parcelVersion: 1,
      approvalReference: 'APR-SEED-2026',
      documentHashes: [],
      timestamp: now
    };
    const eventHash = sha256Hex(prevHash + JSON.stringify(payload));
    insertLedger.run(
      `EVT-SEED-${blockNum}`,
      p.parcel_id,
      null,
      `SIM-TX-GENESIS-${p.parcel_id}`,
      blockNum,
      'PARCEL_GENESIS',
      eventHash,
      prevHash,
      1,
      'APR-SEED-2026',
      JSON.stringify([]),
      JSON.stringify(['RevenueDeptMSP', 'SurveyGISMSP', 'RegistrarAuthorityMSP']),
      'Admin@RevenueDeptMSP.demo.fabric',
      JSON.stringify(payload),
      now
    );
    prevHash = eventHash;
    blockNum++;
  }

  // Record the approved mutation event for APP-2026-0001 (parcel version 2)
  const mutPayload = {
    parcelId: 'TN-CHN-PR-000104',
    applicationId: 'APP-2026-0001',
    eventType: 'APPROVED_MUTATION',
    parcelVersion: 2,
    approvalReference: 'APR-REV-2026-0001',
    documentHashes: [docHash1],
    timestamp: now
  };
  const mutEventHash = sha256Hex(prevHash + JSON.stringify(mutPayload));
  insertLedger.run(
    `EVT-2026-0006`,
    'TN-CHN-PR-000104',
    'APP-2026-0001',
    'SIM-TX-20260001-000104',
    blockNum,
    'APPROVED_MUTATION',
    mutEventHash,
    prevHash,
    2,
    'APR-REV-2026-0001',
    JSON.stringify([docHash1]),
    JSON.stringify(['RevenueDeptMSP', 'SurveyGISMSP', 'RegistrarAuthorityMSP']),
    'ApprovingOfficer@RegistrarAuthorityMSP.demo.fabric',
    JSON.stringify(mutPayload),
    now
  );

  // Seed system config
  const insertCfg = db.prepare(
    'INSERT INTO system_config (config_key, config_value, updated_by, updated_at) VALUES (?, ?, ?, ?)'
  );
  insertCfg.run('fabric_network_available', 'true', 'SYSTEM_SEED', now);
  insertCfg.run('fabric_mode', 'simulated', 'SYSTEM_SEED', now);
  insertCfg.run('max_file_size_mb', '10', 'SYSTEM_SEED', now);
  insertCfg.run('lockout_threshold', '5', 'SYSTEM_SEED', now);

  // Seed Fabric MSP certificates
  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const insertCert = db.prepare(`
    INSERT INTO fabric_identities (
      identity_id, org_msp, role_name, common_name, cert_serial, cert_status, expires_at, issued_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCert.run('FID-REV-01', 'RevenueDeptMSP', 'CLERK', 'clerk.revenue.demo.fabric', 'SER-99A1-001', 'ACTIVE', nextYear, now);
  insertCert.run('FID-SRV-01', 'SurveyGISMSP', 'SURVEYOR', 'surveyor.gis.demo.fabric', 'SER-99A1-002', 'ACTIVE', nextYear, now);
  insertCert.run('FID-REG-01', 'RegistrarAuthorityMSP', 'APPROVING_OFFICER', 'officer.registrar.demo.fabric', 'SER-99A1-003', 'ACTIVE', nextYear, now);
  insertCert.run('FID-ADM-01', 'RevenueDeptMSP', 'ADMIN', 'admin.consortium.demo.fabric', 'SER-99A1-004', 'ACTIVE', nextYear, now);

  // Seed notifications
  const insertNotif = db.prepare(`
    INSERT INTO notifications (notification_id, user_id, title, message, type, related_object_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `);
  insertNotif.run(
    'NTF-DEMO-01',
    'USR-DEMO-CIT-01',
    'Application APP-2026-0001 Approved & Recorded',
    'Your DEMO mutation application APP-2026-0001 for parcel TN-CHN-PR-000104 was approved (APR-REV-2026-0001) and recorded on the simulated Fabric ledger.',
    'APPROVAL',
    'APP-2026-0001',
    now
  );
  insertNotif.run(
    'NTF-DEMO-02',
    'USR-DEMO-OFF-01',
    'Pending Final Review: APP-2026-0002',
    'Transfer application APP-2026-0002 (Parcel TN-CHN-PR-000105) has cleared Clerk and Surveyor verification and awaits your decision.',
    'PENDING_ACTION',
    'APP-2026-0002',
    now
  );
  insertNotif.run(
    'NTF-DEMO-03',
    'USR-DEMO-CLK-01',
    'New Submission: APP-2026-0003',
    'Record correction application APP-2026-0003 (Parcel TN-CHN-PR-000201) requires clerk completeness verification.',
    'SUBMISSION',
    'APP-2026-0003',
    now
  );

  // Seed initial audit log
  db.prepare(`
    INSERT INTO audit_logs (log_id, actor_id, actor_role, action, object_type, object_id, details_json, ip_address, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'LOG-SEED-0001',
    'SYSTEM_SEED',
    'ADMIN',
    'SYSTEM_INITIALIZED',
    'DATABASE',
    'land_records.db',
    JSON.stringify({ mode: 'DEMO_ACADEMIC_PROTOTYPE', seededParcels: parcels.length }),
    '127.0.0.1',
    now
  );
}
