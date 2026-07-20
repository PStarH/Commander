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
  /** CPU limit (number of cores). Default: 2. Enforced by Docker/gVisor via --cpus. */
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

export interface SandboxWorkloadContext {
  tenantId: string;
  runId: string;
  stepId: string;
  workloadId: string;
}

export interface PlatformSandbox {
  readonly name: SandboxMechanism;
  readonly available: boolean;
  execute(
    command: string,
    profile: SandboxProfile,
    workdir?: string,
    context?: SandboxWorkloadContext,
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
  execute(
    command: string,
    workdir?: string,
    timeout?: number,
    context?: SandboxWorkloadContext,
  ): Promise<SandboxExecutionResult>;
}
