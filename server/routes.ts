import crypto from 'node:crypto';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  type AuthRequest,
  createNotification,
  hasAnyRole,
  hashPassword,
  logAudit,
  requireAuth,
  requireRole,
  signAuthToken,
  verifyPassword,
  getUserWithRolesById
} from './auth.ts';
import { createSystemBackup, restoreSystemBackup } from './backup.ts';
import {
  isFabricNetworkAvailable,
  setFabricNetworkAvailability,
  submitApprovedApplicationToLedger,
  verifyLedgerChain
} from './blockchain.ts';
import { getDb, type RoleName } from './db.ts';
import {
  computeBufferSha256,
  getPrivateDocumentPath,
  savePrivateDocument,
  uploadMiddleware,
  validateUploadedFile
} from './storage.ts';

export const apiRouter = express.Router();

function parseBoolean(val: unknown): boolean {
  return val === true || val === 'true' || val === 1 || val === '1';
}

function handleMulterUpload(req: Request, res: Response, next: NextFunction): void {
  uploadMiddleware.single('file')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'File upload error.';
      res.status(400).json({ error: message });
      return;
    }
    next();
  });
}

function userCanAccessParcel(userId: string, roles: RoleName[], parcelId: string): boolean {
  if (roles.some((r) => r !== 'CITIZEN')) return true;
  const db = getDb();
  const owned = db
    .prepare('SELECT 1 FROM parcels WHERE parcel_id = ? AND owner_user_id = ?')
    .get(parcelId, userId);
  if (owned) return true;

  const hasApp = db
    .prepare('SELECT 1 FROM applications WHERE parcel_id = ? AND applicant_id = ? LIMIT 1')
    .get(parcelId, userId);
  return Boolean(hasApp);
}

// ============================================================================
// HEALTH CHECK
// ============================================================================
apiRouter.get('/health', (_req, res) => {
  const db = getDb();
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  res.json({
    status: 'OK',
    service: 'CivicLedger Land Record API',
    database: 'CONNECTED (SQLite WAL)',
    fabricMode: 'SIMULATED_PERMISSIONED_NETWORK',
    fabricAvailable: isFabricNetworkAvailable(),
    usersCount: userCount,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// AUTHENTICATION & ACCOUNT MANAGEMENT
// ============================================================================
apiRouter.post('/auth/register', (req, res) => {
  const { name, email, contact, password } = req.body || {};
  if (!name || !email || !contact || !password) {
    res.status(400).json({ error: 'Name, email, contact, and password are all required.' });
    return;
  }
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    return;
  }

  const db = getDb();
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT user_id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists.' });
    return;
  }

  const userId = `USR-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();
  const passwordHash = hashPassword(password);

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `INSERT INTO users (user_id, name, email, contact, password_hash, status, mfa_enabled, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0, 0, ?, ?)`
    ).run(userId, String(name).trim(), normalizedEmail, String(contact).trim(), passwordHash, now, now);

    db.prepare(
      `INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at)
       VALUES (?, 'ROLE-CITIZEN', 'SELF_REGISTRATION', ?)`
    ).run(userId, now);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const user = getUserWithRolesById(userId)!;
  const token = signAuthToken(user);

  logAudit({
    actorId: userId,
    actorRole: 'CITIZEN',
    action: 'USER_REGISTERED',
    objectType: 'USER',
    objectId: userId,
    details: { email: normalizedEmail },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.cookie('civicledger_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  });
  res.status(201).json({ user, token });
});

apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  const db = getDb();
  const normalizedEmail = String(email).trim().toLowerCase();
  const userRow = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(normalizedEmail) as
    | {
        user_id: string;
        email: string;
        password_hash: string;
        status: string;
        failed_attempts: number;
        locked_until: string | null;
        mfa_enabled: number;
      }
    | undefined;

  if (!userRow) {
    logAudit({
      actorId: null,
      actorRole: null,
      action: 'LOGIN_FAILED',
      objectType: 'AUTH',
      objectId: normalizedEmail,
      details: { reason: 'UNKNOWN_EMAIL' },
      ipAddress: req.ip || '127.0.0.1'
    });
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  if (userRow.status === 'SUSPENDED') {
    res.status(403).json({ error: 'Account has been suspended by an administrator.' });
    return;
  }

  if (userRow.status === 'LOCKED' || (userRow.locked_until && new Date(userRow.locked_until) > new Date())) {
    res.status(423).json({
      error: 'Account is temporarily locked due to multiple failed login attempts. Try again later or contact an administrator.'
    });
    return;
  }

  if (!verifyPassword(String(password), userRow.password_hash)) {
    const thresholdCfg = db
      .prepare("SELECT config_value FROM system_config WHERE config_key = 'lockout_threshold'")
      .get() as { config_value: string } | undefined;
    const threshold = Number(thresholdCfg?.config_value || 5);
    const nextAttempts = (userRow.failed_attempts || 0) + 1;
    const shouldLock = nextAttempts >= threshold;
    const lockedUntil = shouldLock ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;

    db.prepare(
      `UPDATE users SET failed_attempts = ?, status = ?, locked_until = ?, updated_at = ? WHERE user_id = ?`
    ).run(
      nextAttempts,
      shouldLock ? 'LOCKED' : 'ACTIVE',
      lockedUntil,
      new Date().toISOString(),
      userRow.user_id
    );

    logAudit({
      actorId: userRow.user_id,
      actorRole: null,
      action: shouldLock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
      objectType: 'USER',
      objectId: userRow.user_id,
      details: { failedAttempts: nextAttempts },
      ipAddress: req.ip || '127.0.0.1'
    });

    res.status(401).json({
      error: shouldLock
        ? 'Account locked after repeated invalid password attempts.'
        : 'Invalid email or password.'
    });
    return;
  }

  // Reset failed attempts on valid password
  db.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, status = 'ACTIVE', updated_at = ? WHERE user_id = ?`
  ).run(new Date().toISOString(), userRow.user_id);

  // Check optional MFA
  if (userRow.mfa_enabled) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET mfa_code = ?, mfa_expires_at = ? WHERE user_id = ?').run(
      code,
      expiresAt,
      userRow.user_id
    );
    res.json({
      mfaRequired: true,
      userId: userRow.user_id,
      message: 'MFA verification code issued.',
      demoMfaCode: code
    });
    return;
  }

  const user = getUserWithRolesById(userRow.user_id)!;
  const token = signAuthToken(user);

  logAudit({
    actorId: user.user_id,
    actorRole: user.roles.join(','),
    action: 'LOGIN_SUCCESS',
    objectType: 'USER',
    objectId: user.user_id,
    details: { roles: user.roles },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.cookie('civicledger_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ user, token });
});

apiRouter.post('/auth/mfa/verify', (req, res) => {
  const { userId, code } = req.body || {};
  if (!userId || !code) {
    res.status(400).json({ error: 'userId and MFA code are required.' });
    return;
  }
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, mfa_code, mfa_expires_at FROM users WHERE user_id = ?')
    .get(String(userId)) as { user_id: string; mfa_code: string | null; mfa_expires_at: string | null } | undefined;

  if (!row || !row.mfa_code || row.mfa_code !== String(code).trim()) {
    res.status(401).json({ error: 'Invalid MFA verification code.' });
    return;
  }
  if (!row.mfa_expires_at || new Date(row.mfa_expires_at) < new Date()) {
    res.status(401).json({ error: 'MFA verification code has expired.' });
    return;
  }

  db.prepare('UPDATE users SET mfa_code = NULL, mfa_expires_at = NULL WHERE user_id = ?').run(row.user_id);
  const user = getUserWithRolesById(row.user_id)!;
  const token = signAuthToken(user);

  logAudit({
    actorId: user.user_id,
    actorRole: user.roles.join(','),
    action: 'MFA_VERIFIED_LOGIN',
    objectType: 'USER',
    objectId: user.user_id,
    ipAddress: req.ip || '127.0.0.1'
  });

  res.cookie('civicledger_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ user, token });
});

apiRouter.post('/auth/logout', requireAuth, (req: AuthRequest, res) => {
  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'LOGOUT',
    objectType: 'USER',
    objectId: req.user!.user_id,
    ipAddress: req.ip || '127.0.0.1'
  });
  res.clearCookie('civicledger_token');
  res.json({ ok: true });
});

apiRouter.get('/auth/me', requireAuth, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

apiRouter.post('/auth/mfa/toggle', requireAuth, (req: AuthRequest, res) => {
  const enabled = parseBoolean(req.body?.enabled);
  const db = getDb();
  db.prepare('UPDATE users SET mfa_enabled = ?, updated_at = ? WHERE user_id = ?').run(
    enabled ? 1 : 0,
    new Date().toISOString(),
    req.user!.user_id
  );
  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: enabled ? 'MFA_ENABLED' : 'MFA_DISABLED',
    objectType: 'USER',
    objectId: req.user!.user_id,
    ipAddress: req.ip || '127.0.0.1'
  });
  res.json({ mfa_enabled: enabled, user: getUserWithRolesById(req.user!.user_id) });
});

