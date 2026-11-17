import { useEffect, useState, type FormEvent } from 'react';
import { Download, FileText, Upload, X } from 'lucide-react';
import { apiRequest, downloadProtectedFile } from '../api';
import type {
  ApplicationRecord,
  ApplicationType,
  DocumentRecord,
  LedgerEvent,
  Parcel,
  ReviewRecord,
  User
} from '../types';
import { StatusText } from './StatusText';

interface ApplicationModalProps {
  mode: 'create' | 'view';
  applicationId?: string;
  parcels: Parcel[];
  currentUser: User;
  onClose: () => void;
  onUpdated: () => void;
}

const WORKFLOW_STEPS = [
  'SUBMITTED',
  'SURVEY_IN_PROGRESS',
  'AWAITING_APPROVAL',
  'APPROVED'
];

export function ApplicationModal({
  mode,
  applicationId,
  parcels,
  currentUser,
  onClose,
  onUpdated
}: ApplicationModalProps) {
  // Create state
  const [parcelId, setParcelId] = useState(parcels[0]?.parcel_id || '');
  const [appType, setAppType] = useState<ApplicationType>('LAND_MUTATION');
  const [transferee, setTransferee] = useState('');
  const [summaryNotes, setSummaryNotes] = useState('');
  const [initialFile, setInitialFile] = useState<File | null>(null);
  const [docCategory, setDocCategory] = useState('SUPPORTING_DEED');

  // Detail state
  const [detail, setDetail] = useState<{
    application: ApplicationRecord;
    documents: DocumentRecord[];
    reviews: ReviewRecord[];
    ledgerEvents: LedgerEvent[];
  } | null>(null);

  // Review / Upload / Approval state
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadCat, setUploadCat] = useState('SUPPORTING_DOCUMENT');
  const [remarks, setRemarks] = useState('');
  const [surveyNotes, setSurveyNotes] = useState('');
  const [approvalRefInput, setApprovalRefInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Assignment state (Clerk/Admin)
  const [reviewers, setReviewers] = useState<Array<{ user_id: string; name: string; role_name: string }>>([]);
  const [assignSurveyorId, setAssignSurveyorId] = useState('');
  const [assignOfficerId, setAssignOfficerId] = useState('');

  async function loadDetail(id: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{
        application: ApplicationRecord;
        documents: DocumentRecord[];
        reviews: ReviewRecord[];
        ledgerEvents: LedgerEvent[];
      }>(`/api/applications/${id}`);
      setDetail(res);
      setAssignSurveyorId(res.application.assigned_surveyor_id || '');
      setAssignOfficerId(res.application.assigned_officer_id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load application details.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (mode === 'view' && applicationId) {
      loadDetail(applicationId);
      if (currentUser.roles.includes('CLERK') || currentUser.roles.includes('ADMIN')) {
        apiRequest<{ reviewers: Array<{ user_id: string; name: string; role_name: string }> }>('/api/staff/reviewers')
          .then((r) => setReviewers(r.reviewers))
          .catch(() => {});
      }
    }
  }, [mode, applicationId, currentUser.roles]);

  async function handleAssignReviewers() {
    if (!detail) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await apiRequest(`/api/applications/${detail.application.application_id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          surveyor_id: assignSurveyorId || undefined,
          officer_id: assignOfficerId || undefined,
          remarks: remarks || 'Assigned reviewers via portal.'
        })
      });
      setNotice('Reviewer assignment updated.');
      await loadDetail(detail.application.application_id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ application: ApplicationRecord }>('/api/applications', {
        method: 'POST',
        body: JSON.stringify({
          parcel_id: parcelId,
          type: appType,
          proposed_transferee_name: appType === 'LAND_TRANSFER' ? transferee : undefined,
          summary_notes: summaryNotes
        })
      });

      if (initialFile) {
        const fd = new FormData();
        fd.append('file', initialFile);
        fd.append('doc_category', docCategory);
        await apiRequest(`/api/applications/${res.application.application_id}/documents`, {
          method: 'POST',
          body: fd
        });
      }

      onUpdated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit application.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDocumentUpload(e: FormEvent) {
    e.preventDefault();
    if (!detail || !uploadFile) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      fd.append('doc_category', uploadCat);
      await apiRequest(`/api/applications/${detail.application.application_id}/documents`, {
        method: 'POST',
        body: fd
      });
      setUploadFile(null);
      setNotice('Document stored privately and SHA-256 hash registered.');
      await loadDetail(detail.application.application_id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Document upload failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleReviewAction(decision: 'VERIFIED' | 'RETURNED' | 'SURVEY_COMPLETED' | 'ESCALATED') {
    if (!detail) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await apiRequest(`/api/applications/${detail.application.application_id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, remarks, survey_notes: surveyNotes || undefined })
      });
      setRemarks('');
      setSurveyNotes('');
      setNotice(`Review action (${decision}) recorded.`);
      await loadDetail(detail.application.application_id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review action failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleOfficerDecision(decision: 'APPROVED' | 'REJECTED' | 'RETURNED' | 'ESCALATED', submitToLedger: boolean) {
    if (!detail) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        application: ApplicationRecord;
        ledgerResult?: { ok: boolean; errorMessage?: string; event?: { tx_id: string } } | null;
      }>(`/api/applications/${detail.application.application_id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          remarks,
          approval_reference: approvalRefInput || undefined,
          submitToLedger
        })
      });
      setRemarks('');
      if (res.ledgerResult && !res.ledgerResult.ok) {
        setError(
          `Application marked ${decision}, but simulated ledger commit failed: ${res.ledgerResult.errorMessage}`
        );
      } else if (res.ledgerResult?.ok) {
        setNotice(
          `Application approved and committed to simulated Fabric ledger (TX: ${res.ledgerResult.event?.tx_id}).`
        );
      } else {
        setNotice(`Official decision ${decision} recorded.`);
      }
      await loadDetail(detail.application.application_id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval decision failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitLedgerOnly() {
    if (!detail) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ event: { tx_id: string } }>(
        `/api/applications/${detail.application.application_id}/submit-ledger`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      setNotice(`Committed to simulated Fabric ledger: ${res.event.tx_id}`);
      await loadDetail(detail.application.application_id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ledger submission failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDownloadReceipt() {
    if (!detail) return;
    const data = await apiRequest<{ receipt: Record<string, unknown> }>(
      `/api/applications/${detail.application.application_id}/receipt`
    );
    const content = [
      'CIVICLEDGER LAND RECORD MANAGEMENT SYSTEM',
      'APPLICATION ACKNOWLEDGEMENT RECEIPT',
      '=========================================================',
      JSON.stringify(data.receipt, null, 2)
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Receipt_${detail.application.application_id}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const isClerk = currentUser.roles.includes('CLERK');
  const isSurveyor = currentUser.roles.includes('SURVEYOR');
  const isOfficer = currentUser.roles.includes('APPROVING_OFFICER') || currentUser.roles.includes('ADMIN');

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {mode === 'create'
                ? 'Submit Land Record Application'
                : `Application ${detail?.application.application_id || applicationId}`}
            </h2>
            <p className="text-xs text-slate-500">
              {mode === 'create'
                ? 'Select a permitted parcel and attach supporting documentation.'
                : 'Complete workflow audit trail, document SHA-256 registry, and review controls.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">{error}</div>
          )}
          {notice && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
              {notice}
            </div>
          )}

          {mode === 'create' && (
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Parcel Reference</label>
                  <select
                    required
                    value={parcelId}
                    onChange={(e) => setParcelId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {parcels.map((p) => (
                      <option key={p.parcel_id} value={p.parcel_id}>
                        {p.parcel_id} · Survey {p.survey_no} ({p.area})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Application Type</label>
                  <select
                    value={appType}
                    onChange={(e) => setAppType(e.target.value as ApplicationType)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="LAND_TRANSFER">Land Transfer</option>
                    <option value="LAND_MUTATION">Land Mutation</option>
                    <option value="RECORD_CORRECTION">Record Correction</option>
                    <option value="DOCUMENT_VERIFICATION">Document Verification</option>
                  </select>
                </div>
              </div>

              {appType === 'LAND_TRANSFER' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Proposed Transferee Name (Mandatory for Land Transfer)
                  </label>
                  <input
                    type="text"
                    required
                    value={transferee}
                    onChange={(e) => setTransferee(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    placeholder="Full name of proposed transferee"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Application Summary & Justification
                </label>
                <textarea
                  required
                  minLength={5}
                  rows={3}
                  value={summaryNotes}
                  onChange={(e) => setSummaryNotes(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  placeholder="Describe the mutation, transfer, or record correction requested..."
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Supporting Document (Optional, PDF/PNG/JPG/TXT)
                  </label>
                  <input
                    type="file"
                    onChange={(e) => setInitialFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-semibold file:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Document Category</label>
                  <input
                    type="text"
                    value={docCategory}
                    onChange={(e) => setDocCategory(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg"
                >
                  {loading ? 'Submitting...' : 'Submit Application'}
                </button>
              </div>
            </form>
          )}

          {mode === 'view' && detail && (
            <>
              {/* Summary Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-4 border-b border-slate-200 text-xs">
                <div>
                  <p className="text-slate-500">Status</p>
                  <div className="mt-1">
                    <StatusText status={detail.application.status} />
                  </div>
                </div>
                <div>
                  <p className="text-slate-500">Parcel ID & Version</p>
                  <p className="font-mono font-semibold text-slate-900 mt-1">
                    {detail.application.parcel_id} (exp v{detail.application.expected_parcel_version} / cur v
                    {detail.application.current_parcel_version})
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Application Type</p>
                  <p className="font-semibold text-slate-900 mt-1">
                    {detail.application.type.replace(/_/g, ' ')}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Approval Reference</p>
                  <p className="font-mono font-semibold text-slate-900 mt-1">
                    {detail.application.approval_reference || 'Pending'}
                  </p>
                </div>
              </div>

              {/* Workflow Stage Progress */}
              <div className="grid grid-cols-4 gap-2 text-xs">
                {WORKFLOW_STEPS.map((step, idx) => {
                  const statusIdx = WORKFLOW_STEPS.indexOf(detail.application.status);
                  const reached =
                    detail.application.status === 'APPROVED' ||
                    (statusIdx >= 0 && idx <= statusIdx) ||
                    (detail.application.status === 'CLERK_VERIFIED' && idx <= 1) ||
                    (detail.application.status === 'SURVEY_VERIFIED' && idx <= 2);
                  return (
                    <div
                      key={step}
                      className={`p-2 rounded border text-center font-medium ${
                        reached
                          ? 'bg-blue-50 border-blue-200 text-blue-900'
                          : 'bg-slate-50 border-slate-200 text-slate-500'
                      }`}
                    >
                      {idx + 1}. {step.replace(/_/g, ' ')}
                    </div>
                  );
                })}
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs space-y-1.5">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold text-slate-900">
                    Applicant: {detail.application.applicant_name} ({detail.application.applicant_email})
                  </span>
                  <button
                    type="button"
                    onClick={handleDownloadReceipt}
                    className="inline-flex items-center gap-1.5 text-blue-700 hover:underline font-semibold"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Acknowledgement Receipt</span>
                  </button>
                </div>
                <p className="text-slate-700">{detail.application.summary_notes}</p>
                {detail.application.proposed_transferee_name && (
                  <p className="text-slate-700">
                    <strong>Proposed Transferee:</strong> {detail.application.proposed_transferee_name}
                  </p>
                )}
              </div>

              {/* Supporting Documents & Upload */}
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-slate-900">
                  Registered Supporting Documents ({detail.documents.length})
                </h3>
                {detail.documents.length > 0 ? (
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {detail.documents.map((doc) => (
                      <div key={doc.document_id} className="p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-semibold text-slate-900">
                            <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                            <span className="truncate">{doc.original_filename}</span>
                            <span className="font-mono text-slate-500">v{doc.version}</span>
                          </div>
                          <p className="font-mono text-slate-500 mt-0.5 break-all">
                            {doc.document_id} · SHA-256: {doc.sha256_hash}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            downloadProtectedFile(
                              `/api/documents/${doc.document_id}/download`,
                              doc.original_filename
                            )
                          }
                          className="px-2.5 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-semibold text-slate-700 inline-flex items-center gap-1.5 shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download</span>
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">No documents attached yet.</p>
                )}

                <form onSubmit={handleDocumentUpload} className="flex flex-wrap items-center gap-3 pt-2">
                  <input
                    type="file"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    className="text-xs text-slate-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-semibold file:bg-slate-50"
                  />
                  <input
                    type="text"
                    value={uploadCat}
                    onChange={(e) => setUploadCat(e.target.value)}
                    placeholder="Category (e.g. SURVEY_REPORT)"
                    className="px-3 py-1.5 text-xs border border-slate-300 rounded-md"
                  />
                  <button
                    type="submit"
                    disabled={!uploadFile || loading}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white text-xs font-semibold rounded-md inline-flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Upload & Compute SHA-256</span>
                  </button>
                </form>
              </div>

              {/* Review History */}
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-slate-900">
                  Review & Verification History ({detail.reviews.length})
                </h3>
                {detail.reviews.length === 0 ? (
                  <p className="text-xs text-slate-500">No officer reviews recorded yet.</p>
                ) : (
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {detail.reviews.map((rev) => (
                      <div key={rev.review_id} className="p-3 text-xs space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-900">
                            {rev.reviewer_name} ({rev.reviewer_role}) · {rev.decision}
                          </span>
                          <span className="font-mono tabular-nums text-slate-500">
                            {new Date(rev.created_at).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-slate-700">{rev.remarks}</p>
                        {rev.survey_notes && (
                          <p className="text-blue-900 bg-blue-50 px-2 py-1 rounded">
                            <strong>Survey Notes:</strong> {rev.survey_notes}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Role-Specific Workflow Controls */}
              {(isClerk || isSurveyor || isOfficer) && (
                <div className="border-t border-slate-200 pt-4 space-y-3">
                  <h3 className="text-sm font-bold text-slate-900">Officer Workflow Action</h3>
                  <textarea
                    rows={2}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Enter official verification or approval remarks..."
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />

                  {isSurveyor && (
                    <input
                      type="text"
                      value={surveyNotes}
                      onChange={(e) => setSurveyNotes(e.target.value)}
                      placeholder="Survey boundary & GIS evidence notes (optional)"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  )}

                  {isOfficer && (
                    <input
                      type="text"
                      value={approvalRefInput}
                      onChange={(e) => setApprovalRefInput(e.target.value)}
                      placeholder="Official Approval Reference (auto-generated if left blank)"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  )}

                  {(isClerk || currentUser.roles.includes('ADMIN')) && reviewers.length > 0 && (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 sm:grid-cols-3 gap-2 items-end text-xs">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">Assign Surveyor</label>
                        <select
                          value={assignSurveyorId}
                          onChange={(e) => setAssignSurveyorId(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                        >
                          <option value="">-- Unassigned --</option>
                          {reviewers
                            .filter((r) => r.role_name === 'SURVEYOR')
                            .map((r) => (
                              <option key={r.user_id} value={r.user_id}>
                                {r.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">Assign Approving Officer</label>
                        <select
                          value={assignOfficerId}
                          onChange={(e) => setAssignOfficerId(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                        >
                          <option value="">-- Unassigned --</option>
                          {reviewers
                            .filter((r) => r.role_name === 'APPROVING_OFFICER')
                            .map((r) => (
                              <option key={r.user_id} value={r.user_id}>
                                {r.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={handleAssignReviewers}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white font-semibold rounded"
                      >
                        Assign Reviewers
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {isClerk && (
                      <>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleReviewAction('VERIFIED')}
                          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg"
                        >
                          Clerk Verify & Route to Surveyor
                        </button>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleReviewAction('RETURNED')}
                          className="px-3 py-1.5 border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-semibold rounded-lg"
                        >
                          Return Incomplete
                        </button>
                      </>
                    )}

                    {isSurveyor && (
                      <>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleReviewAction('SURVEY_COMPLETED')}
                          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg"
                        >
                          Submit Survey Findings
                        </button>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleReviewAction('RETURNED')}
                          className="px-3 py-1.5 border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-semibold rounded-lg"
                        >
                          Return for Boundary Correction
                        </button>
                      </>
                    )}

                    {isOfficer && detail.application.status !== 'APPROVED' && (
                      <>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleOfficerDecision('APPROVED', true)}
                          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold rounded-lg"
                        >
                          Approve & Record on Simulated Ledger
                        </button>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleOfficerDecision('APPROVED', false)}
                          className="px-3 py-1.5 border border-emerald-700 text-emerald-800 hover:bg-emerald-50 text-xs font-semibold rounded-lg"
                        >
                          Approve Only (Queue Ledger)
                        </button>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleOfficerDecision('RETURNED', false)}
                          className="px-3 py-1.5 border border-amber-300 bg-amber-50 text-amber-900 text-xs font-semibold rounded-lg"
                        >
                          Return
                        </button>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleOfficerDecision('ESCALATED', false)}
                          className="px-3 py-1.5 border border-slate-300 text-slate-700 text-xs font-semibold rounded-lg"
                        >
                          Escalate
                        </button>
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => handleOfficerDecision('REJECTED', false)}
                          className="px-3 py-1.5 bg-red-700 hover:bg-red-800 text-white text-xs font-semibold rounded-lg"
                        >
                          Reject
                        </button>
                      </>
                    )}

                    {isOfficer &&
                      detail.application.status === 'APPROVED' &&
                      !detail.ledgerEvents.some((e) => e.status === 'COMMITTED') && (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={handleSubmitLedgerOnly}
                          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg"
                        >
                          Submit Approved Event to Simulated Fabric Ledger
                        </button>
                      )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
