/**
 * Sandbox Types — Execution confinement layer
 *
 * Inspired by Codex (Seatbelt/bwrap), Claude Code (sandboxed bash),
 * and Hermes (docker/SSH backends).
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access';
export type NetworkPolicy = 'blocked' | 'allowlisted' | 'proxy' | 'full';
export type SandboxMechanism =
  | 'v8-isolate'
  | 'seatbelt'
  | 'bwrap'
  | 'appcontainer'
  | 'docker'
  | 'gvisor'
  | 'tee'
  | 'ssh'
  | 'none';

/**
 * WS7 isolation level — the operator-facing knob that selects which sandbox
 * backend family to use. Distinct from SandboxMechanism (which is the
 * concrete backend discovered on the host).
 *
 * - `process`: OS subprocess constrained by seccomp/cgroup/network policy
 *   (seatbelt/bwrap/appcontainer). NOT host exec. Production rejects this.
 * - `docker`: Per-workload ephemeral OCI container. Production default.
 * - `gvisor`: Docker + runsc runtime. Explicit selection — never degrades.
 */
export type SandboxIsolation = 'process' | 'docker' | 'gvisor';

export interface FileAccessPolicy {
  readablePaths: string[];
  writablePaths: string[];
  protectedPaths: string[];
  useStagingDir: boolean;
  stagingDir?: string;
}

export interface SandboxProfile {
  mode: SandboxMode;
  network: NetworkPolicy;
  filesystem: FileAccessPolicy;
  allowedDomains?: string[];
  envVarDenyList?: string[];
  envVarAllowList?: string[];
  timeout?: number;
  memoryLimitMB?: number;
  /** CPU limit (number of cores). Default: 2. Enforced by Docker/gVisor via --cpus/--cpu-quota. */
  cpuLimit?: number;
  runAs?: string;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxMechanism: SandboxMechanism;
  violated?: string[];
}

export interface PlatformSandbox {
  readonly name: SandboxMechanism;
  readonly available: boolean;
  execute(
    command: string,
    profile: SandboxProfile,
    workdir?: string,
  ): Promise<SandboxExecutionResult>;
}

// ============================================================================
// Execution Backend Types (Sprint 2: Multi-Terminal)
// ============================================================================

/**
 * Identifies the execution backend to use for a tool call.
 */
export type ExecutionBackendType = 'local' | 'ssh' | 'docker_exec';

/**
 * SSH connection configuration for the remote execution backend.
 */
export interface SSHConfig {
  host: string;
  port: number;
  user: string;
  /** Path to SSH private key (default: ~/.ssh/id_rsa) */
  identityFile?: string;
  /** Additional SSH options passed as -o Key=Value */
  extraOptions?: Record<string, string>;
  /** Connection timeout in ms (default: 10000) */
  connectTimeoutMs?: number;
}

/**
 * Docker exec configuration for executing in running containers.
 */
export interface DockerExecConfig {
  /** Container name or ID to exec into */
  container: string;
  /** Working directory inside the container */
  workdir?: string;
  /** User to run as inside the container */
  user?: string;
  /**
   * Exact names of host environment variables to forward into the container.
   * Default-deny: only listed names are passed. When omitted, a conservative
   * built-in allowlist (PATH/HOME/USER/SHELL/TERM/LANG/TZ) is used. This is an
   * allowlist by design — never fall back to forwarding all of process.env.
   */
  envAllowList?: string[];
}

/**
 * Union of all backend-specific configs.
 */
export type BackendConfig = SSHConfig | DockerExecConfig;

/**
 * Execution backend — abstracts over local sandbox, SSH, and docker exec.
 */
export interface ExecutionBackend {
  readonly type: ExecutionBackendType;
  readonly available: boolean;
  execute(command: string, workdir?: string, timeout?: number): Promise<SandboxExecutionResult>;
}

// ============================================================================
// WS7: Per-tenant / per-workload sandbox identity
// ============================================================================

/**
 * WS7 §5.1 — Workload identity carried into every sandboxed execution.
 * All four identity fields must be non-empty and pass a safe-charset check
 * before container creation. Container names are server-generated.
 */
export interface WorkloadIdentity {
  tenantId: string;
  runId: string;
  stepId: string;
  workloadId: string;
}