apiRouter.post('/auth/change-password', requireAuth, (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 8) {
    res.status(400).json({ error: 'Current password and new password (min 8 chars) are required.' });
    return;
  }
  const db = getDb();
  const row = db
    .prepare('SELECT password_hash FROM users WHERE user_id = ?')
    .get(req.user!.user_id) as { password_hash: string } | undefined;
  if (!row || !verifyPassword(String(currentPassword), row.password_hash)) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?').run(
    hashPassword(String(newPassword)),
    new Date().toISOString(),
    req.user!.user_id
  );
  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'PASSWORD_CHANGED',
    objectType: 'USER',
    objectId: req.user!.user_id,
    ipAddress: req.ip || '127.0.0.1'
  });
  res.json({ ok: true, message: 'Password updated successfully.' });
});

apiRouter.post('/auth/password-reset/request', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) {
    res.status(400).json({ error: 'Email is required.' });
    return;
  }
  const db = getDb();
  const user = db.prepare('SELECT user_id FROM users WHERE email = ?').get(email) as { user_id: string } | undefined;
  if (!user) {
    res.json({ ok: true, message: 'If an account matches that email, a reset token has been generated.' });
    return;
  }
  const token = `RST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO password_resets (reset_id, user_id, token, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(`PR-${Date.now()}`, user.user_id, token, expiresAt, now);

  logAudit({
    actorId: user.user_id,
    actorRole: null,
    action: 'PASSWORD_RESET_REQUESTED',
    objectType: 'USER',
    objectId: user.user_id,
    ipAddress: req.ip || '127.0.0.1'
  });

  res.json({
    ok: true,
    message: 'Password reset token generated for academic prototype demonstration.',
    demoResetToken: token
  });
});

apiRouter.post('/auth/password-reset/confirm', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || String(newPassword).length < 8) {
    res.status(400).json({ error: 'Valid reset token and new password (min 8 characters) are required.' });
    return;
  }
  const db = getDb();
  const resetRow = db
    .prepare('SELECT * FROM password_resets WHERE token = ? AND used = 0')
    .get(String(token).trim()) as
    | { reset_id: string; user_id: string; expires_at: string }
    | undefined;

  if (!resetRow || new Date(resetRow.expires_at) < new Date()) {
    res.status(400).json({ error: 'Invalid or expired password reset token.' });
    return;
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `UPDATE users SET password_hash = ?, status = 'ACTIVE', failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?`
    ).run(hashPassword(String(newPassword)), new Date().toISOString(), resetRow.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE reset_id = ?').run(resetRow.reset_id);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  logAudit({
    actorId: resetRow.user_id,
    actorRole: null,
    action: 'PASSWORD_RESET_COMPLETED',
    objectType: 'USER',
    objectId: resetRow.user_id,
    ipAddress: req.ip || '127.0.0.1'
  });

  res.json({ ok: true, message: 'Password updated successfully. You may now sign in.' });
});

// ============================================================================
// PARCEL MANAGEMENT & GIS
// ============================================================================
apiRouter.get('/parcels', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const user = req.user!;
  const q = String(req.query.q || '').trim();
  const isStaff = hasAnyRole(user, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);

  let rows: Array<Record<string, unknown>>;
  if (isStaff) {
    if (q) {
      const pattern = `%${q}%`;
      rows = db
        .prepare(
          `SELECT * FROM parcels
           WHERE parcel_id LIKE ? OR survey_no LIKE ? OR locality LIKE ? OR owner_display_name LIKE ?
           ORDER BY updated_at DESC`
        )
        .all(pattern, pattern, pattern, pattern) as Array<Record<string, unknown>>;
    } else {
      rows = db.prepare('SELECT * FROM parcels ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
    }
  } else {
    // Citizen only views permitted parcels (owned by them or linked to their applications)
    if (q) {
      const pattern = `%${q}%`;
      rows = db
        .prepare(
          `SELECT DISTINCT p.* FROM parcels p
           LEFT JOIN applications a ON p.parcel_id = a.parcel_id AND a.applicant_id = ?
           WHERE (p.owner_user_id = ? OR a.application_id IS NOT NULL)
             AND (p.parcel_id LIKE ? OR p.survey_no LIKE ? OR p.locality LIKE ?)
           ORDER BY p.updated_at DESC`
        )
        .all(user.user_id, user.user_id, pattern, pattern, pattern) as Array<Record<string, unknown>>;
    } else {
      rows = db
        .prepare(
          `SELECT DISTINCT p.* FROM parcels p
           LEFT JOIN applications a ON p.parcel_id = a.parcel_id AND a.applicant_id = ?
           WHERE p.owner_user_id = ? OR a.application_id IS NOT NULL
           ORDER BY p.updated_at DESC`
        )
        .all(user.user_id, user.user_id) as Array<Record<string, unknown>>;
    }
  }

  res.json({
    parcels: rows.map((r) => ({
      ...r,
      geojson_boundary: JSON.parse(String(r.geojson_boundary || '{}'))
    }))
  });
});

apiRouter.get('/parcels/:parcel_id', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const parcelId = String(req.params.parcel_id);
  const parcel = db.prepare('SELECT * FROM parcels WHERE parcel_id = ?').get(parcelId) as
    | Record<string, unknown>
    | undefined;

  if (!parcel) {
    res.status(404).json({ error: `Parcel ${parcelId} not found.` });
    return;
  }

  if (!userCanAccessParcel(req.user!.user_id, req.user!.roles, parcelId)) {
    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: 'UNAUTHORIZED_PARCEL_ACCESS',
      objectType: 'PARCEL',
      objectId: parcelId,
      ipAddress: req.ip || '127.0.0.1'
    });
    res.status(403).json({
      error: 'Unauthorized parcel access. Citizens may only access permitted parcel records.'
    });
    return;
  }

  const apps = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR'])
    ? db.prepare('SELECT * FROM applications WHERE parcel_id = ? ORDER BY submitted_at DESC').all(parcelId)
    : db
        .prepare('SELECT * FROM applications WHERE parcel_id = ? AND applicant_id = ? ORDER BY submitted_at DESC')
        .all(parcelId, req.user!.user_id);

  const docs = db
    .prepare(
      `SELECT d.document_id, d.application_id, d.parcel_id, d.original_filename, d.mime_type,
              d.file_size, d.sha256_hash, d.version, d.doc_category, d.is_demo, d.created_at
       FROM documents d WHERE d.parcel_id = ? ORDER BY d.created_at DESC`
    )
    .all(parcelId);

  const events = db
    .prepare('SELECT * FROM ledger_events WHERE parcel_id = ? ORDER BY block_number DESC')
    .all(parcelId);

  res.json({
    parcel: {
      ...parcel,
      geojson_boundary: JSON.parse(String(parcel.geojson_boundary || '{}'))
    },
    applications: apps,
    documents: docs,
    ledgerEvents: events
  });
});

apiRouter.post('/parcels', requireAuth, requireRole('ADMIN', 'APPROVING_OFFICER'), (req: AuthRequest, res) => {
  const {
    parcel_id,
    survey_no,
    locality,
    area,
    land_use,
    geometry_ref,
    owner_user_id,
    owner_display_name,
    centroid_lat,
    centroid_lng
  } = req.body || {};

  if (!parcel_id || !survey_no || !locality || !area || !land_use || !owner_display_name) {
    res.status(400).json({
      error: 'parcel_id, survey_no, locality, area, land_use, and owner_display_name are required.'
    });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT parcel_id FROM parcels WHERE parcel_id = ?').get(String(parcel_id));
  if (existing) {
    res.status(409).json({ error: `Parcel ${parcel_id} already exists.` });
    return;
  }

  const lat = Number(centroid_lat) || 13.045;
  const lng = Number(centroid_lng) || 80.235;
  const geomRef = geometry_ref || `GIS-${parcel_id}`;
  const geojson = JSON.stringify({
    type: 'Feature',
    properties: { parcel_id, label: 'DEMO Synthetic Boundary' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[lng - 0.0005, lat - 0.0004], [lng + 0.0005, lat - 0.0004], [lng + 0.0005, lat + 0.0004], [lng - 0.0005, lat + 0.0004], [lng - 0.0005, lat - 0.0004]]]
    }
  });
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO parcels (
      parcel_id, survey_no, locality, area, land_use, geometry_ref, geojson_boundary,
      centroid_lat, centroid_lng, owner_user_id, owner_display_name, status, version, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, 1, ?, ?)`
  ).run(
    String(parcel_id).trim(),
    String(survey_no).trim(),
    String(locality).trim(),
    String(area).trim(),
    String(land_use).trim(),
    String(geomRef).trim(),
    geojson,
    lat,
    lng,
    owner_user_id || null,
    String(owner_display_name).trim(),
    now,
    now
  );

  // Record genesis event if network available
  if (isFabricNetworkAvailable()) {
    const latestCommitted = db
      .prepare("SELECT event_hash, block_number FROM ledger_events WHERE status = 'COMMITTED' ORDER BY block_number DESC LIMIT 1")
      .get() as { event_hash: string; block_number: number } | undefined;
    const prevHash = latestCommitted ? latestCommitted.event_hash : '0'.repeat(64);
    const nextBlock = (latestCommitted ? latestCommitted.block_number : 0) + 1;
    const payload = {
      parcelId: String(parcel_id).trim(),
      surveyNo: String(survey_no).trim(),
      locality: String(locality).trim(),
      geometryRef: String(geomRef).trim(),
      eventType: 'PARCEL_GENESIS',
      parcelVersion: 1,
      approvalReference: `APR-ADM-${Date.now()}`,
      documentHashes: [],
      timestamp: now
    };
    const eventHash = crypto.createHash('sha256').update(prevHash + JSON.stringify(payload)).digest('hex');
    db.prepare(
      `INSERT INTO ledger_events (
        event_id, parcel_id, application_id, tx_id, block_number, event_type,
        event_hash, previous_event_hash, parcel_version, approval_reference,
        doc_hash_refs_json, endorser_orgs_json, msp_identity, is_simulated,
        status, error_message, payload_json, timestamp
      ) VALUES (?, ?, NULL, ?, ?, 'PARCEL_GENESIS', ?, ?, 1, ?, '[]', ?, ?, 1, 'COMMITTED', NULL, ?, ?)`
    ).run(
      `EVT-${Date.now()}`,
      String(parcel_id).trim(),
      `SIM-TX-GENESIS-${Date.now().toString(36).toUpperCase()}`,
      nextBlock,
      eventHash,
      prevHash,
      payload.approvalReference,
      JSON.stringify(['RevenueDeptMSP', 'SurveyGISMSP', 'RegistrarAuthorityMSP']),
      `${req.user!.email} (AdminMSP)`,
      JSON.stringify(payload),
      now
    );
  }

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'PARCEL_CREATED',
    objectType: 'PARCEL',
    objectId: String(parcel_id).trim(),
    ipAddress: req.ip || '127.0.0.1'
  });

  res.status(201).json({ parcel: db.prepare('SELECT * FROM parcels WHERE parcel_id = ?').get(String(parcel_id).trim()) });
});

