/**
 * STRAP-Consolidated Resource Tools
 *
 * Single Tool Resource Action Pattern (STRAP):
 * Instead of one tool per CRUD operation, define domain-level resource tools
 * with an `action` parameter. This reduces tool count by 80–90% and directly
 * addresses the semantic confusion problem (Section 2.3 of the Synthesis doc).
 *
 * Resource domains consolidated:
 *   - file       → file_read, file_write, file_edit, file_search, file_list, glob
 *   - memory     → memory_store, memory_recall, memory_list
 *   - web        → web_search, web_fetch
 *   - browser    → browser_search, browser_fetch
 *   - code       → code_search, refine_code, fix_code
 *   - checkpoint → checkpoint_save, checkpoint_rewind, checkpoint_list, checkpoint_collapse
 *   - handoff    → handoff, handoff_check
 *   - exec       → python_execute, shell_execute, execute_script
 *   - media      → vision_analyze, screenshot_capture, pdf_extract
 *   - system     → request_human_input, request_tool
 */
import type { Tool, ToolDefinition, AgentExecutionContext } from '../runtime/types';
import type { AgentHandoff } from '../runtime/agentHandoff';
export declare class FileResourceTool implements Tool {
    definition: ToolDefinition;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class MemoryResourceTool implements Tool {
    definition: ToolDefinition;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class WebResourceTool implements Tool {
    definition: ToolDefinition;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class BrowserResourceTool implements Tool {
    definition: ToolDefinition;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class CodeResourceTool implements Tool {
    definition: ToolDefinition;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class CheckpointResourceTool implements Tool {
    definition: ToolDefinition;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class HandoffResourceTool implements Tool {
    definition: ToolDefinition;
    private handoff?;
    private agentId;
    setHandoff(handoff: AgentHandoff, agentId?: string): void;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class ExecResourceTool implements Tool {
    definition: ToolDefinition;
    private scriptTool;
    private toolMap;
    setTools(tools: Map<string, Tool>): void;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class MediaResourceTool implements Tool {
    definition: ToolDefinition;
    private actions;
    constructor();
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class SystemResourceTool implements Tool {
    definition: ToolDefinition;
    private humanInputTool;
    private requestToolResolver;
    private registryTools;
    setToolResolver(resolver: (name: string) => ToolDefinition | undefined, registryTools?: string[]): void;
    private actions;
    constructor();
    execute(args: Record<string, unknown>, ctx?: AgentExecutionContext): Promise<string>;
}
export declare function createResourceTools(): Map<string, Tool>;
/**
 * Wire runtime dependencies for resource tools that need them.
 * Call after all tools are registered with the runtime.
 */
export declare function wireResourceToolDependencies(tools: Map<string, Tool>, deps: {
    handoff?: {
        handoff: AgentHandoff;
        agentId?: string;
    };
    toolResolver?: (name: string) => ToolDefinition | undefined;
    registryTools?: string[];
}): void;
//# sourceMappingURL=resourceTools.d.ts.map