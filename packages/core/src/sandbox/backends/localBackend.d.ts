import type { ExecutionBackend, SandboxExecutionResult } from '../types';
export interface LocalBackendConfig {
    /** When true, reject execution if no sandbox is available instead of falling back to execSync. */
    rejectOnNoSandbox?: boolean;
}
/**
 * Local execution backend — runs commands through the OS sandbox (Seatbelt/Bwrap/Docker)
 * or falls back to direct execSync when sandbox is unavailable.
 */
export declare class LocalBackend implements ExecutionBackend {
    readonly type: "local";
    readonly available = true;
    private config;
    constructor(config?: LocalBackendConfig);
    execute(command: string, workdir?: string, timeout?: number): Promise<SandboxExecutionResult>;
}
//# sourceMappingURL=localBackend.d.ts.map