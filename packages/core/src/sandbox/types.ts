/**
 * Sandbox Types — Execution confinement layer
 *
 * Inspired by Codex (Seatbelt/bwrap), Claude Code (sandboxed bash),
 * and Hermes (Docker/SSH backends).
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access';
export type NetworkPolicy = 'blocked' | 'allowlisted' | 'proxy' | 'full';
export type SandboxMechanism = 'seatbelt' | 'bwrap' | 'appcontainer' | 'docker' | 'none';

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
