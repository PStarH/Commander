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

export interface AgentDef {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
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

    const ctx: AgentExecutionContext = {
      agentId: `subagent-${name}-${Date.now()}`,
      projectId: 'subagent',
      goal,
      contextData: {},
      availableTools: agentDef?.tools || tools,
      maxSteps: 15,
      tokenBudget: 25000,
    };

    try {
      const result = await this.runtime.execute(ctx);
      if (result.status === 'success' && result.summary) {
        // Return condensed summary (Claude Code pattern: ~1-2K tokens)
        const summary = result.summary.slice(0, 2000);
        return `[Sub-agent "${name}" completed]\n\n${summary}`;
      }
      return `[Sub-agent "${name}" ${result.status}]\n${result.error || 'No output'}`;
    } catch (err: any) {
      return `[Sub-agent "${name}" error]\n${err.message || String(err)}`;
    }
  }
}
