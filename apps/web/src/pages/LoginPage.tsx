import { useState, useEffect, type FormEvent } from 'react';
import { LogIn, UserPlus, ChevronRight, Shield } from 'lucide-react';
import {
  setAuthTokens,
  fetchOIDCConfig,
  exchangeOIDCToken,
  discoverOIDCAuthorizationEndpoint,
  buildOIDCAuthorizationUrl,
  generateOIDCState,
} from '../api';
import { useAuth } from '../hooks/useAuth';

const OIDC_STATE_KEY = 'commander.oidc.state';

type Tab = 'login' | 'register';

function getOIDCState(): string | null {
  try {
    return sessionStorage.getItem(OIDC_STATE_KEY);
  } catch {
    return null;
  }
}

function setOIDCState(state: string): void {
  try {
    sessionStorage.setItem(OIDC_STATE_KEY, state);
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}

function clearOIDCState(): void {
  try {
    sessionStorage.removeItem(OIDC_STATE_KEY);
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}

export function LoginPage() {
  const { login, register } = useAuth();
  const [tab, setTab] = useState<Tab>('login');

  // ── Login form state ──
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // ── Register form state ──
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── OIDC SSO state ──
  const [oidcEnabled, setOidcEnabled] = useState<boolean | null>(null);
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcExchanging, setOidcExchanging] = useState(false);

  // Detect and complete an OIDC implicit-flow callback (id_token in fragment).
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.includes('id_token=')) return;

    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const idToken = params.get('id_token');
    const state = params.get('state');
    if (!idToken) return;

    // Validate the OIDC state parameter to mitigate CSRF / session-fixation.
    const expectedState = getOIDCState();
    if (expectedState && state !== expectedState) {
      setError('Invalid OIDC callback state');
      clearOIDCState();
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }

    setOidcExchanging(true);
    setError(null);
    clearOIDCState();

    exchangeOIDCToken(idToken)
      .then((response) => {
        setAuthTokens(response.token, response.refreshToken);
        // Clear the OIDC fragment so a refresh does not re-trigger exchange.
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      })
      .catch((err) => {
        setOidcExchanging(false);
        setError(err instanceof Error ? err.message : 'OIDC login failed');
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      });
  }, []);

  // Probe whether OIDC SSO is configured so we can show the SSO button.
  useEffect(() => {
    fetchOIDCConfig()
      .then((config) => setOidcEnabled(config.enabled && !!config.clientId && !!config.issuer))
      .catch(() => setOidcEnabled(false));
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(loginUsername.trim(), loginPassword);
      // App.tsx will redirect automatically when isLoggedIn becomes true.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (regPassword !== regConfirm) {
      setError('Passwords do not match');
      return;
    }
    if (regPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setSubmitting(true);
    try {
      await register(regUsername.trim(), regEmail.trim(), regPassword);
      // App.tsx will redirect automatically when isLoggedIn becomes true.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOIDCLogin() {
    setOidcLoading(true);
    setError(null);
    try {
      const config = await fetchOIDCConfig();
      if (!config.enabled || !config.issuer || !config.clientId || !config.redirectUri) {
        setError('OIDC SSO is not configured');
        return;
      }
      const authorizationEndpoint = await discoverOIDCAuthorizationEndpoint(config.issuer);
      const state = generateOIDCState();
      setOIDCState(state);
      const url = buildOIDCAuthorizationUrl(
        authorizationEndpoint,
        config.clientId,
        config.redirectUri,
        state,
      );
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start SSO login');
    } finally {
      setOidcLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'radial-gradient(ellipse at 0% 0%, rgba(0,255,153,0.06), transparent 50%), ' +
          'radial-gradient(ellipse at 100% 100%, rgba(0,204,255,0.05), transparent 50%), ' +
          'var(--bg-deep)',
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: '400px', padding: '28px 24px' }}>
        {oidcExchanging ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
              padding: '24px 0',
            }}
          >
            <div className="loader" />
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Completing SSO login...
            </p>
          </div>
        ) : (
          <>
            {/* Brand */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}
            >
              <div className="sidebar-logo">
                <ChevronRight size={20} />
              </div>
              <div>
                <div className="sidebar-title">Commander</div>
                <div className="sidebar-ver">v0 · War Room</div>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '18px' }}>
              <TabButton
                active={tab === 'login'}
                onClick={() => {
                  setTab('login');
                  setError(null);
                }}
                icon={<LogIn size={14} />}
                label="Login"
              />
              <TabButton
                active={tab === 'register'}
                onClick={() => {
                  setTab('register');
                  setError(null);
                }}
                icon={<UserPlus size={14} />}
                label="Register"
              />
            </div>

            {/* Error banner */}
            {error && (
              <div className="banner error" style={{ marginBottom: '14px' }}>
                <span>{error}</span>
                <button type="button" className="banner-close" onClick={() => setError(null)}>
                  ×
                </button>
              </div>
            )}

            {/* Login form */}
            {tab === 'login' && (
              <form
                onSubmit={handleLogin}
                style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
              >
                <FormField label="Username">
                  <input
                    className="inp"
                    type="text"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder="admin"
                    autoComplete="username"
                    required
                    style={{ width: '100%' }}
                  />
                </FormField>
                <FormField label="Password">
                  <input
                    className="inp"
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                    style={{ width: '100%' }}
                  />
                </FormField>
                <button
                  type="submit"
                  className="btn btn-primary btn-md"
                  disabled={submitting}
                  style={{ marginTop: '4px' }}
                >
                  <LogIn size={14} />
                  {submitting ? 'Signing in...' : 'Sign In'}
                </button>
              </form>
            )}

            {/* Register form */}
            {tab === 'register' && (
              <form
                onSubmit={handleRegister}
                style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
              >
                <FormField label="Username">
                  <input
                    className="inp"
                    type="text"
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="choose a username"
                    autoComplete="username"
                    required
                    style={{ width: '100%' }}
                  />
                </FormField>
                <FormField label="Email">
                  <input
                    className="inp"
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                    style={{ width: '100%' }}
                  />
                </FormField>
                <FormField label="Password">
                  <input
                    className="inp"
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="min 6 characters"
                    autoComplete="new-password"
                    required
                    style={{ width: '100%' }}
                  />
                </FormField>
                <FormField label="Confirm Password">
                  <input
                    className="inp"
                    type="password"
                    value={regConfirm}
                    onChange={(e) => setRegConfirm(e.target.value)}
                    placeholder="re-enter password"
                    autoComplete="new-password"
                    required
                    style={{ width: '100%' }}
                  />
                </FormField>
                <button
                  type="submit"
                  className="btn btn-primary btn-md"
                  disabled={submitting}
                  style={{ marginTop: '4px' }}
                >
                  <UserPlus size={14} />
                  {submitting ? 'Creating account...' : 'Create Account'}
                </button>
              </form>
            )}

            {/* OIDC SSO divider + button */}
            {oidcEnabled && (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    margin: '18px 0 14px',
                  }}
                >
                  <div style={{ flex: 1, height: '1px', background: 'var(--border-default)' }} />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>OR</span>
                  <div style={{ flex: 1, height: '1px', background: 'var(--border-default)' }} />
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-md"
                  onClick={handleOIDCLogin}
                  disabled={oidcLoading}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Shield size={14} />
                  {oidcLoading ? 'Redirecting to SSO...' : 'Sign in with SSO'}
                </button>
              </>
            )}

            {/* Hint */}
            <p
              style={{
                marginTop: '16px',
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
                textAlign: 'center',
              }}
            >
              Default admin: <code style={{ color: 'var(--text-tertiary)' }}>admin</code> /{' '}
              <code style={{ color: 'var(--text-tertiary)' }}>commander-admin</code>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`topology-tab ${props.active ? 'active' : ''}`}
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: '8px 10px',
        fontSize: '0.78rem',
      }}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function FormField(props: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span
        style={{
          fontSize: '0.7rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-tertiary)',
        }}
      >
        {props.label}
      </span>
      {props.children}
    </label>
  );
}
