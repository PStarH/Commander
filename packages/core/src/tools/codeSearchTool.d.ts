import type { Tool, ToolDefinition } from '../runtime/types';
export declare class CodeSearchTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=codeSearchTool.d.ts.map