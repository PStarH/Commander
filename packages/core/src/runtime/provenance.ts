import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Capture all metadata about an evaluation run that matters for
 * reproducibility: git state, model config, parameters, environment.
 */
export interface RunProvenance {
  runId: string;
  timestamp: string;
  git: {
    commitHash: string;
    branch: string;
    dirty: boolean;
  };
  model: {
    provider: string;
    modelId: string;
    tier: string;
    temperature?: number;
    maxTokens?: number;
    reasoningConfig?: { enabled: boolean; budget?: number; effort?: string };
  };
  system: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  /** Arbitrary extra context (evaluation name, task set, etc.) */
  tags: Record<string, string>;
}

export function captureProvenance(): Omit<RunProvenance, 'runId' | 'timestamp' | 'model' | 'tags'> {
  let commitHash = 'unknown';
  let branch = 'unknown';
  let dirty = false;
  try {
    commitHash = execSync('git rev-parse HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
    branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 3000 }).trim();
    dirty = status.length > 0;
  } catch {
    // Not in a git repo or git not available
  }

  return {
    git: { commitHash, branch, dirty },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export function createRunProvenance(
  runId: string,
  model: RunProvenance['model'],
  tags?: Record<string, string>,
): RunProvenance {
  const base = captureProvenance();
  return {
    runId,
    timestamp: new Date().toISOString(),
    ...base,
    model,
    tags: tags ?? {},
  };
}
