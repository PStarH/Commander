/**
 * AgentTool — Claude Code-inspired sub-agent spawning.
 *
 * Spawns an isolated sub-agent with its own context, tools, and token budget.
 * The sub-agent runs in a clean session, completes its task, and returns
 * a condensed summary (~1-2K tokens) to the parent.
 *
 * Key features borrowed from Claude Code:
 * - Fresh context per sub-agent (no conversation history bleed)
 * - Configurable tool allowlist per sub-agent
 * - Result summarization (not full transcript)
 * - Hard depth limit of 1 (sub-agents cannot spawn sub-agents)
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import type { AgentRuntimeInterface } from '../runtime';
export interface AgentDef {
    name: string;
    description: string;
    prompt: string;
    tools?: string[];
    /** Hard whitelist of tools this agent is allowed to use.
     *  If set, the sub-agent can ONLY use these tools, regardless of what the
     *  parent agent requests. Use for security/isolation boundaries. */
    allowedTools?: string[];
    model?: string;
}
export declare class AgentTool implements Tool {
    readonly definition: ToolDefinition;
    isConcurrencySafe: boolean;
    isReadOnly: boolean;
    timeout: number;
    maxOutputSize: number;
    private runtime;
    private registeredAgents;
    constructor(runtime: AgentRuntimeInterface);
    registerAgent(def: AgentDef): void;
    getRegisteredAgents(): AgentDef[];
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=agentTool.d.ts.map