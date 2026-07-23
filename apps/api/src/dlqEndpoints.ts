/**
 * dlqEndpoints — Express router for Dead Letter Queue (DLQ) management.
 *
 * Endpoints:
 *   GET  /api/dlq/stats             — aggregate counts across all categories
 *   GET  /api/dlq/categories        — all DLQ categories with their entry counts
 *   GET  /api/dlq/entries           — list unrecovered entries (supports ?category= & ?limit=)
 *   POST /api/dlq/replay/:entryId   — mark an entry as recovered
 *
 * Implementation reads the on-disk `.commander_dlq/{category}.ndjson` files
 * directly (no DeadLetterQueue class instantiation) so the API layer stays
 * decoupled from the core runtime package.
 */
import { Router, type Request, type Response } from 'express';
import type { NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { toErrorMessage } from './routeHelpers';
import { hasRole } from './userStore';

const DLQ_DIR = path.join(process.cwd(), '.commander_dlq');

const DLQ_CATEGORIES = [
  'llm',
  'tool',
  'execution',
  'verification',
  'circuit_breaker',
  'compensation',
  'semantic_drift',
] as const;

const KNOWN_FAILURE_MODES = [
  'timeout',
  'rate_limit',
  'auth',
  'validation',
  'compilation',
  'execution',
  'provider_unavailable',
  'budget_exceeded',
  'verification',
  'compensation_exhausted',
  'cascade_escalation',
  'subagent_limit',
  'circuit_open',
  'semantic_degradation',
  'unknown',
] as const;

interface DlqEntry {
  id: string;
  category: string;
  runId: string;
  agentId: string;
  missionId?: string;
  timestamp: string;
  errorClass: string;
  errorMessage: string;
  retryable: boolean;
  attemptNumber: number;
  operationName: string;
  inputSnapshot?: string;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  compensated: boolean;
  recovered: boolean;
  tags: string[];
  tenantId?: string;
  ownerId?: string;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function canAccessEntry(req: Request, entry: DlqEntry): boolean {
  if (req.user && hasRole(req.user.role, 'super_admin')) return true;
  const principal = req.user?.id ?? req.apiKeyId;
  const tenant = req.user?.tenantId ?? req.tenantId;
  if (!principal || !tenant) return false;
  const entryTenant = entry.tenantId ?? process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local';
  return (
    entryTenant === tenant &&
    (req.user?.role === 'admin' ||
      !entry.ownerId ||
      entry.ownerId === principal ||
      entry.agentId === principal)
  );
}

function canReplayEntry(req: Request, entry: DlqEntry): boolean {
  if (req.user && hasRole(req.user.role, 'super_admin')) return true;
  const authorized =
    (req.user && hasRole(req.user.role, 'admin')) ||
    req.apiScopes?.some((scope) => scope === 'replay' || scope === 'admin' || scope === '*');
  if (!authorized) return false;
  const tenant = req.user?.tenantId ?? req.tenantId;
  const entryTenant = entry.tenantId ?? process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local';
  return !!tenant && entryTenant === tenant;
}

interface CategoryStat {
  category: string;
  count: number;
  unrecovered: number;
}

interface DlqStats {
  totalEntries: number;
  totalUnrecovered: number;
  totalRecovered: number;
  categories: CategoryStat[];
}

/**
 * Extract a human-readable failure mode from the entry's tags array.
 * Tags use the `mode:<value>` convention; we look for one matching a
 * known FailureMode, falling back to 'unknown'.
 */
function extractFailureMode(tags: string[] | undefined): string {
  if (!tags || !Array.isArray(tags)) return 'unknown';
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    if (!tag.startsWith('mode:')) continue;
    const value = tag.slice('mode:'.length);
    if ((KNOWN_FAILURE_MODES as readonly string[]).includes(value)) {
      return value;
    }
  }
  return 'unknown';
}

function ensureDlqDir(): void {
  try {
    fs.mkdirSync(DLQ_DIR, { recursive: true });
  } catch {
    // Directory creation is best-effort; readEntries handles missing files.
  }
}

function readCategoryEntries(category: string): DlqEntry[] {
  const filePath = path.join(DLQ_DIR, `${category}.ndjson`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return [];
    const entries: DlqEntry[] = [];
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as DlqEntry;
        if (parsed && typeof parsed.id === 'string') {
          entries.push(parsed);
        }
      } catch {
        // Skip corrupt lines silently — mirrors core DeadLetterQueue behavior.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function getAllCategoryEntries(): Array<{ category: string; entry: DlqEntry }> {
  ensureDlqDir();
  const result: Array<{ category: string; entry: DlqEntry }> = [];
  for (const category of DLQ_CATEGORIES) {
    const entries = readCategoryEntries(category);
    for (const entry of entries) {
      result.push({ category, entry });
    }
  }
  return result;
}

function buildStats(req?: Request): DlqStats {
  const all = getAllCategoryEntries();
  const categoryMap = new Map<string, CategoryStat>();
  for (const category of DLQ_CATEGORIES) {
    categoryMap.set(category, { category, count: 0, unrecovered: 0 });
  }

  let totalEntries = 0;
  let totalUnrecovered = 0;

  for (const { category, entry } of all) {
    if (req && !canAccessEntry(req, entry)) continue;
    const stat = categoryMap.get(category);
    if (!stat) continue;
    stat.count++;
    totalEntries++;
    if (!entry.recovered) {
      stat.unrecovered++;
      totalUnrecovered++;
    }
  }

  return {
    totalEntries,
    totalUnrecovered,
    totalRecovered: totalEntries - totalUnrecovered,
    categories: DLQ_CATEGORIES.map((c) => categoryMap.get(c)!),
  };
}

/**
 * Mark an authorized entry as recovered by rewriting its line on disk.
 */
function markEntryRecovered(
  category: string,
  entryId: string,
  canAccess: (entry: DlqEntry) => boolean,
): boolean {
  ensureDlqDir();
  const filePath = path.join(DLQ_DIR, `${category}.ndjson`);
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return false;
  const lines = raw.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as DlqEntry;
      if (parsed.id === entryId && canAccess(parsed)) {
        parsed.recovered = true;
        parsed.tags = [...(parsed.tags ?? []), 'replayed'];
        lines[i] = JSON.stringify(parsed);
        found = true;
        break;
      }
    } catch {
      // Skip corrupt lines.
    }
  }
  if (found) {
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  }
  return false;
}

