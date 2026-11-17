import { useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import { apiRequest } from '../api';
import type { LedgerEvent } from '../types';
import { StatusText } from './StatusText';

interface LedgerExplorerProps {
  events: LedgerEvent[];
  fabricAvailable: boolean;
  onRefresh: () => void;
}

export function LedgerExplorer({ events, fabricAvailable, onRefresh }: LedgerExplorerProps) {
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'COMMITTED' | 'FAILED'>('ALL');
  const [chainCheck, setChainCheck] = useState<{
    valid: boolean;
    totalCommittedEvents: number;
    brokenLinks: Array<{ event_id: string; block_number: number; reason: string }>;
    checkedAt: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  async function runChainVerification() {
    setChecking(true);
    try {
      const res = await apiRequest<typeof chainCheck>('/api/ledger/verify');
      setChainCheck(res);
    } finally {
      setChecking(false);
    }
  }

  const filtered = events.filter((e) => (statusFilter === 'ALL' ? true : e.status === statusFilter));

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Permissioned Blockchain Ledger Explorer (Simulated Hyperledger Fabric)
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Channel <span className="font-mono font-semibold">landrecords-channel</span> · Chaincode{' '}
              <span className="font-mono font-semibold">land_record_chaincode</span> · Endorsement across
              RevenueDeptMSP, SurveyGISMSP, and RegistrarAuthorityMSP.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runChainVerification}
              disabled={checking}
              className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg whitespace-nowrap"
            >
              {checking ? 'Verifying Hashes...' : 'Verify Hash Chain Integrity'}
            </button>
            <button
              type="button"
              onClick={onRefresh}
              className="px-3 py-2 border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <div className="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700">
          <span>
            <strong>Network Mode:</strong> Local Simulated Hyperledger Fabric Consortium (Academic Prototype).
            Only minimal parcel references, approval IDs, and document SHA-256 hashes are written on-chain.
          </span>
          <span className={`font-semibold ${fabricAvailable ? 'text-emerald-700' : 'text-red-700'}`}>
            Peer Network: {fabricAvailable ? 'ONLINE (Simulated)' : 'UNAVAILABLE (Simulated Outage)'}
          </span>
        </div>

        {chainCheck && (
          <div
            className={`mt-4 p-3.5 rounded-lg border text-xs flex items-center justify-between gap-3 ${
              chainCheck.valid
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-900'
            }`}
          >
            <div className="flex items-center gap-2">
              {chainCheck.valid ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              ) : (
                <ShieldAlert className="w-4 h-4 text-red-700 shrink-0" />
              )}
              <span>
                {chainCheck.valid
                  ? `Hash chain verified intact across ${chainCheck.totalCommittedEvents} committed ledger blocks.`
                  : `Chain integrity mismatch detected in ${chainCheck.brokenLinks.length} block(s).`}
              </span>
            </div>
            <span className="font-mono tabular-nums">
              {new Date(chainCheck.checkedAt).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-slate-900">Ledger Event History ({filtered.length})</h3>
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['ALL', 'COMMITTED', 'FAILED'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  statusFilter === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Block</th>
                <th className="py-3 px-4">Transaction ID (Simulated)</th>
                <th className="py-3 px-4">Parcel / Version</th>
                <th className="py-3 px-4">Event Type</th>
                <th className="py-3 px-4">Approval Ref</th>
                <th className="py-3 px-4">Event Hash</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    No ledger events match the selected filter.
                  </td>
                </tr>
              ) : (
                filtered.map((evt) => (
                  <tr key={evt.event_id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-mono tabular-nums font-semibold text-slate-900">
                      #{evt.block_number}
                    </td>
                    <td className="py-3 px-4 font-mono text-blue-800">{evt.tx_id}</td>
                    <td className="py-3 px-4">
                      <span className="font-mono font-semibold text-slate-900">{evt.parcel_id}</span>
                      <span className="text-slate-400"> · </span>
                      <span className="font-mono text-slate-600">v{evt.parcel_version}</span>
                    </td>
                    <td className="py-3 px-4 text-slate-700 font-medium">{evt.event_type}</td>
                    <td className="py-3 px-4 font-mono text-slate-600">{evt.approval_reference || '—'}</td>
                    <td className="py-3 px-4 font-mono text-slate-600" title={evt.event_hash}>
                      {evt.event_hash.slice(0, 14)}…
                    </td>
                    <td className="py-3 px-4">
                      <StatusText status={evt.status} />
                      {evt.error_message && (
                        <p className="text-red-700 mt-1 max-w-xs">{evt.error_message}</p>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {new Date(evt.timestamp).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
