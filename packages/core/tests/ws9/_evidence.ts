/**
 * _evidence.ts — Shared WS9 live-fire helpers (spec §3.2, §9).
 *
 * Provides:
 *   - Infrastructure probes (Postgres / Vault / gVisor / /v1 gateway).
 *   - `describeIf` — conditional `describe` that uses `describe.skip` when the
 *     probe is unavailable. Skipped tests emit NO evidence (spec §9.2 honesty).
 *   - `writeEvidence` / `writePass` / `writeBreach` / `writeFail` — structured
 *     JSON artifact writers to `docs/baselines/ws9/<caseId>.json`.
 *   - `TENANT_A` / `TENANT_B` — the two real tenant identifiers (spec §3.1).
 *
 * Evidence artifact format (spec §9):
 *   { testCaseId, verdict, evidenceLevel, breach, details, gitSha, ranAt, artifacts }
 *
 * Honesty rules (spec §9.2):
 *   - Skipped tests MUST NOT write evidence (no artifact = "missing" in summary).
 *   - `evidenceLevel=ci-worm-sim` CANNOT fill live/SOC slots.
 *   - `evidenceLevel=live` requires real backend (PG + non-owner role + multi-process).
 */

import { describe, it as vitestIt } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── Constants ──────────────────────────────────────────────────────────

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';

/**
 * Baseline directory for WS9 evidence artifacts.
 * Derived from this file's location: packages/core/tests/ws9/ → repo root.
 */
export const WS9_BASELINE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'baselines',
  'ws9',
);

// ─── Types ──────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'SKIPPED' | 'BREACH';
export type EvidenceLevel = 'live' | 'ci-worm-sim' | 'simulated';

export interface EvidenceArtifact {
  testCaseId: string;
  verdict: Verdict;
  evidenceLevel: EvidenceLevel;
  breach: boolean;
  details: string;
  gitSha: string;
  ranAt: string;
  artifacts: string[];
}

export interface ProbeResult {
  available: boolean;
  reason: string;
}

// ─── Infrastructure probes (spec §3.1) ──────────────────────────────────

/** True if a binary is resolvable on PATH (POSIX `command -v`). */
function hasBinary(name: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 3_000,
  });
  return result.status === 0 && !!result.stdout?.trim();
}

/** Check Postgres availability: psql binary + COMMANDER_DB_HOST/NAME/USER set. */
export const probePostgres: ProbeResult = (() => {
  if (!hasBinary('psql')) {
    return { available: false, reason: 'psql binary not found on PATH' };
  }
  const host = process.env.COMMANDER_DB_HOST;
  const db = process.env.COMMANDER_DB_NAME;
  const user = process.env.COMMANDER_DB_USER;
  if (!host || !db || !user) {
    return { available: false, reason: 'COMMANDER_DB_HOST/NAME/USER not set' };
  }
  return { available: true, reason: 'psql + COMMANDER_DB_* configured' };
})();

/** Check Vault availability: COMMANDER_VAULT_ADDR + COMMANDER_VAULT_TOKEN set. */
export const probeVault: ProbeResult = (() => {
  const addr = process.env.COMMANDER_VAULT_ADDR;
  const token = process.env.COMMANDER_VAULT_TOKEN;
  if (!addr || !token) {
    return { available: false, reason: 'COMMANDER_VAULT_ADDR/TOKEN not set' };
  }
  return { available: true, reason: `Vault at ${addr}` };
})();

/**
 * Check gVisor availability: runsc on PATH, or docker with `runsc` runtime
 * configured (matches GVisorSB — Colima often exposes runsc only inside the VM).
 */
export const probeGvisor: ProbeResult = (() => {
  if (hasBinary('runsc')) {
    return { available: true, reason: 'runsc binary present' };
  }
  if (hasBinary('docker')) {
    const info = spawnSync('docker', ['info', '--format', '{{.Runtimes}}'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 8_000,
    });
    if (info.status === 0 && (info.stdout ?? '').includes('runsc')) {
      return {
        available: true,
        reason: 'docker runtime runsc configured (runsc not on PATH)',
      };
    }
  }
  return {
    available: false,
    reason: 'runsc binary not found on PATH and docker runsc runtime not configured',
  };
})();

