/**
 * ApprovalConfigPanel — Unified approval configuration panel.
 *
 * Closes GAP-06: the framework previously exposed two overlapping approval
 * systems (ApprovalSystem sandbox modes + ToolApproval policy engine). This
 * panel presents a single coherent read/write interface over the unified
 * /api/approval/* endpoints, split into three regions:
 *
 *   A. Sandbox mode selector — suggest / auto-edit / full-auto / read-only / plan
 *   B. Tool policy table     — per-pattern level, risk, description + CRUD
 *   C. Approval audit log    — recent approval decisions
 */
import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  Shield,
  ShieldAlert,
  Settings,
  Plus,
  Trash2,
  Pencil,
  AlertTriangle,
  Check,
  X,
  Lightbulb,
  Zap,
  Eye,
  Map,
  History,
} from 'lucide-react';
import { Card, Badge, Button, Select, Input } from './ui';
import {
  fetchApprovalConfig,
  updateSandboxMode,
  updateToolPolicy,
  addToolPolicy,
  removeToolPolicy,
  fetchApprovalAuditLog,
} from '../api';
import type {
  UnifiedApprovalConfig,
  ToolPolicy,
  ApprovalSandboxMode,
  ApprovalLevel,
  RiskLevel,
  ApprovalAuditEntry,
} from '../api';
import { formatTimestamp } from '../types';

// Reusable Badge variant union (matches the variants exposed by components/ui).
type BadgeVariant = 'success' | 'warning' | 'error' | 'info';

// ── Sandbox mode metadata (descriptions mirror backend SANDBOX_MODE_DESC) ──
interface SandboxModeMeta {
  mode: ApprovalSandboxMode;
  label: string;
  description: string;
  icon: ReactNode;
  danger?: boolean;
}

const SANDBOX_MODES: SandboxModeMeta[] = [
  {
    mode: 'suggest',
    label: 'Suggest',
    description: 'Agent suggests actions; user approves each one',
    icon: <Lightbulb size={16} />,
  },
  {
    mode: 'auto-edit',
    label: 'Auto Edit',
    description: 'File edits auto-approved; shell/exec still requires approval',
    icon: <Pencil size={16} />,
  },
  {
    mode: 'full-auto',
    label: 'Full Auto',
    description: 'All actions auto-approved (dangerous — sandbox only)',
    icon: <Zap size={16} />,
    danger: true,
  },
  {
    mode: 'read-only',
    label: 'Read Only',
    description: 'Agent can only read; no writes or executions',
    icon: <Eye size={16} />,
  },
  {
    mode: 'plan',
    label: 'Plan',
    description: 'Agent can analyze and plan; no writes or executions',
    icon: <Map size={16} />,
  },
];

// ── Level metadata — color coding: auto=green, semi_auto=yellow, manual=red ──
const LEVEL_META: Record<ApprovalLevel, { label: string; variant: BadgeVariant; color: string }> = {
  auto: { label: 'auto', variant: 'success', color: 'var(--accent-green)' },
  semi_auto: { label: 'semi_auto', variant: 'warning', color: 'var(--accent-amber)' },
  manual: { label: 'manual', variant: 'error', color: 'var(--accent-red)' },
};

