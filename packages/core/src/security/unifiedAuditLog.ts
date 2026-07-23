/**
 * UnifiedAuditLog — Cross-source audit log aggregator.
 *
 * Commander has several scattered audit producers, each persisted in a
 * different location/format:
 *   - Security events    → .commander/security-audit.ndjson,
 *                          .commander/security/*.ndjson,
 *                          .commander_security/*.ndjson
 *   - Approval decisions → .commander/approvals/*.ndjson,
 *                          .commander/approval-audit.{json,ndjson}
 *   - Execution traces   → .commander_traces/*.ndjson (key execution events)
 *   - User actions       → .commander/audit/user-actions.ndjson (written here)
 *   - Configuration      → derived from security 'config_change' events and
 *                          approval sandbox-mode changes
 *
 * This class merges them into a single normalized `UnifiedAuditEntry` trail so
 * operators can answer "who did what, when, and why" from one place. It
 * provides unified query (filter + paginate), stats (timeline + top-N), and
 * export (JSON / CSV) capabilities.
 *
 * Design:
 *   - Lazy load with a short-TTL in-memory cache. Audit files are append-only
 *     and near-real-time freshness is not required for a viewer, so multiple
 *     parallel calls (logs + stats + categories) share one disk read.
 *   - Large-file safety: caps lines read per ndjson file and total entries
 *     materialized per source to bound memory and query latency.
 *   - `log()` writes append-only ndjson to .commander/audit/user-actions.ndjson
 *     and never throws — audit recording must not break request handling.
 *
 * This module is Node-only (uses fs/path/crypto). It deliberately avoids
 * importing other core modules so it can be consumed by the API layer without
 * pulling in heavy runtime dependencies.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getCurrentTenantId } from '../runtime/tenantContext';

// ─────────────────────────────────────────────────────────────────────────────
// GOV-15: GDPR Art.17 read-time masking.
//
// gdprCompliance records a durable, fsync'd tombstone (SHA-256 of the userId) in
// the erasure registry. This aggregator masks the PII of erased subjects at read
// time — entries are retained (Art.17(3)(e)) but rendered non-personal. We read
// the registry directly (fs + crypto only) rather than importing gdprCompliance,
// keeping this module dependency-light per its design contract.
// ─────────────────────────────────────────────────────────────────────────────
function erasureRegistryFilePath(): string {
  const dir = process.env.COMMANDER_AUDIT_DIR
    ? path.resolve(process.env.COMMANDER_AUDIT_DIR)
    : path.resolve(process.cwd(), path.join('.commander', 'audit'));
  return path.join(dir, 'gdpr-erasures.ndjson');
}

function loadErasedSubjectHashes(): Set<string> {
  const set = new Set<string>();
  try {
    const file = erasureRegistryFilePath();
    if (!fs.existsSync(file)) return set;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line) continue;
      try {
        const h = (JSON.parse(line) as { subjectHash?: string }).subjectHash;
        if (h) set.add(h);
      } catch {
        /* skip a torn record */
      }
    }
  } catch {
    /* best-effort: absence of the registry means nothing is erased */
  }
  return set;
}

function hashAuditSubjectId(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex');
}

/**
 * GOV-15: mask the PII of GDPR Art.17-erased subjects. The direct identifier and
 * free-text/details (which may embed PII) are redacted; event metadata
 * (category, type, severity, timestamps, run/agent/tool) is preserved so the
 * trail stays auditable. Returns the input unchanged when nothing is erased.
 */
function maskErasedSubjects(entries: UnifiedAuditEntry[]): UnifiedAuditEntry[] {
  const erased = loadErasedSubjectHashes();
  if (erased.size === 0) return entries;
  const cache = new Map<string, boolean>();
  const isErased = (userId?: string): boolean => {
    if (!userId) return false;
    let v = cache.get(userId);
    if (v === undefined) {
      v = erased.has(hashAuditSubjectId(userId));
      cache.set(userId, v);
    }
    return v;
  };
  return entries.map((e) => {
    const ctxUserId = (e.details?.context as { userId?: string } | undefined)?.userId;
    if (!isErased(e.userId) && !isErased(ctxUserId)) return e;
    return {
      ...e,
      userId: e.userId ? '[erased]' : e.userId,
      message: '[erased per GDPR Art.17]',
      details: { erased: true },
    };
  });
}

