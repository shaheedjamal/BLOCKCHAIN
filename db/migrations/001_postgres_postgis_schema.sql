-- PostgreSQL + PostGIS Reference Migration Schema
-- CivicLedger: Blockchain-Based Land Record Management System

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
  user_id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  contact VARCHAR(50) NOT NULL,
  password_hash TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'SUSPENDED')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  role_id VARCHAR(64) PRIMARY KEY,
  role_name VARCHAR(40) NOT NULL UNIQUE CHECK (role_name IN ('CITIZEN', 'CLERK', 'SURVEYOR', 'APPROVING_OFFICER', 'ADMIN', 'AUDITOR')),
  description TEXT NOT NULL,
  permissions_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role_id VARCHAR(64) NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  assigned_by VARCHAR(64),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS parcels (
  parcel_id VARCHAR(64) PRIMARY KEY,
  survey_no VARCHAR(64) NOT NULL,
  locality VARCHAR(100) NOT NULL,
  area VARCHAR(64) NOT NULL,
  land_use VARCHAR(64) NOT NULL,
  geometry_ref VARCHAR(120) NOT NULL,
  geom GEOMETRY(POLYGON, 4326),
  geojson_boundary JSONB NOT NULL,
  owner_user_id VARCHAR(64) REFERENCES users(user_id) ON DELETE SET NULL,
  owner_display_name VARCHAR(150) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'UNDER_MUTATION', 'DISPUTED', 'ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 1,
  is_demo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS applications (
  application_id VARCHAR(64) PRIMARY KEY,
  parcel_id VARCHAR(64) NOT NULL REFERENCES parcels(parcel_id) ON DELETE RESTRICT,
  applicant_id VARCHAR(64) NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  type VARCHAR(40) NOT NULL CHECK (type IN ('LAND_TRANSFER', 'LAND_MUTATION', 'RECORD_CORRECTION', 'DOCUMENT_VERIFICATION')),
  status VARCHAR(40) NOT NULL,
  assigned_clerk_id VARCHAR(64) REFERENCES users(user_id),
  assigned_surveyor_id VARCHAR(64) REFERENCES users(user_id),
  assigned_officer_id VARCHAR(64) REFERENCES users(user_id),
  proposed_transferee_name VARCHAR(150),
  summary_notes TEXT NOT NULL,
  expected_parcel_version INTEGER NOT NULL,
  approval_reference VARCHAR(80),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  document_id VARCHAR(64) PRIMARY KEY,
  application_id VARCHAR(64) NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
  parcel_id VARCHAR(64) NOT NULL REFERENCES parcels(parcel_id) ON DELETE RESTRICT,
  uploaded_by VARCHAR(64) NOT NULL REFERENCES users(user_id),
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL,
  storage_key VARCHAR(255) NOT NULL UNIQUE,
  sha256_hash CHAR(64) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  doc_category VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id VARCHAR(64) PRIMARY KEY,
  application_id VARCHAR(64) NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
  reviewer_id VARCHAR(64) NOT NULL REFERENCES users(user_id),
  reviewer_role VARCHAR(40) NOT NULL,
  stage VARCHAR(50) NOT NULL,
  decision VARCHAR(30) NOT NULL,
  remarks TEXT NOT NULL,
  survey_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_events (
  event_id VARCHAR(64) PRIMARY KEY,
  parcel_id VARCHAR(64) NOT NULL REFERENCES parcels(parcel_id),
  application_id VARCHAR(64),
  tx_id VARCHAR(120) NOT NULL,
  block_number BIGINT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_hash CHAR(64) NOT NULL,
  previous_event_hash CHAR(64) NOT NULL,
  parcel_version INTEGER NOT NULL,
  approval_reference VARCHAR(80),
  doc_hash_refs_json JSONB NOT NULL,
  endorser_orgs_json JSONB NOT NULL,
  msp_identity VARCHAR(150) NOT NULL,
  is_simulated BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('COMMITTED', 'FAILED')),
  error_message TEXT,
  payload_json JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id VARCHAR(64) PRIMARY KEY,
  actor_id VARCHAR(64),
  actor_role VARCHAR(80),
  action VARCHAR(80) NOT NULL,
  object_type VARCHAR(50) NOT NULL,
  object_id VARCHAR(100) NOT NULL,
  details_json JSONB NOT NULL,
  ip_address VARCHAR(64) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parcels_geom ON parcels USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_apps_parcel ON applications(parcel_id);
CREATE INDEX IF NOT EXISTS idx_docs_hash ON documents(sha256_hash);
CREATE INDEX IF NOT EXISTS idx_ledger_parcel ON ledger_events(parcel_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(timestamp DESC);
