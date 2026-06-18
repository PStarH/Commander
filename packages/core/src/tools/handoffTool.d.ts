/**
 * HandoffTool — Agent-to-Agent Task Handoff
 *
 * Allows the LLM to initiate a handoff to another agent, passing a typed
 * WorkOrder and a compressed ContextSummary instead of full chat history.
 * Wraps AgentHandoff infrastructure.
 *
 * Research backing: Claude Code's agent handoff pattern, AutoGen's GroupChatManager.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import { AgentHandoff } from '../runtime/agentHandoff';
export declare class HandoffTool implements Tool {
    definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    private handoff;
    private agentId;
    constructor(handoff: AgentHandoff, agentId: string);
    execute(args: Record<string, unknown>): Promise<string>;
}
/**
 * HandoffCheckTool — Check status of a pending handoff
 */
export declare class HandoffCheckTool implements Tool {
    definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    private handoff;
    constructor(handoff: AgentHandoff);
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=handoffTool.d.ts.map