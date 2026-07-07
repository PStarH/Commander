import { useEffect, useState } from 'react';
import {
  Settings,
  AlertTriangle,
  Plus,
  Trash2,
  Key,
  Webhook,
  Save,
  Check,
  X,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Send,
  CheckSquare,
  Square,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import {
  fetchSettings,
  updateSettings,
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
  fetchOutgoingWebhooks,
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  fetchWebhookDeliveries,
  type AppSettings,
  type ApiKeyRecord,
  type OutgoingWebhookConfig,
  type WebhookDelivery,
} from '../api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'webhooks', label: 'Outgoing Webhooks' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const MODEL_OPTIONS = [
  'gpt-4o',
  'gpt-4o-mini',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'deepseek-chat',
  'gemini-1.5-pro',
  'ollama/llama3.1',
];

const EVENT_OPTIONS = [
  'agent.started',
  'agent.completed',
  'agent.failed',
  'mission.created',
  'mission.completed',
  'cost.alert',
  '*',
];

export function SettingsPage() {
  const auth = useAuth();
  const isAdmin = auth.currentUser?.role === 'admin';
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) {
    return (
      <div className="users-page">
        <div className="page-header">
          <div className="page-header-title">
            <Settings size={20} />
            <h1>Settings</h1>
          </div>
        </div>
        <Card>
          <div className="empty">
            <AlertTriangle size={24} style={{ marginBottom: 8 }} />
            <p>Admin privileges are required to manage settings.</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="users-page">
      <div className="page-header">
        <div className="page-header-title">
          <Settings size={20} />
          <h1>Settings</h1>
        </div>
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

      <div className="time-window-selector" style={{ marginBottom: 20 }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`time-window-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'general' && <GeneralSettingsTab onError={setError} />}
      {activeTab === 'api-keys' && <ApiKeysTab onError={setError} />}
      {activeTab === 'webhooks' && <WebhooksTab onError={setError} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// General settings
// ─────────────────────────────────────────────────────────────────────────────

function GeneralSettingsTab({ onError }: { onError: (msg: string | null) => void }) {
  const [settings, setSettings] = useState<AppSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSettings()
      .then((data) => {
        if (!cancelled) setSettings(data.settings);
      })
      .catch((err) => onError(err instanceof Error ? err.message : 'Failed to load settings'))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function handleSave() {
    setSaving(true);
    onError(null);
    try {
      const data = await updateSettings(settings);
      setSettings(data.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function updateField<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  function updateNotification<K extends keyof NonNullable<AppSettings['notifications']>>(
    key: K,
    value: NonNullable<AppSettings['notifications']>[K],
  ) {
    setSettings((s) => ({
      ...s,
      notifications: { ...s.notifications, [key]: value },
    }));
  }

  if (loading) {
    return (
      <Card>
        <div className="empty">Loading settings...</div>
      </Card>
    );
  }

  return (
    <div className="approval-config-panel">
      <Card>
        <div className="approval-section">
          <div className="approval-subhead">
            <Send size={16} />
            <h3>Default Model</h3>
          </div>
          <p className="approval-hint">Default LLM used for new runs when no model is specified.</p>
          <div className="form-row">
            <label htmlFor="model">Model</label>
            <Input
              id="model"
              list="model-options"
              value={settings.model ?? ''}
              onChange={(e) => updateField('model', e.target.value || undefined)}
              placeholder="e.g. gpt-4o"
            />
            <datalist id="model-options">
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        </div>
      </Card>

      <Card>
        <div className="approval-section">
          <div className="approval-subhead">
            <CheckSquare size={16} />
            <h3>Feature Flags</h3>
          </div>
          <p className="approval-hint">Toggle runtime capabilities for all agents.</p>
          <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="enableMetaTools"
              type="checkbox"
              className="chk"
              checked={!!settings.enableMetaTools}
              onChange={(e) => updateField('enableMetaTools', e.target.checked)}
            />
            <label htmlFor="enableMetaTools" style={{ margin: 0 }}>
              Enable meta-tools (self-reflection, planning)
            </label>
          </div>
          <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="toolRetrieval"
              type="checkbox"
              className="chk"
              checked={!!settings.toolRetrieval}
              onChange={(e) => updateField('toolRetrieval', e.target.checked)}
            />
            <label htmlFor="toolRetrieval" style={{ margin: 0 }}>
              Enable dynamic tool retrieval
            </label>
          </div>
          <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="entropyGating"
              type="checkbox"
              className="chk"
              checked={!!settings.entropyGating}
              onChange={(e) => updateField('entropyGating', e.target.checked)}
            />
            <label htmlFor="entropyGating" style={{ margin: 0 }}>
              Enable entropy gating
            </label>
          </div>
          <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="speculativeExecution"
              type="checkbox"
              className="chk"
              checked={!!settings.speculativeExecution}
              onChange={(e) => updateField('speculativeExecution', e.target.checked)}
            />
            <label htmlFor="speculativeExecution" style={{ margin: 0 }}>
              Enable speculative execution
            </label>
          </div>
        </div>
      </Card>

      <Card>
        <div className="approval-section">
          <div className="approval-subhead">
            <Webhook size={16} />
            <h3>Notifications</h3>
          </div>
          <p className="approval-hint">Configure alert delivery channels.</p>
          <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="alertsEnabled"
              type="checkbox"
              className="chk"
              checked={!!settings.notifications?.alertsEnabled}
              onChange={(e) => updateNotification('alertsEnabled', e.target.checked)}
            />
            <label htmlFor="alertsEnabled" style={{ margin: 0 }}>
              Enable alerts
            </label>
          </div>
          <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              id="emailEnabled"
              type="checkbox"
              className="chk"
              checked={!!settings.notifications?.emailEnabled}
              onChange={(e) => updateNotification('emailEnabled', e.target.checked)}
            />
            <label htmlFor="emailEnabled" style={{ margin: 0 }}>
              Enable email notifications
            </label>
          </div>
          <div className="form-row">
            <label htmlFor="email">Notification email</label>
            <Input
              id="email"
              type="email"
              value={settings.notifications?.email ?? ''}
              onChange={(e) => updateNotification('email', e.target.value)}
              placeholder="ops@company.com"
            />
          </div>
          <div className="form-row">
            <label htmlFor="slackWebhook">Slack webhook URL</label>
            <Input
              id="slackWebhook"
              type="url"
              value={settings.notifications?.slackWebhook ?? ''}
              onChange={(e) => updateNotification('slackWebhook', e.target.value)}
              placeholder="https://hooks.slack.com/services/..."
            />
          </div>
          <div className="form-row">
            <label htmlFor="webhookUrl">Generic notification webhook URL</label>
            <Input
              id="webhookUrl"
              type="url"
              value={settings.notifications?.webhookUrl ?? ''}
              onChange={(e) => updateNotification('webhookUrl', e.target.value)}
              placeholder="https://example.com/webhooks/notifications"
            />
          </div>
        </div>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={handleSave} disabled={saving}>
          {saved ? <Check size={16} /> : <Save size={16} />}
          {saved ? 'Saved' : 'Save Settings'}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// API Keys
// ─────────────────────────────────────────────────────────────────────────────

function ApiKeysTab({ onError }: { onError: (msg: string | null) => void }) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'write']);
  const [revealed, setRevealed] = useState(false);

  async function loadKeys() {
    setLoading(true);
    onError(null);
    try {
      const data = await fetchApiKeys();
      setKeys(data.keys);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadKeys();
  }, []);

  function toggleScope(scope: string) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    onError(null);
    try {
      const data = await createApiKey(name, scopes);
      setNewKey(data.key);
      await loadKeys();
      setName('');
      setScopes(['read', 'write']);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(id: string) {
    onError(null);
    try {
      await revokeApiKey(id);
      await loadKeys();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to revoke API key');
    }
  }

  function closeCreate() {
    setIsCreateOpen(false);
    setNewKey(null);
    setRevealed(false);
  }

  return (
    <>
      <div className="page-header" style={{ marginTop: -10 }}>
        <div />
        <Button onClick={() => setIsCreateOpen(true)}>
          <Plus size={16} />
          Create API Key
        </Button>
      </div>

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Created</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && keys.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    Loading API keys...
                  </td>
                </tr>
              ) : keys.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    No API keys found.
                  </td>
                </tr>
              ) : (
                keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td className="font-mono">{k.prefix}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {k.scopes.map((s) => (
                          <Badge key={s} variant="default">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td>
                      <Badge variant={k.enabled ? 'success' : 'error'}>
                        {k.enabled ? 'Active' : 'Revoked'}
                      </Badge>
                    </td>
                    <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Revoke"
                        disabled={!k.enabled}
                        onClick={() => handleRevoke(k.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {isCreateOpen && (
        <div className="modal-overlay" onClick={closeCreate}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Create API Key</h2>
              <button type="button" className="icon-btn" onClick={closeCreate}>
                <X size={16} />
              </button>
            </div>
            {newKey ? (
              <>
                <div className="modal-body">
                  <div className="banner success" style={{ marginBottom: 16 }}>
                    <Key size={16} />
                    <span>Copy this key now — it will not be shown again.</span>
                  </div>
                  <div className="form-row">
                    <label>API Key</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Input
                        type={revealed ? 'text' : 'password'}
                        value={newKey}
                        readOnly
                        style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title={revealed ? 'Hide' : 'Reveal'}
                        onClick={() => setRevealed((v) => !v)}
                      >
                        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Copy to clipboard"
                        onClick={() => navigator.clipboard.writeText(newKey)}
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <Button onClick={closeCreate}>
                    <Check size={16} />
                    Done
                  </Button>
                </div>
              </>
            ) : (
              <form onSubmit={handleCreate}>
                <div className="modal-body">
                  <div className="form-row">
                    <label htmlFor="key-name">Name</label>
                    <Input
                      id="key-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. CI/CD integration"
                      required
                    />
                  </div>
                  <div className="form-row">
                    <label>Scopes</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {['read', 'write', 'admin'].map((scope) => (
                        <label
                          key={scope}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: '0.85rem',
                            textTransform: 'none',
                            letterSpacing: 'normal',
                            fontWeight: 400,
                            cursor: 'pointer',
                          }}
                        >
                          {scopes.includes(scope) ? (
                            <CheckSquare size={16} color="var(--accent-green)" />
                          ) : (
                            <Square size={16} color="var(--text-muted)" />
                          )}
                          <input
                            type="checkbox"
                            className="chk"
                            checked={scopes.includes(scope)}
                            onChange={() => toggleScope(scope)}
                            style={{ display: 'none' }}
                          />
                          {scope}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <Button type="button" variant="ghost" onClick={closeCreate}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={submitting || !name.trim()}>
                    <Key size={16} />
                    Create Key
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Outgoing Webhooks
// ─────────────────────────────────────────────────────────────────────────────

function WebhooksTab({ onError }: { onError: (msg: string | null) => void }) {
  const [webhooks, setWebhooks] = useState<OutgoingWebhookConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedWebhook, setSelectedWebhook] = useState<OutgoingWebhookConfig | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [deliveryFilter, setDeliveryFilter] = useState<'all' | 'success' | 'failed' | 'retrying'>(
    'all',
  );

  const filteredDeliveries =
    deliveryFilter === 'all' ? deliveries : deliveries.filter((d) => d.status === deliveryFilter);

  const [form, setForm] = useState({
    name: '',
    url: '',
    events: [] as string[],
    secret: '',
    retryMax: 3,
    enabled: true,
  });

  async function loadWebhooks() {
    setLoading(true);
    onError(null);
    try {
      const data = await fetchOutgoingWebhooks();
      setWebhooks(data.webhooks);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWebhooks();
  }, []);

  async function loadDeliveries(webhook: OutgoingWebhookConfig) {
    setSelectedWebhook(webhook);
    setDeliveryFilter('all');
    setLoadingDeliveries(true);
    try {
      const data = await fetchWebhookDeliveries(webhook.id);
      setDeliveries(data.deliveries);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load deliveries');
    } finally {
      setLoadingDeliveries(false);
    }
  }

  function toggleEvent(event: string) {
    setForm((f) => ({
      ...f,
      events: f.events.includes(event) ? f.events.filter((e) => e !== event) : [...f.events, event],
    }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (form.events.length === 0) {
      onError('Select at least one event');
      return;
    }
    setSubmitting(true);
    onError(null);
    try {
      await createOutgoingWebhook({
        name: form.name,
        url: form.url,
        events: form.events,
        secret: form.secret || undefined,
        retryMax: form.retryMax,
        enabled: form.enabled,
      });
      setIsCreateOpen(false);
      setForm({ name: '', url: '', events: [], secret: '', retryMax: 3, enabled: true });
      await loadWebhooks();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create webhook');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    onError(null);
    try {
      await deleteOutgoingWebhook(id);
      if (selectedWebhook?.id === id) {
        setSelectedWebhook(null);
        setDeliveries([]);
      }
      await loadWebhooks();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete webhook');
    }
  }

  return (
    <>
      <div className="page-header" style={{ marginTop: -10 }}>
        <div />
        <Button onClick={() => setIsCreateOpen(true)}>
          <Plus size={16} />
          Add Webhook
        </Button>
      </div>

      <div className="approval-add-grid" style={{ gridTemplateColumns: '1.2fr 1fr' }}>
        <Card>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Events</th>
                  <th>Status</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && webhooks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      Loading webhooks...
                    </td>
                  </tr>
                ) : webhooks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      No outgoing webhooks configured.
                    </td>
                  </tr>
                ) : (
                  webhooks.map((wh) => (
                    <tr
                      key={wh.id}
                      style={{
                        cursor: 'pointer',
                        background:
                          selectedWebhook?.id === wh.id ? 'rgba(77, 233, 140, 0.05)' : undefined,
                      }}
                      onClick={() => loadDeliveries(wh)}
                    >
                      <td>{wh.name || wh.id}</td>
                      <td className="font-mono" style={{ maxWidth: 240 }}>
                        <span
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}
                        >
                          {wh.url}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {wh.events.slice(0, 3).map((e) => (
                            <Badge key={e} variant="default">
                              {e}
                            </Badge>
                          ))}
                          {wh.events.length > 3 && (
                            <Badge variant="default">+{wh.events.length - 3}</Badge>
                          )}
                        </div>
                      </td>
                      <td>
                        <Badge variant={wh.enabled ? 'success' : 'error'}>
                          {wh.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="View deliveries"
                          onClick={(e) => {
                            e.stopPropagation();
                            loadDeliveries(wh);
                          }}
                        >
                          <RefreshCw size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(wh.id);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="approval-section">
            <div className="approval-subhead">
              <Send size={16} />
              <h3>Delivery Log</h3>
              {selectedWebhook && (
                <Select
                  aria-label="Filter deliveries by status"
                  value={deliveryFilter}
                  onChange={(e) => setDeliveryFilter(e.target.value as typeof deliveryFilter)}
                  style={{ marginLeft: 'auto' }}
                >
                  <option value="all">All statuses</option>
                  <option value="success">Success</option>
                  <option value="failed">Failed</option>
                  <option value="retrying">Retrying</option>
                </Select>
              )}
            </div>
            {selectedWebhook ? (
              <>
                <p className="approval-hint" style={{ marginBottom: 12 }}>
                  {selectedWebhook.name || selectedWebhook.id}
                </p>
                {loadingDeliveries ? (
                  <div className="empty">Loading deliveries...</div>
                ) : filteredDeliveries.length === 0 ? (
                  <div className="empty">
                    {deliveries.length === 0
                      ? 'No deliveries recorded yet.'
                      : 'No deliveries match the selected filter.'}
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      maxHeight: 480,
                      overflowY: 'auto',
                    }}
                  >
                    {filteredDeliveries.map((d, i) => (
                      <div
                        key={`${d.webhookId}-${d.deliveredAt}-${i}`}
                        style={{
                          padding: 10,
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 0,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            marginBottom: 4,
                          }}
                        >
                          <Badge
                            variant={
                              d.status === 'success'
                                ? 'success'
                                : d.status === 'retrying'
                                  ? 'warning'
                                  : 'error'
                            }
                          >
                            {d.status}
                          </Badge>
                          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            {d.attempts} attempt{d.attempts > 1 ? 's' : ''}
                          </span>
                        </div>
                        <div
                          className="font-mono"
                          style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}
                        >
                          {d.event}
                        </div>
                        {d.statusCode !== undefined && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
                            HTTP {d.statusCode}
                          </div>
                        )}
                        {d.error && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--accent-red)' }}>
                            {d.error}
                          </div>
                        )}
                        <div
                          style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 4 }}
                        >
                          {new Date(d.deliveredAt).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="empty">Select a webhook to view deliveries.</div>
            )}
          </div>
        </Card>
      </div>

      {isCreateOpen && (
        <div className="modal-overlay" onClick={() => setIsCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Add Outgoing Webhook</h2>
              <button type="button" className="icon-btn" onClick={() => setIsCreateOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="form-row">
                  <label htmlFor="wh-name">Name</label>
                  <Input
                    id="wh-name"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Slack alerts"
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="wh-url">URL</label>
                  <Input
                    id="wh-url"
                    type="url"
                    value={form.url}
                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                    placeholder="https://example.com/webhook"
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Events</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {EVENT_OPTIONS.map((event) => (
                      <button
                        key={event}
                        type="button"
                        className={`tag-chip ${form.events.includes(event) ? 'active' : ''}`}
                        onClick={() => toggleEvent(event)}
                      >
                        {form.events.includes(event) ? (
                          <CheckSquare size={12} />
                        ) : (
                          <Square size={12} />
                        )}
                        {event}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="wh-secret">Secret (optional)</label>
                  <Input
                    id="wh-secret"
                    type="password"
                    value={form.secret}
                    onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                    placeholder="HMAC secret for signing payloads"
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="wh-retry">Max retries</label>
                  <Select
                    id="wh-retry"
                    value={form.retryMax}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, retryMax: parseInt(e.target.value, 10) }))
                    }
                  >
                    {[0, 1, 2, 3, 5, 10].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </div>
                <div
                  className="form-row"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
                >
                  <input
                    id="wh-enabled"
                    type="checkbox"
                    className="chk"
                    checked={form.enabled}
                    onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                  />
                  <label htmlFor="wh-enabled" style={{ margin: 0 }}>
                    Enabled
                  </label>
                </div>
              </div>
              <div className="modal-footer">
                <Button type="button" variant="ghost" onClick={() => setIsCreateOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting || !form.url.trim()}>
                  <Webhook size={16} />
                  Add Webhook
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
