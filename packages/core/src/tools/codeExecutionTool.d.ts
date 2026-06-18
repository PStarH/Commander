import type { Tool, ToolDefinition } from '../runtime/types';
export declare class PythonExecuteTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class ShellExecuteTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=codeExecutionTool.d.ts.map