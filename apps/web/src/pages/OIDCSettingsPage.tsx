import { useEffect, useState, type FormEvent } from 'react';
import { Shield, Save, AlertTriangle, RotateCcw, Check } from 'lucide-react';
import { fetchOIDCSettings, updateOIDCSettings, type OIDCSettingsPayload } from '../api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';

const DEFAULT_ROLES = {
  admin: ['admin'],
  operator: ['operator', 'developer'],
  roleClaim: 'roles',
};

const EMPTY_FORM: OIDCSettingsPayload = {
  enabled: false,
  issuer: '',
  clientId: '',
  roleClaim: DEFAULT_ROLES.roleClaim,
  adminRoles: [...DEFAULT_ROLES.admin],
  operatorRoles: [...DEFAULT_ROLES.operator],
  redirectUri: `${window.location.origin}/login`,
};

export function OIDCSettingsPage() {
  const [form, setForm] = useState<OIDCSettingsPayload>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const config = await fetchOIDCSettings();
      setForm({
        enabled: config.enabled,
        issuer: config.issuer ?? '',
        clientId: config.clientId ?? '',
        roleClaim: config.roleClaim || DEFAULT_ROLES.roleClaim,
        adminRoles: config.adminRoles?.length ? config.adminRoles : [...DEFAULT_ROLES.admin],
        operatorRoles: config.operatorRoles?.length
          ? config.operatorRoles
          : [...DEFAULT_ROLES.operator],
        redirectUri: config.redirectUri ?? `${window.location.origin}/login`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load OIDC settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  function updateField<K extends keyof OIDCSettingsPayload>(
    field: K,
    value: OIDCSettingsPayload[K],
  ) {
    setForm((f) => ({ ...f, [field]: value }));
    setSaved(false);
  }

  function updateRoleList(field: 'adminRoles' | 'operatorRoles', value: string) {
    const list = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    updateField(field, list);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateOIDCSettings(form);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save OIDC settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="oidc-settings-page">
      <div className="page-header">
        <div className="page-header-title">
          <Shield size={20} />
          <h1>SSO / OIDC Configuration</h1>
        </div>
        <Button type="button" variant="ghost" onClick={loadSettings} disabled={loading}>
          <RotateCcw size={16} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="banner error" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {saved && (
        <div className="banner success" style={{ marginBottom: 16 }}>
          <Check size={16} />
          <span>OIDC settings saved successfully.</span>
          <button type="button" className="banner-close" onClick={() => setSaved(false)}>
            ×
          </button>
        </div>
      )}

      <Card className="oidc-settings-card">
        {loading ? (
          <div className="loading-inline" style={{ padding: 24 }}>
            Loading OIDC settings...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="oidc-settings-form">
            <label className="oidc-toggle">
              <input
                type="checkbox"
                className="chk"
                checked={form.enabled}
                onChange={(e) => updateField('enabled', e.target.checked)}
              />
              <span className="oidc-toggle-body">
                <span className="oidc-toggle-title">Enable OIDC SSO</span>
                <span className="oidc-toggle-desc">
                  When enabled, users will see a "Sign in with SSO" button on the login page.
                </span>
              </span>
            </label>

            <div className="form-row">
              <label htmlFor="oidc-issuer">Issuer URL</label>
              <Input
                id="oidc-issuer"
                type="url"
                value={form.issuer}
                onChange={(e) => updateField('issuer', e.target.value)}
                placeholder="https://your-tenant.okta.com/oauth2/default"
                required
              />
              <span className="field-hint">
                The OIDC issuer identifier. Must match the <code>iss</code> claim in ID tokens.
              </span>
            </div>

            <div className="form-row">
              <label htmlFor="oidc-client-id">Client ID</label>
              <Input
                id="oidc-client-id"
                type="text"
                value={form.clientId}
                onChange={(e) => updateField('clientId', e.target.value)}
                placeholder="0abc123..."
                required
              />
              <span className="field-hint">
                The public client identifier registered with your OIDC provider.
              </span>
            </div>

            <div className="form-row">
              <label htmlFor="oidc-redirect-uri">Redirect URI</label>
              <Input
                id="oidc-redirect-uri"
                type="url"
                value={form.redirectUri}
                onChange={(e) => updateField('redirectUri', e.target.value)}
                placeholder={`${window.location.origin}/login`}
                required
              />
              <span className="field-hint">
                Must be registered as an allowed redirect URI with your OIDC provider.
              </span>
            </div>

            <div className="form-row">
              <label htmlFor="oidc-role-claim">Role Claim</label>
              <Input
                id="oidc-role-claim"
                type="text"
                value={form.roleClaim}
                onChange={(e) => updateField('roleClaim', e.target.value)}
                placeholder="roles"
                required
              />
              <span className="field-hint">
                The ID token claim containing the user&apos;s role list.
              </span>
            </div>

            <div className="oidc-role-grid">
              <div className="form-row">
                <label htmlFor="oidc-admin-roles">Admin Roles</label>
                <Input
                  id="oidc-admin-roles"
                  type="text"
                  value={form.adminRoles.join(', ')}
                  onChange={(e) => updateRoleList('adminRoles', e.target.value)}
                  placeholder="admin, commander-admin"
                  required
                />
                <span className="field-hint">Comma-separated values mapped to admin.</span>
              </div>

              <div className="form-row">
                <label htmlFor="oidc-operator-roles">Operator Roles</label>
                <Input
                  id="oidc-operator-roles"
                  type="text"
                  value={form.operatorRoles.join(', ')}
                  onChange={(e) => updateRoleList('operatorRoles', e.target.value)}
                  placeholder="operator, developer"
                  required
                />
                <span className="field-hint">Comma-separated values mapped to operator.</span>
              </div>
            </div>

            <div className="oidc-env-notice">
              <strong>Environment override</strong>
              <p>
                <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, <code>OIDC_ENABLED</code>,{' '}
                <code>OIDC_ROLE_CLAIM</code>, <code>OIDC_ADMIN_ROLES</code>, and{' '}
                <code>OIDC_OPERATOR_ROLES</code> take precedence over these settings at runtime.
              </p>
            </div>

            <div className="oidc-settings-actions">
              <Button type="submit" disabled={saving}>
                <Save size={16} />
                {saving ? 'Saving...' : 'Save OIDC Settings'}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
