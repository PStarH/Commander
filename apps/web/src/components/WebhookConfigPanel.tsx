/**
 * WebhookConfigPanel — IM webhook integration configuration panel.
 *
 * Closes the IM integration gap: Chinese enterprises use DingTalk, Feishu,
 * and WeCom as their primary communication tools. This panel lets admins
 * configure webhook endpoints so that an Agent can be embedded directly
 * into IM workflows — users @mention the bot, the IM platform forwards
 * the message to Commander, and the Agent's reply is returned.
 *
 * Features:
 *   A. Webhook list — shows platform, name, callback URL, target agent, status
 *   B. Add webhook form — select platform, enter name, choose target agent
 *   C. Delete webhook — remove a configuration
 */
import { useState, useEffect, useCallback } from 'react';
import { Webhook, Plus, Trash2, AlertTriangle, Check, X, Copy, MessageCircle } from 'lucide-react';
import { Card, Badge, Button, Select, Input } from './ui';
import { fetchWebhooks, createWebhook, deleteWebhook, API_BASE } from '../api';
import type { IMWebhookConfig, WebhookPlatform, CreateWebhookPayload } from '../api';
import { formatTimestamp } from '../types';

// ── Platform metadata ─────────────────────────────────────────────────────

interface PlatformMeta {
  platform: WebhookPlatform;
  label: string;
  color: string;
  badgeVariant: 'success' | 'warning' | 'error' | 'info';
}

const PLATFORMS: PlatformMeta[] = [
  { platform: 'dingtalk', label: 'DingTalk', color: '#1677ff', badgeVariant: 'info' },
  { platform: 'feishu', label: 'Feishu', color: '#3370ff', badgeVariant: 'success' },
  { platform: 'wecom', label: 'WeCom', color: '#07c160', badgeVariant: 'warning' },
];

function platformMeta(platform: WebhookPlatform): PlatformMeta {
  return PLATFORMS.find((p) => p.platform === platform) ?? PLATFORMS[0]!;
}

function buildCallbackUrl(config: IMWebhookConfig): string {
  return `${API_BASE}/api/webhook/${config.platform}/${config.id}`;
}

// ── Default agent options ─────────────────────────────────────────────────

const DEFAULT_AGENTS = [
  { value: 'agent-commander', label: 'Agent Commander' },
  { value: 'agent-scout', label: 'Agent Scout' },
  { value: 'agent-engineer', label: 'Agent Engineer' },
  { value: 'agent-analyst', label: 'Agent Analyst' },
];

interface NewWebhookDraft {
  platform: WebhookPlatform;
  name: string;
  agentId: string;
}

const EMPTY_DRAFT: NewWebhookDraft = {
  platform: 'dingtalk',
  name: '',
  agentId: 'agent-commander',
};

