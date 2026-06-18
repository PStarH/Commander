import type { ExecutionBackend, DockerExecConfig, SandboxExecutionResult } from '../types';
/**
 * Docker exec backend — executes commands inside running Docker containers
 * using the `docker exec` CLI. Supports user, workdir, and full environment control.
 */
export declare class DockerExecBackend implements ExecutionBackend {
    readonly type: "docker_exec";
    private config;
    private _available;
    constructor(config: DockerExecConfig);
    get available(): boolean;
    execute(command: string, workdir?: string, timeout?: number): Promise<SandboxExecutionResult>;
}
/**
 * Resolve Docker exec configuration from tool arguments and environment.
 *
 * Priority: explicit args > env vars
 */
export declare function resolveDockerExecConfig(args: Record<string, unknown>): DockerExecConfig | null;
//# sourceMappingURL=dockerExecBackend.d.ts.map