apiRouter.patch(
  '/parcels/:parcel_id',
  requireAuth,
  requireRole('ADMIN', 'APPROVING_OFFICER', 'SURVEYOR'),
  (req: AuthRequest, res) => {
    const db = getDb();
    const parcelId = String(req.params.parcel_id);
    const parcel = db.prepare('SELECT * FROM parcels WHERE parcel_id = ?').get(parcelId) as
      | Record<string, unknown>
      | undefined;
    if (!parcel) {
      res.status(404).json({ error: `Parcel ${parcelId} not found.` });
      return;
    }

    const { area, land_use, geometry_ref, locality, status } = req.body || {};
    const isSurveyorOnly =
      req.user!.roles.includes('SURVEYOR') && !hasAnyRole(req.user!, ['ADMIN', 'APPROVING_OFFICER']);

    const nextArea = area ? String(area) : String(parcel.area);
    const nextGeom = geometry_ref ? String(geometry_ref) : String(parcel.geometry_ref);
    const nextLandUse = !isSurveyorOnly && land_use ? String(land_use) : String(parcel.land_use);
    const nextLocality = !isSurveyorOnly && locality ? String(locality) : String(parcel.locality);
    const nextStatus = !isSurveyorOnly && status ? String(status) : String(parcel.status);

    db.prepare(
      `UPDATE parcels SET area = ?, geometry_ref = ?, land_use = ?, locality = ?, status = ?, updated_at = ?
       WHERE parcel_id = ?`
    ).run(nextArea, nextGeom, nextLandUse, nextLocality, nextStatus, new Date().toISOString(), parcelId);

    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: 'PARCEL_METADATA_UPDATED',
      objectType: 'PARCEL',
      objectId: parcelId,
      details: { area: nextArea, geometry_ref: nextGeom, land_use: nextLandUse },
      ipAddress: req.ip || '127.0.0.1'
    });

    res.json({ parcel: db.prepare('SELECT * FROM parcels WHERE parcel_id = ?').get(parcelId) });
  }
);

apiRouter.get('/parcels/:id/history', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const parcelId = String(req.params.id);
  const parcel = db.prepare('SELECT * FROM parcels WHERE parcel_id = ?').get(parcelId);
  if (!parcel) {
    res.status(404).json({ error: `Parcel ${parcelId} not found.` });
    return;
  }

  if (!userCanAccessParcel(req.user!.user_id, req.user!.roles, parcelId)) {
    res.status(403).json({ error: 'Unauthorized access to parcel history.' });
    return;
  }

  const events = db
    .prepare('SELECT * FROM ledger_events WHERE parcel_id = ? ORDER BY block_number ASC')
    .all(parcelId);

  const reviews = db
    .prepare(
      `SELECT r.*, a.parcel_id, a.type as application_type
       FROM reviews r
       JOIN applications a ON r.application_id = a.application_id
       WHERE a.parcel_id = ?
       ORDER BY r.created_at ASC`
    )
    .all(parcelId);

  res.json({ parcelId, events, reviews });
});

// ============================================================================
// APPLICATIONS WORKFLOW
// ============================================================================
apiRouter.post('/applications', requireAuth, (req: AuthRequest, res) => {
  const { parcel_id, type, summary_notes, proposed_transferee_name } = req.body || {};
  const validTypes = new Set(['LAND_TRANSFER', 'LAND_MUTATION', 'RECORD_CORRECTION', 'DOCUMENT_VERIFICATION']);

  // Mandatory field validation (TC-05)
  if (!parcel_id || !type || !summary_notes || String(summary_notes).trim().length < 5) {
    res.status(400).json({
      error: 'Missing mandatory fields: parcel_id, type, and summary_notes (min 5 characters) are required.'
    });
    return;
  }
  if (!validTypes.has(String(type))) {
    res.status(400).json({ error: 'Invalid application type.' });
    return;
  }
  if (type === 'LAND_TRANSFER' && (!proposed_transferee_name || !String(proposed_transferee_name).trim())) {
    res.status(400).json({
      error: 'Missing mandatory field: proposed_transferee_name is required for LAND_TRANSFER applications.'
    });
    return;
  }

  const db = getDb();
  const parcel = db.prepare('SELECT * FROM parcels WHERE parcel_id = ?').get(String(parcel_id)) as
    | { parcel_id: string; owner_user_id: string | null; version: number }
    | undefined;

  if (!parcel) {
    res.status(404).json({ error: `Parcel ${parcel_id} does not exist.` });
    return;
  }

  if (req.user!.roles.includes('CITIZEN') && parcel.owner_user_id !== req.user!.user_id) {
    res.status(403).json({
      error: 'Citizens can only submit applications for parcels registered under their permitted account.'
    });
    return;
  }

  const appId = `APP-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}-${crypto
    .randomBytes(1)
    .toString('hex')
    .toUpperCase()}`;
  const now = new Date().toISOString();

  // Assign default demo clerk if available
  const defaultClerk = db
    .prepare(
      `SELECT u.user_id FROM users u
       JOIN user_roles ur ON u.user_id = ur.user_id
       JOIN roles r ON ur.role_id = r.role_id
       WHERE r.role_name = 'CLERK' AND u.status = 'ACTIVE' LIMIT 1`
    )
    .get() as { user_id: string } | undefined;

  db.prepare(
    `INSERT INTO applications (
      application_id, parcel_id, applicant_id, type, status, assigned_clerk_id,
      proposed_transferee_name, summary_notes, expected_parcel_version, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?, ?, ?)`
  ).run(
    appId,
    parcel.parcel_id,
    req.user!.user_id,
    String(type),
    defaultClerk?.user_id || null,
    proposed_transferee_name ? String(proposed_transferee_name).trim() : null,
    String(summary_notes).trim(),
    parcel.version,
    now,
    now
  );

  // Update parcel status when mutation/transfer starts
  if (type === 'LAND_TRANSFER' || type === 'LAND_MUTATION') {
    db.prepare("UPDATE parcels SET status = 'UNDER_MUTATION', updated_at = ? WHERE parcel_id = ?").run(
      now,
      parcel.parcel_id
    );
  }

  createNotification({
    userId: req.user!.user_id,
    title: `Application ${appId} Submitted`,
    message: `Your ${String(type).replace('_', ' ')} application for parcel ${parcel.parcel_id} was submitted.`,
    type: 'SUBMISSION',
    relatedObjectId: appId
  });

  if (defaultClerk?.user_id) {
    createNotification({
      userId: defaultClerk.user_id,
      title: `New Application Assigned: ${appId}`,
      message: `Application ${appId} for parcel ${parcel.parcel_id} is ready for clerk completeness review.`,
      type: 'PENDING_ACTION',
      relatedObjectId: appId
    });
  }

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'APPLICATION_SUBMITTED',
    objectType: 'APPLICATION',
    objectId: appId,
    details: { parcel_id: parcel.parcel_id, type, expected_parcel_version: parcel.version },
    ipAddress: req.ip || '127.0.0.1'
  });

  const created = db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId);
  res.status(201).json({ application: created });
});

