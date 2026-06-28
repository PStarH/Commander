/**
 * AuditLogPage — Unified, cross-source audit log explorer (v2).
 *
 * Backs the `/audit` route and the redesigned `/api/audit-logs*` endpoints. It
 * merges every audit producer (security / approval / execution / user-action /
 * configuration) behind a single category-based view so operators can trace
 * "who did what, when, and why" end-to-end.
 *
 * Features:
 *   A. Stats bar — total entries + colored severity-distribution badges
 *   B. Filters — time range preset/custom, category multi-select, severity
 *      multi-select, event-type dropdown (sourced from the catalog endpoint),
 *      and a user-id input
 *   C. Timeline list — left timestamp rail + right content, category badge,
 *      severity color bar, expandable JSON details
 *   D. Pagination — 50 per page, prev/next + page window
 *   E. Export — JSON or CSV download of the filtered set
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import {
  Search,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ShieldAlert,
  CheckCircle,
  Activity,
  Settings,
  User,
  FileJson,
  FileSpreadsheet,
} from 'lucide-react';
import { Button, MetricCard } from '../components/ui';
import {
  fetchUnifiedAuditLogs,
  fetchUnifiedAuditStats,
  fetchUnifiedAuditCategories,
  exportUnifiedAuditLogs,
  type UnifiedAuditEntry,
  type UnifiedAuditQuery,
  type UnifiedAuditStats,
  type UnifiedAuditCatalog,
  type UnifiedAuditCategory,
  type UnifiedAuditSeverity,
} from '../api';

// ── Constants ─────────────────────────────────────────────────────────────

type TimeRangePreset = 'today' | '7d' | '30d' | 'all' | 'custom';

const TIME_RANGE_OPTIONS: { value: TimeRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom…' },
];

const CATEGORY_OPTIONS: { value: UnifiedAuditCategory; label: string }[] = [
  { value: 'security', label: 'Security' },
  { value: 'approval', label: 'Approval' },
  { value: 'execution', label: 'Execution' },
  { value: 'configuration', label: 'Configuration' },
  { value: 'user_action', label: 'User Action' },
];

const SEVERITY_OPTIONS: { value: UnifiedAuditSeverity; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'critical', label: 'Critical' },
];

const PAGE_SIZE = 50;

// info=blue, warn=amber, error=orange, critical=red.
const SEVERITY_COLOR: Record<UnifiedAuditSeverity, string> = {
  info: 'var(--accent-blue)',
  warn: 'var(--accent-amber)',
  error: '#ff9f43',
  critical: 'var(--accent-red)',
};

// Distinct hue per category for at-a-glance scanning.
const CATEGORY_COLOR: Record<UnifiedAuditCategory, string> = {
  security: 'var(--accent-red)',
  approval: 'var(--accent-purple)',
  execution: 'var(--accent-blue)',
  configuration: 'var(--accent-green)',
  user_action: '#06b6d4',
};

const CATEGORY_ICON: Record<UnifiedAuditCategory, ReactNode> = {
  security: <ShieldAlert size={13} />,
  approval: <CheckCircle size={13} />,
  execution: <Activity size={13} />,
  configuration: <Settings size={13} />,
  user_action: <User size={13} />,
};

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: string): { time: string; date: string } {
  try {
    const d = new Date(ts);
    return {
      time: d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    };
  } catch {
    return { time: ts, date: '' };
  }
}

/** Convert a datetime-local input value (local time) to an ISO string. */
function datetimeLocalToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Format a Date as a datetime-local input value (YYYY-MM-DDTHH:mm). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compute startTime/endTime ISO strings for a preset. */
function computeTimeRange(
  preset: TimeRangePreset,
  customStart: string,
  customEnd: string,
): { startTime?: string; endTime?: string } {
  const now = new Date();
  switch (preset) {
    case 'today': {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { startTime: start.toISOString(), endTime: now.toISOString() };
    }
    case '7d': {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { startTime: start.toISOString(), endTime: now.toISOString() };
    }
    case '30d': {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { startTime: start.toISOString(), endTime: now.toISOString() };
    }
    case 'custom':
      return {
        startTime: datetimeLocalToIso(customStart),
        endTime: datetimeLocalToIso(customEnd),
      };
    case 'all':
    default:
      return {};
  }
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ── Small presentational helpers ──────────────────────────────────────────

function ColoredTag({
  color,
  children,
  icon,
}: {
  color: string;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <span
      className="bdg"
      style={{
        borderColor: color,
        color,
        background: `${color}1f`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        textTransform: 'capitalize',
      }}
    >
      {icon}
      {children}
    </span>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label
        style={{
          fontSize: '0.6rem',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--text-tertiary)',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/** A toggleable chip used for multi-select category/severity filters. */
function FilterChip({
  active,
  color,
  label,
  onClick,
}: {
  active: boolean;
  color: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn btn-ghost btn-sm`}
      style={{
        padding: '4px 10px',
        borderRadius: '999px',
        fontSize: '0.68rem',
        textTransform: 'capitalize',
        borderColor: active ? color : 'var(--border-color)',
        color: active ? color : 'var(--text-secondary)',
        background: active ? `${color}1f` : 'transparent',
      }}
    >
      {label}
    </button>
  );
}

// ── Component ─────────────────────────────────────────────────────────────

export function AuditLogPage() {
  // Filters
  const [categories, setCategories] = useState<UnifiedAuditCategory[]>([]);
  const [severities, setSeverities] = useState<UnifiedAuditSeverity[]>([]);
  const [eventType, setEventType] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [timeRange, setTimeRange] = useState<TimeRangePreset>('7d');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');

  // Data
  const [entries, setEntries] = useState<UnifiedAuditEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [stats, setStats] = useState<UnifiedAuditStats | null>(null);
  const [catalog, setCatalog] = useState<UnifiedAuditCatalog | null>(null);

  // UI state
  const [loading, setLoading] = useState<boolean>(true);
  const [exporting, setExporting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Default the custom range to the last 7 days so "Custom…" is usable immediately.
  useEffect(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    setCustomStart(toDatetimeLocalValue(start));
    setCustomEnd(toDatetimeLocalValue(now));
  }, []);

  // Build the query object from current filter state.
  const buildQuery = useCallback(
    (overrides?: { page?: number }): UnifiedAuditQuery => {
      const { startTime, endTime } = computeTimeRange(timeRange, customStart, customEnd);
      const pg = overrides?.page ?? page;
      return {
        category: categories.length > 0 ? categories : undefined,
        severity: severities.length > 0 ? severities : undefined,
        eventType: eventType ? [eventType] : undefined,
        startTime,
        endTime,
        userId: userId.trim() || undefined,
        limit: PAGE_SIZE,
        offset: pg * PAGE_SIZE,
      };
    },
    [categories, severities, eventType, userId, timeRange, customStart, customEnd, page],
  );

  // Load logs + stats. Stats reflect the current time range (not the
  // category/severity filters, mirroring the overview semantics).
  const loadAll = useCallback(
    async (query: UnifiedAuditQuery) => {
      setLoading(true);
      setError(null);
      try {
        const { startTime, endTime } = computeTimeRange(timeRange, customStart, customEnd);
        const [logsRes, statsRes] = await Promise.all([
          fetchUnifiedAuditLogs(query),
          fetchUnifiedAuditStats({ startTime, endTime }),
        ]);
        setEntries(logsRes.entries);
        setTotal(logsRes.total);
        setHasMore(logsRes.hasMore);
        setStats(statsRes);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audit logs');
      } finally {
        setLoading(false);
      }
    },
    [timeRange, customStart, customEnd],
  );

  // Reload logs (only) when page changes — keep filters + stats stable.
  const loadLogs = useCallback(async (query: UnifiedAuditQuery) => {
    setLoading(true);
    setError(null);
    try {
      const logsRes = await fetchUnifiedAuditLogs(query);
      setEntries(logsRes.entries);
      setTotal(logsRes.total);
      setHasMore(logsRes.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load: logs + stats + catalog.
  useEffect(() => {
    void (async () => {
      try {
        const cat = await fetchUnifiedAuditCategories();
        setCatalog(cat);
      } catch {
        /* catalog is best-effort — filter still works without it */
      }
    })();
    loadAll(buildQuery());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = useCallback(() => {
    setPage(0);
    setExpandedId(null);
    loadAll(buildQuery({ page: 0 }));
  }, [buildQuery, loadAll]);

  const handlePageChange = useCallback(
    (next: number) => {
      const clamped = Math.max(0, next);
      setPage(clamped);
      setExpandedId(null);
      loadLogs(buildQuery({ page: clamped }));
    },
    [buildQuery, loadLogs],
  );

  const handleRefresh = useCallback(() => {
    loadAll(buildQuery());
  }, [buildQuery, loadAll]);

  const handleExport = useCallback(
    async (format: 'json' | 'csv') => {
      setExporting(true);
      setError(null);
      try {
        // Export uses current filters but ignores pagination.
        const query = buildQuery();
        const blob = await exportUnifiedAuditLogs(
          { ...query, limit: undefined, offset: undefined },
          format,
        );
        triggerBlobDownload(blob, `audit-logs-${Date.now()}.${format}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to export audit logs');
      } finally {
        setExporting(false);
      }
    },
    [buildQuery],
  );

  const toggleCategory = useCallback((cat: UnifiedAuditCategory) => {
    setCategories((cur) => (cur.includes(cat) ? cur.filter((c) => c !== cat) : [...cur, cat]));
  }, []);

  const toggleSeverity = useCallback((sev: UnifiedAuditSeverity) => {
    setSeverities((cur) => (cur.includes(sev) ? cur.filter((s) => s !== sev) : [...cur, sev]));
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);

  const severityBreakdown = useMemo(() => {
    const s = stats?.bySeverity ?? {};
    return {
      info: s['info'] ?? 0,
      warn: s['warn'] ?? 0,
      error: s['error'] ?? 0,
      critical: s['critical'] ?? 0,
    };
  }, [stats]);

  // Event-type options: prefer the live catalog; fall back to nothing (the
  // dropdown still offers "All event types").
  const eventTypeOptions = useMemo(() => {
    return catalog?.eventTypes ?? [];
  }, [catalog]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Accountability</div>
          <h1>Audit Log</h1>
        </div>
        <p className="page-desc">
          Unified, cross-source audit trail merging security events, approval decisions, execution
          traces, configuration changes, and user actions. Filter by category, severity, event type,
          time range, or user to trace who did what, when, and why. Export the filtered set for
          compliance review.
        </p>
      </div>

      <div className="dashboard-grid">
        {/* ── Stats bar ──────────────────────────────────────────────── */}
        <div className="metric-row">
          <MetricCard
            label="Total Entries"
            value={String(stats?.total ?? 0)}
            icon={<ClipboardList size={14} />}
          />
          <SeverityBadge severity="info" count={severityBreakdown.info} />
          <SeverityBadge severity="warn" count={severityBreakdown.warn} />
          <SeverityBadge severity="error" count={severityBreakdown.error} />
          <SeverityBadge severity="critical" count={severityBreakdown.critical} />
        </div>

        {/* ── Filters ────────────────────────────────────────────────── */}
        <div
          className="card"
          style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
            <FilterField label="Time Range">
              <select
                className="sel"
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as TimeRangePreset)}
                style={{ minWidth: '150px' }}
              >
                {TIME_RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FilterField>

            {timeRange === 'custom' && (
              <>
                <FilterField label="Start">
                  <input
                    className="inp"
                    type="datetime-local"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                </FilterField>
                <FilterField label="End">
                  <input
                    className="inp"
                    type="datetime-local"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </FilterField>
              </>
            )}

            <FilterField label="Event Type">
              <select
                className="sel"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                style={{ minWidth: '220px' }}
              >
                <option value="">All event types</option>
                {CATEGORY_OPTIONS.map((cat) => {
                  const opts = eventTypeOptions.filter((o) => o.category === cat.value);
                  if (opts.length === 0) return null;
                  return (
                    <optgroup key={cat.value} label={cat.label}>
                      {opts.map((o) => (
                        <option key={`${o.category}:${o.eventType}`} value={o.eventType}>
                          {o.eventType}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </FilterField>

            <FilterField label="User ID">
              <input
                className="inp"
                type="text"
                placeholder="filter by user"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSearch();
                }}
                style={{ minWidth: '160px' }}
              />
            </FilterField>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
              <Button variant="primary" size="sm" onClick={handleSearch} disabled={loading}>
                <Search size={13} />
                Search
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleExport('json')}
                disabled={exporting || loading}
              >
                <FileJson size={13} />
                JSON
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleExport('csv')}
                disabled={exporting || loading}
              >
                <FileSpreadsheet size={13} />
                CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={loading}>
                <RefreshCw size={13} />
                Refresh
              </Button>
            </div>
          </div>

          {/* Category multi-select */}
          <FilterRow label="Category">
            {CATEGORY_OPTIONS.map((c) => (
              <FilterChip
                key={c.value}
                active={categories.includes(c.value)}
                color={CATEGORY_COLOR[c.value]}
                label={c.label}
                onClick={() => toggleCategory(c.value)}
              />
            ))}
          </FilterRow>

          {/* Severity multi-select */}
          <FilterRow label="Severity">
            {SEVERITY_OPTIONS.map((s) => (
              <FilterChip
                key={s.value}
                active={severities.includes(s.value)}
                color={SEVERITY_COLOR[s.value]}
                label={s.label}
                onClick={() => toggleSeverity(s.value)}
              />
            ))}
          </FilterRow>
        </div>

        {/* ── Error banner ───────────────────────────────────────────── */}
        {error && (
          <div className="banner error" style={{ marginBottom: '12px' }}>
            <span>{error}</span>
            <button type="button" className="banner-close" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {/* ── Timeline list ──────────────────────────────────────────── */}
        <AuditTimeline
          entries={entries}
          loading={loading}
          expandedId={expandedId}
          onToggleRow={(id) => setExpandedId((cur) => (cur === id ? null : id))}
        />

        {/* ── Pagination ─────────────────────────────────────────────── */}
        <Pagination
          page={currentPage}
          totalPages={totalPages}
          total={total}
          pageSize={PAGE_SIZE}
          hasMore={hasMore}
          onPageChange={handlePageChange}
        />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      <span
        style={{
          fontSize: '0.6rem',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--text-tertiary)',
          minWidth: '64px',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function SeverityBadge({
  severity,
  count,
}: {
  severity: UnifiedAuditSeverity;
  count: number;
}) {
  const color = SEVERITY_COLOR[severity];
  const label = SEVERITY_OPTIONS.find((s) => s.value === severity)?.label ?? severity;
  return (
    <div
      className="metric-card"
      style={{ borderLeft: `3px solid ${color}`, padding: '10px 14px' }}
    >
      <div className="metric-card-head">
        <span className="metric-card-label" style={{ color }}>
          {label}
        </span>
      </div>
      <div className="metric-card-body">
        <span className="metric-card-value">{count}</span>
      </div>
    </div>
  );
}

function AuditTimeline({
  entries,
  loading,
  expandedId,
  onToggleRow,
}: {
  entries: UnifiedAuditEntry[];
  loading: boolean;
  expandedId: string | null;
  onToggleRow: (id: string) => void;
}) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        className="section-head"
        style={{
          padding: '12px 16px',
          marginBottom: 0,
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div>
          <span className="section-label">Audit Trail</span>
          <h2 style={{ fontSize: '1.1rem' }}>
            {entries.length > 0 ? `${entries.length} entries on this page` : 'No entries'}
          </h2>
        </div>
      </div>

      {loading ? (
        <div className="loading-screen" style={{ padding: '24px 16px' }}>
          <div className="loader" />
          <p>Loading audit logs…</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="empty" style={{ padding: '24px 16px' }}>
          No audit log entries match the current filters.
        </div>
      ) : (
        <div>
          {entries.map((entry) => (
            <AuditEntryRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => onToggleRow(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AuditEntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: UnifiedAuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const categoryColor = CATEGORY_COLOR[entry.category] ?? 'var(--text-muted)';
  const severityColor = SEVERITY_COLOR[entry.severity] ?? 'var(--text-muted)';
  const { time, date } = formatTimestamp(entry.timestamp);
  const hasDetails = entry.details !== undefined && Object.keys(entry.details).length > 0;

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '14px',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-color)',
    borderLeft: `3px solid ${severityColor}`,
    cursor: hasDetails ? 'pointer' : 'default',
    background: expanded ? 'var(--bg-hover)' : 'transparent',
  };

  return (
    <div style={rowStyle} onClick={hasDetails ? onToggle : undefined}>
      {/* Left: timestamp rail */}
      <div
        style={{
          flexShrink: 0,
          minWidth: '92px',
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <div style={{ fontSize: '0.72rem', color: 'var(--text-primary)', fontWeight: 600 }}>
          {time}
        </div>
        <div style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>{date}</div>
      </div>

      {/* Right: content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            marginBottom: '4px',
          }}
        >
          <ColoredTag color={categoryColor} icon={CATEGORY_ICON[entry.category]}>
            {entry.category}
          </ColoredTag>
          <ColoredTag color={severityColor}>{entry.severity}</ColoredTag>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              color: 'var(--text-secondary)',
            }}
          >
            {entry.eventType}
          </span>
          {hasDetails ? (
            expanded ? (
              <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />
            ) : (
              <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />
            )
          ) : null}
        </div>

        <div
          title={entry.message}
          style={{
            fontSize: '0.78rem',
            color: 'var(--text-primary)',
            lineHeight: 1.4,
            wordBreak: 'break-word',
          }}
        >
          {entry.message}
        </div>

        {/* Inline meta line */}
        <div
          style={{
            marginTop: '4px',
            display: 'flex',
            gap: '12px',
            flexWrap: 'wrap',
            fontSize: '0.62rem',
            color: 'var(--text-tertiary)',
          }}
        >
          {entry.userId && <span>user: {entry.userId}</span>}
          {entry.runId && <span>run: {entry.runId}</span>}
          {entry.agentId && <span>agent: {entry.agentId}</span>}
          {entry.toolName && <span>tool: {entry.toolName}</span>}
          {entry.tenantId && <span>tenant: {entry.tenantId}</span>}
          <span style={{ opacity: 0.7 }}>src: {entry.source}</span>
        </div>

        {expanded && hasDetails && (
          <pre
            style={{
              margin: '8px 0 0',
              padding: '12px',
              background: 'var(--bg-deep)',
              borderRadius: '4px',
              border: '1px solid var(--border-color)',
              fontSize: '0.68rem',
              lineHeight: 1.5,
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              overflowX: 'auto',
              maxHeight: '360px',
            }}
          >
            {JSON.stringify(entry.details, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  hasMore,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  hasMore: boolean;
  onPageChange: (next: number) => void;
}) {
  // Show a sliding window of page numbers around the current page.
  const windowSize = 5;
  const start = Math.max(0, page - Math.floor(windowSize / 2));
  const end = Math.min(totalPages, start + windowSize);
  const pages: number[] = [];
  for (let i = start; i < end; i++) pages.push(i);

  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(total, (page + 1) * pageSize);

  return (
    <div
      className="card"
      style={{
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
        {total === 0
          ? '0 entries'
          : `${rangeStart}–${rangeEnd} of ${total}${hasMore ? '+' : ''} entries`}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <Button variant="ghost" size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 0}>
          ‹ Prev
        </Button>
        {pages.map((p) => (
          <button
            key={p}
            type="button"
            className={`btn btn-ghost btn-sm ${p === page ? 'active' : ''}`}
            onClick={() => onPageChange(p)}
            style={
              p === page
                ? {
                    borderColor: 'var(--accent-green-border)',
                    color: 'var(--accent-green)',
                    background: 'var(--accent-green-bg)',
                  }
                : undefined
            }
          >
            {p + 1}
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasMore && page >= totalPages - 1}
        >
          Next ›
        </Button>
      </div>

      <span style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
        {pageSize} / page
      </span>
    </div>
  );
}
