import { useEffect, useState, type FormEvent } from 'react';
import { Database, Download, KeyRound, RefreshCw, RotateCcw, Send, Shield } from 'lucide-react';
import { apiRequest, downloadProtectedFile } from '../api';
import type { AuditLog, RoleName, User } from '../types';
import { StatusText } from './StatusText';

interface AdminConsoleProps {
  currentUser: User;
  fabricAvailable: boolean;
  onRefreshGlobal: () => void;
}

interface BackupRecord {
  backup_id: string;
  created_by: string;
  checksum_sha256: string;
  document_count: number;
  created_at: string;
}

interface FabricCert {
  identity_id: string;
  org_msp: string;
  role_name: string;
  common_name: string;
  cert_serial: string;
  cert_status: string;
  expires_at: string;
}

export function AdminConsole({ currentUser, fabricAvailable, onRefreshGlobal }: AdminConsoleProps) {
  const isAdmin = currentUser.roles.includes('ADMIN');
  const [users, setUsers] = useState<User[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [certs, setCerts] = useState<FabricCert[]>([]);
  const [configs, setConfigs] = useState<Array<{ config_key: string; config_value: string }>>([]);
  const [health, setHealth] = useState<{
    status: string;
    database: string;
    fabricMode: string;
    fabricAvailable: boolean;
  } | null>(null);
  const [summary, setSummary] = useState<{
    metrics: Record<string, number>;
    applicationsByStatus: Array<{ status: string; count: number }>;
  } | null>(null);
  const [cfgKey, setCfgKey] = useState('lockout_threshold');
  const [cfgVal, setCfgVal] = useState('5');
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAdminData() {
    try {
      const [uRes, aRes, bRes, cRes, cfgRes, hRes, sRes] = await Promise.all([
        apiRequest<{ users: User[] }>('/api/admin/users'),
        apiRequest<{ logs: AuditLog[] }>('/api/audit-logs'),
        apiRequest<{ backups: BackupRecord[] }>('/api/admin/backups'),
        apiRequest<{ certificates: FabricCert[] }>('/api/admin/certificates'),
        apiRequest<{ configs: Array<{ config_key: string; config_value: string }> }>('/api/admin/config'),
        apiRequest<NonNullable<typeof health>>('/api/health'),
        apiRequest<NonNullable<typeof summary>>('/api/reports/summary')
      ]);
      setUsers(uRes.users);
      setAuditLogs(aRes.logs);
      setBackups(bRes.backups);
      setCerts(cRes.certificates);
      setConfigs(cfgRes.configs);
      setHealth(hRes);
      setSummary(sRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin console data.');
    }
  }

  useEffect(() => {
    loadAdminData();
  }, []);

  async function handleToggleCert(certId: string, currentStatus: string) {
    setError(null);
    setMessage(null);
    const nextStatus = currentStatus === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
    await apiRequest(`/api/admin/certificates/${certId}/status`, {
      method: 'POST',
      body: JSON.stringify({ cert_status: nextStatus })
    });
    setMessage(`MSP Certificate ${certId} set to ${nextStatus}.`);
    await loadAdminData();
  }

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    await apiRequest('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({ config_key: cfgKey, config_value: cfgVal })
    });
    setMessage(`Updated configuration ${cfgKey} = ${cfgVal}.`);
    await loadAdminData();
  }

  async function handleUserStatus(userId: string, status: 'ACTIVE' | 'LOCKED' | 'SUSPENDED') {
    setError(null);
    setMessage(null);
    await apiRequest(`/api/admin/users/${userId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
    setMessage(`Updated user ${userId} status to ${status}.`);
    await loadAdminData();
  }

  async function handleRoleChange(userId: string, roleName: RoleName) {
    setError(null);
    setMessage(null);
    await apiRequest(`/api/admin/users/${userId}/roles`, {
      method: 'POST',
      body: JSON.stringify({ role_name: roleName })
    });
    setMessage(`Updated role for ${userId} to ${roleName}.`);
    await loadAdminData();
  }

  async function handleToggleFabric() {
    setError(null);
    setMessage(null);
    await apiRequest('/api/ledger/toggle-availability', {
      method: 'POST',
      body: JSON.stringify({ available: !fabricAvailable })
    });
    setMessage(
      !fabricAvailable
        ? 'Simulated Hyperledger Fabric network restored ONLINE.'
        : 'Simulated Hyperledger Fabric network set to UNAVAILABLE (Outage Test Mode).'
    );
    onRefreshGlobal();
    await loadAdminData();
  }

  async function handleCreateBackup() {
    setError(null);
    setMessage(null);
    const res = await apiRequest<{ backup: BackupRecord }>('/api/admin/backups', { method: 'POST' });
    setMessage(`Backup ${res.backup.backup_id} created (${res.backup.document_count} documents).`);
    await loadAdminData();
  }

  async function handleRestoreBackup(backupId: string) {
    setError(null);
    setMessage(null);
    const res = await apiRequest<{ restoredDocuments: number }>(`/api/admin/backups/${backupId}/restore`, {
      method: 'POST'
    });
    setMessage(`Restored backup ${backupId} (${res.restoredDocuments} private documents verified).`);
    onRefreshGlobal();
    await loadAdminData();
  }

  async function handleBroadcast(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await apiRequest<{ sentCount: number }>('/api/admin/notifications/broadcast', {
      method: 'POST',
      body: JSON.stringify({ title: broadcastTitle, message: broadcastMessage })
    });
    setBroadcastTitle('');
    setBroadcastMessage('');
    setMessage(`Notification broadcast delivered to ${res.sentCount} user(s).`);
    onRefreshGlobal();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">{error}</div>
      )}
      {message && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
          {message}
        </div>
      )}

      {/* Service Health & Statistics Summary */}
      {health && summary && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <p className="text-slate-500">API & Database Health</p>
            <p className="font-semibold text-emerald-700 mt-1">
              {health.status} · {health.database}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Applications (Approved / Pending)</p>
            <p className="font-mono font-bold text-slate-900 tabular-nums mt-1">
              {summary.metrics.approvedApplications || 0} / {summary.metrics.pendingApplications || 0}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Ledger TX (Committed / Failed)</p>
            <p className="font-mono font-bold text-slate-900 tabular-nums mt-1">
              {summary.metrics.committedTransactions || 0} / {summary.metrics.failedTransactions || 0}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Status Breakdown</p>
            <p className="font-mono text-slate-700 mt-1 truncate" title={summary.applicationsByStatus.map((s) => `${s.status}:${s.count}`).join(', ')}>
              {summary.applicationsByStatus.map((s) => `${s.status}:${s.count}`).join(' · ') || 'None'}
            </p>
          </div>
        </div>
      )}

      {/* Fabric Availability & Backup Quick Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-blue-700" />
              <h3 className="text-base font-bold text-slate-900">Simulated Fabric Network & Key Status</h3>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={handleToggleFabric}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                  fabricAvailable
                    ? 'bg-amber-50 border border-amber-300 text-amber-900 hover:bg-amber-100'
                    : 'bg-emerald-700 text-white hover:bg-emerald-800'
                }`}
              >
                {fabricAvailable ? 'Simulate Network Outage' : 'Restore Fabric Network'}
              </button>
            )}
          </div>

          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 text-xs">
            {certs.map((cert) => (
              <div key={cert.identity_id} className="p-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">
                    {cert.org_msp} · {cert.role_name}
                  </p>
                  <p className="font-mono text-slate-500">
                    {cert.common_name} · Serial {cert.cert_serial}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusText status={cert.cert_status} />
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => handleToggleCert(cert.identity_id, cert.cert_status)}
                      className="text-xs font-semibold text-blue-700 hover:underline"
                    >
                      {cert.cert_status === 'ACTIVE' ? 'Revoke' : 'Activate'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2 pt-2 border-t border-slate-100 text-xs">
            <p className="text-slate-600">
              <strong>System Config:</strong>{' '}
              {configs.map((c) => `${c.config_key}=${c.config_value}`).join(' · ')}
            </p>
            {isAdmin && (
              <form onSubmit={handleSaveConfig} className="flex flex-wrap gap-2 items-center">
                <select
                  value={cfgKey}
                  onChange={(e) => setCfgKey(e.target.value)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded bg-white text-xs"
                >
                  <option value="lockout_threshold">lockout_threshold</option>
                  <option value="max_file_size_mb">max_file_size_mb</option>
                  <option value="fabric_mode">fabric_mode</option>
                </select>
                <input
                  type="text"
                  value={cfgVal}
                  onChange={(e) => setCfgVal(e.target.value)}
                  className="w-28 px-2.5 py-1.5 border border-slate-300 rounded font-mono text-xs"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white font-semibold rounded text-xs"
                >
                  Save Config
                </button>
              </form>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-blue-700" />
              <h3 className="text-base font-bold text-slate-900">Database & Private Document Backups</h3>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={handleCreateBackup}
                className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg"
              >
                Create Backup Snapshot
              </button>
            )}
          </div>

          {backups.length === 0 ? (
            <p className="text-xs text-slate-500">
              No backup snapshots created yet. Click Create Backup Snapshot to archive SQLite & private files.
            </p>
          ) : (
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 text-xs max-h-56 overflow-y-auto">
              {backups.map((b) => (
                <div key={b.backup_id} className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono font-semibold text-slate-900">{b.backup_id}</p>
                    <p className="text-slate-500 font-mono truncate">
                      {b.document_count} docs · SHA-256: {b.checksum_sha256.slice(0, 16)}…
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => handleRestoreBackup(b.backup_id)}
                      className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-50 font-semibold text-slate-700 inline-flex items-center gap-1 shrink-0"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Restore</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* User & Role Management */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-blue-700" />
            <h3 className="text-sm font-bold text-slate-900">User Accounts & Role Permissions ({users.length})</h3>
          </div>
          <button
            type="button"
            onClick={loadAdminData}
            className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                <th className="py-3 px-4">User</th>
                <th className="py-3 px-4">Email</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">MFA</th>
                {isAdmin && <th className="py-3 px-4">Admin Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.user_id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-4 font-medium text-slate-900">{u.name}</td>
                  <td className="py-2.5 px-4 font-mono text-slate-600">{u.email}</td>
                  <td className="py-2.5 px-4">
                    {isAdmin ? (
                      <select
                        value={u.roles[0] || 'CITIZEN'}
                        onChange={(e) => handleRoleChange(u.user_id, e.target.value as RoleName)}
                        className="px-2 py-1 border border-slate-300 rounded bg-white text-xs"
                      >
                        <option value="CITIZEN">CITIZEN</option>
                        <option value="CLERK">CLERK</option>
                        <option value="SURVEYOR">SURVEYOR</option>
                        <option value="APPROVING_OFFICER">APPROVING_OFFICER</option>
                        <option value="ADMIN">ADMIN</option>
                        <option value="AUDITOR">AUDITOR</option>
                      </select>
                    ) : (
                      <span className="font-mono">{u.roles.join(', ')}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4">
                    <StatusText status={u.status} />
                  </td>
                  <td className="py-2.5 px-4">{u.mfa_enabled ? 'Enabled' : 'Off'}</td>
                  {isAdmin && (
                    <td className="py-2.5 px-4 space-x-2">
                      {u.status !== 'ACTIVE' ? (
                        <button
                          type="button"
                          onClick={() => handleUserStatus(u.user_id, 'ACTIVE')}
                          className="text-emerald-700 hover:underline font-semibold"
                        >
                          Activate
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleUserStatus(u.user_id, 'SUSPENDED')}
                          className="text-red-700 hover:underline font-semibold"
                        >
                          Suspend
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Downloadable Reports & Notification Broadcast */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h3 className="text-base font-bold text-slate-900">Downloadable Compliance & Audit Reports</h3>
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { id: 'applications', label: 'Applications Report (CSV)' },
              { id: 'parcels', label: 'Parcel Registry (CSV)' },
              { id: 'ledger', label: 'Ledger Events (CSV)' },
              { id: 'audit', label: 'Audit Logs (CSV)' }
            ].map((rep) => (
              <button
                key={rep.id}
                type="button"
                onClick={() =>
                  downloadProtectedFile(
                    `/api/reports/export?type=${rep.id}&format=csv`,
                    `civicledger_${rep.id}.csv`
                  )
                }
                className="px-3 py-2 border border-slate-300 hover:bg-slate-50 rounded-lg text-xs font-semibold text-slate-700 inline-flex items-center justify-between"
              >
                <span>{rep.label}</span>
                <Download className="w-3.5 h-3.5 text-slate-500" />
              </button>
            ))}
          </div>
        </div>

        {isAdmin && (
          <form onSubmit={handleBroadcast} className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <h3 className="text-base font-bold text-slate-900">Broadcast System Notification</h3>
            <input
              type="text"
              required
              value={broadcastTitle}
              onChange={(e) => setBroadcastTitle(e.target.value)}
              placeholder="Notice title"
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={broadcastMessage}
                onChange={(e) => setBroadcastMessage(e.target.value)}
                placeholder="Message to all portal users..."
                className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
              <button
                type="submit"
                className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg inline-flex items-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send</span>
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Audit Logs */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-900">Immutable System Audit Trail (Latest 200)</h3>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                <th className="py-2.5 px-4">Timestamp</th>
                <th className="py-2.5 px-4">Actor</th>
                <th className="py-2.5 px-4">Action</th>
                <th className="py-2.5 px-4">Object</th>
                <th className="py-2.5 px-4">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {auditLogs.map((log) => (
                <tr key={log.log_id} className="hover:bg-slate-50">
                  <td className="py-2 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString()}
                  </td>
                  <td className="py-2 px-4 font-mono text-slate-700">
                    {log.actor_id} ({log.actor_role || 'NONE'})
                  </td>
                  <td className="py-2 px-4 font-semibold text-slate-900">{log.action}</td>
                  <td className="py-2 px-4 font-mono text-slate-600">
                    {log.object_type}:{log.object_id}
                  </td>
                  <td className="py-2 px-4 font-mono text-slate-500 max-w-xs truncate" title={log.details_json}>
                    {log.details_json}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
