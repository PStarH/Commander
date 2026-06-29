/**
 * KnowledgeBasePage — Dedicated page for the enterprise knowledge base / RAG.
 *
 * Layout:
 *   1. Page header (title + description)
 *   2. RagPluginStatus card — enable/disable the built-in `builtin-rag` plugin
 *      and show live document/vector counts + embedding info.
 *   3. KnowledgeBase component — full document management + semantic search UI
 *      (backed by /api/knowledge/*).
 *
 * Accessible via the /knowledge route in the sidebar.
 */
import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Power, PowerOff, RefreshCw, FileText, Database, Cpu } from 'lucide-react';
import { KnowledgeBase } from '../components/KnowledgeBase';
import { Badge, Button, MetricCard } from '../components/ui';
import { fetchKbStatus, enableRagPlugin, disableRagPlugin, type KbStatus } from '../api';

// ── RagPluginStatus — plugin control card ──────────────────────────────────

/**
 * Controls the built-in RAG CommanderPlugin: shows its enabled state, live
 * document/vector counts, and the embedding backend in use. The Enable/Disable
 * toggle calls the /api/knowledge-base/{enable,disable} endpoints.
 *
 * Note: the data plane (upload/search) works whether or not the plugin is
 * enabled — enabling only activates the beforeLLMCall auto-inject hook and the
 * `knowledge_search` tool exposure.
 */
function RagPluginStatus() {
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchKbStatus();
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(async () => {
    if (!status) return;
    setToggling(true);
    setError(null);
    try {
      if (status.enabled) {
        await disableRagPlugin();
      } else {
        await enableRagPlugin();
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  }, [status, refresh]);

  const enabled = status?.enabled ?? false;
  const registered = status?.registered ?? false;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>RAG Plugin</h2>
          {registered ? (
            <Badge variant={enabled ? 'success' : 'warning'}>
              {enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          ) : (
            <Badge variant="error">Not Registered</Badge>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} style={{ marginRight: 4 }} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button
            variant={enabled ? 'danger' : 'primary'}
            size="sm"
            onClick={() => void handleToggle()}
            disabled={!registered || toggling}
          >
            {enabled ? (
              <>
                <PowerOff size={14} style={{ marginRight: 4 }} />
                {toggling ? 'Disabling…' : 'Disable'}
              </>
            ) : (
              <>
                <Power size={14} style={{ marginRight: 4 }} />
                {toggling ? 'Enabling…' : 'Enable'}
              </>
            )}
          </Button>
        </div>
      </div>

      <p
        style={{
          margin: '8px 0 12px',
          color: 'var(--muted, #6b7280)',
          fontSize: 13,
        }}
      >
        Enabling the RAG plugin activates the <code>beforeLLMCall</code> auto-inject hook (retrieved
        context is prepended to the conversation) and exposes the <code>knowledge_search</code> tool
        to the Agent. The knowledge base itself (upload / search) works regardless of this toggle.
      </p>

      <div
        className="metric-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
        }}
      >
        <MetricCard
          label="Documents"
          value={String(status?.documentCount ?? 0)}
          icon={<FileText size={16} />}
        />
        <MetricCard
          label="Vectors"
          value={String(status?.vectorCount ?? 0)}
          icon={<Database size={16} />}
        />
        <MetricCard label="Embedding" value={status?.embedding ?? '—'} icon={<Cpu size={16} />} />
        <MetricCard
          label="Dimension"
          value={String(status?.embeddingDimension ?? 0)}
          icon={<Cpu size={16} />}
        />
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: '8px 12px',
            borderRadius: 6,
            background: 'var(--danger-bg, #fef2f2)',
            color: 'var(--danger, #b91c1c)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function KnowledgeBasePage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">Enterprise Knowledge</div>
          <h1>Knowledge Base</h1>
        </div>
        <p className="page-desc">
          Upload internal documents and let your Agent retrieve them via semantic search. Documents
          are chunked and embedded locally (no external API key required), then served as
          retrieval-augmented context for LLM calls. Storage lives in
          <code style={{ marginLeft: 4 }}>.commander/knowledge-base/</code>.
        </p>
      </div>

      <RagPluginStatus />

      <KnowledgeBase />
    </div>
  );
}

// Re-export the icon for potential sidebar reuse.
export { BookOpen };
