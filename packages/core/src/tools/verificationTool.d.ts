import type { Tool, ToolDefinition } from '../runtime/types';
export declare class VerificationTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
    private runCommand;
    private runLint;
    private runTypeCheck;
    private runTests;
    private runBuild;
    private hasTool;
    private hasFile;
}
//# sourceMappingURL=verificationTool.d.ts.map