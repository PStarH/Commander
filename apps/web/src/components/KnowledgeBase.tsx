/**
 * KnowledgeBase — Enterprise knowledge-base management component.
 *
 * Enterprise users' #1 need: let Agents retrieve internal company documents.
 * This component provides a full management UI for the RAG pipeline:
 *   A. Stat cards — document count, chunk count, total size, embedding dim
 *   B. Upload area — paste text or upload a file (auto-detected content type)
 *   C. Document table — name, type, chunks, size, status, delete (with confirm)
 *   D. Semantic search box — query the vector index, show ranked chunks + scores
 *
 * Backed by `/api/knowledge/*` endpoints (see apps/api/src/knowledgeBaseEndpoints.ts).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import {
  BookOpen,
  Upload,
  Search,
  Trash2,
  RefreshCw,
  FileText,
  Database,
  HardDrive,
  Layers,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { Badge, Button, MetricCard } from './ui';
import {
  fetchKnowledgeDocuments,
  fetchKnowledgeStats,
  uploadKnowledgeDocument,
  deleteKnowledgeDocument,
  searchKnowledge,
  type KnowledgeDocument,
  type KnowledgeStats,
  type KnowledgeSearchResult,
  type KnowledgeContentType,
} from '../api';

// ── Constants ────────────────────────────────────────────────────────────

const CONTENT_TYPE_OPTIONS: { value: KnowledgeContentType; label: string }[] = [
  { value: 'text/plain', label: 'Plain Text' },
  { value: 'text/markdown', label: 'Markdown' },
  { value: 'application/json', label: 'JSON' },
  { value: 'text/html', label: 'HTML' },
];

const REFRESH_INTERVAL_MS = 60_000;

// ── Helpers ──────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString('en');
  } catch {
    return ts;
  }
}

function contentTypeLabel(type: string): string {
  const found = CONTENT_TYPE_OPTIONS.find((o) => o.value === type);
  return found ? found.label : type;
}

function guessContentType(file: File): KnowledgeContentType {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
  return 'text/plain';
}

// ── Component ────────────────────────────────────────────────────────────

export function KnowledgeBase() {
  // Document list + pagination
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 20;

  // Stats
  const [stats, setStats] = useState<KnowledgeStats | null>(null);

  // Upload form
  const [uploadName, setUploadName] = useState('');
  const [uploadType, setUploadType] = useState<KnowledgeContentType>('text/plain');
  const [uploadContent, setUploadContent] = useState('');
  const [uploading, setUploading] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTopK, setSearchTopK] = useState(5);
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [docsRes, statsRes] = await Promise.all([
        fetchKnowledgeDocuments(page, limit),
        fetchKnowledgeStats(),
      ]);
      setDocuments(docsRes.documents);
      setTotal(docsRes.total);
      setStats(statsRes);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge base');
    } finally {
      setLoading(false);
    }
  }, [page]);

  // Initial + page-change load
  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    const name = uploadName.trim();
    const content = uploadContent.trim();
    if (!name || !content) {
      setError('Document name and content are both required');
      return;
    }
    setUploading(true);
    try {
      await uploadKnowledgeDocument(content, name, uploadType);
      setUploadName('');
      setUploadContent('');
      setUploadType('text/plain');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload document');
    } finally {
      setUploading(false);
    }
  }, [uploadName, uploadContent, uploadType, load]);

  const handleFileSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        setUploadContent(text);
        setUploadName(file.name);
        setUploadType(guessContentType(file));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to read file');
      } finally {
        // Reset input so the same file can be re-selected
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [],
  );

  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) {
      setError('Search query cannot be empty');
      return;
    }
    setSearching(true);
    setHasSearched(true);
    try {
      const results = await searchKnowledge(q, searchTopK);
      setSearchResults(results);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search knowledge base');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchQuery, searchTopK]);

  const handleDelete = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        await deleteKnowledgeDocument(id);
        setConfirmDeleteId(null);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete document');
      } finally {
        setDeletingId(null);
      }
    },
    [load],
  );

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="dashboard-grid">
      {error && (
        <div className="banner error" style={{ marginBottom: '12px' }}>
          <span>{error}</span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* ── Stats Row ────────────────────────────────────────────────────── */}
      <div className="metric-row">
        <MetricCard
          label="Documents"
          value={String(stats?.documentCount ?? 0)}
          icon={<FileText size={14} />}
        />
        <MetricCard
          label="Chunks"
          value={String(stats?.chunkCount ?? 0)}
          icon={<Layers size={14} />}
        />
        <MetricCard
          label="Total Size"
          value={formatSize(stats?.totalSizeBytes ?? 0)}
          icon={<HardDrive size={14} />}
        />
        <MetricCard
          label="Embedding Dim"
          value={String(stats?.embeddingDimension ?? 0)}
          icon={<Database size={14} />}
        />
      </div>

      {/* ── Upload Card ──────────────────────────────────────────────────── */}
      <UploadCard
        uploadName={uploadName}
        uploadType={uploadType}
        uploadContent={uploadContent}
        uploading={uploading}
        fileInputRef={fileInputRef}
        onNameChange={setUploadName}
        onTypeChange={setUploadType}
        onContentChange={setUploadContent}
        onFileSelected={handleFileSelected}
        onUpload={handleUpload}
      />

      {/* ── Semantic Search Card ─────────────────────────────────────────── */}
      <SearchCard
        query={searchQuery}
        topK={searchTopK}
        searching={searching}
        hasSearched={hasSearched}
        results={searchResults}
        onQueryChange={setSearchQuery}
        onTopKChange={setSearchTopK}
        onSearch={handleSearch}
      />

      {/* ── Document List Controls ───────────────────────────────────────── */}
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
          <BookOpen size={14} />
          <span className="section-label">Documents</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {total} total
          </span>
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

      {/* ── Documents Table ──────────────────────────────────────────────── */}
      <DocumentsTable
        documents={documents}
        loading={loading}
        confirmDeleteId={confirmDeleteId}
        deletingId={deletingId}
        onConfirmDelete={setConfirmDeleteId}
        onCancelDelete={() => setConfirmDeleteId(null)}
        onDelete={handleDelete}
      />

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div
          className="card"
          style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Prev
          </Button>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            Page {page} of {totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

interface UploadCardProps {
  uploadName: string;
  uploadType: KnowledgeContentType;
  uploadContent: string;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onNameChange: (v: string) => void;
  onTypeChange: (v: KnowledgeContentType) => void;
  onContentChange: (v: string) => void;
  onFileSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onUpload: () => void;
}

function UploadCard({
  uploadName,
  uploadType,
  uploadContent,
  uploading,
  fileInputRef,
  onNameChange,
  onTypeChange,
  onContentChange,
  onFileSelected,
  onUpload,
}: UploadCardProps) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="section-head" style={{ marginBottom: '12px' }}>
        <div>
          <span className="section-label">Ingest</span>
          <h2 style={{ fontSize: '1.1rem' }}>Upload Document</h2>
        </div>
        <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: 0 }}>
          Paste text or upload a file. Content is chunked (500-1000 chars, 100 overlap) and embedded
          with a zero-dependency hashing-trick embedder — no OpenAI key required.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <div>
          <label
            htmlFor="kb-upload-name"
            style={labelStyle}
          >
            Document Name
          </label>
          <input
            id="kb-upload-name"
            className="inp"
            type="text"
            placeholder="e.g. Onboarding Guide"
            value={uploadName}
            onChange={(e) => onNameChange(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <label htmlFor="kb-upload-type" style={labelStyle}>
            Content Type
          </label>
          <select
            id="kb-upload-type"
            className="sel"
            value={uploadType}
            onChange={(e) => onTypeChange(e.target.value as KnowledgeContentType)}
            style={{ width: '100%' }}
          >
            {CONTENT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: '10px' }}>
        <label htmlFor="kb-upload-content" style={labelStyle}>
          Content
        </label>
        <textarea
          id="kb-upload-content"
          className="inp"
          placeholder="Paste document text here, or use the file picker below..."
          value={uploadContent}
          onChange={(e) => onContentChange(e.target.value)}
          rows={6}
          style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', resize: 'vertical' }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown,.json,.html,.htm,text/plain,text/markdown,application/json,text/html"
          onChange={onFileSelected}
          style={{ display: 'none' }}
        />
        <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload size={13} />
          Choose File
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onUpload}
          disabled={uploading || !uploadName.trim() || !uploadContent.trim()}
        >
          {uploading ? (
            <>
              <Loader2 size={13} className="spin" />
              Indexing...
            </>
          ) : (
            <>
              <Upload size={13} />
              Upload & Index
            </>
          )}
        </Button>
        {uploadContent.length > 0 && (
          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {uploadContent.length.toLocaleString()} chars
          </span>
        )}
      </div>
    </div>
  );
}

