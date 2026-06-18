import type { ExecutionBackend, ExecutionBackendType, SandboxExecutionResult } from './types';
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
export declare class ExecutionRouter {
    private localBackend;
    private backends;
    constructor();
    /**
     * Register a named backend (e.g., "prod-server", "db-container").
     * Named backends persist and can be referenced by name in tool calls.
     */
    registerBackend(name: string, backend: ExecutionBackend): void;
    /**
     * Get a registered backend by name.
     */
    getBackend(name: string): ExecutionBackend | undefined;
    /**
     * List all registered backends.
     */
    listBackends(): Array<{
        name: string;
        type: ExecutionBackendType;
        available: boolean;
    }>;
    /**
     * Select the appropriate backend for a tool call based on arguments.
     *
     * Selection logic:
     *   1. If `backend_name` is provided and matches a registered backend → use it
     *   2. If `backend` arg is "ssh"  or has ssh_host → create ephemeral SSHBackend
     *   3. If `backend` arg is "docker" or has container/container_id → create ephemeral DockerExecBackend
     *   4. Default → LocalBackend
     */
    selectBackend(args: Record<string, unknown>): Promise<ExecutionBackend>;
    /**
     * Execute a command through the appropriate backend.
     * This is a convenience wrapper around selectBackend + execute.
     */
    execute(command: string, args: Record<string, unknown>, workdir?: string): Promise<SandboxExecutionResult>;
}
export declare function getExecutionRouter(): ExecutionRouter;
export declare function resetExecutionRouter(): void;
//# sourceMappingURL=executionRouter.d.ts.map