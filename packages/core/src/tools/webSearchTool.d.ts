import type { Tool, ToolDefinition } from '../runtime/types';
export declare class WebSearchTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
    private tryDuckDuckGo;
    private tryBing;
    private tryGoogle;
    private parseGoogle;
    private parseDuckDuckGo;
    private parseBing;
}
export declare class WebFetchTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=webSearchTool.d.ts.map