apiRouter.get('/applications', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const user = req.user!;
  const isStaff = hasAnyRole(user, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  const statusFilter = String(req.query.status || '').trim();
  const typeFilter = String(req.query.type || '').trim();

  const conditions: string[] = [];
  const params: Array<string> = [];

  if (!isStaff) {
    conditions.push('a.applicant_id = ?');
    params.push(user.user_id);
  }
  if (statusFilter) {
    conditions.push('a.status = ?');
    params.push(statusFilter);
  }
  if (typeFilter) {
    conditions.push('a.type = ?');
    params.push(typeFilter);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT a.*, p.survey_no, p.locality, p.area, p.land_use, p.version as current_parcel_version,
              u.name as applicant_name, u.email as applicant_email
       FROM applications a
       JOIN parcels p ON a.parcel_id = p.parcel_id
       JOIN users u ON a.applicant_id = u.user_id
       ${whereSql}
       ORDER BY a.updated_at DESC`
    )
    .all(...params);

  res.json({ applications: rows });
});

apiRouter.get('/applications/:id', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const appId = String(req.params.id);
  const app = db
    .prepare(
      `SELECT a.*, p.survey_no, p.locality, p.area, p.land_use, p.geometry_ref,
              p.version as current_parcel_version, p.owner_display_name,
              u.name as applicant_name, u.email as applicant_email
       FROM applications a
       JOIN parcels p ON a.parcel_id = p.parcel_id
       JOIN users u ON a.applicant_id = u.user_id
       WHERE a.application_id = ?`
    )
    .get(appId) as (Record<string, unknown> & { applicant_id: string }) | undefined;

  if (!app) {
    res.status(404).json({ error: `Application ${appId} not found.` });
    return;
  }

  const isStaff = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  if (!isStaff && app.applicant_id !== req.user!.user_id) {
    res.status(403).json({ error: 'Access denied. You can only view your own applications.' });
    return;
  }

  const documents = db
    .prepare(
      `SELECT document_id, application_id, parcel_id, uploaded_by, original_filename,
              mime_type, file_size, sha256_hash, version, doc_category, is_demo, created_at
       FROM documents WHERE application_id = ? ORDER BY created_at DESC`
    )
    .all(appId);

  const reviews = db
    .prepare(
      `SELECT r.*, u.name as reviewer_name
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.user_id
       WHERE r.application_id = ?
       ORDER BY r.created_at ASC`
    )
    .all(appId);

  const ledgerEvents = db
    .prepare('SELECT * FROM ledger_events WHERE application_id = ? ORDER BY timestamp DESC')
    .all(appId);

  res.json({ application: app, documents, reviews, ledgerEvents });
});

apiRouter.post('/applications/:id/documents', requireAuth, handleMulterUpload, (req: AuthRequest, res) => {
  const db = getDb();
  const appId = String(req.params.id);
  const app = db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId) as
    | { application_id: string; parcel_id: string; applicant_id: string }
    | undefined;

  if (!app) {
    res.status(404).json({ error: `Application ${appId} not found.` });
    return;
  }

  const isStaff = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN']);
  if (!isStaff && app.applicant_id !== req.user!.user_id) {
    res.status(403).json({ error: 'You cannot upload documents to another user application.' });
    return;
  }

  const validation = validateUploadedFile(req.file);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const docCategory = String(req.body?.doc_category || 'SUPPORTING_DOCUMENT').trim();
  const saved = savePrivateDocument({
    file: req.file!,
    applicationId: app.application_id,
    parcelId: app.parcel_id,
    uploadedBy: req.user!.user_id,
    docCategory
  });

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'DOCUMENT_UPLOADED',
    objectType: 'DOCUMENT',
    objectId: saved.document_id,
    details: {
      application_id: app.application_id,
      sha256_hash: saved.sha256_hash,
      version: saved.version
    },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.status(201).json({ document: saved });
});

apiRouter.post(
  '/applications/:id/assign',
  requireAuth,
  requireRole('CLERK', 'ADMIN'),
  (req: AuthRequest, res) => {
    const db = getDb();
    const appId = String(req.params.id);
    const { surveyor_id, officer_id, remarks } = req.body || {};
    const app = db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId) as
      | { application_id: string; parcel_id: string }
      | undefined;

    if (!app) {
      res.status(404).json({ error: `Application ${appId} not found.` });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE applications SET assigned_surveyor_id = COALESCE(?, assigned_surveyor_id),
              assigned_officer_id = COALESCE(?, assigned_officer_id), updated_at = ?
       WHERE application_id = ?`
    ).run(surveyor_id || null, officer_id || null, now, appId);

    db.prepare(
      `INSERT INTO reviews (review_id, application_id, reviewer_id, reviewer_role, stage, decision, remarks, created_at)
       VALUES (?, ?, ?, ?, 'ASSIGNMENT', 'ASSIGNED', ?, ?)`
    ).run(
      `REV-${Date.now()}`,
      appId,
      req.user!.user_id,
      req.user!.roles[0],
      remarks || 'Application assigned to reviewer.',
      now
    );

    if (surveyor_id) {
      createNotification({
        userId: String(surveyor_id),
        title: `Survey Assignment: ${appId}`,
        message: `Application ${appId} (Parcel ${app.parcel_id}) has been assigned to you for boundary & evidence verification.`,
        type: 'ASSIGNMENT',
        relatedObjectId: appId
      });
    }

    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: 'APPLICATION_ASSIGNED',
      objectType: 'APPLICATION',
      objectId: appId,
      details: { surveyor_id, officer_id },
      ipAddress: req.ip || '127.0.0.1'
    });

    res.json({ application: db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId) });
  }
);

