#!/usr/bin/env tsx
/**
 * L4-B Cell smoke — compose/kind/helm ENFORCED harness.
 *
 * Usage:
 *   pnpm cell:smoke -- --base-url http://localhost:4000 --mode compose
 *   pnpm cell:smoke -- --mode helm   # helm template assert only — does not prove Pods are running
 */

import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertComposeCellHealth,
  COMPOSE_CONFIG_ENV,
  tryComposeCellUp,
} from './l4-b-cell-compose.js';

export type CellSmokeMode = 'compose' | 'helm' | 'kind' | 'mock';

export interface CellSmokeResult {
  mode: CellSmokeMode;
  passed: boolean;
  steps: Record<string, boolean>;
  gitSha: string;
  topology: string;
  elapsedMs: number;
}

function resolveGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function assertHelmCellTemplate(): Promise<boolean> {
  const yaml = execSync(
    'helm template cell-smoke deploy/helm/commander -f deploy/helm/commander/values-demo.yaml --set image.tag=test',
    { encoding: 'utf-8', cwd: process.cwd() },
  );
  const { assertHelmCellTopology, loadYamlDocuments } = await import('./helm-cell-assert.js');
  const docs = loadYamlDocuments(yaml);
  assertHelmCellTopology(docs, 'demo', yaml);
  return true;
}

export const CELL_KERNEL_SERVICES = ['api', 'worker', 'kernel-ops', 'adapter-ops'] as const;

/** Worker/adapter must fail-closed on Ed25519 PEM/JWKS/key id (not HMAC). */
export const CELL_CAPABILITY_SERVICES = ['worker', 'adapter-ops'] as const;

const CAPABILITY_ENV_REQUIRED = [
  'COMMANDER_CAPABILITY_PRIVATE_KEY_PEM',
  'COMMANDER_CAPABILITY_KEY_ID',
  'COMMANDER_CAPABILITY_JWKS_JSON',
] as const;

type ComposeServiceEnv = Record<string, string | number | null> | string[];

function envMapFromCompose(environment: ComposeServiceEnv | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!environment) return map;
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      const idx = entry.indexOf('=');
      if (idx <= 0) continue;
      map.set(entry.slice(0, idx), entry.slice(idx + 1));
    }
    return map;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value == null) continue;
    map.set(key, String(value));
  }
  return map;
}

export function assertKernelBackendOnCellServices(composeConfig: {
  services?: Record<string, { environment?: ComposeServiceEnv }>;
}): void {
  for (const service of CELL_KERNEL_SERVICES) {
    const env = envMapFromCompose(composeConfig.services?.[service]?.environment);
    const backend = env.get('COMMANDER_KERNEL_BACKEND');
    if (backend !== 'postgres') {
      throw new Error(
        service +
          ': COMMANDER_KERNEL_BACKEND must be postgres (got ' +
          (backend ?? 'missing') +
          ')',
      );
    }
  }
}

export function assertCapabilityAuthorityOnCellServices(composeConfig: {
  services?: Record<string, { environment?: ComposeServiceEnv }>;
}): void {
  for (const service of CELL_CAPABILITY_SERVICES) {
    const env = envMapFromCompose(composeConfig.services?.[service]?.environment);
    for (const key of CAPABILITY_ENV_REQUIRED) {
      const value = env.get(key);
      if (!value || value.trim() === '') {
        throw new Error(`${service}: ${key} must be present (PEM/JWKS/key id contract)`);
      }
    }
    if (env.has('COMMANDER_CAPABILITY_TOKEN_KEY')) {
      throw new Error(
        `${service}: must not set COMMANDER_CAPABILITY_TOKEN_KEY (HMAC path retired for worker/adapter)`,
      );
    }
  }
}

export { COMPOSE_CONFIG_ENV };

/** When API probes fail, sidecar health from compose exec must not read as true (R10). */
export function applyApiGateToComposeSidecarSteps(steps: Record<string, boolean>): void {
  if (steps.S1 === false || steps.S2 === false) {
    steps.S4_worker = false;
    steps.S5_kernelOps = false;
    steps.S6_adapterOps = false;
  }
}

type ChaosModule = {
  runL4BAdapterChaos: () => Promise<{ passed: boolean; remoteCreateCount: number }>;
};

/**
 * 可选 chaos 步：默认路径不依赖尚未合入的 l4-b-adapter-chaos。
 * require=true 或 CELL_SMOKE_REQUIRE_CHAOS=1 时，缺失/失败记 S7_chaos=false。
 * loadChaos 仅供单测注入「helper 缺失」路径。
 */
