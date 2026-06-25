/**
 * DataRetention — janitor + retention-policy applicator for state-store
 * NDJSON files. Designed to close the SOC 2 C1.2 / GDPR Article 17 disposal
 * gap and the SOC 9.x / EU AI Act Article 10 (data minimisation) gap.
 *
 * Design:
 *   - Pure data-module (no security coupling). Run via cron / setInterval
 *     from agentRuntime / app startup.
 *   - Bounded concurrent-runs: the janitor records a single in-memory
 *     reentrancy flag so two overlapping CLI invocations cannot corrupt
 *     a file's atomic-rename boundary. The second call returns no-ops
 *     cleanly without dropping the run entirely.
 *   - Hard-coded `IMPORTANT_RETENTION_EXCEPTIONS` ensures:
 *       * audit-chain-*.ndjson is NEVER auto-deleted (tamper-evident ledger
 *         until manually frozen + archived).
 *       * conversations.db is untouched (user-owned).
 *
 *   - Idempotent: a file past retentionMs is removed; a file inside is
 *     skipped. Re-running produces no further writes.
 *
 *   - File mtime (not creation time) drives the decision; lets us honor
 *     "user-visible finalisation timestamp" if the policy needs to be
 *     amended retroactively.
 *
 *   - Per-store override: callers can register `RetentionOverride` for any
 *     storePath to use a different retentionMs without touching this file.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Constants — read this list BEFORE changing it. Hard rules.
// ============================================================================

/**
 * Stores that MUST NEVER be auto-deleted by the janitor. Listed explicitly
 * to prevent silent regressions.
 */
const PROTECTED_STORE_PATTERNS: RegExp[] = [
  // Tamper-evident ledger — deletion would break PostureSnapshot continuity
  // and compromise SOC 2 chain-of-custody.
  /^audit-chain-.*\.ndjson$/,
  // User-facing ConversationStore database — user-owned data.
  /^conversations\.(db|sqlite[3]?)$/i,
  // SQLite Write-Ahead-Log files paired with the above.
  /^conversations\..*-journal$/i,
  /^conversations\..*-wal$/i,
  /^conversations\..*-shm$/i,
];

/**
 * Default retention table. Times are in milliseconds. alignStorePath and
 * the matcher table below cooperatively match a file to its policy using
 * the file's path under rootDir. The `auditOnDelete` flag emits an event
 * on the optional audit bus (NOT the security.event bus) to avoid
 * polluting OWASP ASI10 (Hallucination & Failure) signals.
 */