apiRouter.post(
  '/applications/:id/review',
  requireAuth,
  requireRole('CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN'),
  (req: AuthRequest, res) => {
    const db = getDb();
    const appId = String(req.params.id);
    const { decision, remarks, survey_notes } = req.body || {};

    if (!decision || !remarks || String(remarks).trim().length < 3) {
      res.status(400).json({ error: 'Decision and review remarks are required.' });
      return;
    }

    const app = db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId) as
      | { application_id: string; parcel_id: string; applicant_id: string; status: string }
      | undefined;

    if (!app) {
      res.status(404).json({ error: `Application ${appId} not found.` });
      return;
    }

    const user = req.user!;
    const now = new Date().toISOString();
    let nextStatus = app.status;
    let stage = 'REVIEW';
    let reviewDecision = String(decision);

    // Enforce role-specific review permissions (clerks cannot approve!)
    if (reviewDecision === 'APPROVED' || reviewDecision === 'REJECTED') {
      res.status(403).json({
        error: 'Final approval or rejection must be performed through /api/applications/:id/approve by an Approving Officer.'
      });
      return;
    }

    if (user.roles.includes('CLERK') && !hasAnyRole(user, ['ADMIN'])) {
      stage = 'CLERK_VERIFICATION';
      if (reviewDecision === 'VERIFIED') {
        nextStatus = 'SURVEY_IN_PROGRESS';
        // Assign default surveyor if none assigned
        const defSurveyor = db
          .prepare(
            `SELECT u.user_id FROM users u JOIN user_roles ur ON u.user_id = ur.user_id JOIN roles r ON ur.role_id = r.role_id WHERE r.role_name = 'SURVEYOR' LIMIT 1`
          )
          .get() as { user_id: string } | undefined;
        if (defSurveyor) {
          db.prepare('UPDATE applications SET assigned_surveyor_id = COALESCE(assigned_surveyor_id, ?) WHERE application_id = ?').run(
            defSurveyor.user_id,
            appId
          );
          createNotification({
            userId: defSurveyor.user_id,
            title: `Survey Required: ${appId}`,
            message: `Clerk verified ${appId} for parcel ${app.parcel_id}. Ready for survey evidence review.`,
            type: 'PENDING_ACTION',
            relatedObjectId: appId
          });
        }
      } else if (reviewDecision === 'RETURNED') {
        nextStatus = 'RETURNED_FOR_CORRECTION';
      } else {
        res.status(400).json({ error: 'Clerks can submit VERIFIED or RETURNED decisions.' });
        return;
      }
    } else if (user.roles.includes('SURVEYOR') && !hasAnyRole(user, ['ADMIN'])) {
      stage = 'SURVEY_VERIFICATION';
      if (reviewDecision === 'SURVEY_COMPLETED' || reviewDecision === 'VERIFIED') {
        reviewDecision = 'SURVEY_COMPLETED';
        nextStatus = 'AWAITING_APPROVAL';
        const defOfficer = db
          .prepare(
            `SELECT u.user_id FROM users u JOIN user_roles ur ON u.user_id = ur.user_id JOIN roles r ON ur.role_id = r.role_id WHERE r.role_name = 'APPROVING_OFFICER' LIMIT 1`
          )
          .get() as { user_id: string } | undefined;
        if (defOfficer) {
          db.prepare('UPDATE applications SET assigned_officer_id = COALESCE(assigned_officer_id, ?) WHERE application_id = ?').run(
            defOfficer.user_id,
            appId
          );
          createNotification({
            userId: defOfficer.user_id,
            title: `Awaiting Final Approval: ${appId}`,
            message: `Surveyor completed verification for ${appId} (Parcel ${app.parcel_id}).`,
            type: 'PENDING_ACTION',
            relatedObjectId: appId
          });
        }
      } else if (reviewDecision === 'RETURNED') {
        nextStatus = 'RETURNED_FOR_CORRECTION';
      } else {
        res.status(400).json({ error: 'Surveyors can submit SURVEY_COMPLETED or RETURNED decisions.' });
        return;
      }
    } else if (hasAnyRole(user, ['APPROVING_OFFICER', 'ADMIN'])) {
      stage = 'OFFICER_REVIEW';
      if (reviewDecision === 'RETURNED') {
        nextStatus = 'RETURNED_FOR_CORRECTION';
      } else if (reviewDecision === 'ESCALATED') {
        nextStatus = 'ESCALATED';
      } else if (reviewDecision === 'VERIFIED') {
        nextStatus = 'AWAITING_APPROVAL';
      } else if (reviewDecision === 'SURVEY_COMPLETED') {
        nextStatus = 'AWAITING_APPROVAL';
      } else {
        res.status(400).json({ error: 'Invalid review decision.' });
        return;
      }
    }

    db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE application_id = ?').run(
      nextStatus,
      now,
      appId
    );

    const reviewId = `REV-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    db.prepare(
      `INSERT INTO reviews (review_id, application_id, reviewer_id, reviewer_role, stage, decision, remarks, survey_notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reviewId,
      appId,
      user.user_id,
      user.roles[0],
      stage,
      reviewDecision,
      String(remarks).trim(),
      survey_notes ? String(survey_notes).trim() : null,
      now
    );

    createNotification({
      userId: app.applicant_id,
      title: `Application ${appId} Updated: ${nextStatus}`,
      message: `${stage.replace('_', ' ')} result: ${reviewDecision}. Remarks: ${String(remarks).trim()}`,
      type: 'STATUS_UPDATE',
      relatedObjectId: appId
    });

    logAudit({
      actorId: user.user_id,
      actorRole: user.roles.join(','),
      action: `APPLICATION_${reviewDecision}`,
      objectType: 'APPLICATION',
      objectId: appId,
      details: { stage, nextStatus },
      ipAddress: req.ip || '127.0.0.1'
    });

    res.json({
      application: db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId),
      review: db.prepare('SELECT * FROM reviews WHERE review_id = ?').get(reviewId)
    });
  }
);

