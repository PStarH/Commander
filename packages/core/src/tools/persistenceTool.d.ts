import type { Tool, ToolDefinition } from '../runtime/types';
export declare class MemoryStoreTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class MemoryRecallTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class MemoryListTool implements Tool {
    definition: ToolDefinition;
    execute(): Promise<string>;
}
//# sourceMappingURL=persistenceTool.d.ts.map