import type { Tool, ToolDefinition } from '../runtime/types';
export declare class GitTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=gitTool.d.ts.map