// ============================================================================
// Types
// ============================================================================

export type UnifiedAuditCategory =
  'security' | 'approval' | 'execution' | 'configuration' | 'user_action';

export type UnifiedAuditSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface UnifiedAuditEntry {
  /** Unique entry ID. */
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** High-level log category. */
  category: UnifiedAuditCategory;
  /** Specific event type, e.g. 'auth.login', 'tool.blocked', 'approval.granted'. */
  eventType: string;
  /** Severity level. */
  severity: UnifiedAuditSeverity;
  /** User who performed the action, if known. */
  userId?: string;
  /** Tenant scope, if multi-tenant. */
  tenantId?: string;
  /** Associated execution run ID, if any. */
  runId?: string;
  /** Associated agent ID, if any. */
  agentId?: string;
  /** Associated tool name, if any. */
  toolName?: string;
  /** Human-readable description. */
  message: string;
  /** Additional structured details. */
  details?: Record<string, unknown>;
  /** Originating file or module. */
  source: string;
}

export interface AuditQueryFilters {
  /** Tenant scope. When set, only entries explicitly belonging to this tenant match. */
  tenantId?: string;
  /** Inclusive time range (ISO strings). */
  timeRange?: { start?: string; end?: string };
  /** Category allow-list. */
  category?: UnifiedAuditCategory[];
  /** Event-type allow-list (exact match). */
  eventType?: string[];
  /** Severity allow-list. */
  severity?: UnifiedAuditSeverity[];
  /** Filter by user ID (substring, case-insensitive). */
  userId?: string;
  /** Filter by run ID (exact match). */
  runId?: string;
  /** Filter by agent ID (exact match). */
  agentId?: string;
  /** Filter by tool name (substring, case-insensitive). */
  toolName?: string;
  /** Page size (default 100, max 1000). */
  limit?: number;
  /** Page offset for pagination. */
  offset?: number;
}

export interface AuditTimelinePoint {
  /** ISO bucket label (hour granularity: YYYY-MM-DDTHH:00:00.000Z). */
  bucket: string;
  count: number;
}

