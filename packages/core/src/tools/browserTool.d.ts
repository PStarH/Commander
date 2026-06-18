import type { Tool, ToolDefinition } from '../runtime/types';
export declare class BrowserSearchTool implements Tool {
    readonly definition: ToolDefinition;
    isReadOnly: boolean;
    isConcurrencySafe: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class BrowserFetchTool implements Tool {
    readonly definition: ToolDefinition;
    isReadOnly: boolean;
    isConcurrencySafe: boolean;
    timeout: number;
    maxOutputSize: number;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=browserTool.d.ts.map