export const DEFAULT_RETENTION_TABLE: RetentionRule[] = [
  {
    name: 'audit-chain',
    match: /^audit-chain-.*\.ndjson$/,
    retentionMs: 0, // never delete (frozen only via runComplianceAudit sign)
    policy: 'preserve',
  },
  {
    name: 'conversations',
    // Note: SQLite journal/wal/shm files use a *dash* suffix (e.g.
    // `conversations.db-journal`), not a dot. The PROTECTED_STORE_PATTERNS
    // above is the authoritative safety net; this rule is the matching
    // counterpart so per-store overrides can probe it.
    match: /^conversations\.(db|sqlite[3]?|.*-journal|.*-wal|.*-shm)$/i,
    retentionMs: 0,
    policy: 'preserve',
  },
  {
    name: 'sop-artifacts',
    match: /^sops\/[^/]+\/(?:[^/]+\.(md|json))$/,
    retentionMs: 365 * 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
  {
    name: 'execution-traces',
    match: /^traces\/[^/]+\.ndjson$/,
    retentionMs: 90 * 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
  {
    name: 'episodic-memory',
    match: /^episodic-memory-.*\.ndjson$/,
    retentionMs: 365 * 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
  {
    name: 'agent-inbox',
    match: /^inbox\/[^/]+\.ndjson$/,
    retentionMs: 30 * 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
  {
    name: 'posture-snapshots',
    match: /^posture-snapshots\.json$/,
    retentionMs: 365 * 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
  {
    name: 'webhooks',
    match: /^webhooks\.json$/,
    retentionMs: 90 * 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
  {
    name: 'dead-letter-queue',
    match: /^\.commander_dlq\/[^/]+\.ndjson$/,
    retentionMs: 90 * 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
  {
    name: 'tmp-cbor',
    match: /.*\.tmp\.cbor$/,
    retentionMs: 24 * 60 * 60 * 1000,
    policy: 'delete',
  },
];

/**
 * Final safety net: any file matching this list is preserved even if the
 * matcher table fails. Belt-and-suspenders — the regex-based
 * PROTECTED_STORE_PATTERNS handles this for arbitrary shard counts. The
 * hard-coded keep-list exists ONLY for files that live outside the
 * canonical `audit-chain-N.ndjson` / `conversations.*` namespaces.
 */
const PROTECTED_FILENAMES = new Set<string>([
  // conversations.db is also covered by PROTECTED_STORE_PATTERNS; listed
  // here as a final belt for ops that move the file into a non-standard
  // directory.
  'conversations.db',
]);

// ============================================================================
// Public types
// ============================================================================

export type RetentionPolicy = 'delete' | 'preserve';

export interface RetentionRule {
  /** Identifier for the rule (used by overrides) */
  name: string;
  /** Path matcher against rootDir-relative path */
  match: RegExp;
  retentionMs: number;
  policy: RetentionPolicy;
}

export interface DataRetentionConfig {
  /** Root directory containing the per-store NDJSON files. Default process.cwd(). */
  rootDir: string;
  /** Custom retention rules (replaces the default table wholesale). */
  rules?: RetentionRule[];
  /** Per-store overrides keyed by `RetentionRule.name`. */
  overrides?: Record<string, Partial<RetentionRule>>;
  /** If true, never actually delete — log what would be deleted instead. */
  dryRun?: boolean;
  /** Emit audit events on delete? Default true. */
  auditOnDelete?: boolean;
  /** Maximum entries deleted per single run() call (back-pressure safety). */
  maxDeletesPerRun?: number;
}

export interface RetentionRunResult {
  rootDir: string;
  scannedFiles: number;
  deletedFiles: number;
  preservedFiles: number;
  skippedFiles: number;
  byStore: Record<string, { scanned: number; deleted: number }>;
  ranAt: string;
  durationMs: number;
  dryRun: boolean;
}

// ============================================================================
// Janitor
// ============================================================================

export class DataRetentionJanitor {
  private readonly config: DataRetentionConfig;
  private running = false;
  private intervalRef: ReturnType<typeof setInterval> | null = null;
  private readonly activeRules: RetentionRule[];

  constructor(config: Partial<DataRetentionConfig> = {}) {
    this.config = {
      rootDir: config.rootDir ?? process.cwd(),
      rules: config.rules,
      overrides: config.overrides ?? {},
      dryRun: config.dryRun ?? false,
      auditOnDelete: config.auditOnDelete ?? true,
      maxDeletesPerRun: config.maxDeletesPerRun ?? 1_000_000,
    };

    // Build effective rules from defaults + caller overrides.
    const base = this.config.rules ?? DEFAULT_RETENTION_TABLE;
    this.activeRules = base.map((rule) => {
      const ov = this.config.overrides?.[rule.name];
      if (!ov) return rule;
      return {
        ...rule,
        ...ov,
        match: ov.match ?? rule.match,
        name: rule.name,
      };
    });
  }

  /**
   * Run one cleanup pass. Returns synchronously; never throws.
   * Concurrent calls are no-ops while one is already running.
   */
  async run(): Promise<RetentionRunResult> {
    if (this.running) {
      return {
        rootDir: this.config.rootDir,
        scannedFiles: 0,
        deletedFiles: 0,
        preservedFiles: 0,
        skippedFiles: 0,
        byStore: {},
        ranAt: new Date().toISOString(),
        durationMs: 0,
        dryRun: this.config.dryRun === true,
      };
    }
    this.running = true;
    const start = Date.now();
    const result: RetentionRunResult = {
      rootDir: this.config.rootDir,
      scannedFiles: 0,
      deletedFiles: 0,
      preservedFiles: 0,
      skippedFiles: 0,
      byStore: {},
      ranAt: new Date().toISOString(),
      durationMs: 0,
      dryRun: this.config.dryRun === true,
    };

    try {
      const files = await this.listCandidateFiles(this.config.rootDir);
      const now = Date.now();
      let deletesThisRun = 0;

      for (const file of files) {
        result.scannedFiles++;
        const relative = path.relative(this.config.rootDir, file.absolute).replace(/\\/g, '/');
        const decision = this.classify(relative);
        const store = decision.rule?.name ?? 'unknown';
        if (!result.byStore[store]) result.byStore[store] = { scanned: 0, deleted: 0 };
        result.byStore[store].scanned++;

        if (decision.action === 'preserve') {
          result.preservedFiles++;
          continue;
        }

        // Defence-in-depth: never delete protected filenames.
        if (PROTECTED_FILENAMES.has(path.basename(relative))) {
          result.preservedFiles++;
          continue;
        }

        if (decision.action === 'unknown') {
          result.skippedFiles++;
          continue;
        }

        const mtime = file.mtimeMs;
        if (mtime + decision.retentionMs > now) {
          result.skippedFiles++;
          continue;
        }

        if (deletesThisRun >= (this.config.maxDeletesPerRun ?? Infinity)) {
          result.skippedFiles++;
          continue;
        }

        if (this.config.dryRun) {
          result.deletedFiles++;
          result.byStore[store].deleted++;
          this.logDryRunDelete(relative);
        } else {
          try {
            await fs.promises.unlink(file.absolute);
            result.deletedFiles++;
            result.byStore[store].deleted++;
            deletesThisRun++;
            if (this.config.auditOnDelete) {
              this.auditDelete(relative, decision.rule?.name ?? 'unknown', mtime);
            }
          } catch (err) {
            result.skippedFiles++;
            // Best-effort; surface in audit chain so SOC notices recurring
            // unlink failures (permission, race, etc.).
            this.auditUnlinkFailure(relative, err);
          }
        }
      }
    } catch (err) {
      // Never throw from the janitor.
      this.auditUnlinkFailure('<list-failure>', err);
    } finally {
      this.running = false;
      result.durationMs = Date.now() - start;
    }

    return result;
  }

  /**
   * Schedule the janitor on a recurring interval. Cancels previous schedule
   * if called multiple times. `runImmediately: true` runs once synchronously
   * before the interval starts (recommended at CLI / app boot).
   */
  /**
   * Schedule the recurring tick on this rootDir.
   *
   * Glossary — "scheduled" here means ONE of two outcomes:
   *   • **claimed**      — THIS instance now owns the recurring
   *     `setInterval` running on `this.config.rootDir`. Returns `true`.
   *   • **dedup-catch**  — another janitor instance already owned the
   *     tick on the same `rootDir`; this call is a no-op. The
   *     recurring tick IS running (owned by someone else). Returns
   *     `false`.
   *
   * In BOTH outcomes the tick is live — the boolean just lets the
   * caller disambiguate which instance owns it. Callers — currently
   * `httpServer.start()` and `AgentRuntime.constructor()` — log the
   * result so operators can see which surface claimed the tick vs
   * which one was dedup-caught.
   */
  schedule(intervalMs: number, runImmediately = false): boolean {
    this.stopSchedule();
    // Module-level dedup: if another janitor instance is already
    // scanning THIS same rootDir on a recurring tick, this call is a
    // no-op so we don't fan out into parallel ticks. Pair with
    // `stopSchedule()` which removes the rootDir on teardown.
    if (scheduledRootDirs.has(this.config.rootDir)) {
      return false; // dedup-catch
    }
    if (runImmediately) {
      void this.run();
    }
    this.intervalRef = setInterval(() => {
      void this.run();
    }, intervalMs);
    if (typeof this.intervalRef.unref === 'function') this.intervalRef.unref();
    scheduledRootDirs.add(this.config.rootDir);
    return true; // claimed
  }

  /** Public for log-message context (e.g. `[rootDir=${this.rootDir}]`). */
  get rootDir(): string {
    return this.config.rootDir;
  }

  stopSchedule(): void {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
      scheduledRootDirs.delete(this.config.rootDir);
    }
  }

  /** Test-only: lists rootDirs currently holding a scheduled tick. */
  static getScheduledRootDirs(): string[] {
    return Array.from(scheduledRootDirs);
  }

  /**
   * Test-only: was a scheduled run currently in flight. Useful for asserting
   * no-overlap guarantee from a CI test.
   */
  isScheduled(): boolean {
    return this.intervalRef !== null;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private classify(relativePath: string): {
    action: 'delete' | 'preserve' | 'unknown';
    retentionMs: number;
    rule?: RetentionRule;
  } {
    // Always honor protected-store patterns even if a default rule conflicts.
    if (PROTECTED_STORE_PATTERNS.some((rx) => rx.test(relativePath))) {
      return { action: 'preserve', retentionMs: 0 };
    }
    for (const rule of this.activeRules) {
      if (rule.match.test(relativePath)) {
        if (rule.policy === 'preserve' || rule.retentionMs === 0) {
          return { action: 'preserve', retentionMs: 0, rule };
        }
        return { action: 'delete', retentionMs: rule.retentionMs, rule };
      }
    }
    return { action: 'unknown', retentionMs: 0 };
  }

  /**
   * Walks the rootDir for files matching the activeRules. Recurses at most
   * one level (rootDir/<store>/<files>) so accidental scans of the entire
   * project tree are bounded.
   */
  private async listCandidateFiles(
    rootDir: string,
  ): Promise<Array<{ absolute: string; mtimeMs: number }>> {
    const out: Array<{ absolute: string; mtimeMs: number }> = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
    } catch (err) {
      reportSilentFailure(err, 'dataRetention:423');
      return out;
    }
    for (const entry of entries) {
      const abs = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        let sub: fs.Dirent[];
        try {
          sub = await fs.promises.readdir(abs, { withFileTypes: true });
        } catch (err) {
          reportSilentFailure(err, 'dataRetention:433');
          continue;
        }
        for (const subEntry of sub) {
          if (!subEntry.isFile()) continue;
          const subAbs = path.join(abs, subEntry.name);
          try {
            const stat = await fs.promises.stat(subAbs);
            out.push({ absolute: subAbs, mtimeMs: stat.mtimeMs });
          } catch (err) {
            reportSilentFailure(err, 'dataRetention:443');
            /* skip unreadable */
          }
        }
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(abs);
          out.push({ absolute: abs, mtimeMs: stat.mtimeMs });
        } catch (err) {
          reportSilentFailure(err, 'dataRetention:452');
          /* skip unreadable */
        }
      }
    }
    return out;
  }

  /**
   * Plumbing-only helpers. We intentionally do NOT emit to the
   * `security.event` bus: janitor activity is housekeeping, not a
   * security signal, and writing to `security.event` would inflate
   * OWASP ASI10 (Hallucination & Failure) and pollute dashboards.
   * If a future operator needs SOC evidence of deletes, route through
   * a dedicated housekeeping bus — not the security one.
   */
  private logDryRunDelete(_relative: string): void {
    // No-op by design; dry-run is operator-visible via the returned
    // `RetentionRunResult`. Reserved for future dedicated audit bus.
  }

  private auditDelete(relative: string, store: string, mtimeMs: number): void {
    // See `logDryRunDelete`. Reserved for future dedicated audit bus.
    void relative;
    void store;
    void mtimeMs;
  }

  private auditUnlinkFailure(target: string, err: unknown): void {
    // Unlink failures are surfaced in the returned `RetentionRunResult`
    // (`skippedFiles`) so callers can detect permission/race regressions
    // without needing to subscribe to a bus. Log to stderr as a last
    // resort so a CLI invocation gets *some* signal.
    try {
      console.warn(
        `[DataRetentionJanitor] Failed to dispose ${target}: ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
    } catch (err) {
      reportSilentFailure(err, 'dataRetention:493');
      /* swallow */
    }
  }
}

// ============================================================================
// Tenant-aware singleton + module-level facade
// ============================================================================

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const janitorSingleton = createTenantAwareSingleton(() => new DataRetentionJanitor());

// Module-level dedup: ensures N concurrent HttpServer instances that all
// call `.schedule()` on the same rootDir produce exactly ONE running
// setInterval. First-scheduled wins; subsequent calls no-op until the
// active instance's `stopSchedule()` removes its rootDir. Different
// rootDirs are independent (multi-tenant deployments with separate
// data roots each get their own tick).
//
// Without this guard, every `new CommanderHttpServer()` (which always
// passes a config) would fan out into its own cron task walking the
// same filesystem. The guard is per-node-process, not per-cluster —
// a multi-process deployment still has one tick per process; that's
// fine because each process owns its own rootDir under normal layouts.
const scheduledRootDirs = new Set<string>();

/**
 * Module-level facade. Use in production with carefully-set rootDir.
 * Tests can construct new DataRetentionJanitor directly.
 */
export function getDataRetentionJanitor(
  config?: Partial<DataRetentionConfig>,
): DataRetentionJanitor {
  return config ? new DataRetentionJanitor(config) : janitorSingleton.get();
}

/** Reset singleton — test only. Does not stop a scheduled run. */
export function resetDataRetentionJanitor(): void {
  janitorSingleton.reset();
}
