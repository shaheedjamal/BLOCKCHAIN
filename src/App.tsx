import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Bell,
  Blocks,
  FileCheck2,
  FileText,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  X,
  Download,
  KeyRound
} from 'lucide-react';
import { apiRequest, downloadProtectedFile, getStoredToken, setStoredToken } from './api';
import { AdminConsole } from './components/AdminConsole';
import { ApplicationModal } from './components/ApplicationModal';
import { AuthPortal } from './components/AuthPortal';
import { DocumentVerifier } from './components/DocumentVerifier';
import { LedgerExplorer } from './components/LedgerExplorer';
import { ParcelMap } from './components/ParcelMap';
import { StatusText } from './components/StatusText';
import type {
  ApplicationRecord,
  DocumentRecord,
  LedgerEvent,
  NotificationItem,
  Parcel,
  User
} from './types';

type ActiveTab = 'overview' | 'parcels' | 'applications' | 'verify' | 'ledger' | 'admin';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Core data state
  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [ledgerEvents, setLedgerEvents] = useState<LedgerEvent[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [fabricAvailable, setFabricAvailable] = useState(true);

  // UI controls
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null);
  const [parcelDetail, setParcelDetail] = useState<{
    parcel: Parcel;
    ledgerEvents: LedgerEvent[];
    applications: ApplicationRecord[];
  } | null>(null);
  const [parcelSearch, setParcelSearch] = useState('');
  const [appStatusFilter, setAppStatusFilter] = useState('');
  const [appModal, setAppModal] = useState<{ mode: 'create' | 'view'; id?: string } | null>(null);
  const [showNewParcelModal, setShowNewParcelModal] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  // Unified search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    parcels: Parcel[];
    applications: ApplicationRecord[];
    documents: DocumentRecord[];
    ledgerEvents: LedgerEvent[];
  } | null>(null);

  // New Parcel Form
  const [newParcelId, setNewParcelId] = useState('');
  const [newSurveyNo, setNewSurveyNo] = useState('');
  const [newLocality, setNewLocality] = useState('CHN-ZN-05 (DEMO)');
  const [newArea, setNewArea] = useState('');
  const [newLandUse, setNewLandUse] = useState('Residential');
  const [newOwnerName, setNewOwnerName] = useState('');
  const [parcelFormError, setParcelFormError] = useState<string | null>(null);

  // Edit Parcel Metadata
  const [editingParcelMeta, setEditingParcelMeta] = useState(false);
  const [editArea, setEditArea] = useState('');
  const [editGeomRef, setEditGeomRef] = useState('');
  const [editParcelNotice, setEditParcelNotice] = useState<string | null>(null);

  // Change Password Modal
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [curPwd, setCurPwd] = useState('');
  const [nextPwd, setNextPwd] = useState('');
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);

  const loadWorkspaceData = useCallback(async () => {
    try {
      const [pRes, aRes, dRes, lRes, nRes] = await Promise.all([
        apiRequest<{ parcels: Parcel[] }>('/api/parcels'),
        apiRequest<{ applications: ApplicationRecord[] }>('/api/applications'),
        apiRequest<{ documents: DocumentRecord[] }>('/api/documents'),
        apiRequest<{ events: LedgerEvent[]; fabricAvailable: boolean }>('/api/ledger/events'),
        apiRequest<{ notifications: NotificationItem[]; unreadCount: number }>('/api/notifications')
      ]);
      setParcels(pRes.parcels);
      setApplications(aRes.applications);
      setDocuments(dRes.documents);
      setLedgerEvents(lRes.events);
      setFabricAvailable(lRes.fabricAvailable);
      setNotifications(nRes.notifications);
      setUnreadCount(nRes.unreadCount);
    } catch {
      // Handled per view
    }
  }, []);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthLoading(false);
      return;
    }
    apiRequest<{ user: User }>('/api/auth/me')
      .then((res) => {
        setUser(res.user);
      })
      .catch(() => {
        setStoredToken(null);
        setUser(null);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (user) {
      loadWorkspaceData();
    }
  }, [user, loadWorkspaceData]);

  async function inspectParcel(parcel: Parcel) {
    setSelectedParcelId(parcel.parcel_id);
    setEditingParcelMeta(false);
    setEditParcelNotice(null);
    try {
      const res = await apiRequest<{
        parcel: Parcel;
        ledgerEvents: LedgerEvent[];
        applications: ApplicationRecord[];
      }>(`/api/parcels/${parcel.parcel_id}`);
      setParcelDetail(res);
      setEditArea(res.parcel.area);
      setEditGeomRef(res.parcel.geometry_ref);
    } catch {
      setParcelDetail(null);
    }
  }

  async function handleUpdateParcelMeta(e: FormEvent) {
    e.preventDefault();
    if (!parcelDetail) return;
    await apiRequest(`/api/parcels/${parcelDetail.parcel.parcel_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ area: editArea, geometry_ref: editGeomRef })
    });
    setEditingParcelMeta(false);
    setEditParcelNotice('Permitted parcel metadata updated.');
    await loadWorkspaceData();
    await inspectParcel(parcelDetail.parcel);
  }

  function handleDownloadParcelHistoryReport() {
    if (!parcelDetail) return;
    const report = {
      reportType: 'PARCEL_EVENT_HISTORY_REPORT',
      generatedAt: new Date().toISOString(),
      environmentNotice: 'ACADEMIC PROTOTYPE DEMONSTRATION REPORT',
      parcel: parcelDetail.parcel,
      applications: parcelDetail.applications,
      ledgerEvents: parcelDetail.ledgerEvents
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ParcelHistory_${parcelDetail.parcel.parcel_id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPwdErr(null);
    setPwdMsg(null);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: curPwd, newPassword: nextPwd })
      });
      setPwdMsg(res.message);
      setCurPwd('');
      setNextPwd('');
    } catch (err) {
      setPwdErr(err instanceof Error ? err.message : 'Password change failed.');
    }
  }

  async function handleUnifiedSearch(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const res = await apiRequest<NonNullable<typeof searchResults>>(
      `/api/search?q=${encodeURIComponent(searchQuery.trim())}`
    );
    setSearchResults(res);
  }

  async function handleLogout() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setStoredToken(null);
    setUser(null);
    setSearchResults(null);
    setParcelDetail(null);
  }

  async function handleToggleMfa() {
    if (!user) return;
    const res = await apiRequest<{ user: User }>('/api/auth/mfa/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: !user.mfa_enabled })
    });
    setUser(res.user);
  }

  async function handleCreateParcel(e: FormEvent) {
    e.preventDefault();
    setParcelFormError(null);
    try {
      await apiRequest('/api/parcels', {
        method: 'POST',
        body: JSON.stringify({
          parcel_id: newParcelId,
          survey_no: newSurveyNo,
          locality: newLocality,
          area: newArea,
          land_use: newLandUse,
          owner_display_name: newOwnerName
        })
      });
      setShowNewParcelModal(false);
      setNewParcelId('');
      setNewSurveyNo('');
      setNewArea('');
      setNewOwnerName('');
      await loadWorkspaceData();
    } catch (err) {
      setParcelFormError(err instanceof Error ? err.message : 'Failed to create parcel.');
    }
  }

  async function markAllNotificationsRead() {
    await apiRequest('/api/notifications/read-all', { method: 'POST' });
    await loadWorkspaceData();
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">
        Loading CivicLedger workspace...
      </div>
    );
  }

  if (!user) {
    return (
      <AuthPortal
        onAuthenticated={(loggedInUser) => {
          setUser(loggedInUser);
          setActiveTab('overview');
        }}
      />
    );
  }

  const primaryRole = user.roles[0] || 'CITIZEN';
  const isStaff = user.roles.some((r) => r !== 'CITIZEN');
  const canManageAdmin = user.roles.includes('ADMIN') || user.roles.includes('AUDITOR');
  const canAddParcel = user.roles.includes('ADMIN') || user.roles.includes('APPROVING_OFFICER');
  const canEditParcelMeta = user.roles.includes('SURVEYOR') || user.roles.includes('APPROVING_OFFICER') || user.roles.includes('ADMIN');

  const navItems: Array<{ id: ActiveTab; label: string; Icon: typeof LayoutDashboard; show: boolean }> = [
    { id: 'overview', label: 'Dashboard Overview', Icon: LayoutDashboard, show: true },
    { id: 'parcels', label: 'Parcels & GIS Map', Icon: MapPin, show: true },
    { id: 'applications', label: 'Applications', Icon: FileText, show: true },
    { id: 'verify', label: 'SHA-256 Verify', Icon: FileCheck2, show: true },
    { id: 'ledger', label: 'Blockchain Ledger', Icon: Blocks, show: true },
    { id: 'admin', label: 'Admin & Audit', Icon: Settings, show: canManageAdmin }
  ];

  const filteredParcels = parcels.filter((p) => {
    if (!parcelSearch.trim()) return true;
    const q = parcelSearch.toLowerCase();
    return (
      p.parcel_id.toLowerCase().includes(q) ||
      p.survey_no.toLowerCase().includes(q) ||
      p.locality.toLowerCase().includes(q) ||
      p.owner_display_name.toLowerCase().includes(q)
    );
  });

  const filteredApps = applications.filter((a) =>
    appStatusFilter ? a.status === appStatusFilter : true
  );

  // Role-specific action queue
  const roleQueueApps = applications.filter((a) => {
    if (primaryRole === 'CLERK') return a.status === 'SUBMITTED';
    if (primaryRole === 'SURVEYOR')
      return a.status === 'SURVEY_IN_PROGRESS' || a.status === 'CLERK_VERIFIED';
    if (primaryRole === 'APPROVING_OFFICER')
      return a.status === 'AWAITING_APPROVAL' || a.status === 'SURVEY_VERIFIED' || a.status === 'ESCALATED';
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-white border-r border-slate-200 flex flex-col justify-between transition-transform lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div>
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src="/src/assets/images/registry_crest_1794889840582.jpg"
                alt="CivicLedger"
                referrerPolicy="no-referrer"
                className="w-8 h-8 rounded border border-slate-200 object-cover shrink-0"
              />
              <span className="font-bold text-sm text-slate-900 truncate">CivicLedger</span>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="lg:hidden p-1 text-slate-500"
              aria-label="Close navigation"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/70">
            <p className="text-xs font-semibold text-slate-900 truncate">{user.name}</p>
            <p className="text-xs text-blue-700 font-mono mt-0.5">{primaryRole.replace(/_/g, ' ')}</p>
          </div>

          <nav className="p-3 space-y-1">
            {navItems
              .filter((item) => item.show)
              .map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setActiveTab(id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    activeTab === id
                      ? 'bg-blue-50 text-blue-800'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{label}</span>
                </button>
              ))}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-200 space-y-2">
          <button
            type="button"
            onClick={handleToggleMfa}
            className="w-full px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 flex items-center justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-blue-700" />
              <span>MFA Security</span>
            </span>
            <span className="font-mono text-slate-900">{user.mfa_enabled ? 'ON' : 'OFF'}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setPwdErr(null);
              setPwdMsg(null);
              setShowPwdModal(true);
            }}
            className="w-full px-3 py-2 text-xs font-medium border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 flex items-center gap-2"
          >
            <KeyRound className="w-3.5 h-3.5 text-slate-500" />
            <span>Change Password</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 rounded-lg flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-lg border border-slate-200 text-slate-700"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-xs text-slate-500 truncate">
              <span>CivicLedger Portal</span>
              <span className="mx-1.5">/</span>
              <span className="font-semibold text-slate-900 capitalize">{activeTab}</span>
            </div>
          </div>

          <form onSubmit={handleUnifiedSearch} className="hidden md:flex items-center flex-1 max-w-md">
            <div className="relative w-full">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search Parcel ID, Survey No, App ID, TX ID..."
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </form>

          <div className="flex items-center gap-3 shrink-0 relative">
            <button
              type="button"
              onClick={() => setNotifOpen((prev) => !prev)}
              className="relative p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
              aria-label="Notifications"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-700 text-white text-[10px] font-bold rounded-full flex items-center justify-center tabular-nums">
                  {unreadCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setAppModal({ mode: 'create' })}
              className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Application</span>
            </button>

            {notifOpen && (
              <div className="absolute right-0 top-12 w-80 sm:w-96 bg-white border border-slate-200 rounded-xl shadow-lg z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900">
                    Notifications ({unreadCount} unread)
                  </span>
                  <button
                    type="button"
                    onClick={markAllNotificationsRead}
                    className="text-xs text-blue-700 hover:underline font-semibold"
                  >
                    Mark all read
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
                  {notifications.length === 0 ? (
                    <p className="p-4 text-xs text-slate-500">No notifications yet.</p>
                  ) : (
                    notifications.map((n) => (
                      <div key={n.notification_id} className={`p-3 text-xs ${n.is_read ? 'bg-white' : 'bg-blue-50/50'}`}>
                        <p className="font-semibold text-slate-900">{n.title}</p>
                        <p className="text-slate-600 mt-0.5">{n.message}</p>
                        <p className="text-[11px] font-mono text-slate-400 mt-1 tabular-nums">
                          {new Date(n.created_at).toLocaleString()}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        {/* Search Results Overlay Strip */}
        {searchResults && (
          <div className="bg-blue-50 border-b border-blue-200 px-6 py-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-blue-950">
                Search Results for &ldquo;{searchQuery}&rdquo; ({searchResults.parcels.length} parcels ·{' '}
                {searchResults.applications.length} apps · {searchResults.documents.length} docs ·{' '}
                {searchResults.ledgerEvents.length} ledger tx)
              </span>
              <button
                type="button"
                onClick={() => {
                  setSearchResults(null);
                  setSearchQuery('');
                }}
                className="text-xs font-semibold text-blue-800 hover:underline"
              >
                Clear Search
              </button>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {searchResults.parcels.map((p) => (
                <button
                  key={p.parcel_id}
                  type="button"
                  onClick={() => {
                    inspectParcel(p);
                    setActiveTab('parcels');
                  }}
                  className="px-2.5 py-1 bg-white border border-blue-200 rounded font-mono text-blue-900 hover:bg-blue-100"
                >
                  Parcel: {p.parcel_id} ({p.survey_no})
                </button>
              ))}
              {searchResults.applications.map((a) => (
                <button
                  key={a.application_id}
                  type="button"
                  onClick={() => setAppModal({ mode: 'view', id: a.application_id })}
                  className="px-2.5 py-1 bg-white border border-blue-200 rounded font-mono text-blue-900 hover:bg-blue-100"
                >
                  App: {a.application_id} ({a.status})
                </button>
              ))}
              {searchResults.ledgerEvents.map((e) => (
                <button
                  key={e.event_id}
                  type="button"
                  onClick={() => setActiveTab('ledger')}
                  className="px-2.5 py-1 bg-white border border-blue-200 rounded font-mono text-blue-900 hover:bg-blue-100"
                >
                  TX: {e.tx_id}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Active Page Body */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {/* OVERVIEW TAB */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-blue-700">
                    {primaryRole.replace(/_/g, ' ')} Workspace · Academic Prototype (DEMO Data)
                  </p>
                  <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">
                    Welcome, {user.name}
                  </h1>
                  <p className="text-xs text-slate-500 mt-1">
                    {user.email} · {user.contact} · Simulated Fabric Network:{' '}
                    <span className={fabricAvailable ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                      {fabricAvailable ? 'Online' : 'Simulated Outage'}
                    </span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('parcels')}
                    className="px-3.5 py-2 border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700 rounded-lg"
                  >
                    Explore GIS Parcels
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('verify')}
                    className="px-3.5 py-2 border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700 rounded-lg"
                  >
                    Verify Document Hash
                  </button>
                </div>
              </div>

              {/* Metrics Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">Permitted Parcels</p>
                  <p className="text-2xl font-bold text-slate-900 tabular-nums mt-1">{parcels.length}</p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">
                    {isStaff ? 'Total Applications' : 'My Applications'}
                  </p>
                  <p className="text-2xl font-bold text-slate-900 tabular-nums mt-1">{applications.length}</p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">SHA-256 Documents</p>
                  <p className="text-2xl font-bold text-slate-900 tabular-nums mt-1">{documents.length}</p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <p className="text-xs text-slate-500">Simulated Ledger Events</p>
                  <p className="text-2xl font-bold text-slate-900 tabular-nums mt-1">{ledgerEvents.length}</p>
                </div>
              </div>

              {/* Role-Specific Action Queue */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">
                      {primaryRole === 'CLERK'
                        ? 'Clerk Completeness Review Queue'
                        : primaryRole === 'SURVEYOR'
                        ? 'Surveyor Field & GIS Verification Queue'
                        : primaryRole === 'APPROVING_OFFICER'
                        ? 'Approving Officer Final Decision Queue'
                        : 'Recent Land Record Applications'}
                    </h2>
                    <p className="text-xs text-slate-500">
                      Click any application to inspect documents, remarks, receipts, and workflow actions.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('applications')}
                    className="text-xs font-semibold text-blue-700 hover:underline"
                  >
                    View All Applications
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                        <th className="py-3 px-4">Application ID</th>
                        <th className="py-3 px-4">Parcel</th>
                        <th className="py-3 px-4">Type</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4">Updated</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {roleQueueApps.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-slate-500">
                            No items currently waiting in your role queue.
                          </td>
                        </tr>
                      ) : (
                        roleQueueApps.slice(0, 8).map((app) => (
                          <tr key={app.application_id} className="hover:bg-slate-50">
                            <td className="py-3 px-4 font-mono font-semibold text-blue-800">
                              {app.application_id}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-900">
                              {app.parcel_id} · {app.survey_no}
                            </td>
                            <td className="py-3 px-4 text-slate-700">{app.type.replace(/_/g, ' ')}</td>
                            <td className="py-3 px-4">
                              <StatusText status={app.status} />
                            </td>
                            <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                              {new Date(app.updated_at).toLocaleDateString()}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => setAppModal({ mode: 'view', id: app.application_id })}
                                className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100 font-semibold text-slate-800"
                              >
                                Inspect
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* PARCELS & GIS MAP TAB */}
          {activeTab === 'parcels' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={parcelSearch}
                    onChange={(e) => setParcelSearch(e.target.value)}
                    placeholder="Filter by Parcel ID, Survey No, Locality..."
                    className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                  />
                </div>
                {canAddParcel && (
                  <button
                    type="button"
                    onClick={() => setShowNewParcelModal(true)}
                    className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Register DEMO Parcel</span>
                  </button>
                )}
              </div>

              <ParcelMap
                parcels={filteredParcels}
                selectedParcelId={selectedParcelId}
                onSelectParcel={inspectParcel}
              />

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-200">
                    <h3 className="text-sm font-bold text-slate-900">
                      Land Parcel Registry ({filteredParcels.length})
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                          <th className="py-2.5 px-4">Parcel ID</th>
                          <th className="py-2.5 px-4">Survey</th>
                          <th className="py-2.5 px-4">Area / Use</th>
                          <th className="py-2.5 px-4">Version</th>
                          <th className="py-2.5 px-4">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredParcels.map((p) => (
                          <tr
                            key={p.parcel_id}
                            onClick={() => inspectParcel(p)}
                            className={`cursor-pointer hover:bg-blue-50/50 ${
                              selectedParcelId === p.parcel_id ? 'bg-blue-50' : ''
                            }`}
                          >
                            <td className="py-2.5 px-4 font-mono font-semibold text-blue-800">{p.parcel_id}</td>
                            <td className="py-2.5 px-4 font-mono text-slate-800">{p.survey_no}</td>
                            <td className="py-2.5 px-4 text-slate-600">
                              {p.area} · {p.land_use}
                            </td>
                            <td className="py-2.5 px-4 font-mono tabular-nums">v{p.version}</td>
                            <td className="py-2.5 px-4">
                              <StatusText status={p.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5">
                  {parcelDetail ? (
                    <div className="space-y-4 text-xs">
                      <div className="pb-3 border-b border-slate-100 flex items-start justify-between gap-2">
                        <div>
                          <p className="font-mono font-bold text-sm text-slate-900">
                            {parcelDetail.parcel.parcel_id}
                          </p>
                          <p className="text-slate-500 mt-0.5">
                            Survey {parcelDetail.parcel.survey_no} · {parcelDetail.parcel.locality}
                          </p>
                        </div>
                        <StatusText status={parcelDetail.parcel.status} />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <span className="text-slate-500">Area:</span>{' '}
                          <strong className="text-slate-900">{parcelDetail.parcel.area}</strong>
                        </div>
                        <div>
                          <span className="text-slate-500">Land Use:</span>{' '}
                          <strong className="text-slate-900">{parcelDetail.parcel.land_use}</strong>
                        </div>
                        <div>
                          <span className="text-slate-500">Geometry Ref:</span>{' '}
                          <strong className="font-mono text-slate-900">
                            {parcelDetail.parcel.geometry_ref}
                          </strong>
                        </div>
                        <div>
                          <span className="text-slate-500">Version:</span>{' '}
                          <strong className="font-mono text-slate-900">
                            v{parcelDetail.parcel.version}
                          </strong>
                        </div>
                        <div className="col-span-2">
                          <span className="text-slate-500">Registered Holder (DEMO):</span>{' '}
                          <strong className="text-slate-900">
                            {parcelDetail.parcel.owner_display_name}
                          </strong>
                        </div>
                      </div>

                      {editParcelNotice && (
                        <div className="p-2 bg-emerald-50 border border-emerald-200 rounded text-emerald-900">
                          {editParcelNotice}
                        </div>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleDownloadParcelHistoryReport}
                          className="px-2.5 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-semibold text-slate-700 inline-flex items-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Export Parcel History</span>
                        </button>
                        {canEditParcelMeta && (
                          <button
                            type="button"
                            onClick={() => setEditingParcelMeta((v) => !v)}
                            className="px-2.5 py-1.5 border border-blue-200 bg-blue-50 rounded hover:bg-blue-100 font-semibold text-blue-900"
                          >
                            {editingParcelMeta ? 'Cancel Edit' : 'Update Permitted Metadata'}
                          </button>
                        )}
                      </div>

                      {editingParcelMeta && canEditParcelMeta && (
                        <form onSubmit={handleUpdateParcelMeta} className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2">
                          <div>
                            <label className="block font-semibold text-slate-700 mb-1">Area</label>
                            <input
                              type="text"
                              required
                              value={editArea}
                              onChange={(e) => setEditArea(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div>
                            <label className="block font-semibold text-slate-700 mb-1">Geometry Reference</label>
                            <input
                              type="text"
                              required
                              value={editGeomRef}
                              onChange={(e) => setEditGeomRef(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono bg-white"
                            />
                          </div>
                          <button
                            type="submit"
                            className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white font-semibold rounded"
                          >
                            Save Metadata
                          </button>
                        </form>
                      )}

                      <div className="pt-3 border-t border-slate-100 space-y-2">
                        <h4 className="font-bold text-slate-900">
                          Related Applications ({parcelDetail.applications.length})
                        </h4>
                        {parcelDetail.applications.length === 0 ? (
                          <p className="text-slate-500">No applications on this parcel.</p>
                        ) : (
                          <div className="space-y-1">
                            {parcelDetail.applications.map((a) => (
                              <button
                                key={a.application_id}
                                type="button"
                                onClick={() => setAppModal({ mode: 'view', id: a.application_id })}
                                className="w-full text-left p-2 bg-slate-50 hover:bg-blue-50 border border-slate-200 rounded flex items-center justify-between"
                              >
                                <span className="font-mono font-semibold text-blue-800">{a.application_id}</span>
                                <StatusText status={a.status} />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="pt-3 border-t border-slate-100 space-y-2">
                        <h4 className="font-bold text-slate-900">
                          Parcel Ledger History ({parcelDetail.ledgerEvents.length})
                        </h4>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                          {parcelDetail.ledgerEvents.map((e) => (
                            <div key={e.event_id} className="p-2 bg-slate-50 border border-slate-200 rounded">
                              <div className="flex justify-between font-mono text-[11px]">
                                <span className="font-semibold text-slate-900">
                                  #{e.block_number} · {e.event_type} (v{e.parcel_version})
                                </span>
                                <span className="text-slate-500">{e.status}</span>
                              </div>
                              <p className="font-mono text-[11px] text-blue-800 truncate">{e.tx_id}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-slate-500 py-12">
                      Select a parcel from the table or map to view full metadata and ledger history.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* APPLICATIONS TAB */}
          {activeTab === 'applications' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-bold text-slate-900">
                  Land Record Applications ({filteredApps.length})
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={appStatusFilter}
                    onChange={(e) => setAppStatusFilter(e.target.value)}
                    className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">All Statuses</option>
                    <option value="SUBMITTED">SUBMITTED</option>
                    <option value="SURVEY_IN_PROGRESS">SURVEY_IN_PROGRESS</option>
                    <option value="AWAITING_APPROVAL">AWAITING_APPROVAL</option>
                    <option value="RETURNED_FOR_CORRECTION">RETURNED_FOR_CORRECTION</option>
                    <option value="APPROVED">APPROVED</option>
                    <option value="REJECTED">REJECTED</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setAppModal({ mode: 'create' })}
                    className="px-3.5 py-1.5 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg"
                  >
                    Submit Application
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                      <th className="py-3 px-4">Application ID</th>
                      <th className="py-3 px-4">Parcel / Survey</th>
                      <th className="py-3 px-4">Applicant</th>
                      <th className="py-3 px-4">Type</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Approval Ref</th>
                      <th className="py-3 px-4 text-right">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredApps.map((app) => (
                      <tr key={app.application_id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-mono font-semibold text-blue-800">{app.application_id}</td>
                        <td className="py-3 px-4 font-mono text-slate-800">
                          {app.parcel_id} ({app.survey_no})
                        </td>
                        <td className="py-3 px-4 text-slate-700">{app.applicant_name}</td>
                        <td className="py-3 px-4 text-slate-700">{app.type.replace(/_/g, ' ')}</td>
                        <td className="py-3 px-4">
                          <StatusText status={app.status} />
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-600">{app.approval_reference || '—'}</td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => setAppModal({ mode: 'view', id: app.application_id })}
                            className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100 font-semibold text-slate-800"
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SHA-256 VERIFICATION TAB */}
          {activeTab === 'verify' && (
            <div className="space-y-6">
              <DocumentVerifier documents={documents} />

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200">
                  <h3 className="text-sm font-bold text-slate-900">
                    Registered Private Documents ({documents.length})
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                        <th className="py-2.5 px-4">Document ID</th>
                        <th className="py-2.5 px-4">Filename</th>
                        <th className="py-2.5 px-4">Application / Parcel</th>
                        <th className="py-2.5 px-4">Ver</th>
                        <th className="py-2.5 px-4">SHA-256 Digest</th>
                        <th className="py-2.5 px-4 text-right">Download</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {documents.map((doc) => (
                        <tr key={doc.document_id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-mono font-semibold text-blue-800">
                            {doc.document_id}
                          </td>
                          <td className="py-2.5 px-4 text-slate-900 font-medium">{doc.original_filename}</td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">
                            {doc.application_id} · {doc.parcel_id}
                          </td>
                          <td className="py-2.5 px-4 font-mono tabular-nums">v{doc.version}</td>
                          <td className="py-2.5 px-4 font-mono text-slate-500 max-w-xs truncate" title={doc.sha256_hash}>
                            {doc.sha256_hash}
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                downloadProtectedFile(
                                  `/api/documents/${doc.document_id}/download`,
                                  doc.original_filename
                                )
                              }
                              className="text-blue-700 hover:underline font-semibold"
                            >
                              Download
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* LEDGER TAB */}
          {activeTab === 'ledger' && (
            <LedgerExplorer
              events={ledgerEvents}
              fabricAvailable={fabricAvailable}
              onRefresh={loadWorkspaceData}
            />
          )}

          {/* ADMIN & AUDIT TAB */}
          {activeTab === 'admin' && canManageAdmin && (
            <AdminConsole
              currentUser={user}
              fabricAvailable={fabricAvailable}
              onRefreshGlobal={loadWorkspaceData}
            />
          )}
        </main>
      </div>

      {/* Application Create / Detail Modal */}
      {appModal && (
        <ApplicationModal
          mode={appModal.mode}
          applicationId={appModal.id}
          parcels={parcels}
          currentUser={user}
          onClose={() => setAppModal(null)}
          onUpdated={loadWorkspaceData}
        />
      )}

      {/* New Parcel Modal */}
      {showNewParcelModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Register Synthetic DEMO Parcel</h3>
              <button
                type="button"
                onClick={() => setShowNewParcelModal(false)}
                className="p-1 text-slate-500 hover:bg-slate-100 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {parcelFormError && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                {parcelFormError}
              </div>
            )}
            <form onSubmit={handleCreateParcel} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Parcel ID</label>
                  <input
                    required
                    value={newParcelId}
                    onChange={(e) => setNewParcelId(e.target.value)}
                    placeholder="TN-CHN-PR-000510"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Survey Number</label>
                  <input
                    required
                    value={newSurveyNo}
                    onChange={(e) => setNewSurveyNo(e.target.value)}
                    placeholder="88/2B"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Locality Code</label>
                  <input
                    required
                    value={newLocality}
                    onChange={(e) => setNewLocality(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Area</label>
                  <input
                    required
                    value={newArea}
                    onChange={(e) => setNewArea(e.target.value)}
                    placeholder="1600 sq.ft."
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Land Use</label>
                  <select
                    value={newLandUse}
                    onChange={(e) => setNewLandUse(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Residential">Residential</option>
                    <option value="Mixed Commercial">Mixed Commercial</option>
                    <option value="Agricultural">Agricultural</option>
                    <option value="Institutional">Institutional</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Holder Name (DEMO)</label>
                  <input
                    required
                    value={newOwnerName}
                    onChange={(e) => setNewOwnerName(e.target.value)}
                    placeholder="Holder Name (DEMO)"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowNewParcelModal(false)}
                  className="px-3.5 py-2 border border-slate-300 rounded-lg font-semibold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded-lg font-semibold"
                >
                  Register Parcel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Change Password Modal */}
      {showPwdModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Change Account Password</h3>
              <button
                type="button"
                onClick={() => setShowPwdModal(false)}
                className="p-1 text-slate-500 hover:bg-slate-100 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {pwdErr && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded text-xs text-red-800">{pwdErr}</div>
            )}
            {pwdMsg && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-900">
                {pwdMsg}
              </div>
            )}
            <form onSubmit={handleChangePassword} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Current Password</label>
                <input
                  type="password"
                  required
                  value={curPwd}
                  onChange={(e) => setCurPwd(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">New Password (min 8 chars)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={nextPwd}
                  onChange={(e) => setNextPwd(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowPwdModal(false)}
                  className="px-3.5 py-2 border border-slate-300 rounded-lg font-semibold text-slate-700"
                >
                  Close
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded-lg font-semibold"
                >
                  Update Password
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
