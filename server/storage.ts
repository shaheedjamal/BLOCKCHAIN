import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { getDb, STORAGE_DIR } from './db.ts';

export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
  'application/json'
]);

export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.json']);
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES }
});

export function computeBufferSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function validateUploadedFile(file: Express.Multer.File | undefined): {
  valid: boolean;
  error?: string;
} {
  if (!file) {
    return { valid: false, error: 'No document file uploaded.' };
  }
  if (file.size <= 0) {
    return { valid: false, error: 'Uploaded file is empty (0 bytes).' };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { valid: false, error: `File exceeds maximum allowed size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.` };
  }

  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return {
      valid: false,
      error: `Unsupported file type (${ext || 'unknown'} / ${file.mimetype}). Allowed formats: PDF, PNG, JPG, TXT, JSON.`
    };
  }
  return { valid: true };
}

export function savePrivateDocument(params: {
  file: Express.Multer.File;
  applicationId: string;
  parcelId: string;
  uploadedBy: string;
  docCategory: string;
}) {
  const db = getDb();
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const sha256Hash = computeBufferSha256(params.file.buffer);
  const ext = path.extname(params.file.originalname).toLowerCase();
  const storageKey = `${crypto.randomUUID()}${ext}`;
  const fullPath = path.join(STORAGE_DIR, storageKey);

  // Store privately on server filesystem outside static web root
  fs.writeFileSync(fullPath, params.file.buffer);

  const versionRow = db
    .prepare(
      'SELECT COALESCE(MAX(version), 0) as max_ver FROM documents WHERE application_id = ? AND doc_category = ?'
    )
    .get(params.applicationId, params.docCategory) as { max_ver: number };

  const nextVersion = (versionRow?.max_ver || 0) + 1;
  const documentId = `DOC-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO documents (
      document_id, application_id, parcel_id, uploaded_by, original_filename, mime_type,
      file_size, storage_key, sha256_hash, version, doc_category, is_demo, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    documentId,
    params.applicationId,
    params.parcelId,
    params.uploadedBy,
    params.file.originalname,
    params.file.mimetype,
    params.file.size,
    storageKey,
    sha256Hash,
    nextVersion,
    params.docCategory,
    now
  );

  return {
    document_id: documentId,
    application_id: params.applicationId,
    parcel_id: params.parcelId,
    original_filename: params.file.originalname,
    mime_type: params.file.mimetype,
    file_size: params.file.size,
    sha256_hash: sha256Hash,
    version: nextVersion,
    doc_category: params.docCategory,
    created_at: now
  };
}

export function getPrivateDocumentPath(storageKey: string): string {
  const safeKey = path.basename(storageKey);
  return path.join(STORAGE_DIR, safeKey);
}
