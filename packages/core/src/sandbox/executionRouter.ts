import { reportSilentFailure } from '../silentFailureReporter';
import type {
  ExecutionBackend,
  ExecutionBackendType,
  SandboxExecutionResult,
  SandboxWorkloadContext,
} from './types';
import { LocalBackend } from './backends/localBackend';
import { SSHBackend, resolveSSHConfig } from './backends/sshBackend';
import { DockerExecBackend, resolveDockerExecConfig } from './backends/dockerExecBackend';
import { getLaneManager } from './lane';
import { getGlobalLogger } from '../logging';
import { resolveSandboxPolicy, SandboxPolicyError } from './productionPolicy';
import { validateSandboxWorkloadContext } from './workload';
import { getHookManager } from '../pluginManager';

/**
 * ExecutionRouter — manages a set of execution backends and routes
 * shell/code execution tool calls to the appropriate backend.
 *
 * Supports three backend types:
 *   - local: runs through the OS sandbox (Seatbelt/Bwrap/Docker) or fallback execSync
 *   - ssh:  runs on a remote host via the `ssh` CLI
 *   - docker_exec: runs inside a running Docker container via `docker exec`
 *
 * Backend selection is driven by tool call arguments:
 *   - backend="ssh"    + ssh_host, ssh_user, ssh_key, etc.
 *   - backend="docker"  + container/container_id, docker_user, etc.
 *   - backend="local"   (default, no extra config needed)
 */
export class ExecutionRouter {
  private localBackend: LocalBackend;
  private backends: Map<string, ExecutionBackend> = new Map();
  private readonly environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.environment = environment;
    this.localBackend = new LocalBackend({ rejectOnNoSandbox: true });
  }

  /**
   * Register a named backend (e.g., "prod-server", "db-container").
   * Named backends persist and can be referenced by name in tool calls.
   */
  registerBackend(name: string, backend: ExecutionBackend): void {
    this.backends.set(name, backend);
    getGlobalLogger().info('ExecutionRouter', `Registered backend "${name}" (${backend.type})`);
  }

  /**
   * Get a registered backend by name.
   */
  getBackend(name: string): ExecutionBackend | undefined {
    return this.backends.get(name);
  }

  /**
   * List all registered backends.
   */
  listBackends(): Array<{ name: string; type: ExecutionBackendType; available: boolean }> {
    const result: Array<{ name: string; type: ExecutionBackendType; available: boolean }> = [];
    for (const [name, backend] of this.backends) {
      result.push({ name, type: backend.type, available: backend.available });
    }
    return result;
  }

  /**
   * Select the appropriate backend for a tool call based on arguments.
   *
   * Selection logic:
   *   1. If `backend_name` is provided and matches a registered backend → use it
   *   2. If `backend` arg is "ssh"  or has ssh_host → create ephemeral SSHBackend
   *   3. If `backend` arg is "docker" or has container/container_id → create ephemeral DockerExecBackend
   *   4. Default → LocalBackend
   */
  async selectBackend(args: Record<string, unknown>): Promise<ExecutionBackend> {
    const toolName = String(args._toolName ?? 'shell_execute');
    this.assertProductionBackendRequest(args);

    // ── Hook: beforeBackendSelect (can override by returning a registered backend name) ──
    try {
      const hookOverride = await getHookManager().fireBeforeBackendSelect({
        toolName,
        args,
        agentId: String(args._agentId ?? ''),
        runId: String(args._runId ?? ''),
      });
      if (hookOverride && this.backends.has(hookOverride)) {
        return this.backends.get(hookOverride)!;
      }
    } catch (err) {
      reportSilentFailure(err, 'executionRouter:82');
      getGlobalLogger().debug('ExecutionRouter', 'beforeBackendSelect hook failed');
    }

    // Named backend takes priority
    const backendName = String(args.backend_name ?? '');
    if (backendName && this.backends.has(backendName)) {
      return this.backends.get(backendName)!;
    }

    // Lane-pinned backend: if the resolved execution lane has a pinned backend, use it
    const laneBackend = getLaneManager().getLaneBackend({
      tenantId: String(args._tenantId ?? ''),
      agentId: String(args._agentId ?? ''),
      runId: String(args._runId ?? ''),
      toolName,
      args,
    });
    if (laneBackend && this.backends.has(laneBackend)) {
      return this.backends.get(laneBackend)!;
    }

    const backendType = String(args.backend ?? '').toLowerCase();

    // SSH backend
    if (backendType === 'ssh' || args.ssh_host) {
      const sshConfig = resolveSSHConfig(args);
      if (sshConfig) {
        return new SSHBackend(sshConfig);
      }
    }

    // Docker exec backend
    if (backendType === 'docker' || args.container || args.container_id) {
      const dockerConfig = resolveDockerExecConfig(args);
      if (dockerConfig) {
        return new DockerExecBackend(dockerConfig);
      }
    }

    // Default: local
    return this.localBackend;
  }

  /**
   * Execute a command through the appropriate backend.
   * This is a convenience wrapper around selectBackend + execute.
   */
  async execute(
    command: string,
    args: Record<string, unknown>,
    workdir?: string,
  ): Promise<SandboxExecutionResult> {
    const backend = await this.selectBackend(args);
    const timeout = Number(args.timeout ?? 60);
    const context = this.getWorkloadContext(args);
    return backend.execute(command, workdir, timeout, context);
  }

  private assertProductionBackendRequest(args: Record<string, unknown>): void {
    const policy = resolveSandboxPolicy(this.environment);
    if (policy.environment !== 'production') return;

    const backend = String(args.backend ?? '').toLowerCase();
    if (
      args.backend_name ||
      backend === 'ssh' ||
      args.ssh_host ||
      backend === 'docker' ||
      args.container ||
      args.container_id ||
      backend === 'local'
    ) {
      throw new SandboxPolicyError(
        'Production execution accepts only the policy-selected local sandbox adapter; host, SSH, and arbitrary Docker backends are forbidden.',
      );
    }
  }

  private getWorkloadContext(args: Record<string, unknown>): SandboxWorkloadContext | undefined {
    return resolveRuntimeWorkloadContext(args, this.environment);
  }
}

/** Resolve runtime-metadata workload args (_tenantId, …) into a context object. */
export function resolveRuntimeWorkloadContext(
  args: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = process.env,
): SandboxWorkloadContext | undefined {
  const values = [args._tenantId, args._runId, args._stepId, args._workloadId];
  const hasAnyContext = values.some((value) => value !== undefined);
  if (!values.every((value) => typeof value === 'string' && value.length > 0)) {
    if (hasAnyContext && resolveSandboxPolicy(environment).environment === 'production') {
      throw new SandboxPolicyError('Production execution requires a complete workload context.');
    }
    return undefined;
  }
  const context: SandboxWorkloadContext = {
    tenantId: String(args._tenantId),
    runId: String(args._runId),
    stepId: String(args._stepId),
    workloadId: String(args._workloadId),
  };
  try {
    validateSandboxWorkloadContext(context);
  } catch (error) {
    if (resolveSandboxPolicy(environment).environment === 'production') throw error;
    return undefined;
  }
  return context;
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const executionRouterSingleton = createTenantAwareSingleton(() => new ExecutionRouter(), {});

export function getExecutionRouter(): ExecutionRouter {
  return executionRouterSingleton.get();
}

export function resetExecutionRouter(): void {
  executionRouterSingleton.reset();
}