apiRouter.post(
  '/applications/:id/approve',
  requireAuth,
  requireRole('APPROVING_OFFICER', 'ADMIN'),
  (req: AuthRequest, res) => {
    const db = getDb();
    const appId = String(req.params.id);
    const { decision, remarks, approval_reference, submitToLedger, expectedParcelVersion } = req.body || {};
    const finalDecision = String(decision || 'APPROVED').toUpperCase();

    if (!['APPROVED', 'REJECTED', 'RETURNED', 'ESCALATED'].includes(finalDecision)) {
      res.status(400).json({ error: 'Decision must be APPROVED, REJECTED, RETURNED, or ESCALATED.' });
      return;
    }
    if (!remarks || String(remarks).trim().length < 3) {
      res.status(400).json({ error: 'Official remarks are mandatory for approval/rejection decisions.' });
      return;
    }

    const app = db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId) as
      | { application_id: string; parcel_id: string; applicant_id: string; status: string }
      | undefined;

    if (!app) {
      res.status(404).json({ error: `Application ${appId} not found.` });
      return;
    }

    const now = new Date().toISOString();
    const nextStatus =
      finalDecision === 'RETURNED' ? 'RETURNED_FOR_CORRECTION' : finalDecision;
    const approvalRef =
      finalDecision === 'APPROVED'
        ? String(approval_reference || `APR-REV-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`)
        : null;

    db.prepare(
      `UPDATE applications SET status = ?, approval_reference = COALESCE(?, approval_reference),
              assigned_officer_id = ?, updated_at = ?
       WHERE application_id = ?`
    ).run(nextStatus, approvalRef, req.user!.user_id, now, appId);

    if (finalDecision === 'REJECTED') {
      db.prepare("UPDATE parcels SET status = 'ACTIVE', updated_at = ? WHERE parcel_id = ?").run(
        now,
        app.parcel_id
      );
    }

    db.prepare(
      `INSERT INTO reviews (review_id, application_id, reviewer_id, reviewer_role, stage, decision, remarks, created_at)
       VALUES (?, ?, ?, ?, 'OFFICER_APPROVAL', ?, ?, ?)`
    ).run(
      `REV-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
      appId,
      req.user!.user_id,
      req.user!.roles[0],
      finalDecision,
      String(remarks).trim(),
      now
    );

    createNotification({
      userId: app.applicant_id,
      title: `Application ${appId} ${finalDecision}`,
      message:
        finalDecision === 'APPROVED'
          ? `Your application ${appId} has been approved under reference ${approvalRef}.`
          : `Your application ${appId} status is now ${nextStatus}. Remarks: ${String(remarks).trim()}`,
      type: finalDecision === 'APPROVED' ? 'APPROVAL' : 'REJECTION',
      relatedObjectId: appId
    });

    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: `APPLICATION_${finalDecision}`,
      objectType: 'APPLICATION',
      objectId: appId,
      details: { approval_reference: approvalRef, remarks },
      ipAddress: req.ip || '127.0.0.1'
    });

    let ledgerResult = null;
    if (finalDecision === 'APPROVED' && submitToLedger !== false) {
      ledgerResult = submitApprovedApplicationToLedger({
        applicationId: appId,
        actor: req.user!,
        expectedParcelVersion:
          typeof expectedParcelVersion === 'number' ? expectedParcelVersion : undefined
      });
    }

    res.json({
      application: db.prepare('SELECT * FROM applications WHERE application_id = ?').get(appId),
      ledgerResult
    });
  }
);

apiRouter.post(
  '/applications/:id/submit-ledger',
  requireAuth,
  requireRole('APPROVING_OFFICER', 'ADMIN'),
  (req: AuthRequest, res) => {
    const appId = String(req.params.id);
    const expectedParcelVersion =
      typeof req.body?.expectedParcelVersion === 'number'
        ? req.body.expectedParcelVersion
        : undefined;

    const result = submitApprovedApplicationToLedger({
      applicationId: appId,
      actor: req.user!,
      expectedParcelVersion
    });

    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: result.ok ? 'LEDGER_EVENT_COMMITTED' : 'LEDGER_EVENT_FAILED',
      objectType: 'APPLICATION',
      objectId: appId,
      details: {
        ok: result.ok,
        errorCode: result.errorCode,
        txId: result.event?.tx_id
      },
      ipAddress: req.ip || '127.0.0.1'
    });

    if (!result.ok) {
      res.status(result.statusCode).json({
        error: result.errorMessage,
        errorCode: result.errorCode
      });
      return;
    }

    res.status(201).json(result);
  }
);

apiRouter.get('/applications/:id/receipt', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const appId = String(req.params.id);
  const app = db
    .prepare(
      `SELECT a.*, p.survey_no, p.locality, p.area, p.land_use, u.name as applicant_name, u.email as applicant_email
       FROM applications a
       JOIN parcels p ON a.parcel_id = p.parcel_id
       JOIN users u ON a.applicant_id = u.user_id
       WHERE a.application_id = ?`
    )
    .get(appId) as (Record<string, unknown> & { applicant_id: string }) | undefined;

  if (!app) {
    res.status(404).json({ error: `Application ${appId} not found.` });
    return;
  }

  const isStaff = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  if (!isStaff && app.applicant_id !== req.user!.user_id) {
    res.status(403).json({ error: 'Unauthorized receipt access.' });
    return;
  }

  const docs = db
    .prepare(
      'SELECT document_id, original_filename, sha256_hash, version, created_at FROM documents WHERE application_id = ?'
    )
    .all(appId);

  const ledger = db
    .prepare("SELECT tx_id, block_number, event_hash, timestamp, is_simulated FROM ledger_events WHERE application_id = ? AND status = 'COMMITTED' LIMIT 1")
    .get(appId);

  res.json({
    receipt: {
      receipt_number: `RCPT-${appId}`,
      generated_at: new Date().toISOString(),
      environment_notice: 'ACADEMIC PROTOTYPE DEMONSTRATION RECEIPT — NOT A GOVERNMENT LEGAL INSTRUMENT',
      application: app,
      registered_documents: docs,
      ledger_confirmation: ledger || null
    }
  });
});

// ============================================================================
// DOCUMENTS & SHA-256 VERIFICATION
// ============================================================================
apiRouter.get('/documents', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const isStaff = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  const rows = isStaff
    ? db
        .prepare(
          `SELECT d.document_id, d.application_id, d.parcel_id, d.uploaded_by, d.original_filename,
                  d.mime_type, d.file_size, d.sha256_hash, d.version, d.doc_category, d.is_demo, d.created_at
           FROM documents d ORDER BY d.created_at DESC`
        )
        .all()
    : db
        .prepare(
          `SELECT d.document_id, d.application_id, d.parcel_id, d.uploaded_by, d.original_filename,
                  d.mime_type, d.file_size, d.sha256_hash, d.version, d.doc_category, d.is_demo, d.created_at
           FROM documents d
           JOIN applications a ON d.application_id = a.application_id
           WHERE a.applicant_id = ?
           ORDER BY d.created_at DESC`
        )
        .all(req.user!.user_id);

  res.json({ documents: rows });
});

apiRouter.post('/documents/verify', requireAuth, handleMulterUpload, (req: AuthRequest, res) => {
  const { document_id } = req.body || {};
  if (!document_id) {
    res.status(400).json({ error: 'document_id is required for SHA-256 hash verification.' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'Please upload a file to verify its SHA-256 bytes.' });
    return;
  }

  const db = getDb();
  const doc = db
    .prepare(
      `SELECT d.*, a.applicant_id FROM documents d
       JOIN applications a ON d.application_id = a.application_id
       WHERE d.document_id = ?`
    )
    .get(String(document_id).trim()) as
    | {
        document_id: string;
        application_id: string;
        parcel_id: string;
        original_filename: string;
        sha256_hash: string;
        version: number;
        applicant_id: string;
      }
    | undefined;

  if (!doc) {
    res.status(404).json({ error: `Document ${document_id} not found.` });
    return;
  }

  const isStaff = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  if (!isStaff && doc.applicant_id !== req.user!.user_id) {
    res.status(403).json({ error: 'Unauthorized document verification attempt.' });
    return;
  }

  const computedHash = computeBufferSha256(req.file.buffer);
  const isMatch = computedHash === doc.sha256_hash;
  const result = isMatch ? 'MATCH' : 'NO_MATCH';
  const verifiedAt = new Date().toISOString();

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'DOCUMENT_HASH_VERIFIED',
    objectType: 'DOCUMENT',
    objectId: doc.document_id,
    details: { result, computedHash, registeredHash: doc.sha256_hash },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.json({
    documentName: doc.original_filename,
    uploadedFilename: req.file.originalname,
    documentId: doc.document_id,
    documentVersion: doc.version,
    registeredHash: doc.sha256_hash,
    computedHash,
    result,
    applicationId: doc.application_id,
    parcelId: doc.parcel_id,
    verifiedAt,
    legalDisclaimer:
      'Cryptographic MATCH confirms byte-for-byte integrity against the registered document version only. It does NOT constitute legal ownership or title validity.'
  });
});

apiRouter.get('/documents/:id/download', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const docId = String(req.params.id);
  const doc = db
    .prepare(
      `SELECT d.*, a.applicant_id FROM documents d
       JOIN applications a ON d.application_id = a.application_id
       WHERE d.document_id = ?`
    )
    .get(docId) as
    | {
        document_id: string;
        original_filename: string;
        mime_type: string;
        storage_key: string;
        applicant_id: string;
      }
    | undefined;

  if (!doc) {
    res.status(404).json({ error: 'Document not found.' });
    return;
  }

  const isStaff = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  if (!isStaff && doc.applicant_id !== req.user!.user_id) {
    res.status(403).json({ error: 'Unauthorized download attempt.' });
    return;
  }

  const filePath = getPrivateDocumentPath(doc.storage_key);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Stored document file is missing from private storage.' });
    return;
  }

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'DOCUMENT_DOWNLOADED',
    objectType: 'DOCUMENT',
    objectId: doc.document_id,
    ipAddress: req.ip || '127.0.0.1'
  });

  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.original_filename}"`);
  res.sendFile(filePath);
});

// ============================================================================
// BLOCKCHAIN LEDGER & CONSORTIUM STATUS
// ============================================================================
apiRouter.get('/ledger/events', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const isStaff = hasAnyRole(req.user!, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  const statusFilter = String(req.query.status || '').trim();

  let events: Array<Record<string, unknown>>;
  if (isStaff) {
    events = statusFilter
      ? (db
          .prepare('SELECT * FROM ledger_events WHERE status = ? ORDER BY block_number DESC, timestamp DESC')
          .all(statusFilter) as Array<Record<string, unknown>>)
      : (db
          .prepare('SELECT * FROM ledger_events ORDER BY block_number DESC, timestamp DESC')
          .all() as Array<Record<string, unknown>>);
  } else {
    events = db
      .prepare(
        `SELECT DISTINCT le.* FROM ledger_events le
         LEFT JOIN parcels p ON le.parcel_id = p.parcel_id
         LEFT JOIN applications a ON le.application_id = a.application_id
         WHERE p.owner_user_id = ? OR a.applicant_id = ?
         ORDER BY le.block_number DESC`
      )
      .all(req.user!.user_id, req.user!.user_id) as Array<Record<string, unknown>>;
  }

  res.json({
    isSimulatedNetwork: true,
    networkNotice: 'Simulated Local Hyperledger Fabric Permissioned Network (Academic Prototype)',
    fabricAvailable: isFabricNetworkAvailable(),
    events: events.map((e) => ({
      ...e,
      doc_hash_refs: JSON.parse(String(e.doc_hash_refs_json || '[]')),
      endorser_orgs: JSON.parse(String(e.endorser_orgs_json || '[]')),
      payload: JSON.parse(String(e.payload_json || '{}'))
    }))
  });
});

apiRouter.get('/ledger/verify', requireAuth, (_req, res) => {
  res.json({
    ...verifyLedgerChain(),
    isSimulatedNetwork: true,
    checkedAt: new Date().toISOString()
  });
});

apiRouter.get('/ledger/status', requireAuth, (_req, res) => {
  const db = getDb();
  const committed = (
    db.prepare("SELECT COUNT(*) as c FROM ledger_events WHERE status = 'COMMITTED'").get() as { c: number }
  ).c;
  const failed = (
    db.prepare("SELECT COUNT(*) as c FROM ledger_events WHERE status = 'FAILED'").get() as { c: number }
  ).c;

  res.json({
    mode: 'SIMULATED_HYPERLEDGER_FABRIC',
    channel: 'landrecords-channel',
    chaincode: 'land_record_chaincode',
    available: isFabricNetworkAvailable(),
    committedTransactions: committed,
    failedTransactions: failed,
    organizations: [
      { msp: 'RevenueDeptMSP', peer: 'peer0.revenue.demo.fabric', status: isFabricNetworkAvailable() ? 'ONLINE' : 'UNREACHABLE' },
      { msp: 'SurveyGISMSP', peer: 'peer0.survey.demo.fabric', status: isFabricNetworkAvailable() ? 'ONLINE' : 'UNREACHABLE' },
      { msp: 'RegistrarAuthorityMSP', peer: 'peer0.registrar.demo.fabric', status: isFabricNetworkAvailable() ? 'ONLINE' : 'UNREACHABLE' }
    ]
  });
});

