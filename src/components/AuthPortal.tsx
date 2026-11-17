import { useState, type FormEvent } from 'react';
import { KeyRound, Lock, ShieldCheck, UserPlus } from 'lucide-react';
import { apiRequest, setStoredToken } from '../api';
import type { User } from '../types';

interface AuthPortalProps {
  onAuthenticated: (user: User) => void;
}

const DEMO_ACCOUNTS = [
  { label: 'Citizen (Arun)', email: 'citizen@demo.landgov', role: 'CITIZEN' },
  { label: 'Citizen 2 (Meera)', email: 'citizen2@demo.landgov', role: 'CITIZEN' },
  { label: 'Clerk (Priya)', email: 'clerk@demo.landgov', role: 'CLERK' },
  { label: 'Surveyor (Vikram)', email: 'surveyor@demo.landgov', role: 'SURVEYOR' },
  { label: 'Approving Officer', email: 'officer@demo.landgov', role: 'APPROVING_OFFICER' },
  { label: 'Administrator', email: 'admin@demo.landgov', role: 'ADMIN' },
  { label: 'Auditor', email: 'auditor@demo.landgov', role: 'AUDITOR' }
];

export function AuthPortal({ onAuthenticated }: AuthPortalProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [email, setEmail] = useState('citizen@demo.landgov');
  const [password, setPassword] = useState('DemoPass@2026');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');

  // MFA challenge state
  const [mfaPending, setMfaPending] = useState<{ userId: string; demoCode: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  // Reset state
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [issuedResetHint, setIssuedResetHint] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        user?: User;
        token?: string;
        mfaRequired?: boolean;
        userId?: string;
        demoMfaCode?: string;
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (res.mfaRequired && res.userId) {
        setMfaPending({ userId: res.userId, demoCode: res.demoMfaCode || '' });
        setInfo('Multi-factor verification required. Enter the 6-digit verification code.');
      } else if (res.user && res.token) {
        setStoredToken(res.token);
        onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaVerify(e: FormEvent) {
    e.preventDefault();
    if (!mfaPending) return;
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ user: User; token: string }>('/api/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({ userId: mfaPending.userId, code: mfaCode })
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid MFA code.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ user: User; token: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, contact, password })
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRequestReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string; demoResetToken?: string }>(
        '/api/auth/password-reset/request',
        {
          method: 'POST',
          body: JSON.stringify({ email })
        }
      );
      setInfo(res.message);
      if (res.demoResetToken) {
        setIssuedResetHint(res.demoResetToken);
        setResetToken(res.demoResetToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request reset.');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token: resetToken, newPassword })
      });
      setInfo(res.message);
      setIssuedResetHint(null);
      setMode('login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset confirmation failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 shrink-0">
            <img
              src="/src/assets/images/registry_crest_1794889840582.jpg"
              alt="CivicLedger Registry Seal"
              referrerPolicy="no-referrer"
              className="w-9 h-9 rounded border border-slate-200 object-cover bg-slate-100"
            />
            <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
              CivicLedger Land Registry
            </span>
          </div>
          <div className="hidden md:flex items-center gap-4 text-xs text-slate-500">
            <span>Academic Prototype</span>
            <span aria-hidden="true">·</span>
            <span>Simulated Hyperledger Fabric Network</span>
            <span aria-hidden="true">·</span>
            <span>SHA-256 Document Verification</span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8 lg:py-12 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left Informational Panel */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between">
          <div>
            <div className="relative h-56 sm:h-64 bg-slate-900 overflow-hidden">
              <img
                src="/src/assets/images/cadastral_survey_banner_1794889841863.jpg"
                alt="Synthetic cadastral parcel grid illustration"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-900/35 to-transparent flex items-end p-6">
                <div>
                  <p className="text-xs font-medium text-blue-200 mb-1">
                    Department of Revenue & Cadastral Records (DEMO Environment)
                  </p>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white leading-tight">
                    Permissioned Blockchain Land Record Management System
                  </h1>
                </div>
              </div>
            </div>

            <div className="p-6 sm:p-8 space-y-6">
              <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
                A unified role-based portal connecting citizens, clerks, surveyors, approving officers,
                administrators, and independent auditors. Operational records are persisted in a relational
                database, supporting files are verified byte-for-byte with SHA-256, and approved mutations
                are anchored to a local simulated Hyperledger Fabric consortium ledger.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
                <div>
                  <p className="text-xs font-semibold text-slate-900">6-Stage Workflow</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Citizen submission through Clerk, Surveyor, Officer approval, and ledger commit.
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-900">SHA-256 Integrity</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Private server storage with byte-exact hash registration and tamper verification.
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-900">GIS Parcel Mapping</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Interactive Leaflet boundary display using synthetic demonstration geometry.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-slate-50 border-t border-slate-200 px-6 py-4 text-xs text-slate-600">
            <strong>Academic Demonstration Notice:</strong> All parcels, identities, and blockchain
            transactions in this portal use synthetic demonstration data. Document hash matches confirm
            byte integrity only and do not represent legal ownership adjudication.
          </div>
        </section>

        {/* Right Authentication Form */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setMfaPending(null);
                  setError(null);
                  setInfo(null);
                }}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  mode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setMfaPending(null);
                  setError(null);
                  setInfo(null);
                }}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  mode === 'register' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Citizen Register
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('reset');
                  setMfaPending(null);
                  setError(null);
                  setInfo(null);
                }}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  mode === 'reset' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Reset Password
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                {error}
              </div>
            )}
            {info && (
              <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-900">
                {info}
              </div>
            )}

            {mode === 'login' && !mfaPending && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5" htmlFor="login-email">
                    Official or Citizen Email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="name@demo.landgov"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5" htmlFor="login-password">
                    Password
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="Enter your password"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Lock className="w-4 h-4" />
                  <span>{loading ? 'Authenticating...' : 'Sign In to Portal'}</span>
                </button>
              </form>
            )}

            {mode === 'login' && mfaPending && (
              <form onSubmit={handleMfaVerify} className="space-y-4">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700">
                  <p className="font-semibold text-slate-900 mb-1">MFA Challenge Active</p>
                  <p>
                    Demo verification code:{' '}
                    <span className="font-mono font-semibold text-blue-700">{mfaPending.demoCode}</span>
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5" htmlFor="mfa-code">
                    6-Digit Verification Code
                  </label>
                  <input
                    id="mfa-code"
                    type="text"
                    required
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="000000"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>{loading ? 'Verifying...' : 'Verify MFA & Sign In'}</span>
                </button>
              </form>
            )}

            {mode === 'register' && (
              <form onSubmit={handleRegister} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="e.g. Karthik Sundaram"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Email Address</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="citizen.name@example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Contact Number</label>
                  <input
                    type="text"
                    required
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="+91-98000-00000"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Password (minimum 8 characters)
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    placeholder="Create a strong password"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>{loading ? 'Registering...' : 'Create Citizen Account'}</span>
                </button>
              </form>
            )}

            {mode === 'reset' && (
              <div className="space-y-4">
                <form onSubmit={handleRequestReset} className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Account Email</label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2 px-4 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg"
                  >
                    Generate Reset Token
                  </button>
                </form>

                {issuedResetHint && (
                  <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs text-slate-700">
                    Demo Reset Token: <span className="font-mono font-semibold">{issuedResetHint}</span>
                  </div>
                )}

                <form onSubmit={handleConfirmReset} className="space-y-3 pt-3 border-t border-slate-200">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Reset Token</label>
                    <input
                      type="text"
                      required
                      value={resetToken}
                      onChange={(e) => setResetToken(e.target.value)}
                      className="w-full px-3.5 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                      placeholder="RST-XXXXXXXX"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">New Password</label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-2 px-4 bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Confirm Password Reset</span>
                  </button>
                </form>
              </div>
            )}
          </div>

          {/* Quick Role Selector for Academic Evaluation */}
          <div className="mt-6 pt-5 border-t border-slate-200">
            <p className="text-xs font-semibold text-slate-700 mb-2">
              Quick-Fill Synthetic Demo Roles (Password: <span className="font-mono">DemoPass@2026</span>)
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setMfaPending(null);
                    setEmail(acc.email);
                    setPassword('DemoPass@2026');
                    setError(null);
                  }}
                  className={`text-left px-2.5 py-1.5 rounded border text-xs transition-colors truncate ${
                    email === acc.email && mode === 'login'
                      ? 'border-blue-600 bg-blue-50 text-blue-900 font-semibold'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  {acc.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
