"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentTool = void 0;
const pluginManager_1 = require("../pluginManager");
const logging_1 = require("../logging");
const DEFINITION = {
    name: 'agent',
    description: 'Spawn a sub-agent to handle a focused subtask independently. The sub-agent gets its own clean context and returns a summary. Use this for research, exploration, or any task that can run in isolation.',
    inputSchema: {
        type: 'object',
        properties: {
            task: { type: 'string', description: 'The task for the sub-agent to complete' },
            name: { type: 'string', description: 'Optional agent name/type to use' },
            tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tools the sub-agent may use. Default: browser_search, python_execute, file_read',
            },
        },
        required: ['task'],
    },
    examples: [
        { name: 'agent', arguments: { task: 'Research the latest Python 3.13 features' } },
        {
            name: 'agent',
            arguments: {
                task: 'Analyze the code in src/ for potential bugs',
                tools: ['file_read', 'code_search'],
            },
        },
    ],
    category: 'development',
};
class AgentTool {
    constructor(runtime) {
        this.definition = DEFINITION;
        this.isConcurrencySafe = false; // Sub-agents mutate state
        this.isReadOnly = false;
        this.timeout = 180000;
        this.maxOutputSize = 50000;
        this.registeredAgents = new Map();
        this.runtime = runtime;
    }
    registerAgent(def) {
        this.registeredAgents.set(def.name, def);
    }
    getRegisteredAgents() {
        return Array.from(this.registeredAgents.values());
    }
    async execute(args) {
        const task = String(args.task || '');
        const name = String(args.name || 'general');
        const tools = args.tools || ['browser_search', 'python_execute', 'file_read'];
        // Look up agent definition
        const agentDef = this.registeredAgents.get(name);
        const goal = agentDef ? `${agentDef.prompt}\n\nTask: ${task}` : task;
        // Resolve available tools: intersect agent definition's tools, caller's requested tools,
        // and the agent's hard allowedTools whitelist. This ensures sub-agents cannot escalate
        // privileges by requesting tools the agent definition does not permit.
        const defTools = agentDef === null || agentDef === void 0 ? void 0 : agentDef.tools;
        const allowedTools = agentDef === null || agentDef === void 0 ? void 0 : agentDef.allowedTools;
        let availableTools = defTools || tools;
        // Apply hard whitelist: if allowedTools is set, intersect with it
        if (allowedTools && allowedTools.length > 0) {
            availableTools = availableTools.filter((t) => allowedTools.includes(t));
            // Ensure there's at least one tool, or fall back to a safe default
            if (availableTools.length === 0) {
                availableTools = allowedTools;
            }
        }
        const ctx = {
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
            (0, pluginManager_1.getHookManager)()
                .fireOnSessionFork({
                parentRunId: 'subagent-parent',
                childRunId: `subagent-${name}-${Date.now()}`,
                agentId: ctx.agentId,
                goal,
            })
                .catch((e) => (0, logging_1.getGlobalLogger)().debug('AgentTool', 'onSessionFork hook error', {
                error: e === null || e === void 0 ? void 0 : e.message,
            }));
            const result = await this.runtime.execute(ctx);
            if (result.status === 'success' && result.summary) {
                // Return condensed summary (Claude Code pattern: ~1-2K tokens)
                const summary = result.summary.slice(0, 2000);
                return `[Sub-agent "${name}" completed]\n\n${summary}`;
            }
            return `[Sub-agent "${name}" ${result.status}]\n${result.error || 'No output'}`;
        }
        catch (err) {
            return `[Sub-agent "${name}" error]\n${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.AgentTool = AgentTool;
