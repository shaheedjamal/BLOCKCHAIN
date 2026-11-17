export type RoleName =
  | 'CITIZEN'
  | 'CLERK'
  | 'SURVEYOR'
  | 'APPROVING_OFFICER'
  | 'ADMIN'
  | 'AUDITOR';

export interface User {
  user_id: string;
  name: string;
  email: string;
  contact: string;
  status: 'ACTIVE' | 'LOCKED' | 'SUSPENDED';
  mfa_enabled: boolean;
  is_demo: boolean;
  roles: RoleName[];
  failed_attempts?: number;
  created_at?: string;
}

export interface Parcel {
  parcel_id: string;
  survey_no: string;
  locality: string;
  area: string;
  land_use: string;
  geometry_ref: string;
  geojson_boundary: {
    type: string;
    properties?: Record<string, unknown>;
    geometry: {
      type: string;
      coordinates: number[][][];
    };
  };
  centroid_lat: number;
  centroid_lng: number;
  owner_user_id: string | null;
  owner_display_name: string;
  status: 'ACTIVE' | 'UNDER_MUTATION' | 'DISPUTED' | 'ARCHIVED';
  version: number;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export type ApplicationType =
  | 'LAND_TRANSFER'
  | 'LAND_MUTATION'
  | 'RECORD_CORRECTION'
  | 'DOCUMENT_VERIFICATION';

export type ApplicationStatus =
  | 'SUBMITTED'
  | 'CLERK_VERIFIED'
  | 'RETURNED_FOR_CORRECTION'
  | 'SURVEY_IN_PROGRESS'
  | 'SURVEY_VERIFIED'
  | 'AWAITING_APPROVAL'
  | 'ESCALATED'
  | 'APPROVED'
  | 'REJECTED';

export interface ApplicationRecord {
  application_id: string;
  parcel_id: string;
  applicant_id: string;
  applicant_name?: string;
  applicant_email?: string;
  type: ApplicationType;
  status: ApplicationStatus;
  assigned_clerk_id: string | null;
  assigned_surveyor_id: string | null;
  assigned_officer_id: string | null;
  proposed_transferee_name: string | null;
  summary_notes: string;
  expected_parcel_version: number;
  current_parcel_version?: number;
  approval_reference: string | null;
  survey_no?: string;
  locality?: string;
  area?: string;
  land_use?: string;
  geometry_ref?: string;
  owner_display_name?: string;
  submitted_at: string;
  updated_at: string;
}

export interface DocumentRecord {
  document_id: string;
  application_id: string;
  parcel_id: string;
  uploaded_by: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  sha256_hash: string;
  version: number;
  doc_category: string;
  is_demo: number;
  created_at: string;
}

export interface ReviewRecord {
  review_id: string;
  application_id: string;
  reviewer_id: string;
  reviewer_name?: string;
  reviewer_role: string;
  stage: string;
  decision: string;
  remarks: string;
  survey_notes: string | null;
  created_at: string;
}

export interface LedgerEvent {
  event_id: string;
  parcel_id: string;
  application_id: string | null;
  tx_id: string;
  block_number: number;
  event_type: string;
  event_hash: string;
  previous_event_hash: string;
  parcel_version: number;
  approval_reference: string | null;
  doc_hash_refs?: string[];
  endorser_orgs?: string[];
  msp_identity: string;
  is_simulated: number;
  status: 'COMMITTED' | 'FAILED';
  error_message: string | null;
  payload?: Record<string, unknown>;
  timestamp: string;
}

export interface AuditLog {
  log_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  object_type: string;
  object_id: string;
  details_json: string;
  ip_address: string;
  timestamp: string;
}

export interface NotificationItem {
  notification_id: string;
  user_id: string;
  title: string;
  message: string;
  type: string;
  related_object_id: string | null;
  is_read: number;
  created_at: string;
}

export interface VerificationResult {
  documentName: string;
  uploadedFilename: string;
  documentId: string;
  documentVersion: number;
  registeredHash: string;
  computedHash: string;
  result: 'MATCH' | 'NO_MATCH';
  applicationId: string;
  parcelId: string;
  verifiedAt: string;
  legalDisclaimer: string;
}
