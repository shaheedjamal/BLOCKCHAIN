import { useState, type FormEvent } from 'react';
import { FileCheck2, ShieldAlert, Upload } from 'lucide-react';
import { apiRequest } from '../api';
import type { DocumentRecord, VerificationResult } from '../types';
import { StatusText } from './StatusText';

interface DocumentVerifierProps {
  documents: DocumentRecord[];
}

export function DocumentVerifier({ documents }: DocumentVerifierProps) {
  const [selectedDocId, setSelectedDocId] = useState(documents[0]?.document_id || '');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (!selectedDocId || !file) {
      setError('Select a registered document ID and choose a local file to verify.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('document_id', selectedDocId);
      formData.append('file', file);
      const res = await apiRequest<VerificationResult>('/api/documents/verify', {
        method: 'POST',
        body: formData
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="text-lg font-bold text-slate-900">SHA-256 Document Integrity Verification</h2>
        <p className="text-sm text-slate-600 mt-1">
          Upload any copy of a registered document to recompute its exact SHA-256 cryptographic digest and
          compare it against the registered database hash.
        </p>

        <form onSubmit={handleVerify} className="mt-6 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-5">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Registered Document Reference
            </label>
            <select
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">-- Select a registered document --</option>
              {documents.map((d) => (
                <option key={d.document_id} value={d.document_id}>
                  {d.document_id} · {d.original_filename} (v{d.version})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-4">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Or Enter Document ID Manually
            </label>
            <input
              type="text"
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              placeholder="DOC-2026-0001"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              File Bytes to Verify
            </label>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-semibold file:bg-slate-50 hover:file:bg-slate-100"
            />
          </div>

          <div className="md:col-span-12 flex items-center justify-between pt-2">
            <span className="text-xs text-slate-500">
              Reads exact binary bytes server-side using Node crypto SHA-256.
            </span>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-sm font-semibold rounded-lg inline-flex items-center gap-2 whitespace-nowrap"
            >
              <Upload className="w-4 h-4" />
              <span>{loading ? 'Hashing & Comparing...' : 'Verify Document SHA-256'}</span>
            </button>
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            {error}
          </div>
        )}
      </div>

      {result && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div className="flex items-center gap-3">
              {result.result === 'MATCH' ? (
                <FileCheck2 className="w-6 h-6 text-emerald-700" />
              ) : (
                <ShieldAlert className="w-6 h-6 text-red-700" />
              )}
              <div>
                <h3 className="text-base font-bold text-slate-900">Verification Report</h3>
                <p className="text-xs text-slate-500 tabular-nums">
                  Verified at {new Date(result.verifiedAt).toLocaleString()}
                </p>
              </div>
            </div>
            <StatusText status={result.result} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <p className="text-slate-500">Document Name</p>
              <p className="font-semibold text-slate-900 mt-0.5 break-all">{result.documentName}</p>
            </div>
            <div>
              <p className="text-slate-500">Document ID & Version</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">
                {result.documentId} (v{result.documentVersion})
              </p>
            </div>
            <div>
              <p className="text-slate-500">Related Application</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">{result.applicationId}</p>
            </div>
            <div>
              <p className="text-slate-500">Parcel Reference</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">{result.parcelId}</p>
            </div>
          </div>

          <div className="space-y-2 pt-2">
            <div>
              <p className="text-xs font-semibold text-slate-700">Registered SHA-256 Hash</p>
              <p className="mt-1 p-2.5 bg-slate-50 border border-slate-200 rounded font-mono text-xs text-slate-800 break-all">
                {result.registeredHash}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700">Computed SHA-256 Hash (Uploaded File)</p>
              <p
                className={`mt-1 p-2.5 border rounded font-mono text-xs break-all ${
                  result.result === 'MATCH'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border-red-200 text-red-900'
                }`}
              >
                {result.computedHash}
              </p>
            </div>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
            <strong>Scope Notice:</strong> {result.legalDisclaimer}
          </div>
        </div>
      )}
    </div>
  );
}