apiRouter.post('/ledger/toggle-availability', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const available = parseBoolean(req.body?.available);
  setFabricNetworkAvailability(available, req.user!.user_id);

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: available ? 'FABRIC_NETWORK_RESTORED' : 'FABRIC_NETWORK_SIMULATED_OUTAGE',
    objectType: 'LEDGER_NETWORK',
    objectId: 'landrecords-channel',
    details: { available },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.json({ available, mode: 'SIMULATED_HYPERLEDGER_FABRIC' });
});

// ============================================================================
// UNIFIED SEARCH (ROLE-FILTERED)
// ============================================================================
apiRouter.get('/search', requireAuth, (req: AuthRequest, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.json({ parcels: [], applications: [], documents: [], ledgerEvents: [] });
    return;
  }

  const db = getDb();
  const user = req.user!;
  const isStaff = hasAnyRole(user, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);
  const pattern = `%${q}%`;

  const parcels = isStaff
    ? db
        .prepare('SELECT * FROM parcels WHERE parcel_id LIKE ? OR survey_no LIKE ? OR locality LIKE ? LIMIT 25')
        .all(pattern, pattern, pattern)
    : db
        .prepare(
          `SELECT DISTINCT p.* FROM parcels p
           LEFT JOIN applications a ON p.parcel_id = a.parcel_id AND a.applicant_id = ?
           WHERE (p.owner_user_id = ? OR a.application_id IS NOT NULL)
             AND (p.parcel_id LIKE ? OR p.survey_no LIKE ? OR p.locality LIKE ?)
           LIMIT 25`
        )
        .all(user.user_id, user.user_id, pattern, pattern, pattern);

  const applications = isStaff
    ? db
        .prepare('SELECT * FROM applications WHERE application_id LIKE ? OR parcel_id LIKE ? OR status LIKE ? LIMIT 25')
        .all(pattern, pattern, pattern)
    : db
        .prepare(
          `SELECT * FROM applications WHERE applicant_id = ? AND (application_id LIKE ? OR parcel_id LIKE ? OR status LIKE ?) LIMIT 25`
        )
        .all(user.user_id, pattern, pattern, pattern);

  const documents = isStaff
    ? db
        .prepare(
          `SELECT document_id, application_id, parcel_id, original_filename, sha256_hash, version, created_at
           FROM documents WHERE document_id LIKE ? OR original_filename LIKE ? OR sha256_hash LIKE ? LIMIT 25`
        )
        .all(pattern, pattern, pattern)
    : db
        .prepare(
          `SELECT d.document_id, d.application_id, d.parcel_id, d.original_filename, d.sha256_hash, d.version, d.created_at
           FROM documents d JOIN applications a ON d.application_id = a.application_id
           WHERE a.applicant_id = ? AND (d.document_id LIKE ? OR d.original_filename LIKE ? OR d.sha256_hash LIKE ?) LIMIT 25`
        )
        .all(user.user_id, pattern, pattern, pattern);

  const ledgerEvents = isStaff
    ? db
        .prepare('SELECT * FROM ledger_events WHERE tx_id LIKE ? OR parcel_id LIKE ? OR application_id LIKE ? LIMIT 25')
        .all(pattern, pattern, pattern)
    : db
        .prepare(
          `SELECT DISTINCT le.* FROM ledger_events le
           LEFT JOIN parcels p ON le.parcel_id = p.parcel_id
           LEFT JOIN applications a ON le.application_id = a.application_id
           WHERE (p.owner_user_id = ? OR a.applicant_id = ?)
             AND (le.tx_id LIKE ? OR le.parcel_id LIKE ? OR le.application_id LIKE ?) LIMIT 25`
        )
        .all(user.user_id, user.user_id, pattern, pattern, pattern);

  res.json({ parcels, applications, documents, ledgerEvents });
});

// ============================================================================
// NOTIFICATIONS
// ============================================================================
apiRouter.get('/notifications', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.user!.user_id);
  const unread = (
    db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user!.user_id) as {
      c: number;
    }
  ).c;
  res.json({ notifications: rows, unreadCount: unread });
});

apiRouter.post('/notifications/:id/read', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE notification_id = ? AND user_id = ?').run(
    String(req.params.id),
    req.user!.user_id
  );
  res.json({ ok: true });
});

apiRouter.post('/notifications/read-all', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user!.user_id);
  res.json({ ok: true });
});

// ============================================================================
// AUDIT LOGS & REPORTS
// ============================================================================
apiRouter.get(
  '/audit-logs',
  requireAuth,
  requireRole('ADMIN', 'AUDITOR'),
  (req: AuthRequest, res) => {
    const db = getDb();
    const action = String(req.query.action || '').trim();
    const rows = action
      ? db.prepare('SELECT * FROM audit_logs WHERE action LIKE ? ORDER BY timestamp DESC LIMIT 200').all(`%${action}%`)
      : db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 200').all();
    res.json({ logs: rows });
  }
);

apiRouter.get('/reports/summary', requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const user = req.user!;
  const isStaff = hasAnyRole(user, ['CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR']);

  if (!isStaff) {
    const myApps = (
      db.prepare('SELECT COUNT(*) as c FROM applications WHERE applicant_id = ?').get(user.user_id) as { c: number }
    ).c;
    const myParcels = (
      db.prepare('SELECT COUNT(*) as c FROM parcels WHERE owner_user_id = ?').get(user.user_id) as { c: number }
    ).c;
    const myDocs = (
      db
        .prepare('SELECT COUNT(*) as c FROM documents d JOIN applications a ON d.application_id = a.application_id WHERE a.applicant_id = ?')
        .get(user.user_id) as { c: number }
    ).c;
    res.json({
      scope: 'CITIZEN',
      metrics: { myApplications: myApps, myParcels, myDocuments: myDocs }
    });
    return;
  }

  const totalParcels = (db.prepare('SELECT COUNT(*) as c FROM parcels').get() as { c: number }).c;
  const totalApps = (db.prepare('SELECT COUNT(*) as c FROM applications').get() as { c: number }).c;
  const approvedApps = (db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'APPROVED'").get() as { c: number }).c;
  const pendingApps = (
    db.prepare("SELECT COUNT(*) as c FROM applications WHERE status NOT IN ('APPROVED', 'REJECTED')").get() as { c: number }
  ).c;
  const totalDocs = (db.prepare('SELECT COUNT(*) as c FROM documents').get() as { c: number }).c;
  const committedTx = (db.prepare("SELECT COUNT(*) as c FROM ledger_events WHERE status = 'COMMITTED'").get() as { c: number }).c;
  const failedTx = (db.prepare("SELECT COUNT(*) as c FROM ledger_events WHERE status = 'FAILED'").get() as { c: number }).c;
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM applications GROUP BY status').all();

  res.json({
    scope: 'STAFF',
    metrics: {
      totalParcels,
      totalApplications: totalApps,
      approvedApplications: approvedApps,
      pendingApplications: pendingApps,
      totalDocuments: totalDocs,
      committedTransactions: committedTx,
      failedTransactions: failedTx
    },
    applicationsByStatus: byStatus
  });
});

