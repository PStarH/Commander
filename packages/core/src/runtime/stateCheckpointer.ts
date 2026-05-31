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

export interface CheckpointState {
  runId: string;
  agentId: string;
  missionId?: string;
  timestamp: string;
  phase: 'started' | 'llm_call' | 'tool_execution' | 'verification' | 'completed' | 'failed';
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
  };
  lastError?: string;
  totalDurationMs: number;
}

export class StateCheckpointer {
  private baseDir: string;
  private tenantId?: string;
  private pruneCounter = 0;

  constructor(baseDir?: string, tenantId?: string) {
    this.tenantId = tenantId;
    const base = baseDir ?? path.join(process.cwd(), '.commander_state');
    this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
    fs.mkdirSync(path.join(this.baseDir, 'completed'), { recursive: true });
  }

  checkpoint(state: CheckpointState): void {
    const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);
    const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf-8');
      fs.renameSync(tmpPath, chkPath);
    } catch (e) { getGlobalLogger().warn('StateCheckpointer', 'Failed to write checkpoint', { error: (e as Error)?.message, runId: state.runId }); }
  }

  terminalCheckpoint(state: CheckpointState): void {
    const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
    const donePath = path.join(this.baseDir, 'completed', `${state.runId}.json`);
    const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);

    const writeTmp = path.join(this.baseDir, `${state.runId}.terminal.tmp`);
    try {
      fs.writeFileSync(writeTmp, JSON.stringify(state), 'utf-8');
      fs.renameSync(writeTmp, donePath);
    } catch (e) { getGlobalLogger().warn('StateCheckpointer', 'Failed to write terminal checkpoint', { error: (e as Error)?.message, runId: state.runId }); }

    if (fs.existsSync(chkPath)) {
      try { fs.unlinkSync(chkPath); } catch (e) { getGlobalLogger().warn('StateCheckpointer', 'Failed to remove checkpoint file', { error: (e as Error)?.message, runId: state.runId }); }
    }
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) { getGlobalLogger().warn('StateCheckpointer', 'Failed to remove temp file', { error: (e as Error)?.message, runId: state.runId }); }
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
        getGlobalLogger().warn('StateCheckpointer', 'Failed to resume from checkpoint', { error: (e as Error)?.message, runId });
        try { fs.unlinkSync(chkPath); } catch (unlinkError) { getGlobalLogger().warn('StateCheckpointer', 'Failed to remove corrupt checkpoint', { error: (unlinkError as Error)?.message, runId }); }
        return null;
      }
    }

    const donePath = path.join(this.baseDir, 'completed', `${runId}.json`);
    if (fs.existsSync(donePath)) {
      try {
        const raw = fs.readFileSync(donePath, 'utf-8');
        return JSON.parse(raw) as CheckpointState;
      } catch (e) {
        getGlobalLogger().warn('StateCheckpointer', 'Failed to read completed checkpoint', { error: (e as Error)?.message, runId });
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
      } catch (e) { getGlobalLogger().warn('StateCheckpointer', 'Failed to list checkpoints', { error: (e as Error)?.message, dir }); }
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
        try { fs.unlinkSync(p); } catch (e) { getGlobalLogger().warn('StateCheckpointer', 'Failed to delete checkpoint artifact', { error: (e as Error)?.message, path: p, runId }); }
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

  private _readFile(filePath: string): CheckpointState | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as CheckpointState;
    } catch (e) {
      getGlobalLogger().warn('StateCheckpointer', 'Failed to read checkpoint file', { error: (e as Error)?.message, filePath });
      return null;
    }
  }
}
