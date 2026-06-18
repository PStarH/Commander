import type { Tool, ToolDefinition } from '../runtime/types';
/**
 * ExecuteScriptTool — Programmatic Tool Calling
 *
 * Allows the agent to write a JavaScript/TypeScript script that calls other tools
 * programmatically, collecting results and producing a final output WITHOUT
 * requiring multiple LLM round-trips for each tool call.
 *
 * Reference: Claude Code's programmatic tool calling (Python→RPC→stdout),
 * Hermes Agent's execute_code (Python→RPC→stdout).
 *
 * How it works:
 * 1. Agent writes a script using the `tools` object (pre-injected)
 * 2. Script calls any number of tools via `tools.toolName(args)`
 * 3. Each call is executed, results are available in the script
 * 4. Only `console.log()` output is returned to the LLM context
 * 5. Intermediate tool results NEVER enter context → zero token waste
 *
 * BFCL v3 impact:
 *   Normal flow (5 tools) = 0.96^5 = 59% success
 *   Script flow (5 tools) = ~96% success (single LLM call)
 */
export declare class ExecuteScriptTool implements Tool {
    definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    /** Registered tool map — populated by the runtime */
    private toolMap;
    /**
     * Set the available tools for script execution.
     * Called by AgentRuntime when registering this tool.
     */
    setTools(tools: Map<string, (args: Record<string, unknown>) => Promise<string>>): void;
    execute(args: Record<string, unknown>): Promise<string>;
    private runScript;
}
//# sourceMappingURL=scriptTool.d.ts.map