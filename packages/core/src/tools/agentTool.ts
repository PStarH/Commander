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
import type { Tool, ToolDefinition, AgentExecutionContext, AgentExecutionResult } from '../runtime/types';
import type { AgentRuntime } from '../runtime/agentRuntime';
import { getHookManager } from '../pluginManager';
import { getGlobalLogger } from '../logging';

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

const DEFINITION: ToolDefinition = {
  name: 'agent',
  description: 'Spawn a sub-agent to handle a focused subtask independently. The sub-agent gets its own clean context and returns a summary. Use this for research, exploration, or any task that can run in isolation.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task for the sub-agent to complete' },
      name: { type: 'string', description: 'Optional agent name/type to use' },
      tools: {
        type: 'array', items: { type: 'string' },
        description: 'Tools the sub-agent may use. Default: browser_search, python_execute, file_read',
      },
    },
    required: ['task'],
  },
  examples: [
    { name: 'agent', arguments: { task: 'Research the latest Python 3.13 features' } },
    { name: 'agent', arguments: { task: 'Analyze the code in src/ for potential bugs', tools: ['file_read', 'code_search'] } },
  ],
  category: 'development',
};

export class AgentTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = false; // Sub-agents mutate state
  isReadOnly = false;
  timeout = 180000;
  maxOutputSize = 50000;

  private runtime: AgentRuntime;
  private registeredAgents: Map<string, AgentDef> = new Map();

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

  registerAgent(def: AgentDef): void {
    this.registeredAgents.set(def.name, def);
  }

  getRegisteredAgents(): AgentDef[] {
    return Array.from(this.registeredAgents.values());
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const task = String(args.task || '');
    const name = String(args.name || 'general');
    const tools = (args.tools as string[]) || ['browser_search', 'python_execute', 'file_read'];

    // Look up agent definition
    const agentDef = this.registeredAgents.get(name);
    const goal = agentDef
      ? `${agentDef.prompt}\n\nTask: ${task}`
      : task;

    // Resolve available tools: intersect agent definition's tools, caller's requested tools,
    // and the agent's hard allowedTools whitelist. This ensures sub-agents cannot escalate
    // privileges by requesting tools the agent definition does not permit.
    const defTools = agentDef?.tools;
    const allowedTools = agentDef?.allowedTools;
    let availableTools = defTools || tools;

    // Apply hard whitelist: if allowedTools is set, intersect with it
    if (allowedTools && allowedTools.length > 0) {
      availableTools = availableTools.filter(t => allowedTools.includes(t));
      // Ensure there's at least one tool, or fall back to a safe default
      if (availableTools.length === 0) {
        availableTools = allowedTools;
      }
    }

    const ctx: AgentExecutionContext = {
      agentId: `subagent-${name}-${Date.now()}`,
      projectId: 'subagent',
      goal,
      contextData: {},
      availableTools,
      maxSteps: 15,
      tokenBudget: 25000,
    };

    try {
      // ── Hook: onSessionFork ──
      getHookManager().fireOnSessionFork({
        parentRunId: 'subagent-parent',
        childRunId: `subagent-${name}-${Date.now()}`,
        agentId: ctx.agentId,
        goal,
      }).catch(e => getGlobalLogger().debug('AgentTool', 'onSessionFork hook error', { error: (e as Error)?.message }));

      const result = await this.runtime.execute(ctx);
      if (result.status === 'success' && result.summary) {
        // Return condensed summary (Claude Code pattern: ~1-2K tokens)
        const summary = result.summary.slice(0, 2000);
        return `[Sub-agent "${name}" completed]\n\n${summary}`;
      }
      return `[Sub-agent "${name}" ${result.status}]\n${result.error || 'No output'}`;
    } catch (err: unknown) {
      return `[Sub-agent "${name}" error]\n${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
