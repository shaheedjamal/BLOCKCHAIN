import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { BACKUP_DIR, DB_PATH, closeDb, getDb, STORAGE_DIR } from './db.ts';

export async function createSystemBackup(actorId: string) {
  const db = getDb();
  const backupId = `BKP-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const targetDir = path.join(BACKUP_DIR, backupId);
  const dbBackupPath = path.join(targetDir, 'land_records.db');
  const storageBackupPath = path.join(targetDir, 'documents');

  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(storageBackupPath, { recursive: true });

  // 1. Online SQLite backup using Node built-in backup()
  await sqliteBackup(db, dbBackupPath);

  // 2. Copy all private document files
  let documentCount = 0;
  if (fs.existsSync(STORAGE_DIR)) {
    const files = fs.readdirSync(STORAGE_DIR);
    for (const file of files) {
      const src = path.join(STORAGE_DIR, file);
      const dst = path.join(storageBackupPath, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
        documentCount++;
      }
    }
  }

  // 3. Compute deterministic SHA-256 checksum over the backed-up DB file
  const dbBytes = fs.readFileSync(dbBackupPath);
  const checksumSha256 = crypto.createHash('sha256').update(dbBytes).digest('hex');
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO backup_records (backup_id, created_by, db_backup_path, storage_backup_path, checksum_sha256, document_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(backupId, actorId, dbBackupPath, storageBackupPath, checksumSha256, documentCount, now);

  return {
    backup_id: backupId,
    created_by: actorId,
    db_backup_path: dbBackupPath,
    storage_backup_path: storageBackupPath,
    checksum_sha256: checksumSha256,
    document_count: documentCount,
    created_at: now
  };
}

export function restoreSystemBackup(backupId: string): {
  restored: boolean;
  backupId: string;
  restoredDocuments: number;
  checksumVerified: boolean;
} {
  const db = getDb();
  const record = db
    .prepare('SELECT * FROM backup_records WHERE backup_id = ?')
    .get(backupId) as
    | {
        backup_id: string;
        db_backup_path: string;
        storage_backup_path: string;
        checksum_sha256: string;
      }
    | undefined;

  if (!record) {
    throw new Error(`Backup ${backupId} not found.`);
  }
  if (!fs.existsSync(record.db_backup_path)) {
    throw new Error(`Backup database file missing at ${record.db_backup_path}.`);
  }

  const backupBytes = fs.readFileSync(record.db_backup_path);
  const actualChecksum = crypto.createHash('sha256').update(backupBytes).digest('hex');
  if (actualChecksum !== record.checksum_sha256) {
    throw new Error('Backup integrity check failed: SHA-256 checksum mismatch.');
  }

  // Close current DB connection, replace DB file & remove stale WAL/SHM, restore documents, reopen DB
  closeDb();

  fs.copyFileSync(record.db_backup_path, DB_PATH);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) {
      fs.unlinkSync(DB_PATH + suffix);
    }
  }

  let restoredDocuments = 0;
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (fs.existsSync(record.storage_backup_path)) {
    const files = fs.readdirSync(record.storage_backup_path);
    for (const file of files) {
      const src = path.join(record.storage_backup_path, file);
      const dst = path.join(STORAGE_DIR, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
        restoredDocuments++;
      }
    }
  }

  getDb();

  return {
    restored: true,
    backupId: record.backup_id,
    restoredDocuments,
    checksumVerified: true
  };
}