// ── Risk → Badge variant mapping (low → green, medium → blue, high → yellow, critical → red) ──
const RISK_VARIANT: Record<RiskLevel, BadgeVariant> = {
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

function riskVariantFor(level: string | undefined): BadgeVariant {
  switch (level) {
    case 'low':
      return 'success';
    case 'medium':
      return 'info';
    case 'high':
      return 'warning';
    case 'critical':
      return 'error';
    default:
      return 'info';
  }
}

// ── Built-in default policy patterns (mirror backend DEFAULT_POLICIES) ──
// The DELETE endpoint only removes custom policies, so deletion is gated on the
// pattern NOT being one of the framework defaults.
const BUILTIN_PATTERNS = new Set<string>([
  'shell_execute',
  'python_execute',
  'file_write',
  'file_edit',
  'file_read',
  'web_search',
  'web_fetch',
  'browser_search',
  'memory_*',
  'agent',
  'git_push',
  'git_commit',
  'git',
]);

function isCustomPolicy(pattern: string): boolean {
  return !BUILTIN_PATTERNS.has(pattern);
}

interface NewPolicyDraft {
  pattern: string;
  level: ApprovalLevel;
  riskLevel: RiskLevel;
  description: string;
}

const EMPTY_NEW_POLICY: NewPolicyDraft = {
  pattern: '',
  level: 'semi_auto',
  riskLevel: 'medium',
  description: '',
};

export function ApprovalConfigPanel() {
  const [config, setConfig] = useState<UnifiedApprovalConfig | null>(null);
  const [auditEntries, setAuditEntries] = useState<ApprovalAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sandbox mode confirmation state — switching TO full-auto requires explicit confirm.
  const [pendingMode, setPendingMode] = useState<ApprovalSandboxMode | null>(null);

  // Add-policy inline form.
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPolicy, setNewPolicy] = useState<NewPolicyDraft>({ ...EMPTY_NEW_POLICY });

  // Inline edit state (per pattern) for risk + description.
  const [editingPattern, setEditingPattern] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ riskLevel: RiskLevel; description: string }>({
    riskLevel: 'low',
    description: '',
  });

  const loadData = useCallback(async () => {
    try {
      const [cfg, audit] = await Promise.all([fetchApprovalConfig(), fetchApprovalAuditLog(50)]);
      setConfig(cfg);
      setAuditEntries(audit.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approval configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Sandbox mode handlers ──────────────────────────────────────────────
  async function applySandboxMode(mode: ApprovalSandboxMode) {
    setBusy(true);
    setActionError(null);
    try {
      await updateSandboxMode(mode);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update sandbox mode');
    } finally {
      setBusy(false);
      setPendingMode(null);
    }
  }

  function handleSandboxClick(mode: ApprovalSandboxMode) {
    if (busy) return;
    if (mode === config?.sandboxMode) return;
    // full-auto is dangerous — require an explicit inline confirmation.
    if (mode === 'full-auto') {
      setPendingMode('full-auto');
      return;
    }
    void applySandboxMode(mode);
  }

  // ── Tool policy handlers ───────────────────────────────────────────────
  async function handleLevelChange(policy: ToolPolicy, level: ApprovalLevel) {
    if (policy.level === level) return;
    setBusy(true);
    setActionError(null);
    try {
      await updateToolPolicy(policy.pattern, { level });
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update policy level');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(policy: ToolPolicy) {
    setEditingPattern(policy.pattern);
    setEditDraft({ riskLevel: policy.riskLevel, description: policy.description });
  }

  function cancelEdit() {
    setEditingPattern(null);
  }

  async function saveEdit(policy: ToolPolicy) {
    setBusy(true);
    setActionError(null);
    try {
      await updateToolPolicy(policy.pattern, {
        riskLevel: editDraft.riskLevel,
        description: editDraft.description,
      });
      setEditingPattern(null);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update policy');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(policy: ToolPolicy) {
    if (!isCustomPolicy(policy.pattern)) return;
    setBusy(true);
    setActionError(null);
    try {
      await removeToolPolicy(policy.pattern);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove policy');
    } finally {
      setBusy(false);
    }
  }

  async function handleAddPolicy() {
    if (!newPolicy.pattern.trim()) {
      setActionError('Pattern is required');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const policy: ToolPolicy = {
        pattern: newPolicy.pattern.trim(),
        level: newPolicy.level,
        riskLevel: newPolicy.riskLevel,
        description: newPolicy.description.trim(),
      };
      await addToolPolicy(policy);
      setShowAddForm(false);
      setNewPolicy({ ...EMPTY_NEW_POLICY });
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add policy');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="approval-config-panel">
        <div className="section-head">
          <div>
            <div className="section-label">Approval Policy</div>
            <h2>Loading approval configuration...</h2>
          </div>
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="approval-config-panel">
        <div className="section-head">
          <div>
            <div className="section-label">Approval Policy</div>
            <h2>Approval Configuration</h2>
          </div>
        </div>
        <div className="narrative narrative-red">
          <AlertTriangle size={14} /> {error ?? 'Failed to load approval configuration'}
        </div>
      </div>
    );
  }

  return (
    <div className="approval-config-panel">
      <div className="section-head">
        <div>
          <div className="section-label">Approval Policy</div>
          <h2>Unified Approval Configuration</h2>
        </div>
        <span className="section-tag">Unified · GAP-06</span>
      </div>

      {actionError && (
        <div className="narrative narrative-red" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} /> {actionError}
        </div>
      )}

      {/* ── A. Sandbox mode selector ────────────────────────────────────── */}
      <section className="approval-section">
        <div className="approval-subhead">
          <Shield size={14} />
          <h3>Sandbox Mode</h3>
          <span className="approval-hint">
            Controls how aggressively the agent auto-executes actions
          </span>
        </div>

        <div className="sandbox-mode-grid">
          {SANDBOX_MODES.map((m) => {
            const active = config.sandboxMode === m.mode;
            return (
              <button
                key={m.mode}
                type="button"
                className={`sandbox-mode-card${active ? ' active' : ''}${m.danger ? ' danger' : ''}`}
                onClick={() => handleSandboxClick(m.mode)}
                disabled={busy}
              >
                <div className="sandbox-mode-card-head">
                  <span className="sandbox-mode-icon">{m.icon}</span>
                  <span className="sandbox-mode-label">{m.label}</span>
                  {active && <Check size={14} className="sandbox-mode-check" />}
                </div>
                <p className="sandbox-mode-desc">{m.description}</p>
              </button>
            );
          })}
        </div>

        {pendingMode === 'full-auto' && (
          <div className="narrative narrative-red" style={{ marginTop: 12 }}>
            <AlertTriangle size={14} />
            <div style={{ flex: 1 }}>
              <strong>Warning: Full Auto mode auto-approves ALL actions</strong>, including shell
              execution and file writes. This should only be used inside an isolated sandbox. Are
              you sure you want to continue?
              <div className="gov-card-acts" style={{ marginTop: 8 }}>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => applySandboxMode('full-auto')}
                  disabled={busy}
                >
                  <AlertTriangle size={12} /> Confirm Full Auto
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingMode(null)}
                  disabled={busy}
                >
                  <X size={12} /> Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="narrative narrative-green" style={{ marginTop: 12 }}>
          <ShieldAlert size={14} /> Current mode: <strong>{config.sandboxMode}</strong> —{' '}
          {config.sandboxModeDescription}
          {config.failClosed && ' · Fail-closed enforcement is active.'}
        </div>
      </section>

      {/* ── B. Tool policy table ────────────────────────────────────────── */}
      <section className="approval-section">
        <div className="approval-subhead">
          <Settings size={14} />
          <h3>Tool Policies</h3>
          <span className="approval-hint">
            {config.toolPolicies.length} pattern(s) · Last updated{' '}
            {formatTimestamp(config.lastUpdated)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowAddForm((v) => !v)}
            disabled={busy}
            style={{ marginLeft: 'auto' }}
          >
            <Plus size={12} /> {showAddForm ? 'Close' : 'Add Policy'}
          </Button>
        </div>

        {showAddForm && (
          <Card className="approval-add-form">
            <div className="approval-add-grid">
              <label className="approval-field">
                <span>Pattern</span>
                <Input
                  placeholder="e.g. docker_*"
                  value={newPolicy.pattern}
                  onChange={(e) => setNewPolicy((p) => ({ ...p, pattern: e.target.value }))}
                  disabled={busy}
                />
              </label>
              <label className="approval-field">
                <span>Level</span>
                <Select
                  value={newPolicy.level}
                  onChange={(e) =>
                    setNewPolicy((p) => ({ ...p, level: e.target.value as ApprovalLevel }))
                  }
                  disabled={busy}
                  style={{ color: LEVEL_META[newPolicy.level].color }}
                >
                  <option value="auto">auto</option>
                  <option value="semi_auto">semi_auto</option>
                  <option value="manual">manual</option>
                </Select>
              </label>
              <label className="approval-field">
                <span>Risk</span>
                <Select
                  value={newPolicy.riskLevel}
                  onChange={(e) =>
                    setNewPolicy((p) => ({ ...p, riskLevel: e.target.value as RiskLevel }))
                  }
                  disabled={busy}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </Select>
              </label>
              <label className="approval-field approval-field-wide">
                <span>Description</span>
                <Input
                  placeholder="Short description of the policy"
                  value={newPolicy.description}
                  onChange={(e) => setNewPolicy((p) => ({ ...p, description: e.target.value }))}
                  disabled={busy}
                />
              </label>
            </div>
            <div className="gov-card-acts" style={{ marginTop: 10 }}>
              <Button variant="primary" size="sm" onClick={handleAddPolicy} disabled={busy}>
                <Check size={12} /> Add
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAddForm(false)}
                disabled={busy}
              >
                <X size={12} /> Cancel
              </Button>
            </div>
          </Card>
        )}

        <div className="approval-table-wrap">
          <table className="approval-table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Level</th>
                <th>Risk</th>
                <th>Description</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {config.toolPolicies.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No tool policies configured
                  </td>
                </tr>
              )}
              {config.toolPolicies.map((policy) => {
                const isEditing = editingPattern === policy.pattern;
                const custom = isCustomPolicy(policy.pattern);
                const lvl = LEVEL_META[policy.level];
                return (
                  <tr key={policy.pattern}>
                    <td>
                      <span className="approval-pattern">
                        <code>{policy.pattern}</code>
                        {custom && <Badge variant="info">custom</Badge>}
                      </span>
                    </td>
                    <td>
                      <Select
                        value={policy.level}
                        onChange={(e) => handleLevelChange(policy, e.target.value as ApprovalLevel)}
                        disabled={busy}
                        className="approval-level-select"
                        style={{ color: lvl.color, borderColor: lvl.color }}
                      >
                        <option value="auto">auto</option>
                        <option value="semi_auto">semi_auto</option>
                        <option value="manual">manual</option>
                      </Select>
                    </td>
                    <td>
                      <Badge variant={RISK_VARIANT[policy.riskLevel]}>{policy.riskLevel}</Badge>
                    </td>
                    <td className="approval-desc">
                      {isEditing ? (
                        <Input
                          value={editDraft.description}
                          onChange={(e) =>
                            setEditDraft((d) => ({ ...d, description: e.target.value }))
                          }
                          disabled={busy}
                        />
                      ) : (
                        <span>{policy.description || '—'}</span>
                      )}
                    </td>
                    <td>
                      <div className="gov-card-acts">
                        {isEditing ? (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => saveEdit(policy)}
                              disabled={busy}
                            >
                              <Check size={12} /> Save
                            </Button>
                            <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={busy}>
                              <X size={12} /> Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => startEdit(policy)}
                              disabled={busy}
                              title="Edit risk & description"
                            >
                              <Pencil size={12} /> Edit
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => handleDelete(policy)}
                              disabled={busy || !custom}
                              title={
                                custom
                                  ? 'Remove custom policy'
                                  : 'Only custom policies can be removed'
                              }
                            >
                              <Trash2 size={12} /> Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── C. Approval audit log ───────────────────────────────────────── */}
      <section className="approval-section">
        <div className="approval-subhead">
          <History size={14} />
          <h3>Approval Audit Log</h3>
          <span className="approval-hint">{auditEntries.length} recent decision(s)</span>
        </div>

        {auditEntries.length === 0 ? (
          <div className="empty">No approval decisions recorded yet</div>
        ) : (
          <div className="approval-table-wrap">
            <table className="approval-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Tool</th>
                  <th>Decision</th>
                  <th>Risk</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {auditEntries.map((entry, i) => {
                  const decision = (entry.decision ?? '').toLowerCase();
                  const decisionVariant: BadgeVariant =
                    decision === 'approved' ? 'success' : decision === 'denied' ? 'error' : 'info';
                  return (
                    <tr key={`${entry.timestamp}-${i}`}>
                      <td className="approval-time">{formatTimestamp(entry.timestamp)}</td>
                      <td>
                        <code>{entry.toolName ?? '—'}</code>
                      </td>
                      <td>
                        <Badge variant={decisionVariant}>
                          {entry.decision ?? entry.event ?? '—'}
                        </Badge>
                      </td>
                      <td>
                        {entry.riskLevel ? (
                          <Badge variant={riskVariantFor(entry.riskLevel)}>{entry.riskLevel}</Badge>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td className="approval-reason">{entry.reason ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
