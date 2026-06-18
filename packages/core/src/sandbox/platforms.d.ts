import type { PlatformSandbox, SandboxProfile, SandboxExecutionResult } from './types';
declare class NoopSB implements PlatformSandbox {
    readonly name: "none";
    readonly available = true;
    execute(cmd: string, p: SandboxProfile, wd?: string): Promise<SandboxExecutionResult>;
}
export declare function discoverSandboxes(): PlatformSandbox[];
export { NoopSB };
//# sourceMappingURL=platforms.d.ts.map