interface SearchCardProps {
  query: string;
  topK: number;
  searching: boolean;
  hasSearched: boolean;
  results: KnowledgeSearchResult[];
  onQueryChange: (v: string) => void;
  onTopKChange: (v: number) => void;
  onSearch: () => void;
}

function SearchCard({
  query,
  topK,
  searching,
  hasSearched,
  results,
  onQueryChange,
  onTopKChange,
  onSearch,
}: SearchCardProps) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="section-head" style={{ marginBottom: '12px' }}>
        <div>
          <span className="section-label">Retrieve</span>
          <h2 style={{ fontSize: '1.1rem' }}>Semantic Search</h2>
        </div>
        <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: 0 }}>
          Embed your query and find the most similar document chunks by cosine similarity.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '260px' }}>
          <label htmlFor="kb-search-query" style={labelStyle}>
            Query
          </label>
          <input
            id="kb-search-query"
            className="inp"
            type="text"
            placeholder="e.g. How do I configure SSO?"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSearch();
            }}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ width: '110px' }}>
          <label htmlFor="kb-search-topk" style={labelStyle}>
            Top K
          </label>
          <select
            id="kb-search-topk"
            className="sel"
            value={topK}
            onChange={(e) => onTopKChange(Number(e.target.value))}
            style={{ width: '100%' }}
          >
            {[3, 5, 10, 20].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" size="sm" onClick={onSearch} disabled={searching || !query.trim()}>
          {searching ? (
            <>
              <Loader2 size={13} className="spin" />
              Searching...
            </>
          ) : (
            <>
              <Search size={13} />
              Search
            </>
          )}
        </Button>
      </div>

      {/* Results */}
      {hasSearched && (
        <div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {results.length === 0
              ? 'No matching chunks found.'
              : `${results.length} matching chunk${results.length === 1 ? '' : 's'}`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {results.map((r, i) => (
              <SearchResultItem key={r.chunkId} result={r} rank={i + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SearchResultItem({ result, rank }: { result: KnowledgeSearchResult; rank: number }) {
  const scorePercent = Math.round(Math.max(0, result.score) * 100);
  const scoreVariant: 'success' | 'warning' | 'info' =
    result.score >= 0.5 ? 'success' : result.score >= 0.2 ? 'warning' : 'info';

  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'var(--bg-elevated)',
        borderRadius: '4px',
        borderLeft: '2px solid var(--accent-green-border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '6px',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>#{rank}</span>
        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-primary)' }}>
          {result.docName}
        </span>
        <Badge variant="info">chunk {result.chunkIndex + 1}</Badge>
        <Badge variant={scoreVariant}>{scorePercent}% match</Badge>
        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          score {result.score.toFixed(3)}
        </span>
      </div>
      <pre
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.7rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
          maxHeight: '160px',
          overflow: 'hidden',
        }}
      >
        {result.text}
      </pre>
    </div>
  );
}

interface DocumentsTableProps {
  documents: KnowledgeDocument[];
  loading: boolean;
  confirmDeleteId: string | null;
  deletingId: string | null;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}

function DocumentsTable({
  documents,
  loading,
  confirmDeleteId,
  deletingId,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: DocumentsTableProps) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        className="section-head"
        style={{ padding: '12px 16px', marginBottom: 0, borderBottom: '1px solid var(--border-color)' }}
      >
        <div>
          <span className="section-label">Indexed Documents</span>
          <h2 style={{ fontSize: '1.1rem' }}>
            {documents.length} document{documents.length === 1 ? '' : 's'}
          </h2>
        </div>
      </div>

      {loading ? (
        <div className="empty" style={{ padding: '24px 16px' }}>
          <div className="loader" style={{ marginBottom: '8px' }} />
          Loading documents...
        </div>
      ) : documents.length === 0 ? (
        <div className="empty" style={{ padding: '24px 16px' }}>
          No documents yet. Upload one above to get started.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th style={{ textAlign: 'right' }}>Chunks</Th>
                <Th style={{ textAlign: 'right' }}>Size</Th>
                <Th>Status</Th>
                <Th>Created</Th>
                <Th style={{ textAlign: 'right' }}>Action</Th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <Td>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                      {doc.name}
                    </span>
                    {doc.tags && doc.tags.length > 0 && (
                      <div style={{ marginTop: '4px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {doc.tags.map((t) => (
                          <span
                            key={t}
                            style={{
                              fontSize: '0.6rem',
                              padding: '1px 6px',
                              borderRadius: '3px',
                              background: 'var(--bg-elevated)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Badge variant="info">{contentTypeLabel(doc.type)}</Badge>
                  </Td>
                  <Td style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      {doc.chunks}
                    </span>
                  </Td>
                  <Td style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                      {formatSize(doc.size)}
                    </span>
                  </Td>
                  <Td>
                    <StatusBadge status={doc.status} />
                    {doc.status === 'failed' && doc.error && (
                      <div
                        title={doc.error}
                        style={{
                          fontSize: '0.6rem',
                          color: 'var(--accent-red)',
                          marginTop: '2px',
                          maxWidth: '220px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {doc.error}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {formatTimestamp(doc.createdAt)}
                    </span>
                  </Td>
                  <Td style={{ textAlign: 'right' }}>
                    {confirmDeleteId === doc.id ? (
                      <div style={{ display: 'inline-flex', gap: '4px' }}>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => onDelete(doc.id)}
                          disabled={deletingId === doc.id}
                        >
                          {deletingId === doc.id ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <Trash2 size={13} />
                          )}
                          Confirm
                        </Button>
                        <Button variant="ghost" size="sm" onClick={onCancelDelete} disabled={deletingId === doc.id}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onConfirmDelete(doc.id)}
                        disabled={!!deletingId}
                      >
                        <Trash2 size={13} />
                        Delete
                      </Button>
                    )}
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

function StatusBadge({ status }: { status: KnowledgeDocument['status'] }) {
  switch (status) {
    case 'ready':
      return (
        <Badge variant="success">
          <CheckCircle2 size={10} style={{ marginRight: '2px', verticalAlign: 'middle' }} />
          Ready
        </Badge>
      );
    case 'indexing':
      return (
        <Badge variant="warning">
          <Loader2 size={10} style={{ marginRight: '2px', verticalAlign: 'middle' }} className="spin" />
          Indexing
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="error">
          <AlertTriangle size={10} style={{ marginRight: '2px', verticalAlign: 'middle' }} />
          Failed
        </Badge>
      );
    default:
      return <Badge variant="info">{status}</Badge>;
  }
}

// ── Shared table primitives (match DlqPage styling) ──────────────────────

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.62rem',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: 'var(--text-tertiary)',
  marginBottom: '4px',
};

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