export async function runOptionalChaosStep(
  steps: Record<string, boolean>,
  options?: { require?: boolean; loadChaos?: () => Promise<ChaosModule> },
): Promise<void> {
  const requireChaos =
    options?.require === true || process.env.CELL_SMOKE_REQUIRE_CHAOS === '1';
  try {
    const { runL4BAdapterChaos } = options?.loadChaos
      ? await options.loadChaos()
      : await import('./l4-b-adapter-chaos.js');
    const chaos = await runL4BAdapterChaos();
    steps.S7_chaos = chaos.passed && chaos.remoteCreateCount === 1;
  } catch {
    if (requireChaos) {
      steps.S7_chaos = false;
    }
  }
}

function assertComposeKernelBackend(): boolean {
  const json = execSync(
    'docker compose -f docker-compose.yml -f docker-compose.cell.yml --profile cell config --format json',
    { encoding: 'utf-8', cwd: process.cwd(), env: { ...process.env, ...COMPOSE_CONFIG_ENV } },
  );
  const config = JSON.parse(json) as { services?: Record<string, { environment?: ComposeServiceEnv }> };
  assertKernelBackendOnCellServices(config);
  assertCapabilityAuthorityOnCellServices(config);
  return true;
}

export async function runCellSmoke(options: {
  baseUrl?: string;
  mode?: CellSmokeMode;
  apiKey?: string;
}): Promise<CellSmokeResult> {
  const started = Date.now();
  const mode = options.mode ?? 'mock';
  const steps: Record<string, boolean> = {};
  const baseUrl = options.baseUrl ?? 'http://localhost:4000';

  if (mode === 'mock') {
    try {
      const { runL4BAdapterChaos } = await import('./l4-b-adapter-chaos.js');
      const chaos = await runL4BAdapterChaos();
      steps.S6 = chaos.passed && chaos.remoteCreateCount === 1;
    } catch {
      steps.S6 = false;
    }
    return {
      mode,
      passed: steps.S6 === true,
      steps,
      gitSha: resolveGitSha(),
      topology: 'mock',
      elapsedMs: Date.now() - started,
    };
  }

  if (mode === 'helm') {
    try {
      steps.helm_template_assert = await assertHelmCellTemplate();
    } catch {
      steps.helm_template_assert = false;
    }
    return {
      mode,
      passed: steps.helm_template_assert === true,
      steps,
      gitSha: resolveGitSha(),
      topology: 'helm-template-assert',
      elapsedMs: Date.now() - started,
    };
  }

  if (mode === 'compose') {
    if (process.env.CELL_SMOKE_COMPOSE_UP === '1') {
      const up = tryComposeCellUp();
      steps.S0_composeUp = up.ok;
      if (!up.ok) {
        return {
          mode,
          passed: false,
          steps,
          gitSha: resolveGitSha(),
          topology: 'compose-cell',
          elapsedMs: Date.now() - started,
        };
      }
    }
    const cellHealth = await assertComposeCellHealth(baseUrl);
    steps.S1 = cellHealth.apiReady;
    steps.S2 = cellHealth.apiHealth;
    steps.S4_worker = cellHealth.workerHealth;
    steps.S5_kernelOps = cellHealth.kernelOpsHealth;
    steps.S6_adapterOps = cellHealth.adapterOpsHealth;
    applyApiGateToComposeSidecarSteps(steps);
    try {
      steps.S3 = assertComposeKernelBackend();
    } catch {
      steps.S3 = false;
    }
  } else {
    const headers: Record<string, string> = {};
    if (options.apiKey) headers.Authorization = 'Bearer ' + options.apiKey;

    const ready = await fetch(baseUrl + '/ready', { headers }).catch(() => null);
    steps.S1 = ready?.ok === true;

    const health = await fetch(baseUrl + '/health', { headers }).catch(() => null);
    steps.S2 = health?.ok === true;

    try {
      steps.S3 = assertComposeKernelBackend();
    } catch {
      steps.S3 = false;
    }
  }

  // 默认路径不硬依赖 chaos；完整 helper 属后续 wedge。
  await runOptionalChaosStep(steps);

  return {
    mode,
    passed: Object.values(steps).every(Boolean),
    steps,
    gitSha: resolveGitSha(),
    topology: mode === 'compose' ? 'compose-cell' : mode,
    elapsedMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseUrlIdx = args.indexOf('--base-url');
  const modeIdx = args.indexOf('--mode');
  const baseUrl = baseUrlIdx >= 0 ? args[baseUrlIdx + 1] : 'http://localhost:4000';
  const mode = (modeIdx >= 0 ? args[modeIdx + 1] : 'compose') as CellSmokeMode;
  const apiKey = process.env.COMMANDER_API_KEY;

  const result = await runCellSmoke({ baseUrl, mode, apiKey });
  const outDir = join(process.cwd(), 'artifacts');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'l4-b-cell-smoke-' + Date.now() + '.json');
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(
    'Cell smoke ' + (result.passed ? 'PASS' : 'FAIL') + ' → ' + outPath,
  );
  if (!result.passed) process.exit(1);
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
