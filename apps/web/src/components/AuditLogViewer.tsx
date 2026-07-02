/**
 * AuditLogViewer — Unified audit log explorer.
 *
 * Surfaces the three previously-scattered audit producers (security events,
 * approval decisions, action rationale) behind a single filterable, pageable
 * table so operators can trace accountability end-to-end.
 *
 * Features:
 *   A. Filter bar — source / severity / eventType (fuzzy) / time range / userId
 *   B. Stats overview — total events + per-source + per-severity counts
 *   C. Log table — expandable rows reveal the structured `details` payload
 *   D. Pagination — prev/next + page window + page-size selector
 *   E. Export — downloads the filtered set as a JSON file
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import {
  Search,
  Download,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ShieldAlert,
  CheckCircle,
  Activity,
} from 'lucide-react';
import { Button, MetricCard } from './ui';
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

const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'security', label: 'Security' },
  { value: 'approval', label: 'Approval' },
  { value: 'execution', label: 'Execution' },
  { value: 'configuration', label: 'Configuration' },
  { value: 'user_action', label: 'User Action' },
];

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All severities' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'critical', label: 'Critical' },
];

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// Per task spec: info=blue, warn=yellow, error=orange, critical=red.
const SEVERITY_COLOR: Record<UnifiedAuditSeverity, string> = {
  info: 'var(--accent-blue)',
  warn: 'var(--accent-amber)',
  error: '#ff9f43',
  critical: 'var(--accent-red)',
};

// security=red, approval=purple, execution=blue, configuration=amber, user_action=teal.
const SOURCE_COLOR: Record<UnifiedAuditCategory, string> = {
  security: 'var(--accent-red)',
  approval: 'var(--accent-purple)',
  execution: 'var(--accent-blue)',
  configuration: 'var(--accent-amber)',
  user_action: '#2ec4b6',
};

const SOURCE_ICON: Record<UnifiedAuditCategory, ReactNode> = {
  security: <ShieldAlert size={13} />,
  approval: <CheckCircle size={13} />,
  execution: <Activity size={13} />,
  configuration: <ClipboardList size={13} />,
  user_action: <Activity size={13} />,
};

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString('en');
  } catch {
    return ts;
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
  // Revoke on the next tick to ensure the download has started.
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

function Th({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '8px 12px',
        fontSize: '0.62rem',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: 'var(--text-tertiary)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <td style={{ padding: '8px 12px', verticalAlign: 'middle', ...style }}>{children}</td>;
}

// ── Component ─────────────────────────────────────────────────────────────

export function AuditLogViewer() {
  // Filters
  const [source, setSource] = useState<string>('all');
  const [severity, setSeverity] = useState<string>('all');
  const [eventType, setEventType] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [timeRange, setTimeRange] = useState<TimeRangePreset>('7d');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');

  // Data
  const [logs, setLogs] = useState<UnifiedAuditEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [stats, setStats] = useState<UnifiedAuditStats | null>(null);
  const [catalog, setCatalog] = useState<UnifiedAuditCatalog | null>(null);

  // UI state
  const [loading, setLoading] = useState<boolean>(true);
  const [exporting, setExporting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(0);
  const [pageSize, setPageSize] = useState<number>(20);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Build the query object from current filter state.
  const buildQuery = useCallback(
    (overrides?: { page?: number; pageSize?: number }): UnifiedAuditQuery => {
      const { startTime, endTime } = computeTimeRange(timeRange, customStart, customEnd);
      const pg = overrides?.page ?? page;
      const ps = overrides?.pageSize ?? pageSize;
      return {
        category: source !== 'all' ? [source as UnifiedAuditCategory] : undefined,
        severity: severity !== 'all' ? [severity as UnifiedAuditSeverity] : undefined,
        eventType: eventType.trim() ? [eventType.trim()] : undefined,
        startTime,
        endTime,
        userId: userId.trim() || undefined,
        limit: ps,
        offset: pg * ps,
      };
    },
    [source, severity, eventType, userId, timeRange, customStart, customEnd, page, pageSize],
  );

  // Load logs + stats + catalog. Stats/catalog reflect the full (unfiltered)
  // corpus so the overview cards stay stable across filter changes.
  const loadAll = useCallback(
    async (query: UnifiedAuditQuery) => {
      setLoading(true);
      setError(null);
      try {
        const { startTime, endTime } = computeTimeRange(timeRange, customStart, customEnd);
        const [logsRes, statsRes, catalogRes] = await Promise.all([
          fetchUnifiedAuditLogs(query),
          fetchUnifiedAuditStats({ startTime, endTime }),
          fetchUnifiedAuditCategories(),
        ]);
        setLogs(logsRes.entries);
        setTotal(logsRes.total);
        setStats(statsRes);
        setCatalog(catalogRes);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load audit logs');
      } finally {
        setLoading(false);
      }
    },
    [timeRange, customStart, customEnd],
  );

  // Initial load.
  useEffect(() => {
    loadAll(buildQuery());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload logs (only) when page or pageSize changes — keep filters stable.
  const loadLogs = useCallback(async (query: UnifiedAuditQuery) => {
    setLoading(true);
    setError(null);
    try {
      const logsRes = await fetchUnifiedAuditLogs(query);
      setLogs(logsRes.entries);
      setTotal(logsRes.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
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

  const handlePageSizeChange = useCallback(
    (nextSize: number) => {
      setPageSize(nextSize);
      setPage(0);
      setExpandedId(null);
      loadLogs(buildQuery({ page: 0, pageSize: nextSize }));
    },
    [buildQuery, loadLogs],
  );

  const handleRefresh = useCallback(() => {
    loadAll(buildQuery());
  }, [buildQuery, loadAll]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      // Export uses current filters but ignores pagination.
      const exportQuery: UnifiedAuditQuery = {
        category: source !== 'all' ? [source as UnifiedAuditCategory] : undefined,
        severity: severity !== 'all' ? [severity as UnifiedAuditSeverity] : undefined,
        eventType: eventType.trim() ? [eventType.trim()] : undefined,
        startTime: computeTimeRange(timeRange, customStart, customEnd).startTime,
        endTime: computeTimeRange(timeRange, customStart, customEnd).endTime,
        userId: userId.trim() || undefined,
      };
      const blob = await exportUnifiedAuditLogs(exportQuery, 'json');
      triggerBlobDownload(blob, `audit-logs-${Date.now()}.json`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export audit logs');
    } finally {
      setExporting(false);
    }
  }, [source, severity, eventType, userId, timeRange, customStart, customEnd]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
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

  return (
    <div className="dashboard-grid">
      {/* ── Stats overview cards ─────────────────────────────────────── */}
      <div className="metric-row">
        <MetricCard
          label="Total Events"
          value={String(stats?.total ?? 0)}
          icon={<ClipboardList size={14} />}
        />
        <MetricCard
          label="Security"
          value={String(stats?.byCategory['security'] ?? 0)}
          icon={<ShieldAlert size={14} />}
        />
        <MetricCard
          label="Approval"
          value={String(stats?.byCategory['approval'] ?? 0)}
          icon={<CheckCircle size={14} />}
        />
        <MetricCard
          label="Execution"
          value={String(stats?.byCategory['execution'] ?? 0)}
          icon={<Activity size={14} />}
        />
      </div>

      {/* ── Severity breakdown ───────────────────────────────────────── */}
      <SeverityBreakdownCard severity={severityBreakdown} />

      {/* ── Filter bar ───────────────────────────────────────────────── */}
      <div
        className="card"
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <FilterField label="Source">
          <select
            className="sel"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{ minWidth: '150px' }}
          >
            {(catalog?.categories ?? SOURCE_OPTIONS).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Severity">
          <select
            className="sel"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            style={{ minWidth: '150px' }}
          >
            {SEVERITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Event Type">
          <input
            className="inp"
            type="text"
            placeholder="e.g. sandbox_violation"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            style={{ minWidth: '200px' }}
          />
        </FilterField>

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

        <FilterField label="User ID">
          <input
            className="inp"
            type="text"
            placeholder="filter by user/agent"
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
          <Button variant="ghost" size="sm" onClick={handleExport} disabled={exporting || loading}>
            <Download size={13} />
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={loading}>
            <RefreshCw size={13} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────── */}
      {error && (
        <div className="banner error" style={{ marginBottom: '12px' }}>
          <span>{error}</span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* ── Log table ────────────────────────────────────────────────── */}
      <LogsTable
        logs={logs}
        loading={loading}
        expandedId={expandedId}
        onToggleRow={(id) => setExpandedId((cur) => (cur === id ? null : id))}
      />

      {/* ── Pagination ───────────────────────────────────────────────── */}
      <Pagination
        page={currentPage}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
      />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

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

function SeverityBreakdownCard({
  severity,
}: {
  severity: { info: number; warn: number; error: number; critical: number };
}) {
  const items: { key: UnifiedAuditSeverity; count: number }[] = [
    { key: 'info', count: severity.info },
    { key: 'warn', count: severity.warn },
    { key: 'error', count: severity.error },
    { key: 'critical', count: severity.critical },
  ];
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="section-head" style={{ marginBottom: '10px' }}>
        <div>
          <span className="section-label">Severity Distribution</span>
          <h2 style={{ fontSize: '1.1rem' }}>Events by Severity</h2>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: '8px',
        }}
      >
        {items.map(({ key, count }) => {
          const color = SEVERITY_COLOR[key];
          return (
            <div
              key={key}
              style={{
                padding: '10px 12px',
                background: 'var(--bg-elevated)',
                borderRadius: '4px',
                borderLeft: `2px solid ${color}`,
              }}
            >
              <div
                style={{
                  fontSize: '0.65rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color,
                }}
              >
                {key}
              </div>
              <div
                style={{
                  fontSize: '1.1rem',
                  fontWeight: 700,
                  color: 'var(--text-primary)',
                  marginTop: '4px',
                }}
              >
                {count}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LogsTable({
  logs,
  loading,
  expandedId,
  onToggleRow,
}: {
  logs: UnifiedAuditEntry[];
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
            {logs.length > 0 ? `${logs.length} entries on this page` : 'No entries'}
          </h2>
        </div>
      </div>

      {loading ? (
        <div className="loading-screen" style={{ padding: '24px 16px' }}>
          <div className="loader" />
          <p>Loading audit logs…</p>
        </div>
      ) : logs.length === 0 ? (
        <div className="empty" style={{ padding: '24px 16px' }}>
          No audit log entries match the current filters.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <Th style={{ width: '28px' }} />
                <Th>Time</Th>
                <Th>Category</Th>
                <Th>Event Type</Th>
                <Th>Severity</Th>
                <Th>User</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((entry) => {
                const expanded = expandedId === entry.id;
                return (
                  <LogRow
                    key={entry.id}
                    entry={entry}
                    expanded={expanded}
                    onToggle={() => onToggleRow(entry.id)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: UnifiedAuditEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sourceColor = SOURCE_COLOR[entry.category] ?? 'var(--text-muted)';
  const severityColor = SEVERITY_COLOR[entry.severity] ?? 'var(--text-muted)';
  const hasDetails = entry.details !== undefined && Object.keys(entry.details).length > 0;

  return (
    <>
      <tr
        style={{
          borderBottom: '1px solid var(--border-color)',
          cursor: hasDetails ? 'pointer' : 'default',
          background: expanded ? 'var(--bg-hover)' : 'transparent',
        }}
        onClick={hasDetails ? onToggle : undefined}
      >
        <Td style={{ color: 'var(--text-muted)' }}>
          {hasDetails ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <span style={{ display: 'inline-block', width: '14px' }} />
          )}
        </Td>
        <Td>
          <span
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {formatTimestamp(entry.timestamp)}
          </span>
        </Td>
        <Td>
          <ColoredTag color={sourceColor} icon={SOURCE_ICON[entry.category]}>
            {entry.category}
          </ColoredTag>
        </Td>
        <Td>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              color: 'var(--text-secondary)',
            }}
          >
            {entry.eventType}
          </span>
        </Td>
        <Td>
          <ColoredTag color={severityColor}>{entry.severity}</ColoredTag>
        </Td>
        <Td>
          <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
            {entry.userId ?? '—'}
          </span>
        </Td>
        <Td>
          <span
            title={entry.message}
            style={{
              fontSize: '0.7rem',
              color: 'var(--text-primary)',
              maxWidth: '420px',
              display: 'inline-block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              verticalAlign: 'bottom',
            }}
          >
            {entry.message}
          </span>
        </Td>
      </tr>
      {expanded && hasDetails && (
        <tr style={{ background: 'var(--bg-elevated)' }}>
          <td colSpan={7} style={{ padding: '12px 16px' }}>
            <div
              style={{
                fontSize: '0.62rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--text-tertiary)',
                marginBottom: '6px',
              }}
            >
              Details
            </div>
            <pre
              style={{
                margin: 0,
                padding: '12px',
                background: 'var(--bg-deep)',
                borderRadius: '4px',
                border: '1px solid var(--border-color)',
                fontSize: '0.68rem',
                lineHeight: 1.5,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
                overflowX: 'auto',
                maxHeight: '320px',
              }}
            >
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (next: number) => void;
  onPageSizeChange: (next: number) => void;
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
        {total === 0 ? '0 entries' : `${rangeStart}–${rangeEnd} of ${total} entries`}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 0}
        >
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
          disabled={page >= totalPages - 1}
        >
          Next ›
        </Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
        <label
          htmlFor="audit-page-size"
          style={{
            fontSize: '0.6rem',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'var(--text-tertiary)',
          }}
        >
          Per page
        </label>
        <select
          id="audit-page-size"
          className="sel"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          style={{ minWidth: '80px' }}
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
