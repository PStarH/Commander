/**
 * StateCheckpointer — Crash-safe execution state persistence for AgentRuntime.
 *
 * Writes a JSON snapshot of mutable execution state after every LLM call,
 * tool execution cycle, and verification. Atomic writes (write to tmp, rename)
 * prevent corruption. Enables crash recovery and long-running workflow resilience.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import type { LLMMessage, TokenUsage } from './types';
import type { LeaseManager } from '../atr/leaseManager';
import { getMetricsCollector } from './metricsCollector';

export interface CheckpointState {
  runId: string;
  agentId: string;
  missionId?: string;
  timestamp: string;
  phase:
    | 'started'
    | 'llm_call'
    | 'tool_execution'
    | 'verification'
    | 'completed'
    | 'completed_early_exit'
    | 'failed'
    | 'interrupted';
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
    /** Cache key of loaded project context files, for resumability. */
    projectContextCacheKey?: string;
    /** Project context files read at run start. */
    projectContextFiles?: string[];
  };
  lastError?: string;
  totalDurationMs: number;
  /** ATR lease token — required when StateCheckpointer is bound to a LeaseManager. */
  leaseToken?: string;
  /** ATR fencing epoch — must match the live lease for the write to be accepted. */
  fencingEpoch?: number;
  /** Monotonic version of this checkpoint file; bumped on every successful write. */
  version?: number;
}

export class StateCheckpointer {
  private baseDir: string;
  private tenantId?: string;
  private leaseManager?: LeaseManager;
  private pruneCounter = 0;

  constructor(baseDir?: string, tenantId?: string, options?: { leaseManager?: LeaseManager }) {
    this.tenantId = tenantId;
    this.leaseManager = options?.leaseManager;
    const base = baseDir ?? path.join(process.cwd(), '.commander_state');
    this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch {
      /* best-effort */
    }
    fs.mkdirSync(path.join(this.baseDir, 'completed'), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(path.join(this.baseDir, 'completed'), 0o700);
    } catch {
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
    const prior = this._readFile(path.join(this.baseDir, `${state.runId}.checkpoint`));
    state.version = (prior?.version ?? 0) + 1;
    return true;
  }

  checkpoint(state: CheckpointState): void {
    if (!this.authorize(state)) return;
    const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);
    const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        /* best-effort */
      }
      fs.renameSync(tmpPath, chkPath);
      try {
        fs.chmodSync(chkPath, 0o600);
      } catch {
        /* best-effort */
      }
      try {
        getMetricsCollector().recordCheckpointFlush(state.phase ?? 'unknown');
      } catch {
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
    const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
    const donePath = path.join(this.baseDir, 'completed', `${state.runId}.json`);
    const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);

    const writeTmp = path.join(this.baseDir, `${state.runId}.terminal.tmp`);
    try {
      fs.writeFileSync(writeTmp, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(writeTmp, 0o600);
      } catch {
        /* best-effort */
      }
      fs.renameSync(writeTmp, donePath);
      try {
        fs.chmodSync(donePath, 0o600);
      } catch {
        /* best-effort */
      }
      try {
        getMetricsCollector().recordCheckpointFlush('terminal');
      } catch {
        /* best-effort */
      }
    } catch (e) {
      getGlobalLogger().warn('StateCheckpointer', 'Failed to write terminal checkpoint', {
        error: (e as Error)?.message,
        runId: state.runId,
      });
    }

    if (fs.existsSync(chkPath)) {
      try {
        fs.unlinkSync(chkPath);
      } catch (e) {
        getGlobalLogger().warn('StateCheckpointer', 'Failed to remove checkpoint file', {
          error: (e as Error)?.message,
          runId: state.runId,
        });
      }
    }
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (e) {
        getGlobalLogger().warn('StateCheckpointer', 'Failed to remove temp file', {
          error: (e as Error)?.message,
          runId: state.runId,
        });
      }
    }

    // Auto-prune completed checkpoints periodically (not every completion)
    this.pruneCounter++;
    if (this.pruneCounter >= 10) {
      this.pruneCounter = 0;
      this.prune(100);
    }
  }

  resume(runId: string): CheckpointState | null {
    const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
    if (fs.existsSync(chkPath)) {
      try {
        const raw = fs.readFileSync(chkPath, 'utf-8');
        return JSON.parse(raw) as CheckpointState;
      } catch (e) {
        getGlobalLogger().warn('StateCheckpointer', 'Failed to resume from checkpoint', {
          error: (e as Error)?.message,
          runId,
        });
        try {
          fs.unlinkSync(chkPath);
        } catch (unlinkError) {
          getGlobalLogger().warn('StateCheckpointer', 'Failed to remove corrupt checkpoint', {
            error: (unlinkError as Error)?.message,
            runId,
          });
        }
        return null;
      }
    }

    const donePath = path.join(this.baseDir, 'completed', `${runId}.json`);
    if (fs.existsSync(donePath)) {
      try {
        const raw = fs.readFileSync(donePath, 'utf-8');
        return JSON.parse(raw) as CheckpointState;
      } catch (e) {
        getGlobalLogger().warn('StateCheckpointer', 'Failed to read completed checkpoint', {
          error: (e as Error)?.message,
          runId,
        });
        return null;
      }
    }

    return null;
  }

  listCheckpoints(): { runId: string; phase: string; timestamp: string }[] {
    const results: { runId: string; phase: string; timestamp: string }[] = [];

    const addFromDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir);
        for (const f of entries) {
          // Skip non-checkpoint files and directories
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
    const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
    const state = this._readFile(chkPath);
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
}
