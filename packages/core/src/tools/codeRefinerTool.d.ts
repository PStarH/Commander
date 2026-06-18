import type { Tool, ToolDefinition } from '../runtime/types';
export declare class CodeRefinerTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
    private runTests;
    private getTemplate;
}
//# sourceMappingURL=codeRefinerTool.d.ts.map