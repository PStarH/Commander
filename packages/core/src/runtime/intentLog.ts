/**
 * IntentLog — Persistent record of agent decision rationale.
 *
 * The IntentLog captures the "why" behind each run: which deliberation plan
 * was selected, which topology alternatives were scored, which model was
 * chosen and why, and which cascade escalations were applied. This is the
 * missing layer between the in-memory DeliberationPlan (which is computed
 * and then discarded) and the audit trail.
 *
 * Storage: append-only NDJSON per run, plus a per-tenant directory layout
 * mirroring TraceStore/SamplesStore. Use `readIntent(runId)` to load the
 * intent for post-hoc debugging.
 *
 * Schema version 1 — add fields without bumping by accepting undefined.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';

export interface IntentScoreboardEntry {
  topology: string;
  score: number;
  reasoning?: string;
}

export interface IntentEscalation {
  from: string;
  to: string;
  reason: string;
  timestamp: string;
}

/**
 * Persisted intent record. Most fields are optional so callers can emit
 * partial records (e.g. a cascade escalation record that only knows
 * `routingReasoning`) without a full DeliberationPlan. Schema version is
 * bumped if the layout changes incompatibly.
 */
export interface IntentRecord {
  schemaVersion: 1;
  runId: string;
  agentId?: string;
  tenantId?: string;
  missionId?: string;
  parentRunId?: string;
  goal?: string;
  taskType?: string;
  effortLevel?: string;
  estimatedAgentCount?: number;
  estimatedSteps?: number;
  estimatedTokens?: number;
  estimatedDurationMs?: number;
  estimatedCostUsd?: number;
  confidence?: number;
  chosenTopology?: string;
  topologyScoreboard?: Record<string, unknown> | IntentScoreboardEntry[];
  chosenModel?: { id: string; provider: string; tier: string };
  routingReasoning?: string[];
  escalations?: IntentEscalation[];
  capabilitiesNeeded?: string[];
  decompositionStrategy?: string;
  taskNature?: string;
  suitableForSpeculation?: boolean;
  /** Full LLM-prompt-less deliberation plan — for replay analysis */
  deliberation?: Record<string, unknown>;
  /** Runtime stage (e.g., 'agentRuntime.execute', 'agentRuntime.cascade') */
  stage?: string;
  /** Decision taken at this stage */
  decision?: string;
  /** Reason for the decision */
  reason?: string;
  /** Stage-specific structured payload */
  payload?: Record<string, unknown>;
  /** Captured timestamp */
  capturedAt: string;
  /** Source label: e.g. 'keyword', 'llm', 'agentRuntime', 'agentRuntime.cascade', 'ultimateOrchestrator' */
  source?: string;
}

export class IntentLog {
  private baseDir: string;
  private tenantId?: string;
  private writeQueue: Array<() => Promise<void>> = [];
  private flushing = false;

  constructor(baseDir?: string, tenantId?: string) {
    this.tenantId = tenantId;
    const base = baseDir ?? path.join(process.cwd(), '.commander_intent');
    this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch (err) {
      reportSilentFailure(err, 'intentLog:94');
      /* best-effort */
    }
  }

  /**
   * Append an IntentRecord to disk. Serialised through a write queue to
   * avoid interleaving partial lines on concurrent calls.
   */
  async write(record: IntentRecord): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    this.enqueueWrite(async () => {
      const filePath = path.join(this.baseDir, `${sanitizeRunId(record.runId)}.ndjson`);
      fs.appendFileSync(filePath, line, 'utf-8');
      try {
        fs.chmodSync(filePath, 0o600);
      } catch (err) {
        reportSilentFailure(err, 'intentLog:111');
        /* best-effort */
      }
    });
  }

  /** Read the most recent intent record for a run, or null if none exists. */
  readIntent(runId: string): IntentRecord | null {
    const filePath = path.join(this.baseDir, `${sanitizeRunId(runId)}.ndjson`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return null;
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(lines[i]) as IntentRecord;
        } catch (err) {
          reportSilentFailure(err, 'intentLog:129');
          // skip corrupt line
        }
      }
      return null;
    } catch (e) {
      getGlobalLogger().warn('IntentLog', 'Failed to read intent', {
        error: (e as Error)?.message,
        runId,
      });
      return null;
    }
  }

  /** List all run ids with captured intent. */
  listRuns(): string[] {
    try {
      const entries = fs.readdirSync(this.baseDir);
      return entries.filter((f) => f.endsWith('.ndjson')).map((f) => f.replace(/\.ndjson$/, ''));
    } catch (err) {
      reportSilentFailure(err, 'intentLog:149');
      return [];
    }
  }

  /** Drain pending writes. Call before shutdown. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.writeQueue.length > 0) {
        const task = this.writeQueue.shift();
        if (task) await task();
      }
    } finally {
      this.flushing = false;
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private enqueueWrite(task: () => Promise<void>): void {
    this.writeQueue.push(task);
    if (!this.flushing) {
      void this.flush();
    }
  }
}

function sanitizeRunId(runId: string): string {
  // Block path traversal — the runId is used as a filename component.
  return runId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const intentLogSingleton = createTenantAwareSingleton(() => new IntentLog(), {});

export function getIntentLog(tenantId?: string): IntentLog {
  if (tenantId) return intentLogSingleton.getForTenant(tenantId);
  return intentLogSingleton.get();
}

export function resetIntentLog(): void {
  intentLogSingleton.reset();
}
