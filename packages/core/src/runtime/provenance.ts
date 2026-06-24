/**
 * Run Provenance — Reproducibility metadata capture.
 *
 * Collects git state (commit hash, branch, dirty status), system info
 * (Node version, platform, arch), and model configuration at runtime.
 * Used by SamplesStore and the evaluation framework to ensure every
 * execution trace is reproducible.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getGlobalLogger } from '../logging';

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

/** Cached git state — fetched once per process to avoid repeated blocking calls. */
let cachedGitState: { commitHash: string; branch: string; dirty: boolean } | null = null;

function fetchGitState(): { commitHash: string; branch: string; dirty: boolean } {
  if (cachedGitState) return cachedGitState;

  let commitHash = 'unknown';
  let branch = 'unknown';
  let dirty = false;
  try {
    commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    dirty = status.length > 0;
  } catch (err) {
    console.warn('[Catch]', err);
    getGlobalLogger().debug('Provenance', 'Not in a git repo or git not available');
  }

  cachedGitState = { commitHash, branch, dirty };
  return cachedGitState;
}

export function captureProvenance(): Omit<RunProvenance, 'runId' | 'timestamp' | 'model' | 'tags'> {
  const git = fetchGitState();
  return {
    git,
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

/**
 * Reset cached git state (for testing or when repo changes).
 */
export function resetProvenanceCache(): void {
  cachedGitState = null;
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
