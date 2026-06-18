export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    killed: boolean;
}
/**
 * Execute a command through the ExecutionRouter.
 * The router picks the right backend (local/ssh/docker_exec) based on args.
 *
 * @param command  Shell command to execute
 * @param timeoutSec  Timeout in seconds
 * @param workdir  Working directory
 * @param backendArgs  Tool call arguments for backend selection (backend, ssh_host, container, etc.)
 */
export declare function execSandboxed(command: string, timeoutSec: number, workdir?: string, backendArgs?: Record<string, unknown>): Promise<ExecResult>;
//# sourceMappingURL=sandboxedExec.d.ts.map