export function WebhookConfigPanel() {
  const [webhooks, setWebhooks] = useState<IMWebhookConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [draft, setDraft] = useState<NewWebhookDraft>({ ...EMPTY_DRAFT });
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await fetchWebhooks();
      setWebhooks(data.webhooks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhook configurations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleAdd() {
    if (!draft.name.trim()) {
      setActionError('Name is required');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const payload: CreateWebhookPayload = {
        platform: draft.platform,
        name: draft.name.trim(),
        agentId: draft.agentId,
      };
      await createWebhook(payload);
      setShowAddForm(false);
      setDraft({ ...EMPTY_DRAFT });
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create webhook');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await deleteWebhook(id);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete webhook');
    } finally {
      setBusy(false);
    }
  }

  function handleCopyUrl(url: string, id: string) {
    try {
      navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* clipboard may not be available */
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="webhook-config-panel">
        <div className="section-head">
          <div>
            <div className="section-label">IM Integration</div>
            <h2>Loading webhook configurations...</h2>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="webhook-config-panel">
        <div className="section-head">
          <div>
            <div className="section-label">IM Integration</div>
            <h2>IM Webhook Integration</h2>
          </div>
        </div>
        <div className="narrative narrative-red">
          <AlertTriangle size={14} /> {error}
        </div>
      </div>
    );
  }

  return (
    <div className="webhook-config-panel">
      <div className="section-head">
        <div>
          <div className="section-label">IM Integration</div>
          <h2>IM Webhook Integration</h2>
        </div>
        <span className="section-tag">
          <MessageCircle size={12} style={{ display: 'inline', marginRight: 4 }} />
          DingTalk / Feishu / WeCom
        </span>
      </div>

      <div className="narrative narrative-green" style={{ marginBottom: 12 }}>
        <Webhook size={14} /> Configure webhook endpoints to embed Agents into your IM workflows.
        Users can @mention the bot in a group chat to interact with Commander.
      </div>

      {actionError && (
        <div className="narrative narrative-red" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} /> {actionError}
        </div>
      )}

      {/* ── Add webhook button / form ──────────────────────────────────── */}
      <div className="approval-subhead">
        <h3>Configured Webhooks</h3>
        <span className="approval-hint">{webhooks.length} webhook(s) configured</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowAddForm((v) => !v)}
          disabled={busy}
          style={{ marginLeft: 'auto' }}
        >
          <Plus size={12} /> {showAddForm ? 'Close' : 'Add Webhook'}
        </Button>
      </div>

      {showAddForm && (
        <Card className="approval-add-form">
          <div className="approval-add-grid">
            <label className="approval-field">
              <span>Platform</span>
              <Select
                value={draft.platform}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, platform: e.target.value as WebhookPlatform }))
                }
                disabled={busy}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.platform} value={p.platform}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="approval-field">
              <span>Name</span>
              <Input
                placeholder="e.g. Team Group Bot"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                disabled={busy}
              />
            </label>
            <label className="approval-field">
              <span>Target Agent</span>
              <Select
                value={draft.agentId}
                onChange={(e) => setDraft((d) => ({ ...d, agentId: e.target.value }))}
                disabled={busy}
              >
                {DEFAULT_AGENTS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="gov-card-acts" style={{ marginTop: 10 }}>
            <Button variant="primary" size="sm" onClick={handleAdd} disabled={busy}>
              <Check size={12} /> Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)} disabled={busy}>
              <X size={12} /> Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* ── Webhook list ───────────────────────────────────────────────── */}
      {webhooks.length === 0 ? (
        <div className="empty">
          No IM webhooks configured yet. Click "Add Webhook" to get started.
        </div>
      ) : (
        <div className="approval-table-wrap">
          <table className="approval-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Name</th>
                <th>Callback URL</th>
                <th>Target Agent</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((wh) => {
                const meta = platformMeta(wh.platform);
                const callbackUrl = buildCallbackUrl(wh);
                return (
                  <tr key={wh.id}>
                    <td>
                      <Badge variant={meta.badgeVariant}>{meta.label}</Badge>
                    </td>
                    <td>
                      <strong>{wh.name}</strong>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <code
                          style={{
                            fontSize: 11,
                            maxWidth: 280,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            display: 'inline-block',
                          }}
                          title={callbackUrl}
                        >
                          {callbackUrl}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopyUrl(callbackUrl, wh.id)}
                          title="Copy URL"
                          style={{ padding: '2px 4px' }}
                        >
                          {copiedId === wh.id ? <Check size={12} /> : <Copy size={12} />}
                        </Button>
                      </div>
                    </td>
                    <td>
                      <code>{wh.agentId}</code>
                    </td>
                    <td>
                      <Badge variant={wh.enabled ? 'success' : 'error'}>
                        {wh.enabled ? 'Active' : 'Disabled'}
                      </Badge>
                    </td>
                    <td className="approval-time">{formatTimestamp(wh.createdAt)}</td>
                    <td>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(wh.id)}
                        disabled={busy}
                        title="Delete webhook"
                      >
                        <Trash2 size={12} /> Delete
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