/** Check /v1 gateway availability: COMMANDER_API_HOST/PORT set. */
export const probeV1Gateway: ProbeResult = (() => {
  const host = process.env.COMMANDER_API_HOST;
  const port = process.env.COMMANDER_API_PORT;
  if (!host || !port) {
    return { available: false, reason: 'COMMANDER_API_HOST/PORT not set' };
  }
  return { available: true, reason: `gateway at ${host}:${port}` };
})();

// ─── describeIf — conditional test execution ────────────────────────────

/**
 * Run a `describe` block only when `probe.available` is true; otherwise
 * `describe.skip`. Skipped tests produce NO evidence (spec §9.2 honesty).
 *
 * Usage:
 *   describeIf(probePostgres)('DATA-1: ...', () => { ... });
 *   describeIf(!probePostgres)('DATA-1 (skipped): ...', () => { ... });
 */
export function describeIf(probe: ProbeResult | boolean): typeof describe {
  const available = typeof probe === 'boolean' ? probe : probe.available;
  return available ? describe : describe.skip;
}

// ─── Evidence writers ───────────────────────────────────────────────────

function gitSha(): string {
  try {
    const res = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    return (res.stdout ?? '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureBaselineDir(): void {
  if (!fs.existsSync(WS9_BASELINE_DIR)) {
    fs.mkdirSync(WS9_BASELINE_DIR, { recursive: true });
  }
}

/**
 * Write a structured evidence JSON artifact to `docs/baselines/ws9/<caseId>.json`.
 * Returns the artifact file path (for inclusion in test output).
 */
export function writeEvidence(artifact: Omit<EvidenceArtifact, 'gitSha' | 'ranAt'>): string {
  ensureBaselineDir();
  const full: EvidenceArtifact = {
    ...artifact,
    gitSha: gitSha(),
    ranAt: new Date().toISOString(),
  };
  const filePath = path.join(WS9_BASELINE_DIR, `${artifact.testCaseId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(full, null, 2), { mode: 0o644 });
  return filePath;
}

/**
 * Write a PASS evidence artifact.
 * Default evidenceLevel is `simulated` so unit/mock paths cannot silently
 * fill live/SOC slots. Pass `live` only after a real backend probe succeeded.
 */
export function writePass(
  testCaseId: string,
  details: string,
  artifacts: string[] = [],
  evidenceLevel: EvidenceLevel = 'simulated',
): string {
  const filePath = writeEvidence({
    testCaseId,
    verdict: 'PASS',
    evidenceLevel,
    breach: false,
    details,
    artifacts,
  });
  artifacts.push(filePath);
  return filePath;
}

/**
 * Write a BREACH evidence artifact — a cross-tenant isolation breach was
 * detected. This always sets verdict=FAIL in the summary (spec §9.2).
 */
export function writeBreach(
  testCaseId: string,
  details: string,
  artifacts: string[] = [],
  evidenceLevel: EvidenceLevel = 'simulated',
): string {
  const filePath = writeEvidence({
    testCaseId,
    verdict: 'BREACH',
    evidenceLevel,
    breach: true,
    details,
    artifacts,
  });
  artifacts.push(filePath);
  return filePath;
}

/**
 * Write a FAIL evidence artifact — a test assertion failed (not necessarily a
 * breach, but the expected fail-closed behavior did not hold).
 */
export function writeFail(
  testCaseId: string,
  details: string,
  artifacts: string[] = [],
  evidenceLevel: EvidenceLevel = 'simulated',
): string {
  const filePath = writeEvidence({
    testCaseId,
    verdict: 'FAIL',
    evidenceLevel,
    breach: false,
    details,
    artifacts,
  });
  artifacts.push(filePath);
  return filePath;
}
