import type { Tool, ToolDefinition } from '../runtime/types';
export declare class ApplyPatchTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=patchTool.d.ts.map