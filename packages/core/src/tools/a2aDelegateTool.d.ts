/**
 * A2ADelegateTool — lets Commander agents delegate tasks to remote A2A agents.
 *
 * Agents call this tool with an agent label and task description.
 * The tool looks up the agent in A2ADiscoveryManager, sends the task
 * via JSON-RPC, waits for completion, and returns the result.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import type { A2ADiscoveryManager } from '../mcp/a2aClient';
export declare class A2ADelegateTool implements Tool {
    readonly definition: ToolDefinition;
    readonly isConcurrencySafe = true;
    readonly isReadOnly = false;
    readonly timeout = 300000;
    readonly maxOutputSize = 100000;
    private discoveryManager;
    constructor(discoveryManager: A2ADiscoveryManager);
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=a2aDelegateTool.d.ts.map