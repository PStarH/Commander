import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type SandboxIsolation = 'process' | 'docker' | 'gvisor';
export type SandboxEnvironment = 'development' | 'test' | 'staging' | 'production';

export interface SandboxPolicy {
  environment: SandboxEnvironment;
  isolation: SandboxIsolation;
  failClosed: boolean;
  noSandboxBypassRequested: boolean;
  uncheckedExecutionBypassRequested: boolean;
  pluginSandboxMode: string;
  pluginSoftFallbackRequested: boolean;
}

export class SandboxPolicyError extends Error {
  readonly code = 'SANDBOX_POLICY_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'SandboxPolicyError';
  }
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveEnvironment(value: string | undefined): SandboxEnvironment {
  switch (value?.toLowerCase()) {
    case 'production':
      return 'production';
    case 'staging':
      return 'staging';
    case 'test':
      return 'test';
    default:
      return 'development';
  }
}

function resolveIsolation(
  raw: string | undefined,
  environment: SandboxEnvironment,
): SandboxIsolation {
  if (raw === undefined || raw.trim() === '') {
    return environment === 'production' || environment === 'staging' ? 'docker' : 'process';
  }

  const isolation = raw.trim().toLowerCase();
  if (isolation === 'process' || isolation === 'docker' || isolation === 'gvisor') {
    return isolation;
  }
  throw new SandboxPolicyError(
    `Unsupported COMMANDER_SANDBOX_ISOLATION value "${raw}". Expected process, docker, or gvisor.`,
  );
}

export function resolveSandboxPolicy(env: NodeJS.ProcessEnv = process.env): SandboxPolicy {
  const environment = resolveEnvironment(env.NODE_ENV);
  const policy: SandboxPolicy = {
    environment,
    isolation: resolveIsolation(env.COMMANDER_SANDBOX_ISOLATION, environment),
    failClosed: environment === 'production',
    noSandboxBypassRequested: isTruthy(env.COMMANDER_ALLOW_NO_SANDBOX),
    uncheckedExecutionBypassRequested: isTruthy(env.COMMANDER_ALLOW_UNCHECKED_EXEC),
    pluginSandboxMode:
      env.COMMANDER_PLUGIN_SANDBOX?.trim().toLowerCase() ||
      (environment === 'production' ? 'required' : 'in_process'),
    pluginSoftFallbackRequested: isTruthy(env.COMMANDER_PLUGIN_SANDBOX_SOFT),
  };

  assertProductionSandboxPolicy(policy);
  return policy;
}

export function assertProductionSandboxPolicy(policy: SandboxPolicy): void {
  if (policy.environment !== 'production') return;

  if (policy.noSandboxBypassRequested) {
    throw new SandboxPolicyError(
      'COMMANDER_ALLOW_NO_SANDBOX is forbidden in production; refusing to start.',
    );
  }
  if (policy.uncheckedExecutionBypassRequested) {
    throw new SandboxPolicyError(
      'COMMANDER_ALLOW_UNCHECKED_EXEC is forbidden in production; refusing to start.',
    );
  }
  if (policy.isolation === 'process') {
    throw new SandboxPolicyError(
      'process isolation is not an accepted production baseline; select docker or gvisor.',
    );
  }
  if (policy.pluginSandboxMode !== 'required') {
    throw new SandboxPolicyError(
      `COMMANDER_PLUGIN_SANDBOX=${policy.pluginSandboxMode} is forbidden in production; required is mandatory.`,
    );
  }
  if (policy.pluginSoftFallbackRequested) {
    throw new SandboxPolicyError(
      'COMMANDER_PLUGIN_SANDBOX_SOFT is forbidden in production; soft fallback is disabled.',
    );
  }
}

export function assertProductionSandboxReady(
  options: {
    policy?: SandboxPolicy;
    availableMechanisms?: readonly string[];
  } = {},
): void {
  const policy = options.policy ?? resolveSandboxPolicy();
  assertProductionSandboxPolicy(policy);
  if (policy.environment !== 'production') return;

  const available = options.availableMechanisms ?? [];
  if (!available.includes(policy.isolation)) {
    throw new SandboxPolicyError(
      `Required production sandbox "${policy.isolation}" is unavailable. Available: ${available.join(', ') || 'none'}.`,
    );
  }
}

export function assertProductionSandboxSource(root = process.cwd()): void {
  const files = [
    'packages/core/src/sandbox/productionPolicy.ts',
    'packages/core/src/sandbox/manager.ts',
    'packages/core/src/sandbox/executionRouter.ts',
    'packages/core/src/sandbox/platforms.ts',
    'packages/core/src/sandbox/backends/localBackend.ts',
    'packages/core/src/plugins/pluginSandbox.ts',
    'packages/core/src/runtime/toolExecutionService.ts',
    'packages/core/src/tools/codeExecutionTool.ts',
  ];
  const forbiddenConstant = /(?:const|let|var)\s+ALLOW_NO_SANDBOX\b/;

  for (const relativePath of files) {
    const path = resolve(root, relativePath);
    const source = readFileSync(path, 'utf8');
    if (forbiddenConstant.test(source)) {
      throw new SandboxPolicyError(
        `Production source ${relativePath} declares an ALLOW_NO_SANDBOX constant.`,
      );
    }
  }

  const policySource = readFileSync(resolve(root, files[0]), 'utf8');
  if (!policySource.includes('assertProductionSandboxReady')) {
    throw new SandboxPolicyError(
      'Production sandbox readiness guard is missing from the build input.',
    );
  }
}