export function createDlqRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // ── GET /api/dlq/stats — aggregate counts ───────────────────────────
  router.get('/api/dlq/stats', (req: Request, res: Response) => {
    try {
      const stats = buildStats(req);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── GET /api/dlq/categories — all categories with counts ───────────
  router.get('/api/dlq/categories', (req: Request, res: Response) => {
    try {
      const stats = buildStats(req);
      res.json(stats.categories.map((c) => ({ category: c.category, count: c.count })));
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── GET /api/dlq/entries — list unrecovered entries ────────────────
  router.get('/api/dlq/entries', (req: Request, res: Response) => {
    try {
      const categoryFilter = req.query.category as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);

      const categories = categoryFilter ? [categoryFilter] : [...DLQ_CATEGORIES];
      const entries: Array<DlqEntry & { failureMode: string }> = [];

      for (const category of categories) {
        if (!DLQ_CATEGORIES.includes(category as (typeof DLQ_CATEGORIES)[number])) {
          continue;
        }
        const catEntries = readCategoryEntries(category);
        for (const entry of catEntries) {
          if (!canAccessEntry(req, entry)) continue;
          if (entry.recovered) continue;
          entries.push({ ...entry, failureMode: extractFailureMode(entry.tags) });
          if (entries.length >= limit) break;
        }
        if (entries.length >= limit) break;
      }

      res.json(entries);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── POST /api/dlq/replay/:entryId — mark entry as recovered ────────
  router.post('/api/dlq/replay/:entryId', (req: Request, res: Response) => {
    try {
      const entryId = req.params.entryId as string;
      if (!entryId || entryId.length === 0) {
        return res.status(400).json({ error: 'entryId is required' });
      }
      const found = getAllCategoryEntries().find(
        ({ entry: candidate }) => candidate.id === entryId && canReplayEntry(req, candidate),
      );
      if (!found) {
        const visible = getAllCategoryEntries().some(
          ({ entry }) => entry.id === entryId && canAccessEntry(req, entry),
        );
        return res
          .status(visible ? 403 : 404)
          .json({ error: visible ? 'Replay authority required' : 'Entry not found', entryId });
      }
      const ok = markEntryRecovered(found.category, entryId, (entry) => canReplayEntry(req, entry));
      if (!ok) {
        return res.status(404).json({ error: 'Entry not found', entryId });
      }
      res.json({ status: 'ok', entryId, recovered: true });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
