import type { PlatformSandbox, SandboxProfile, SandboxMechanism, SandboxExecutionResult } from './types';
export declare class SandboxManager {
    private sandboxes;
    private noop;
    constructor();
    getAvailableMechanisms(): SandboxMechanism[];
    hasSandbox(): boolean;
    getSandbox(mechanism?: SandboxMechanism): PlatformSandbox;
    getProfile(name?: string): SandboxProfile;
    execute(command: string, profile?: SandboxProfile | string, workdir?: string, mechanism?: SandboxMechanism): Promise<SandboxExecutionResult>;
}
export declare function getSandboxManager(): SandboxManager;
export declare function resetSandboxManager(): void;
//# sourceMappingURL=manager.d.ts.map