"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.A2ADelegateTool = void 0;
const DEFINITION = {
    name: 'a2a_delegate',
    description: "Delegate a task to a remote A2A-compatible agent. Use this when a task requires specialized capabilities (research, deep analysis, code review) that another agent in the network can handle. Returns the remote agent's response.",
    inputSchema: {
        type: 'object',
        properties: {
            agent: {
                type: 'string',
                description: 'Label of the target A2A agent (e.g., "research-agent", "code-reviewer"). Use "list" to see available agents.',
            },
            task: {
                type: 'string',
                description: 'The task description to send to the remote agent.',
            },
            wait: {
                type: 'boolean',
                description: 'Wait for the remote agent to complete before returning (default: true).',
            },
            timeout: {
                type: 'number',
                description: 'Maximum wait time in ms (default: 120000, max: 300000).',
            },
        },
        required: ['agent', 'task'],
    },
    examples: [
        {
            name: 'a2a_delegate',
            arguments: {
                agent: 'code-reviewer',
                task: 'Review the changes in src/runtime/ for potential issues',
            },
        },
        {
            name: 'a2a_delegate',
            arguments: {
                agent: 'research-agent',
                task: 'Find best practices for implementing RAG',
                wait: true,
            },
        },
    ],
    category: 'development',
};
class A2ADelegateTool {
    constructor(discoveryManager) {
        this.definition = DEFINITION;
        this.isConcurrencySafe = true;
        this.isReadOnly = false;
        this.timeout = 300000;
        this.maxOutputSize = 100000;
        this.discoveryManager = discoveryManager;
    }
    async execute(args) {
        var _a;
        const agentLabel = String(args.agent || '');
        const task = String(args.task || '');
        const wait = args.wait !== false;
        const timeout = Math.min(Number(args.timeout) || 120000, 300000);
        if (agentLabel === 'list') {
            const agents = this.discoveryManager.getAllAgents();
            if (agents.length === 0) {
                return 'No A2A agents are currently connected. Configure them in .commander.json under a2a.remoteAgents.';
            }
            return agents
                .map((a) => `- ${a.label}: ${a.card.name} (${a.url}) — ${a.card.description.slice(0, 100)}`)
                .join('\n');
        }
        const agent = this.discoveryManager.getAgent(agentLabel);
        if (!agent) {
            const available = this.discoveryManager
                .getAllAgents()
                .map((a) => a.label)
                .join(', ') || 'none';
            return `Unknown A2A agent "${agentLabel}". Available agents: ${available}. Use agent="list" to see details.`;
        }
        const client = agent.client;
        const message = {
            messageId: `msg_${Date.now()}`,
            role: 'user',
            parts: [{ type: 'text', text: task }],
        };
        try {
            const taskResult = await client.sendMessage(message);
            if (!wait) {
                return `Task ${taskResult.id} submitted to "${agentLabel}". Poll with a2a_delegate agent="${agentLabel}" task="tasks/get:${taskResult.id}" or check via the agent's native endpoint.`;
            }
            const completed = await client.waitForTask(taskResult.id, 1000, timeout);
            if (completed.status.state === 'COMPLETED') {
                const artifacts = (_a = completed.artifacts) !== null && _a !== void 0 ? _a : [];
                const texts = artifacts.flatMap((a) => a.parts
                    .filter((p) => p.type === 'text')
                    .map((p) => p.text));
                const resultText = texts.join('\n\n') || `Task completed with no output artifacts.`;
                return `[A2A "${agentLabel}" completed]\n\n${resultText.slice(0, 50000)}`;
            }
            return `[A2A "${agentLabel}" ${completed.status.state}]\n${completed.status.message || 'No details'}`;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `[A2A "${agentLabel}" error]\n${msg}`;
        }
    }
}
exports.A2ADelegateTool = A2ADelegateTool;
