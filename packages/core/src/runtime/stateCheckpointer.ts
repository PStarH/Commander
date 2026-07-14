/**
 * StateCheckpointer — Crash-safe execution state persistence for AgentRuntime.
 *
 * Writes a JSON snapshot of mutable execution state after every LLM call,
 * tool execution cycle, and verification. Atomic writes (write to tmp, rename)
 * prevent corruption. Enables crash recovery and long-running workflow resilience.
 *
 * Can optionally dual-write to CheckpointStore (SQLite) for queryable history.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import type { LLMMessage, TokenUsage } from './types';
import type { LeaseManager } from '../atr/leaseManager';
import { getMetricsCollector } from './metricsCollector';
import { CheckpointStore, type CheckpointSnapshot } from './checkpointStore';
import {
  createStateCheckpointBackend,
  type StateCheckpointBackend,
  resolveStateCheckpointBackendType,
} from './stateCheckpointBackend';

export type CheckpointPhase =
  | 'started'
  | 'llm_call'
  | 'tool_execution'
  | 'verification'
  | 'completed'
  | 'completed_early_exit'
  | 'failed'
  | 'interrupted'
  | 'waiting_for_human'
  | 'sequential-step'
  | 'task-pool-batch'
  | 'goal-round'
  | 'swarm-round';

export interface CheckpointState {
  runId: string;
  agentId: string;
  missionId?: string;
  timestamp: string;
  phase: CheckpointPhase;
  stepNumber: number;
  attemptNumber: number;
  messages: LLMMessage[];
  tokenUsage: TokenUsage;
  stepDurations: number[];
  context: {
    agentId: string;
    missionId?: string;
    projectId: string;
    goal: string;
    availableTools: string[];
    maxSteps: number;
    tokenBudget: number;
    projectContextCacheKey?: string;
    projectContextFiles?: string[];
  };
  lastError?: string;
  totalDurationMs: number;
  leaseToken?: string;
  fencingEpoch?: number;
  version?: number;
  executorState?: unknown;
}

export class StateCheckpointer {
  private baseDir: string;
  private tenantId?: string;
  private leaseManager?: LeaseManager;
  private store?: CheckpointStore;
  private readonly backend: StateCheckpointBackend;
  private pruneCounter = 0;

  constructor(
    baseDir?: string,
    tenantId?: string,
    options?: {
      leaseManager?: LeaseManager;
      store?: CheckpointStore;
      backend?: StateCheckpointBackend;
      backendType?: ReturnType<typeof resolveStateCheckpointBackendType>;
    },
  ) {
    this.tenantId = tenantId;
    this.leaseManager = options?.leaseManager;
    this.store = options?.store;
    const base = baseDir ?? path.join(process.cwd(), '.commander_state');
    this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
    this.backend =
      options?.backend ??
      createStateCheckpointBackend(
        this.baseDir,
        options?.backendType ?? resolveStateCheckpointBackendType(),
      );
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch (err) {
      reportSilentFailure(err, 'stateCheckpointer:84');
      /* best-effort */
    }
    fs.mkdirSync(path.join(this.baseDir, 'completed'), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(path.join(this.baseDir, 'completed'), 0o700);
    } catch (err) {
      reportSilentFailure(err, 'stateCheckpointer:91');
      /* best-effort */
    }
  }

  setLeaseManager(leaseManager: LeaseManager | undefined): void {
    this.leaseManager = leaseManager;
  }

  /**
   * Validate that `state` carries a live lease on `runId`. Bumps `state.version`
   * monotonically before write. Returns false (and skips the write) if fenced.
   * When no LeaseManager is bound, validation is a no-op and the write proceeds.
   */
  private authorize(state: CheckpointState): boolean {
    if (!this.leaseManager) return true;
    if (!state.leaseToken || typeof state.fencingEpoch !== 'number') {
      getGlobalLogger().debug('StateCheckpointer', 'Checkpoint missing lease credentials', {
        runId: state.runId,
        hasToken: !!state.leaseToken,
        hasEpoch: typeof state.fencingEpoch === 'number',
      });
      return false;
    }
    const live = this.leaseManager.validate(state.runId, state.leaseToken, state.fencingEpoch, {
      tenantId: this.tenantId,
    });
    if (!live) {
      getGlobalLogger().warn('StateCheckpointer', 'Fenced: checkpoint write rejected', {
        runId: state.runId,
        token: state.leaseToken,
        epoch: state.fencingEpoch,
      });
      return false;
    }
    const prior =
      this.backend.readActive(state.runId) ??
      this._readFile(path.join(this.baseDir, `${state.runId}.checkpoint`));
    state.version = (prior?.version ?? 0) + 1;
    return true;
  }

  checkpoint(state: CheckpointState): void {
    if (!this.authorize(state)) return;
    try {
      this.backend.writeActive(state.runId, state);
      this.writeStoreCheckpoint(state);
      try {
        getMetricsCollector().recordCheckpointFlush(state.phase ?? 'unknown');
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointer:154');
        /* best-effort */
      }
    } catch (e) {
      getGlobalLogger().warn('StateCheckpointer', 'Failed to write checkpoint', {
        error: (e as Error)?.message,
        runId: state.runId,
      });
    }
  }

  terminalCheckpoint(state: CheckpointState): void {
    if (!this.authorize(state)) return;

    try {
      this.backend.writeTerminal(state.runId, state);
      try {
        getMetricsCollector().recordCheckpointFlush('terminal');
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointer:190');
        /* best-effort */
      }
      this.writeStoreCheckpoint(state);
    } catch (e) {
      getGlobalLogger().warn('StateCheckpointer', 'Failed to write terminal checkpoint', {
        error: (e as Error)?.message,
        runId: state.runId,
      });
    }

    // Auto-prune completed checkpoints periodically (not every completion)
    this.pruneCounter++;
    if (this.pruneCounter >= 10) {
      this.pruneCounter = 0;
      this.prune(100);
    }
  }

  resume(runId: string): CheckpointState | null {
    const active = this.backend.readActive(runId);
    if (active) return active;
    return this.backend.readTerminal(runId);
  }

  /**
   * Async variant of resume(). RecoveryBootstrapper calls resume() in a
   * loop on startup; using the async variant lets concurrent zombie-scans
   * not serialize behind a synchronous fs.readFileSync per resume.
   */
  async resumeAsync(runId: string): Promise<CheckpointState | null> {
    const active = await this.backend.readActiveAsync(runId);
    if (active) return active;
    return this.backend.readTerminal(runId);
  }

  listCheckpoints(): { runId: string; phase: string; timestamp: string }[] {
    if (this.store) {
      try {
        const records = this.store.getLatestByRun('');
        if (records) {
          const summaries = this.store.listByRun('*');
          if (summaries.length > 0) {
            return summaries
              .filter((s) => s.phase)
              .map((s) => ({
                runId: s.runId,
                phase: s.phase!,
                timestamp: s.createdAt,
              }));
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointer:287');
        /* fall through to file-based listing */
      }
    }

    const results: { runId: string; phase: string; timestamp: string }[] = [];

    const addFromDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir);
        for (const f of entries) {
          if (f.endsWith('.tmp')) continue;
          if (!f.endsWith('.checkpoint') && !f.endsWith('.json')) continue;
          const state = this._readFile(path.join(dir, f));
          if (state && typeof state.phase === 'string' && typeof state.timestamp === 'string') {
            const runId = f.replace(/\.(checkpoint|json)$/, '');
            results.push({ runId, phase: state.phase, timestamp: state.timestamp });
          }
        }
      } catch (e) {
        getGlobalLogger().warn('StateCheckpointer', 'Failed to list checkpoints', {
          error: (e as Error)?.message,
          dir,
        });
      }
    };

    addFromDir(this.baseDir);
    addFromDir(path.join(this.baseDir, 'completed'));

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * Async variant of listCheckpoints(). Reads run manifests from .commander_state/
   * and the completed/ subdir via fs.promises in parallel; same semantics as
   * the sync version. Used by GET /api/v1/state-machine endpoints under load.
   */
  async listCheckpointsAsync(): Promise<{ runId: string; phase: string; timestamp: string }[]> {
    if (this.store) {
      try {
        const records = this.store.getLatestByRun('');
        if (records) {
          const summaries = this.store.listByRun('*');
          if (summaries.length > 0) {
            return summaries
              .filter((s) => s.phase)
              .map((s) => ({
                runId: s.runId,
                phase: s.phase!,
                timestamp: s.createdAt,
              }));
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointer:listAsync:store');
        /* fall through to file-based listing */
      }
    }

    const gatherFromDir = async (dir: string) => {
      let entries: string[] = [];
      try {
        entries = await fs.promises.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        getGlobalLogger().warn('StateCheckpointer', 'Failed to list checkpoints (async)', {
          error: (err as Error)?.message,
          dir,
        });
        return [];
      }
      const candidates = entries.filter(
        (f) => !f.endsWith('.tmp') && (f.endsWith('.checkpoint') || f.endsWith('.json')),
      );
      // Parallel reads — cheaper than a sequential readdir-then-loop.
      const states = await Promise.all(
        candidates.map((f) => this._readFileAsync(path.join(dir, f))),
      );
      const out: { runId: string; phase: string; timestamp: string }[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const state = states[i];
        const f = candidates[i];
        if (state && typeof state.phase === 'string' && typeof state.timestamp === 'string') {
          const runId = f.replace(/\.(checkpoint|json)$/, '');
          out.push({ runId, phase: state.phase, timestamp: state.timestamp });
        }
      }
      return out;
    };

    const [primary, completed] = await Promise.all([
      gatherFromDir(this.baseDir),
      gatherFromDir(path.join(this.baseDir, 'completed')),
    ]);
    return [...primary, ...completed].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  deleteCheckpoint(runId: string): void {
    for (const p of [
      path.join(this.baseDir, `${runId}.checkpoint`),
      path.join(this.baseDir, `${runId}.tmp`),
      path.join(this.baseDir, 'completed', `${runId}.json`),
    ]) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (e) {
          getGlobalLogger().warn('StateCheckpointer', 'Failed to delete checkpoint artifact', {
            error: (e as Error)?.message,
            path: p,
            runId,
          });
        }
      }
    }
  }

  prune(keepCount: number): void {
    const all = this.listCheckpoints();
    if (all.length <= keepCount) return;
    for (const entry of all.slice(keepCount)) {
      this.deleteCheckpoint(entry.runId);
    }
  }

  /** Release any resources held by this checkpointer. */
  dispose(): void {}

  /**
   * Load the latest checkpoint for a run. Returns null if no checkpoint exists.
   * If a LeaseManager is bound, validates the lease before returning.
   */
  loadCheckpoint(runId: string): CheckpointState | null {
    const state = this.backend.readActive(runId);
    if (!state) return null;
    if (this.leaseManager && state.leaseToken && typeof state.fencingEpoch === 'number') {
      const live = this.leaseManager.validate(runId, state.leaseToken, state.fencingEpoch, {
        tenantId: this.tenantId,
      });
      if (!live) {
        getGlobalLogger().warn('StateCheckpointer', 'Fenced: checkpoint read rejected', {
          runId,
          token: state.leaseToken,
          epoch: state.fencingEpoch,
        });
        return null;
      }
    }
    return state;
  }

  /**
   * Async variant of loadCheckpoint(). Lease validation is identical to
   * the sync version; only the file read differs. Use this from async
   * hot paths (e.g., Resume-from-failure in harness) where a sync
   * readFileSync would otherwise block the event loop during recovery.
   */
  async loadCheckpointAsync(runId: string): Promise<CheckpointState | null> {
    const state = await this.backend.readActiveAsync(runId);
    if (!state) return null;
    if (this.leaseManager && state.leaseToken && typeof state.fencingEpoch === 'number') {
      const live = this.leaseManager.validate(runId, state.leaseToken, state.fencingEpoch, {
        tenantId: this.tenantId,
      });
      if (!live) {
        getGlobalLogger().warn('StateCheckpointer', 'Fenced: checkpoint read rejected (async)', {
          runId,
          token: state.leaseToken,
          epoch: state.fencingEpoch,
        });
        return null;
      }
    }
    return state;
  }

  private writeStoreCheckpoint(state: CheckpointState): void {
    if (!this.store) return;
    const id = `${state.runId}_${state.stepNumber}`;
    const tokenCount =
      (state.tokenUsage?.totalTokens ?? 0) ||
      (state.tokenUsage?.promptTokens ?? 0) + (state.tokenUsage?.completionTokens ?? 0);

    const snapshot: CheckpointSnapshot = {
      checkpoint: {
        id,
        runId: state.runId,
        label: state.phase,
        phase: state.phase,
        stepNumber: state.stepNumber,
        tokenCount,
        agentId: state.agentId,
        tenantId: this.tenantId,
        createdAt: state.timestamp,
        metadata: {
          attemptNumber: state.attemptNumber,
          lastError: state.lastError,
          totalDurationMs: state.totalDurationMs,
          leaseToken: state.leaseToken,
          fencingEpoch: state.fencingEpoch,
          projectId: state.context?.projectId,
          goal: state.context?.goal,
        },
        version: state.version ?? 1,
      },
      messages: state.messages ?? [],
      filesRead: state.context?.projectContextFiles ?? [],
      filesModified: [],
    };

    try {
      this.store.save(snapshot);
    } catch (err) {
      reportSilentFailure(err, 'stateCheckpointer:412');
      /* store write is best-effort — file-based checkpoint is primary */
    }
  }

  private _readFile(filePath: string): CheckpointState | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as CheckpointState;
    } catch (e) {
      getGlobalLogger().warn('StateCheckpointer', 'Failed to read checkpoint file', {
        error: (e as Error)?.message,
        filePath,
      });
      return null;
    }
  }

  /**
   * Async counterpart to _readFile. ENOENT is a benign miss (return
   * null) so callers can avoid noisy warn logs for first-time lookups.
   */
  private async _readFileAsync(filePath: string): Promise<CheckpointState | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      getGlobalLogger().warn('StateCheckpointer', 'Failed to read checkpoint file (async)', {
        error: (err as Error)?.message,
        filePath,
      });
      return null;
    }
    try {
      return JSON.parse(raw) as CheckpointState;
    } catch (e) {
      getGlobalLogger().warn('StateCheckpointer', 'Checkpoint JSON parse failed (async)', {
        error: (e as Error)?.message,
        filePath,
      });
      return null;
    }
  }
}