apiRouter.get(
  '/reports/export',
  requireAuth,
  requireRole('CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR'),
  (req: AuthRequest, res) => {
    const db = getDb();
    const type = String(req.query.type || 'applications');
    const format = String(req.query.format || 'json');

    let rows: Array<Record<string, unknown>> = [];
    if (type === 'applications') {
      rows = db.prepare('SELECT application_id, parcel_id, applicant_id, type, status, approval_reference, submitted_at, updated_at FROM applications ORDER BY submitted_at DESC').all() as Array<Record<string, unknown>>;
    } else if (type === 'parcels') {
      rows = db.prepare('SELECT parcel_id, survey_no, locality, area, land_use, geometry_ref, status, version, updated_at FROM parcels ORDER BY parcel_id').all() as Array<Record<string, unknown>>;
    } else if (type === 'ledger') {
      rows = db.prepare('SELECT event_id, parcel_id, application_id, tx_id, block_number, event_type, event_hash, status, is_simulated, timestamp FROM ledger_events ORDER BY block_number DESC').all() as Array<Record<string, unknown>>;
    } else if (type === 'audit') {
      rows = db.prepare('SELECT log_id, actor_id, actor_role, action, object_type, object_id, timestamp FROM audit_logs ORDER BY timestamp DESC LIMIT 500').all() as Array<Record<string, unknown>>;
    } else if (type === 'verifications') {
      rows = db.prepare("SELECT log_id, actor_id, action, object_id, details_json, timestamp FROM audit_logs WHERE action = 'DOCUMENT_HASH_VERIFIED' ORDER BY timestamp DESC").all() as Array<Record<string, unknown>>;
    } else {
      res.status(400).json({ error: 'Unknown report type.' });
      return;
    }

    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: 'REPORT_EXPORTED',
      objectType: 'REPORT',
      objectId: type,
      details: { format, rowCount: rows.length },
      ipAddress: req.ip || '127.0.0.1'
    });

    if (format === 'csv') {
      const headers = rows.length > 0 ? Object.keys(rows[0]) : ['empty'];
      const csvLines = [
        headers.join(','),
        ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? '')).join(','))
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="civicledger_${type}_report.csv"`);
      res.send(csvLines.join('\n'));
      return;
    }

    res.json({
      reportType: type,
      generatedAt: new Date().toISOString(),
      environmentNotice: 'ACADEMIC PROTOTYPE DEMONSTRATION REPORT',
      count: rows.length,
      data: rows
    });
  }
);

// ============================================================================
// ADMINISTRATOR MODULE
// ============================================================================
apiRouter.get('/admin/users', requireAuth, requireRole('ADMIN', 'CLERK', 'AUDITOR'), (_req, res) => {
  const db = getDb();
  const users = db
    .prepare('SELECT user_id, name, email, contact, status, failed_attempts, mfa_enabled, is_demo, created_at FROM users ORDER BY created_at ASC')
    .all() as Array<Record<string, unknown>>;

  const roleMap = db
    .prepare(
      `SELECT ur.user_id, r.role_name FROM user_roles ur JOIN roles r ON ur.role_id = r.role_id`
    )
    .all() as Array<{ user_id: string; role_name: RoleName }>;

  const rolesByUser = new Map<string, RoleName[]>();
  for (const rm of roleMap) {
    const existing = rolesByUser.get(rm.user_id) || [];
    existing.push(rm.role_name);
    rolesByUser.set(rm.user_id, existing);
  }

  res.json({
    users: users.map((u) => ({
      ...u,
      mfa_enabled: Boolean(u.mfa_enabled),
      roles: rolesByUser.get(String(u.user_id)) || []
    }))
  });
});

apiRouter.get('/admin/roles', requireAuth, requireRole('ADMIN', 'AUDITOR'), (_req, res) => {
  const db = getDb();
  const roles = db.prepare('SELECT * FROM roles').all() as Array<Record<string, unknown>>;
  res.json({
    roles: roles.map((r) => ({ ...r, permissions: JSON.parse(String(r.permissions_json || '[]')) }))
  });
});

apiRouter.post('/admin/users/:id/status', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const userId = String(req.params.id);
  const status = String(req.body?.status || '').toUpperCase();
  if (!['ACTIVE', 'LOCKED', 'SUSPENDED'].includes(status)) {
    res.status(400).json({ error: 'Invalid status. Must be ACTIVE, LOCKED, or SUSPENDED.' });
    return;
  }
  const db = getDb();
  db.prepare(
    `UPDATE users SET status = ?, failed_attempts = CASE WHEN ? = 'ACTIVE' THEN 0 ELSE failed_attempts END,
            locked_until = CASE WHEN ? = 'ACTIVE' THEN NULL ELSE locked_until END, updated_at = ?
     WHERE user_id = ?`
  ).run(status, status, status, new Date().toISOString(), userId);

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'USER_STATUS_CHANGED',
    objectType: 'USER',
    objectId: userId,
    details: { status },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.json({ user: getUserWithRolesById(userId) });
});

apiRouter.post('/admin/users/:id/roles', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const userId = String(req.params.id);
  const roleName = String(req.body?.role_name || '').toUpperCase();
  const db = getDb();
  const role = db.prepare('SELECT role_id FROM roles WHERE role_name = ?').get(roleName) as
    | { role_id: string }
    | undefined;
  if (!role) {
    res.status(400).json({ error: `Role ${roleName} does not exist.` });
    return;
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)').run(
      userId,
      role.role_id,
      req.user!.user_id,
      new Date().toISOString()
    );
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'USER_ROLE_UPDATED',
    objectType: 'USER',
    objectId: userId,
    details: { roleName },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.json({ user: getUserWithRolesById(userId) });
});

apiRouter.get('/admin/config', requireAuth, requireRole('ADMIN', 'AUDITOR'), (_req, res) => {
  const db = getDb();
  const configs = db.prepare('SELECT * FROM system_config').all();
  res.json({ configs });
});

apiRouter.post('/admin/config', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const { config_key, config_value } = req.body || {};
  if (!config_key || config_value === undefined) {
    res.status(400).json({ error: 'config_key and config_value are required.' });
    return;
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO system_config (config_key, config_value, updated_by, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(String(config_key), String(config_value), req.user!.user_id, new Date().toISOString());

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'SYSTEM_CONFIG_UPDATED',
    objectType: 'CONFIG',
    objectId: String(config_key),
    details: { config_value },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.json({ configs: db.prepare('SELECT * FROM system_config').all() });
});

apiRouter.get('/admin/certificates', requireAuth, requireRole('ADMIN', 'AUDITOR'), (_req, res) => {
  const db = getDb();
  const certificates = db.prepare('SELECT * FROM fabric_identities ORDER BY org_msp').all();
  res.json({ certificates });
});

apiRouter.post('/admin/certificates/:id/status', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const certId = String(req.params.id);
  const status = String(req.body?.cert_status || '').toUpperCase();
  if (!['ACTIVE', 'REVOKED'].includes(status)) {
    res.status(400).json({ error: 'cert_status must be ACTIVE or REVOKED.' });
    return;
  }
  const db = getDb();
  db.prepare('UPDATE fabric_identities SET cert_status = ? WHERE identity_id = ?').run(status, certId);
  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'FABRIC_CERTIFICATE_UPDATED',
    objectType: 'FABRIC_IDENTITY',
    objectId: certId,
    details: { cert_status: status },
    ipAddress: req.ip || '127.0.0.1'
  });
  res.json({ certificates: db.prepare('SELECT * FROM fabric_identities ORDER BY org_msp').all() });
});

apiRouter.get('/staff/reviewers', requireAuth, requireRole('CLERK', 'ADMIN', 'APPROVING_OFFICER', 'SURVEYOR'), (_req, res) => {
  const db = getDb();
  const reviewers = db
    .prepare(
      `SELECT u.user_id, u.name, u.email, r.role_name
       FROM users u
       JOIN user_roles ur ON u.user_id = ur.user_id
       JOIN roles r ON ur.role_id = r.role_id
       WHERE r.role_name IN ('CLERK', 'SURVEYOR', 'APPROVING_OFFICER') AND u.status = 'ACTIVE'
       ORDER BY r.role_name, u.name`
    )
    .all();
  res.json({ reviewers });
});

apiRouter.get('/admin/backups', requireAuth, requireRole('ADMIN', 'AUDITOR'), (_req, res) => {
  const db = getDb();
  const backups = db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC').all();
  res.json({ backups });
});

apiRouter.post('/admin/backups', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res) => {
  try {
    const record = await createSystemBackup(req.user!.user_id);
    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: 'BACKUP_CREATED',
      objectType: 'BACKUP',
      objectId: record.backup_id,
      details: { checksum: record.checksum_sha256, documentCount: record.document_count },
      ipAddress: req.ip || '127.0.0.1'
    });
    res.status(201).json({ backup: record });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed.' });
  }
});

apiRouter.post('/admin/backups/:id/restore', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  try {
    const backupId = String(req.params.id);
    const result = restoreSystemBackup(backupId);
    logAudit({
      actorId: req.user!.user_id,
      actorRole: req.user!.roles.join(','),
      action: 'BACKUP_RESTORED',
      objectType: 'BACKUP',
      objectId: backupId,
      details: result,
      ipAddress: req.ip || '127.0.0.1'
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed.' });
  }
});

apiRouter.post('/admin/notifications/broadcast', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res) => {
  const { title, message, targetRole } = req.body || {};
  if (!title || !message) {
    res.status(400).json({ error: 'title and message are required.' });
    return;
  }
  const db = getDb();
  const users = targetRole
    ? (db
        .prepare(
          `SELECT u.user_id FROM users u JOIN user_roles ur ON u.user_id = ur.user_id JOIN roles r ON ur.role_id = r.role_id WHERE r.role_name = ?`
        )
        .all(String(targetRole)) as Array<{ user_id: string }>)
    : (db.prepare('SELECT user_id FROM users').all() as Array<{ user_id: string }>);

  for (const u of users) {
    createNotification({
      userId: u.user_id,
      title: String(title),
      message: String(message),
      type: 'ADMIN_NOTICE'
    });
  }

  logAudit({
    actorId: req.user!.user_id,
    actorRole: req.user!.roles.join(','),
    action: 'NOTIFICATION_BROADCAST',
    objectType: 'NOTIFICATION',
    objectId: targetRole || 'ALL_USERS',
    details: { recipients: users.length },
    ipAddress: req.ip || '127.0.0.1'
  });

  res.status(201).json({ sentCount: users.length });
});
