import { useState, useEffect, useCallback } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw, Inbox } from 'lucide-react';
import { Badge, Button, MetricCard } from '../components/ui';
import {
  fetchDlqStats,
  fetchDlqEntries,
  replayDlqEntry,
  type DlqStats,
  type DlqEntry,
} from '../api';

const REFRESH_INTERVAL_MS = 30_000;

const CATEGORY_BADGE_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
  llm: 'info',
  tool: 'success',
  execution: 'warning',
  verification: 'info',
  circuit_breaker: 'error',
  compensation: 'warning',
  semantic_drift: 'success',
};

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString('en');
  } catch {
    return ts;
  }
}

export function DlqPage() {
  const [stats, setStats] = useState<DlqStats | null>(null);
  const [entries, setEntries] = useState<DlqEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [statsData, entriesData] = await Promise.all([
        fetchDlqStats(),
        fetchDlqEntries(categoryFilter || undefined, 200),
      ]);
      setStats(statsData);
      setEntries(entriesData);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load DLQ data');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter]);

  // Initial + filter-change load
  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const id = setInterval(() => {
      load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  const handleReplay = useCallback(
    async (entryId: string) => {
      setReplayingId(entryId);
      try {
        await replayDlqEntry(entryId);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to replay entry');
      } finally {
        setReplayingId(null);
      }
    },
    [load],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Reliability</div>
          <h1>Dead Letter Queue</h1>
        </div>
        <p className="page-desc">
          Failed executions and tool calls awaiting recovery. Entries are persisted per category in
          <code style={{ marginLeft: 4 }}>.commander_dlq/</code>. Auto-refreshes every 30s.
        </p>
      </div>

      {error && (
        <div className="banner error" style={{ marginBottom: '12px' }}>
          <span>{error}</span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {loading ? (
        <div className="loading-screen">
          <div className="loader" />
          <p>Loading DLQ data...</p>
        </div>
      ) : (
        <div className="dashboard-grid">
          {/* ── Stats Row ───────────────────────────────────────────── */}
          <div className="metric-row">
            <MetricCard
              label="Total Entries"
              value={String(stats?.totalEntries ?? 0)}
              icon={<AlertTriangle size={14} />}
            />
            <MetricCard
              label="Unrecovered"
              value={String(stats?.totalUnrecovered ?? 0)}
              icon={<AlertTriangle size={14} />}
            />
            <MetricCard
              label="Recovered"
              value={String(stats?.totalRecovered ?? 0)}
              icon={<RefreshCw size={14} />}
            />
            <MetricCard
              label="Categories"
              value={String(stats?.categories?.length ?? 0)}
              icon={<Inbox size={14} />}
            />
          </div>

          {/* ── Per-Category Breakdown ─────────────────────────────── */}
          <CategoryBreakdownCard stats={stats} />

          {/* ── Filter + Refresh Controls ──────────────────────────── */}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label
                htmlFor="dlq-category-filter"
                style={{
                  fontSize: '0.7rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'var(--text-tertiary)',
                }}
              >
                Category
              </label>
              <select
                id="dlq-category-filter"
                className="sel"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                style={{ minWidth: '180px' }}
              >
                <option value="">All categories</option>
                {(stats?.categories ?? []).map((c) => (
                  <option key={c.category} value={c.category}>
                    {c.category} ({c.count})
                  </option>
                ))}
              </select>
            </div>
            <Button variant="ghost" size="sm" onClick={() => load()} disabled={loading}>
              <RefreshCw size={14} />
              Refresh
            </Button>
            {lastRefresh && (
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                Last updated {formatTimestamp(lastRefresh.toISOString())}
              </span>
            )}
          </div>

          {/* ── Entries Table ──────────────────────────────────────── */}
          <EntriesTable entries={entries} replayingId={replayingId} onReplay={handleReplay} />
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function CategoryBreakdownCard({ stats }: { stats: DlqStats | null }) {
  const categories = stats?.categories ?? [];
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="section-head" style={{ marginBottom: '10px' }}>
        <div>
          <span className="section-label">Per-Category Counts</span>
          <h2 style={{ fontSize: '1.1rem' }}>Entries by Failure Category</h2>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: '8px',
        }}
      >
        {categories.map((c) => (
          <div
            key={c.category}
            style={{
              padding: '10px 12px',
              background: 'var(--bg-elevated)',
              borderRadius: '4px',
              borderLeft: '2px solid var(--text-muted)',
            }}
          >
            <div
              style={{
                fontSize: '0.65rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--text-tertiary)',
              }}
            >
              {c.category}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {c.count}
              </span>
              {c.unrecovered > 0 && (
                <span style={{ fontSize: '0.65rem', color: 'var(--accent-red)' }}>
                  {c.unrecovered} unrecovered
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EntriesTable({
  entries,
  replayingId,
  onReplay,
}: {
  entries: DlqEntry[];
  replayingId: string | null;
  onReplay: (entryId: string) => void;
}) {
  return (
    <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
      <div
        className="section-head"
        style={{
          padding: '12px 16px',
          marginBottom: 0,
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div>
          <span className="section-label">Unrecovered Entries</span>
          <h2 style={{ fontSize: '1.1rem' }}>
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
          </h2>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="empty" style={{ padding: '24px 16px' }}>
          No unrecovered DLQ entries. All clear.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <Th>Entry ID</Th>
                <Th>Category</Th>
                <Th>Failure Mode</Th>
                <Th>Operation</Th>
                <Th>Timestamp</Th>
                <Th>Error Message</Th>
                <Th style={{ textAlign: 'right' }}>Action</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <Td>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.68rem',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {entry.id.length > 32 ? `${entry.id.slice(0, 32)}...` : entry.id}
                    </span>
                  </Td>
                  <Td>
                    <Badge variant={CATEGORY_BADGE_VARIANT[entry.category] ?? 'info'}>
                      {entry.category}
                    </Badge>
                  </Td>
                  <Td>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                      {entry.failureMode}
                    </span>
                  </Td>
                  <Td>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-primary)' }}>
                      {entry.operationName}
                    </span>
                  </Td>
                  <Td>
                    <span
                      style={{
                        fontSize: '0.65rem',
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </Td>
                  <Td>
                    <span
                      title={entry.errorMessage}
                      style={{
                        fontSize: '0.68rem',
                        color: 'var(--text-secondary)',
                        maxWidth: '320px',
                        display: 'inline-block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        verticalAlign: 'bottom',
                      }}
                    >
                      {entry.errorMessage}
                    </span>
                  </Td>
                  <Td style={{ textAlign: 'right' }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onReplay(entry.id)}
                      disabled={replayingId === entry.id}
                    >
                      <RotateCcw size={13} />
                      {replayingId === entry.id ? 'Replaying...' : 'Replay'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, style }: { children: ReactNode; style?: CSSProperties }) {
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