export interface AuditStats {
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  /** Chronological timeline (hourly buckets). */
  timeline: AuditTimelinePoint[];
  topEventTypes: Array<{ eventType: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  timeRange: { earliest: string | null; latest: string | null };
}

export type AuditExportFormat = 'json' | 'csv';

export interface UnifiedAuditLogOptions {
  /** Base directory for resolving `.commander*` paths. Defaults to cwd. */
  baseDir?: string;
  /** Override the user-actions log file path. */
  userActionsFile?: string;
  /** Cap lines read per ndjson file. */
  maxLinesPerFile?: number;
  /** Cap total entries materialized per source. */
  maxEntriesPerSource?: number;
  /** In-memory cache TTL in ms. */
  cacheTtlMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Cap lines read per ndjson file to bound memory on very large logs. */
const DEFAULT_MAX_LINES_PER_FILE = 200_000;
/** Cap total entries materialized per source to bound query latency. */
const DEFAULT_MAX_ENTRIES_PER_SOURCE = 100_000;
/** Default cache TTL — shares one disk read across parallel UI calls. */
const DEFAULT_CACHE_TTL_MS = 5_000;
/** Default page size for queries. */
const DEFAULT_LIMIT = 100;
/** Maximum page size for queries. */
const MAX_LIMIT = 1000;

/** Sensitive body fields that must never be persisted by the audit middleware. */
export const SENSITIVE_BODY_KEYS = new Set<string>([
  'password',
  'passwd',
  'secret',
  'apikey',
  'api_key',
  'api-key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'session',
  'cookie',
]);

// ============================================================================
// Low-level file readers (missing/unreadable → empty, never throws)
// ============================================================================

async function readNdjsonFile(filePath: string, maxLines: number): Promise<unknown[]> {
  try {
    const raw = (await fsp.readFile(filePath, 'utf-8')).trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const out: unknown[] = [];
    const cap = Math.min(lines.length, maxLines);
    for (let i = 0; i < cap; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = (await fsp.readFile(filePath, 'utf-8')).trim();
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir);
    return entries.filter(predicate).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ============================================================================
// Severity mapping
// ============================================================================

/**
 * Map the SecurityAuditLogger's low/medium/high/critical scale onto the
 * unified info/warn/error/critical scale.
 */
function mapSecuritySeverity(sev: string | undefined): UnifiedAuditSeverity {
  switch (sev) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'error';
    case 'medium':
      return 'warn';
    case 'low':
    case 'info':
    default:
      return 'info';
  }
}

/** Approval severity derives from the decision outcome. */
function mapApprovalSeverity(decision: string | undefined): UnifiedAuditSeverity {
  switch (decision) {
    case 'denied':
    case 'rejected':
    case 'blocked':
      return 'warn';
    case 'approved':
    case 'granted':
    case 'allowed':
      return 'info';
    default:
      return 'info';
  }
}

/** Execution-trace severity derives from the event level/outcome. */
function mapExecutionSeverity(level: string | undefined, outcome?: unknown): UnifiedAuditSeverity {
  switch (level) {
    case 'critical':
    case 'fatal':
      return 'critical';
    case 'error':
      return 'error';
    case 'warn':
    case 'warning':
      return 'warn';
    default:
      break;
  }
  if (outcome === 'error' || outcome === 'failed' || outcome === 'failure') return 'error';
  return 'info';
}

// ============================================================================
// UnifiedAuditLog
// ============================================================================

export class UnifiedAuditLog {
  private readonly baseDir: string;
  private readonly userActionsFile: string;
  private readonly maxLinesPerFile: number;
  private readonly maxEntriesPerSource: number;
  private readonly cacheTtlMs: number;
  private cache: { ts: number; entries: UnifiedAuditEntry[] } | null = null;

  constructor(options?: UnifiedAuditLogOptions) {
    this.baseDir = options?.baseDir ?? process.cwd();
    this.userActionsFile =
      options?.userActionsFile ??
      path.join(this.baseDir, '.commander', 'audit', 'user-actions.ndjson');
    this.maxLinesPerFile = options?.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;
    this.maxEntriesPerSource = options?.maxEntriesPerSource ?? DEFAULT_MAX_ENTRIES_PER_SOURCE;
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  // ── Path accessors (also used by tests / middleware) ──────────────────

  get userActionsPath(): string {
    return this.userActionsFile;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Query the unified audit trail. Returns entries newest-first, filtered
   * and paginated according to `filters`.
   */
  async query(filters: AuditQueryFilters = {}): Promise<UnifiedAuditEntry[]> {
    const all = await this.loadAll();
    const filtered = this.applyFilters(all, filters);
    const limit = this.clampLimit(filters.limit);
    const offset = Math.max(0, filters.offset ?? 0);
    const page = filtered.slice(offset, offset + limit);
    // GOV-15: mask erased subjects' PII at read time (post-cache, so newly
    // recorded erasures take effect immediately).
    return maskErasedSubjects(page);
  }

  /**
   * Total number of entries matching `filters` (ignores pagination).
   */
  async count(filters: AuditQueryFilters = {}): Promise<number> {
    const all = await this.loadAll();
    return this.applyFilters(all, filters).length;
  }

  /**
   * Write a new user-action audit entry to user-actions.ndjson. Never throws.
   */
  async log(
    entry: Omit<UnifiedAuditEntry, 'id' | 'timestamp'> &
      Partial<Pick<UnifiedAuditEntry, 'timestamp'>>,
  ): Promise<UnifiedAuditEntry> {
    let tenantId = entry.tenantId;
    if (!tenantId) {
      // API middleware runs inside tenantContextMiddleware; preserve that
      // authenticated binding even when a producer omits the field.
      tenantId = getCurrentTenantId();
    }
    const full: UnifiedAuditEntry = {
      id: `ua_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      category: entry.category,
      eventType: entry.eventType,
      severity: entry.severity,
      userId: entry.userId,
      tenantId,
      runId: entry.runId,
      agentId: entry.agentId,
      toolName: entry.toolName,
      message: entry.message,
      details: entry.details,
      source: entry.source,
    };
    try {
      await this.ensureDir(path.dirname(this.userActionsFile));
      await fsp.appendFile(this.userActionsFile, JSON.stringify(full) + '\n', 'utf-8');
    } catch (err) {
      // Non-blocking: audit recording must never break request handling.
      process.stderr.write(
        `[UnifiedAuditLog] Persist failed: ${(err as Error)?.message ?? String(err)}\n`,
      );
    }
    // Invalidate cache so the new entry is visible on the next read.
    this.cache = null;
    // Record audit_events_total counter (lazy require to avoid pulling runtime
    // deps into this deliberately-lightweight security module).
    try {
      const { getMetricsCollector } = require('../runtime/metricsCollector');
      getMetricsCollector().recordAuditEvent(full.category, full.tenantId);
    } catch {
      /* metrics must never break audit recording */
    }
    return full;
  }

  /**
   * Aggregate statistics over entries within `timeRange` (optional).
   */
  async getStats(
    timeRange?: { start?: string; end?: string },
    tenantId?: string,
  ): Promise<AuditStats> {
    const all = await this.loadAll();
    // GOV-15: mask erased subjects before aggregation so topUsers cannot leak an
    // erased user's identifier.
    const entries = maskErasedSubjects(
      this.applyFilters(all, {
        timeRange,
        tenantId,
      }),
    );

    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    const byBucket: Record<string, number> = {};
    let earliest: string | null = null;
    let latest: string | null = null;

    for (const e of entries) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
      byEventType[e.eventType] = (byEventType[e.eventType] ?? 0) + 1;
      if (e.userId) byUser[e.userId] = (byUser[e.userId] ?? 0) + 1;

      const bucket = hourBucket(e.timestamp);
      if (bucket) byBucket[bucket] = (byBucket[bucket] ?? 0) + 1;

      if (earliest === null || e.timestamp < earliest) earliest = e.timestamp;
      if (latest === null || e.timestamp > latest) latest = e.timestamp;
    }

    const timeline: AuditTimelinePoint[] = Object.entries(byBucket)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([bucket, count]) => ({ bucket, count }));

    const topEventTypes = Object.entries(byEventType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([eventType, count]) => ({ eventType, count }));

    const topUsers = Object.entries(byUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, count]) => ({ userId, count }));

    return {
      total: entries.length,
      byCategory,
      bySeverity,
      timeline,
      topEventTypes,
      topUsers,
      timeRange: { earliest, latest },
    };
  }

  /**
   * Export the filtered audit trail as JSON or CSV. Returns a string.
   */
  async exportLogs(
    filters: AuditQueryFilters = {},
    format: AuditExportFormat = 'json',
  ): Promise<string> {
    const all = await this.loadAll();
    const filtered = maskErasedSubjects(this.applyFilters(all, filters));
    if (format === 'csv') {
      return toCsv(filtered);
    }
    return JSON.stringify(filtered, null, 2);
  }

  /**
   * Returns every distinct (category, eventType) pair currently present in
   * the corpus, plus the static catalog of known categories. Used to power
   * the frontend filter UI.
   */
  async getCatalog(tenantId?: string): Promise<{
    categories: { value: UnifiedAuditCategory; label: string }[];
    severities: { value: UnifiedAuditSeverity; label: string }[];
    eventTypes: { category: UnifiedAuditCategory; eventType: string }[];
  }> {
    const all = await this.loadAll();
    const scoped = tenantId ? this.applyFilters(all, { tenantId }) : all;
    const seen = new Set<string>();
    const eventTypes: { category: UnifiedAuditCategory; eventType: string }[] = [];
    for (const e of scoped) {
      const key = `${e.category}::${e.eventType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      eventTypes.push({ category: e.category, eventType: e.eventType });
    }
    eventTypes.sort((a, b) =>
      a.category < b.category
        ? -1
        : a.category > b.category
          ? 1
          : a.eventType < b.eventType
            ? -1
            : 1,
    );
    return { categories: CATEGORY_CATALOG, severities: SEVERITY_CATALOG, eventTypes };
  }

  /** Clear the in-memory cache (next read re-reads disk). */
  invalidateCache(): void {
    this.cache = null;
  }

  // ── Filtering ─────────────────────────────────────────────────────────

  private applyFilters(entries: UnifiedAuditEntry[], f: AuditQueryFilters): UnifiedAuditEntry[] {
    let out = entries;
    if (f.tenantId) {
      // Tenant-scoped callers must never receive unscoped or another tenant's entries.
      out = out.filter((e) => e.tenantId === f.tenantId);
    }
    if (f.timeRange?.start) {
      out = out.filter((e) => e.timestamp >= f.timeRange!.start!);
    }
    if (f.timeRange?.end) {
      out = out.filter((e) => e.timestamp <= f.timeRange!.end!);
    }
    if (f.category && f.category.length > 0) {
      const set = new Set(f.category);
      out = out.filter((e) => set.has(e.category));
    }
    if (f.severity && f.severity.length > 0) {
      const set = new Set(f.severity);
      out = out.filter((e) => set.has(e.severity));
    }
    if (f.eventType && f.eventType.length > 0) {
      const set = new Set(f.eventType);
      out = out.filter((e) => set.has(e.eventType));
    }
    if (f.userId) {
      const needle = f.userId.toLowerCase();
      out = out.filter((e) => (e.userId ?? '').toLowerCase().includes(needle));
    }
    if (f.runId) {
      out = out.filter((e) => e.runId === f.runId);
    }
    if (f.agentId) {
      out = out.filter((e) => e.agentId === f.agentId);
    }
    if (f.toolName) {
      const needle = f.toolName.toLowerCase();
      out = out.filter((e) => (e.toolName ?? '').toLowerCase().includes(needle));
    }
    // Sort newest-first. ISO string comparison is valid for UTC timestamps.
    out = out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    return out;
  }

  private clampLimit(limit: number | undefined): number {
    if (limit === undefined || limit <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.floor(limit), MAX_LIMIT);
  }

  // ── Source aggregation ────────────────────────────────────────────────

  private async loadAll(): Promise<UnifiedAuditEntry[]> {
    if (this.cache && Date.now() - this.cache.ts < this.cacheTtlMs) {
      return this.cache.entries;
    }
    const [sec, apr, exec, usr] = await Promise.all([
      this.readSecurityLogs(),
      this.readApprovalLogs(),
      this.readExecutionLogs(),
      this.readUserActionLogs(),
    ]);
    const entries = [...sec, ...apr, ...exec, ...usr];
    this.cache = { ts: Date.now(), entries };
    return entries;
  }

  // ── Security source ──────────────────────────────────────────────────

  private async readSecurityLogs(): Promise<UnifiedAuditEntry[]> {
    const commanderDir = path.join(this.baseDir, '.commander');
    const securityLegacyDir = path.join(this.baseDir, '.commander_security');
    const candidateDirs = [path.join(commanderDir, 'security'), securityLegacyDir];
    const files = new Set<string>();
    for (const dir of candidateDirs) {
      const matches = await listFiles(dir, (n) => n.endsWith('.ndjson') || n.endsWith('.jsonl'));
      for (const f of matches) files.add(f);
    }
    const legacy = path.join(commanderDir, 'security-audit.ndjson');
    if (fs.existsSync(legacy)) files.add(legacy);
    const legacyJsonl = path.join(commanderDir, 'security-audit.jsonl');
    if (fs.existsSync(legacyJsonl)) files.add(legacyJsonl);

    if (files.size === 0) return [];

    const fileArr = Array.from(files);
    const batches = await Promise.all(fileArr.map((f) => readNdjsonFile(f, this.maxLinesPerFile)));
    const entries: UnifiedAuditEntry[] = [];
    const seenIds = new Set<string>();
    for (const batch of batches) {
      for (const raw of batch) {
        const e = raw as RawSecurityEvent;
        const ts = e.timestamp;
        if (!ts) continue;
        const id = e.id ?? `sec_${ts}_${entries.length}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const isConfig = e.type === 'config_change';
        entries.push({
          id,
          timestamp: ts,
          category: isConfig ? 'configuration' : 'security',
          eventType: e.type ?? e.event ?? 'security_event',
          severity: mapSecuritySeverity(e.severity),
          userId: e.context?.userId,
          tenantId: e.context?.tenantId,
          runId: e.context?.runId,
          agentId: e.context?.agentId,
          message: e.message ?? e.type ?? 'Security event',
          details: {
            ...e.details,
            ...(e.context ? { context: e.context } : {}),
            ...(e.source ? { emitter: e.source } : {}),
          },
          source: e.source ?? 'securityAuditLogger',
        });
        if (entries.length >= this.maxEntriesPerSource) return entries;
      }
    }
    return entries;
  }

  // ── Approval source ──────────────────────────────────────────────────

  private async readApprovalLogs(): Promise<UnifiedAuditEntry[]> {
    const commanderDir = path.join(this.baseDir, '.commander');
    const entries: UnifiedAuditEntry[] = [];
    const seenIds = new Set<string>();

    // Directory of approval ndjson files.
    const approvalsDir = path.join(commanderDir, 'approvals');
    const ndFiles = await listFiles(
      approvalsDir,
      (n) => n.endsWith('.ndjson') || n.endsWith('.jsonl'),
    );
    for (const f of ndFiles) {
      const rows = await readNdjsonFile(f, this.maxLinesPerFile);
      for (let i = 0; i < rows.length; i++) {
        const e = rows[i] as RawApprovalEntry;
        if (!e.timestamp) continue;
        const id = e.id ?? `apr_${e.timestamp}_${i}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const isConfig =
          (e.event ?? e.eventType ?? '').includes('mode') || (e.event ?? '').includes('config');
        entries.push(this.toApprovalEntry(e, id, isConfig));
        if (entries.length >= this.maxEntriesPerSource) return entries;
      }
    }

    // Legacy single-file forms.
    const jsonFile = path.join(commanderDir, 'approval-audit.json');
    const arr = await readJsonFile<unknown[]>(jsonFile);
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i] as RawApprovalEntry;
        if (!e.timestamp) continue;
        const id = e.id ?? `apr_${e.timestamp}_${i}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const isConfig = (e.event ?? e.eventType ?? '').includes('mode');
        entries.push(this.toApprovalEntry(e, id, isConfig));
        if (entries.length >= this.maxEntriesPerSource) return entries;
      }
    }
    const ndjsonFile = path.join(commanderDir, 'approval-audit.ndjson');
    const ndEntries = await readNdjsonFile(ndjsonFile, this.maxLinesPerFile);
    for (let i = 0; i < ndEntries.length; i++) {
      const e = ndEntries[i] as RawApprovalEntry;
      if (!e.timestamp) continue;
      const id = e.id ?? `apr_${e.timestamp}_${i}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const isConfig = (e.event ?? e.eventType ?? '').includes('mode');
      entries.push(this.toApprovalEntry(e, id, isConfig));
      if (entries.length >= this.maxEntriesPerSource) return entries;
    }
    return entries;
  }

  private toApprovalEntry(e: RawApprovalEntry, id: string, isConfig: boolean): UnifiedAuditEntry {
    const ts = e.timestamp ?? new Date().toISOString();
    return {
      id,
      timestamp: ts,
      category: isConfig ? 'configuration' : 'approval',
      eventType: e.eventType ?? e.event ?? 'approval_decision',
      severity: mapApprovalSeverity(e.decision),
      userId: e.userId ?? e.user,
      tenantId: e.tenantId ?? e.context?.tenantId,
      message:
        e.message ??
        e.reason ??
        `Approval ${e.decision ?? 'decision'}${e.toolName ? ` for ${e.toolName}` : ''}`,
      toolName: e.toolName,
      details: {
        decision: e.decision,
        toolName: e.toolName,
        reason: e.reason,
        riskLevel: e.riskLevel,
      },
      source: 'approvalConfigEndpoints',
    };
  }

  // ── Execution-trace source ───────────────────────────────────────────

  private async readExecutionLogs(): Promise<UnifiedAuditEntry[]> {
    const tracesDir = path.join(this.baseDir, '.commander_traces');
    const files = await listFiles(tracesDir, (n) => n.endsWith('.ndjson') || n.endsWith('.jsonl'));
    const entries: UnifiedAuditEntry[] = [];
    const seenIds = new Set<string>();
    for (const f of files) {
      const rows = await readNdjsonFile(f, this.maxLinesPerFile);
      for (let i = 0; i < rows.length; i++) {
        const e = rows[i] as RawTraceEvent;
        // Only surface key execution events to keep the trail meaningful.
        if (!isKeyTraceEvent(e)) continue;
        const ts = e.timestamp ?? e.ts;
        if (!ts) continue;
        const id = e.id ?? `exec_${ts}_${i}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const runId = e.runId ?? e.run_id ?? e.sessionId;
        entries.push({
          id,
          timestamp: ts,
          category: 'execution',
          eventType: e.type ?? e.event ?? 'execution_event',
          severity: mapExecutionSeverity(e.level ?? e.severity, e.outcome ?? e.status),
          runId: runId,
          tenantId: e.tenantId ?? e.context?.tenantId,
          agentId: e.agentId ?? e.agent_id,
          toolName: e.toolName ?? e.tool_name ?? e.tool,
          message: e.message ?? e.name ?? `${e.type ?? 'execution event'}`,
          details: {
            ...(e.step !== undefined ? { step: e.step } : {}),
            ...(e.outcome ? { outcome: e.outcome } : {}),
            ...(e.status ? { status: e.status } : {}),
            ...(e.error ? { error: e.error } : {}),
            ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
          },
          source: f,
        });
        if (entries.length >= this.maxEntriesPerSource) return entries;
      }
    }
    return entries;
  }

  // ── User-action source (written by log()) ────────────────────────────

  private async readUserActionLogs(): Promise<UnifiedAuditEntry[]> {
    const rows = await readNdjsonFile(this.userActionsFile, this.maxLinesPerFile);
    const entries: UnifiedAuditEntry[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i] as Partial<UnifiedAuditEntry>;
      if (!e.timestamp || !e.category || !e.eventType) continue;
      const id = e.id ?? `ua_${e.timestamp}_${i}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      entries.push({
        id,
        timestamp: e.timestamp,
        category: e.category,
        eventType: e.eventType,
        severity: e.severity ?? 'info',
        userId: e.userId,
        tenantId: e.tenantId,
        runId: e.runId,
        agentId: e.agentId,
        toolName: e.toolName,
        message: e.message ?? `${e.eventType}`,
        details: e.details,
        source: e.source ?? 'api',
      });
      if (entries.length >= this.maxEntriesPerSource) return entries;
    }
    return entries;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      /* ignore — appendFile will surface a real error */
    }
  }
}

// ============================================================================
// Raw source shapes (loosely-typed parsers — tolerant of producer drift)
// ============================================================================

interface RawSecurityEvent {
  id?: string;
  timestamp?: string;
  type?: string;
  event?: string;
  severity?: string;
  source?: string;
  message?: string;
  details?: Record<string, unknown>;
  context?: { userId?: string; agentId?: string; runId?: string; tenantId?: string };
}

interface RawApprovalEntry {
  id?: string;
  timestamp?: string;
  event?: string;
  eventType?: string;
  decision?: string;
  userId?: string;
  user?: string;
  toolName?: string;
  reason?: string;
  message?: string;
  riskLevel?: string;
  tenantId?: string;
  context?: { tenantId?: string };
}

interface RawTraceEvent {
  id?: string;
  timestamp?: string;
  ts?: string;
  type?: string;
  event?: string;
  level?: string;
  severity?: string;
  name?: string;
  message?: string;
  runId?: string;
  run_id?: string;
  sessionId?: string;
  agentId?: string;
  agent_id?: string;
  toolName?: string;
  tool_name?: string;
  tool?: string;
  step?: number;
  outcome?: string;
  status?: string;
  error?: string;
  durationMs?: number;
  tenantId?: string;
  context?: { tenantId?: string };
}

// ============================================================================
// Helpers
// ============================================================================

/** Truncate an ISO timestamp to the hour bucket (YYYY-MM-DDTHH:00:00.000Z). */
function hourBucket(ts: string): string | null {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/** Whether a trace event is significant enough to surface in the audit trail. */
function isKeyTraceEvent(e: RawTraceEvent): boolean {
  const type = (e.type ?? e.event ?? '').toLowerCase();
  const name = (e.name ?? '').toLowerCase();
  const outcome = (e.outcome ?? e.status ?? '').toLowerCase();
  // Surface: errors/failures, tool calls, run start/end, step boundaries.
  return (
    e.level === 'error' ||
    e.level === 'warn' ||
    e.level === 'critical' ||
    outcome === 'error' ||
    outcome === 'failed' ||
    outcome === 'failure' ||
    outcome === 'success' ||
    type.includes('tool') ||
    type.includes('run') ||
    type.includes('step') ||
    type.includes('error') ||
    type.includes('complete') ||
    type.includes('finish') ||
    type.includes('start') ||
    type.includes('end') ||
    name.includes('tool') ||
    name.includes('run') ||
    name.includes('error')
  );
}

/** CSV column order for exportLogs('csv'). */
const CSV_COLUMNS: Array<keyof UnifiedAuditEntry> = [
  'id',
  'timestamp',
  'category',
  'eventType',
  'severity',
  'userId',
  'tenantId',
  'runId',
  'agentId',
  'toolName',
  'message',
  'source',
];

function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(entries: UnifiedAuditEntry[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = entries.map((e) =>
    CSV_COLUMNS.map((col) => csvEscape(e[col as keyof UnifiedAuditEntry])).join(','),
  );
  return [header, ...rows].join('\n');
}

// ============================================================================
// Static catalogs (for frontend filter UI)
// ============================================================================

const CATEGORY_CATALOG: { value: UnifiedAuditCategory; label: string }[] = [
  { value: 'security', label: 'Security' },
  { value: 'approval', label: 'Approval' },
  { value: 'execution', label: 'Execution' },
  { value: 'configuration', label: 'Configuration' },
  { value: 'user_action', label: 'User Action' },
];

const SEVERITY_CATALOG: { value: UnifiedAuditSeverity; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'critical', label: 'Critical' },
];

// ============================================================================
// Singleton
// ============================================================================

let _singleton: UnifiedAuditLog | null = null;

/** Process-wide singleton (one audit trail per API process). */
export function getUnifiedAuditLog(): UnifiedAuditLog {
  if (_singleton === null) {
    _singleton = new UnifiedAuditLog();
  }
  return _singleton;
}

/** Reset the singleton — intended for tests. */
export function resetUnifiedAuditLog(): void {
  _singleton = null;
}
