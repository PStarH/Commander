/**
 * StateCheckpointer — Crash-safe execution state persistence for AgentRuntime.
 *
 * Writes a JSON snapshot of mutable execution state after every LLM call,
 * tool execution cycle, and verification. Atomic writes (write to tmp, rename)
 * prevent corruption. Enables crash recovery and long-running workflow resilience.
 */

import * as fs from 'fs';
import * as path from 'path';
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

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), '.commander_state');
    fs.mkdirSync(path.join(this.baseDir, 'completed'), { recursive: true });
  }

  checkpoint(state: CheckpointState): void {
    const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);
    const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
    fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmpPath, chkPath);
  }

  terminalCheckpoint(state: CheckpointState): void {
    const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
    const donePath = path.join(this.baseDir, 'completed', `${state.runId}.json`);
    const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);

    const writeTmp = path.join(this.baseDir, `${state.runId}.terminal.tmp`);
    fs.writeFileSync(writeTmp, JSON.stringify(state), 'utf-8');
    fs.renameSync(writeTmp, donePath);

    if (fs.existsSync(chkPath)) fs.unlinkSync(chkPath);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }

  resume(runId: string): CheckpointState | null {
    const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
    if (fs.existsSync(chkPath)) {
      try {
        const raw = fs.readFileSync(chkPath, 'utf-8');
        return JSON.parse(raw) as CheckpointState;
      } catch {
        try { fs.unlinkSync(chkPath); } catch { /* ignore */ }
        return null;
      }
    }

    const donePath = path.join(this.baseDir, 'completed', `${runId}.json`);
    if (fs.existsSync(donePath)) {
      try {
        const raw = fs.readFileSync(donePath, 'utf-8');
        return JSON.parse(raw) as CheckpointState;
      } catch {
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
          if (f.endsWith('.tmp')) continue;
          const state = this._readFile(path.join(dir, f));
          if (state) {
            const runId = f.replace(/\.(checkpoint|json)$/, '');
            results.push({ runId, phase: state.phase, timestamp: state.timestamp });
          }
        }
      } catch { /* ignore */ }
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
        try { fs.unlinkSync(p); } catch { /* ignore */ }
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
    } catch {
      return null;
    }
  }
}
