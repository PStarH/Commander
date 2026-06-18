import type { ExecutionBackend, SSHConfig, SandboxExecutionResult } from '../types';
/**
 * SSH execution backend — runs commands on a remote host via the `ssh` CLI.
 * Uses BatchMode and StrictHostKeyChecking=accept-new for non-interactive auth.
 */
export declare class SSHBackend implements ExecutionBackend {
    readonly type: "ssh";
    private config;
    constructor(config: SSHConfig);
    get available(): boolean;
    execute(command: string, workdir?: string, timeout?: number): Promise<SandboxExecutionResult>;
}
export declare function resolveSSHConfig(args: Record<string, unknown>): SSHConfig | null;
//# sourceMappingURL=sshBackend.d.ts.map