"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommanderAgentLoop = void 0;
const agentRuntime_1 = require("./runtime/agentRuntime");
const messageBus_1 = require("./runtime/messageBus");
const index_1 = require("./tools/index");
const orchestrator_1 = require("./ultimate/orchestrator");
const telosOrchestrator_1 = require("./telos/telosOrchestrator");
const deliberation_1 = require("./ultimate/deliberation");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const mcpToolAdapter_1 = require("./tools/mcpToolAdapter");
const a2aServer_1 = require("./mcp/a2aServer");
const a2aClient_1 = require("./mcp/a2aClient");
const a2aDelegateTool_1 = require("./tools/a2aDelegateTool");
const logging_1 = require("./logging");
const DEFAULT_CONFIG = {
    projectRoot: process.cwd(),
    maxConcurrentTasks: 5,
    sessionTimeoutMs: 3600000,
    stateFile: '.commander_state.json',
    tools: ['web', 'file', 'exec', 'git'],
};
class CommanderAgentLoop {
    constructor(config) {
        this.taskQueue = [];
        this.activeSessions = new Map();
        this.isRunning = false;
        this.mcpManager = null;
        this.a2aServer = null;
        this.a2aDiscoveryManager = null;
        this.logger = (0, logging_1.getGlobalLogger)();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.runtime = new agentRuntime_1.AgentRuntime();
        // Register all tools (synchronous, no dynamic imports needed)
        const allTools = (0, index_1.createAllTools)();
        for (const [name, tool] of allTools) {
            this.runtime.registerTool(name, tool);
        }
        (0, index_1.wireResourceToolDependencies)(allTools, {
            handoff: { handoff: this.runtime.getHandoff(), agentId: 'commander' },
            toolResolver: (name) => { var _a; return (_a = this.runtime.getTool(name)) === null || _a === void 0 ? void 0 : _a.definition; },
            registryTools: [],
        });
        this.telos = new telosOrchestrator_1.TELOSOrchestrator(this.runtime);
        this.orchestrator = new orchestrator_1.UltimateOrchestrator(this.telos, this.runtime);
        this.loadState();
    }
    /**
     * Register LLM providers from environment variables.
     * Uses dynamic imports to avoid loading all 21 provider modules at compile time.
     * Called from start() before the main loop begins.
     */
    async registerProviders() {
        const registrations = [];
        if (process.env.OPENAI_API_KEY) {
            const apiKey = process.env.OPENAI_API_KEY;
            const baseUrl = process.env.OPENAI_BASE_URL;
            const defaultModel = process.env.OPENAI_MODEL || 'gpt-4o';
            registrations.push(async () => {
                const { OpenAIProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/openaiProvider')));
                this.runtime.registerProvider('openai', new OpenAIProvider({ apiKey, baseUrl, defaultModel }));
            });
        }
        if (process.env.ANTHROPIC_API_KEY) {
            const apiKey = process.env.ANTHROPIC_API_KEY;
            registrations.push(async () => {
                const { AnthropicProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/anthropicProvider')));
                this.runtime.registerProvider('anthropic', new AnthropicProvider({ apiKey }));
            });
        }
        if (process.env.GOOGLE_API_KEY) {
            const apiKey = process.env.GOOGLE_API_KEY;
            registrations.push(async () => {
                const { GoogleProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/googleProvider')));
                this.runtime.registerProvider('google', new GoogleProvider({ apiKey }));
            });
        }
        if (process.env.OPENROUTER_API_KEY) {
            const apiKey = process.env.OPENROUTER_API_KEY;
            registrations.push(async () => {
                const { OpenRouterProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/openRouterProvider')));
                this.runtime.registerProvider('openrouter', new OpenRouterProvider({ apiKey }));
            });
        }
        if (process.env.DEEPSEEK_API_KEY) {
            const apiKey = process.env.DEEPSEEK_API_KEY;
            registrations.push(async () => {
                const { DeepSeekProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/deepseekProvider')));
                this.runtime.registerProvider('deepseek', new DeepSeekProvider({ apiKey }));
            });
        }
        if (process.env.ZHIPU_API_KEY) {
            const apiKey = process.env.ZHIPU_API_KEY;
            registrations.push(async () => {
                const { GLMProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/glmProvider')));
                this.runtime.registerProvider('glm', new GLMProvider({ apiKey }));
            });
        }
        if (process.env.MIMO_API_KEY) {
            const apiKey = process.env.MIMO_API_KEY;
            registrations.push(async () => {
                const { MiMoProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/mimoProvider')));
                this.runtime.registerProvider('mimo', new MiMoProvider({ apiKey }));
            });
        }
        if (process.env.XIAOMI_API_KEY) {
            const apiKey = process.env.XIAOMI_API_KEY;
            registrations.push(async () => {
                const { XiaomiProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/xiaomiProvider')));
                this.runtime.registerProvider('xiaomi', new XiaomiProvider({ apiKey }));
            });
        }
        if (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
            const baseUrl = process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || undefined;
            const defaultModel = process.env.OLLAMA_MODEL || undefined;
            registrations.push(async () => {
                const { OllamaProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/ollamaProvider')));
                this.runtime.registerProvider('ollama', new OllamaProvider({ baseUrl, defaultModel }));
            });
        }
        if (process.env.VLLM_BASE_URL || process.env.VLLM_MODEL) {
            const baseUrl = process.env.VLLM_BASE_URL || undefined;
            const defaultModel = process.env.VLLM_MODEL || undefined;
            registrations.push(async () => {
                const { VLLMProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/vllmProvider')));
                this.runtime.registerProvider('vllm', new VLLMProvider({ baseUrl, defaultModel }));
            });
        }
        if (process.env.CO_API_KEY || process.env.COHERE_API_KEY) {
            const apiKey = process.env.CO_API_KEY || process.env.COHERE_API_KEY || '';
            registrations.push(async () => {
                const { CohereProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/cohereProvider')));
                this.runtime.registerProvider('cohere', new CohereProvider({ apiKey }));
            });
        }
        if (process.env.MISTRAL_API_KEY) {
            const apiKey = process.env.MISTRAL_API_KEY;
            registrations.push(async () => {
                const { MistralProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/mistralProvider')));
                this.runtime.registerProvider('mistral', new MistralProvider({ apiKey }));
            });
        }
        if (process.env.GROQ_API_KEY) {
            const apiKey = process.env.GROQ_API_KEY;
            registrations.push(async () => {
                const { GroqProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/groqProvider')));
                this.runtime.registerProvider('groq', new GroqProvider({ apiKey }));
            });
        }
        if (process.env.TOGETHER_API_KEY) {
            const apiKey = process.env.TOGETHER_API_KEY;
            registrations.push(async () => {
                const { TogetherProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/togetherProvider')));
                this.runtime.registerProvider('together', new TogetherProvider({ apiKey }));
            });
        }
        if (process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY) {
            const apiKey = process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY || '';
            registrations.push(async () => {
                const { PerplexityProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/perplexityProvider')));
                this.runtime.registerProvider('perplexity', new PerplexityProvider({ apiKey }));
            });
        }
        if (process.env.FIREWORKS_API_KEY) {
            const apiKey = process.env.FIREWORKS_API_KEY;
            registrations.push(async () => {
                const { FireworksProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/fireworksProvider')));
                this.runtime.registerProvider('fireworks', new FireworksProvider({ apiKey }));
            });
        }
        if (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY) {
            const apiKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '';
            registrations.push(async () => {
                const { ReplicateProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/replicateProvider')));
                this.runtime.registerProvider('replicate', new ReplicateProvider({ apiKey }));
            });
        }
        if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
            registrations.push(async () => {
                const { BedrockProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/bedrockProvider')));
                this.runtime.registerProvider('bedrock', new BedrockProvider({}));
            });
        }
        if (process.env.XAI_API_KEY) {
            const apiKey = process.env.XAI_API_KEY;
            const baseUrl = process.env.XAI_BASE_URL;
            const defaultModel = process.env.XAI_MODEL || 'grok-2-latest';
            registrations.push(async () => {
                const { XAIProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/xaiProvider')));
                this.runtime.registerProvider('xai', new XAIProvider({ apiKey, baseUrl, defaultModel }));
            });
        }
        if (process.env.ANYSCALE_API_KEY) {
            const apiKey = process.env.ANYSCALE_API_KEY;
            const baseUrl = process.env.ANYSCALE_BASE_URL;
            const defaultModel = process.env.ANYSCALE_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';
            registrations.push(async () => {
                const { AnyscaleProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/anyscaleProvider')));
                this.runtime.registerProvider('anyscale', new AnyscaleProvider({ apiKey, baseUrl, defaultModel }));
            });
        }
        if (process.env.DEEPINFRA_API_KEY) {
            const apiKey = process.env.DEEPINFRA_API_KEY;
            const baseUrl = process.env.DEEPINFRA_BASE_URL;
            const defaultModel = process.env.DEEPINFRA_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
            registrations.push(async () => {
                const { DeepInfraProvider } = await Promise.resolve().then(() => __importStar(require('./runtime/providers/deepinfraProvider')));
                this.runtime.registerProvider('deepinfra', new DeepInfraProvider({ apiKey, baseUrl, defaultModel }));
            });
        }
        await Promise.all(registrations.map((fn) => fn()));
        this.logger.info('AgentLoop', `Registered ${registrations.length} provider(s) from environment`);
    }
    loadState() {
        try {
            if (fs.existsSync(this.config.stateFile)) {
                const data = fs.readFileSync(this.config.stateFile, 'utf-8');
                const parsed = JSON.parse(data);
                this.taskQueue = parsed.taskQueue || [];
                this.logger.info('AgentLoop', `Loaded state: ${this.taskQueue.length} pending tasks`);
            }
        }
        catch (e) {
            this.logger.warn('AgentLoop', 'Failed to load state', { error: e === null || e === void 0 ? void 0 : e.message });
            this.taskQueue = [];
        }
    }
    saveState() {
        // Synchronous write — the state file is small (<1KB) and must be consistent
        // for crash recovery. Async writes create races on process exit and test assertions.
        const data = JSON.stringify({
            taskQueue: this.taskQueue,
            updatedAt: new Date().toISOString(),
        }, null, 2);
        try {
            fs.writeFileSync(this.config.stateFile, data, 'utf-8');
        }
        catch (e) {
            this.logger.debug('AgentLoop', 'saveState error', { error: e === null || e === void 0 ? void 0 : e.message });
        }
    }
    addTask(goal, priority = 0) {
        const id = `task_${Date.now()}_${this.taskQueue.length}`;
        const newTask = {
            id,
            goal,
            priority,
            status: 'pending',
            createdAt: new Date().toISOString(),
        };
        // Insertion sort: find correct position and insert (O(N) instead of O(N log N) full sort)
        let insertIdx = this.taskQueue.length;
        for (let i = 0; i < this.taskQueue.length; i++) {
            if (priority > this.taskQueue[i].priority) {
                insertIdx = i;
                break;
            }
        }
        this.taskQueue.splice(insertIdx, 0, newTask);
        // Cap queue size to prevent unbounded growth in long sessions
        if (this.taskQueue.length > CommanderAgentLoop.MAX_QUEUE_SIZE) {
            this.taskQueue.length = CommanderAgentLoop.MAX_QUEUE_SIZE;
        }
        this.saveState();
        this.logger.info('AgentLoop', `Task added: ${goal.slice(0, 60)}... (${id})`);
        return id;
    }
    getQueueLength() {
        return this.taskQueue.length;
    }
    getActiveCount() {
        return this.activeSessions.size;
    }
    /**
     * Initialize MCP/A2A external integrations.
     * Called once at the start of start() since connections are async.
     */
    async initializeExternalIntegrations() {
        var _a, _b, _c, _d, _e, _f, _g;
        // Config reading (async to avoid blocking event loop)
        const configPath = path.join(this.config.projectRoot, '.commander.json');
        let commanderConfig;
        try {
            if (fs.existsSync(configPath)) {
                const data = await fs.promises.readFile(configPath, 'utf-8');
                commanderConfig = JSON.parse(data);
            }
        }
        catch {
            this.logger.warn('AgentLoop', 'Failed to read .commander.json config');
        }
        // MCP integration
        try {
            const mcpServers = (0, mcpToolAdapter_1.readMCPConfig)(commanderConfig);
            if (mcpServers.length > 0) {
                this.mcpManager = new mcpToolAdapter_1.MCPIntegrationManager();
                await this.mcpManager.connect(mcpServers);
                if (this.mcpManager.isConnected()) {
                    this.mcpManager.registerIntoRuntime(this.runtime);
                    this.logger.info('AgentLoop', `Registered ${this.mcpManager.getToolCount()} MCP tools from ${this.mcpManager.getServerCount()} servers`);
                }
            }
        }
        catch (err) {
            this.logger.warn('AgentLoop', 'Failed to initialize MCP integration', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        // A2A server
        const a2aConfig = commanderConfig === null || commanderConfig === void 0 ? void 0 : commanderConfig.a2a;
        try {
            if (a2aConfig === null || a2aConfig === void 0 ? void 0 : a2aConfig.server) {
                const serverCfg = a2aConfig.server;
                if (serverCfg.enabled !== false) {
                    const agentCard = {
                        name: 'Commander',
                        description: 'Multi-agent orchestration system. Supports deliberation, multi-agent topologies, MCP tools, and distributed execution.',
                        version: '1.0.0',
                        supportedInterfaces: [
                            {
                                url: `http://${(_a = serverCfg.host) !== null && _a !== void 0 ? _a : '127.0.0.1'}:${(_b = serverCfg.port) !== null && _b !== void 0 ? _b : 3002}`,
                                protocolBinding: 'JSONRPC',
                                protocolVersion: '1.0',
                            },
                        ],
                        capabilities: {
                            streaming: false,
                            pushNotifications: false,
                            stateTransitionHistory: true,
                        },
                        defaultInputModes: ['text'],
                        defaultOutputModes: ['text'],
                        skills: [
                            {
                                id: 'deliberation',
                                name: 'Task Deliberation',
                                description: 'Analyze task complexity and select optimal execution topology',
                                tags: ['planning', 'analysis'],
                            },
                            {
                                id: 'orchestration',
                                name: 'Multi-Agent Orchestration',
                                description: 'Execute tasks using 8 topologies: single, sequential, parallel, hierarchical, hybrid, debate, ensemble, evaluator-opt',
                                tags: ['execution', 'multi-agent'],
                            },
                            {
                                id: 'tool-execution',
                                name: 'Tool Execution',
                                description: 'Execute 25+ built-in tools and any MCP-compatible external tools',
                                tags: ['tools', 'mcp'],
                            },
                        ],
                    };
                    this.a2aServer = (0, a2aServer_1.createA2AServer)({
                        port: (_c = serverCfg.port) !== null && _c !== void 0 ? _c : 3002,
                        host: (_d = serverCfg.host) !== null && _d !== void 0 ? _d : '127.0.0.1',
                        agentCard,
                    }, this.runtime);
                    await this.a2aServer.start();
                    this.logger.info('AgentLoop', `A2A server started on ${(_e = serverCfg.host) !== null && _e !== void 0 ? _e : '127.0.0.1'}:${(_f = serverCfg.port) !== null && _f !== void 0 ? _f : 3002}`);
                }
            }
        }
        catch (err) {
            this.logger.warn('AgentLoop', 'Failed to start A2A server', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        // A2A discovery from config
        try {
            if ((a2aConfig === null || a2aConfig === void 0 ? void 0 : a2aConfig.remoteAgents) && Array.isArray(a2aConfig.remoteAgents)) {
                this.a2aDiscoveryManager = new a2aClient_1.A2ADiscoveryManager();
                const remoteConfigs = a2aConfig.remoteAgents;
                if (remoteConfigs.length > 0) {
                    await this.a2aDiscoveryManager.discoverFromConfig(remoteConfigs);
                    this.logger.info('AgentLoop', `Connected to ${this.a2aDiscoveryManager.getAgentCount()} remote A2A agents`);
                }
            }
        }
        catch (err) {
            this.logger.warn('AgentLoop', 'Failed to discover A2A agents from config', {
                error: err instanceof Error ? err.message : String(err),
            });
            this.a2aDiscoveryManager = null;
        }
        // Register a2a_delegate tool
        {
            const dm = (_g = this.a2aDiscoveryManager) !== null && _g !== void 0 ? _g : new a2aClient_1.A2ADiscoveryManager();
            this.runtime.registerTool('a2a_delegate', new a2aDelegateTool_1.A2ADelegateTool(dm));
        }
        // A2A discovery from env var
        const envJson = process.env.COMMANDER_A2A_AGENTS;
        if (envJson && !this.a2aDiscoveryManager) {
            try {
                const urls = JSON.parse(envJson);
                if (Array.isArray(urls) && urls.length > 0) {
                    this.a2aDiscoveryManager = new a2aClient_1.A2ADiscoveryManager();
                    await this.a2aDiscoveryManager.discoverFromConfig(urls.map((url, i) => ({ label: `a2a-env-${i}`, url })));
                    this.logger.info('AgentLoop', `Connected to ${this.a2aDiscoveryManager.getAgentCount()} env-configured A2A agents`);
                }
            }
            catch {
                this.logger.warn('AgentLoop', 'Failed to parse COMMANDER_A2A_AGENTS env var');
            }
        }
    }
    async start() {
        if (this.isRunning)
            return;
        await this.initializeExternalIntegrations();
        this.isRunning = true;
        this.logger.info('AgentLoop', `Agent loop started. Tools: ${this.config.tools.join(', ')}`);
        this.logger.info('AgentLoop', `Pending tasks: ${this.taskQueue.length}`);
        while (this.isRunning && this.taskQueue.length > 0) {
            if (this.activeSessions.size >= this.config.maxConcurrentTasks) {
                await this.sleep(1000);
                continue;
            }
            const task = this.taskQueue.shift();
            if (!task)
                continue;
            this.executeTask(task).catch((err) => {
                this.logger.error('AgentLoop', `Task ${task.id} failed`, err instanceof Error ? err : new Error(String(err)));
            });
        }
        // Wait for active sessions to complete before exiting
        while (this.activeSessions.size > 0) {
            await this.sleep(1000);
        }
        this.logger.info('AgentLoop', 'Queue empty. All sessions complete.');
    }
    async executeTask(task) {
        const bus = (0, messageBus_1.getMessageBus)();
        this.activeSessions.set(task.id, { startTime: Date.now(), goal: task.goal });
        // Persist queue state now that the task is confirmed running.
        // Must happen before any async yield point so that crash between
        // shift() and execution start does not lose the task.
        this.saveState();
        this.logger.info('AgentLoop', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.logger.info('AgentLoop', `Executing: ${task.goal.slice(0, 80)}`);
        this.logger.info('AgentLoop', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        bus.publish('agent.started', 'commander-loop', { taskId: task.id, goal: task.goal });
        try {
            // Phase 1: Deliberation
            const plan = (0, deliberation_1.deliberate)(task.goal);
            this.logger.info('AgentLoop', `Type: ${plan.taskType} | Agents: ${plan.estimatedAgentCount} | Topology: ${plan.recommendedTopology} | Nature: ${plan.taskNature} | Spec: ${plan.suitableForSpeculation} | Time/agent: ${(plan.timeBudgetPerAgentMs / 1000).toFixed(1)}s`);
            // Phase 2: Execute via orchestrator
            const result = await this.orchestrator.execute({
                projectId: 'commander',
                agentId: 'commander-lead',
                goal: task.goal,
                contextData: {
                    availableTools: this.config.tools,
                    governanceProfile: { riskLevel: 'LOW' },
                },
            });
            this.logger.info('AgentLoop', `Status: ${result.status}`);
            this.logger.info('AgentLoop', `Synthesis: ${result.synthesis.slice(0, 200)}...`);
            bus.publish('agent.completed', 'commander-loop', {
                taskId: task.id,
                status: result.status,
                metrics: result.metrics,
            });
            return result;
        }
        catch (err) {
            this.logger.error('AgentLoop', 'Task error', err instanceof Error ? err : new Error(String(err)));
            bus.publish('agent.failed', 'commander-loop', { taskId: task.id, error: String(err) });
        }
        finally {
            this.activeSessions.delete(task.id);
        }
    }
    async stop() {
        this.isRunning = false;
        if (this.a2aServer) {
            try {
                await this.a2aServer.stop();
                this.logger.info('AgentLoop', 'A2A server stopped');
            }
            catch (err) {
                this.logger.error('AgentLoop', 'Failed to stop A2A server', err instanceof Error ? err : new Error(String(err)));
            }
        }
        if (this.mcpManager) {
            try {
                await this.mcpManager.disconnect();
                this.logger.info('AgentLoop', 'MCP servers disconnected');
            }
            catch (err) {
                this.logger.error('AgentLoop', 'Failed to disconnect MCP', err instanceof Error ? err : new Error(String(err)));
            }
        }
        this.logger.info('AgentLoop', `Loop stopped. ${this.activeSessions.size} sessions remaining.`);
    }
    getStatus() {
        return {
            running: this.isRunning,
            queueLength: this.taskQueue.length,
            activeSessions: this.activeSessions.size,
            sessions: Array.from(this.activeSessions.entries()).map(([id, s]) => ({
                id,
                goal: s.goal.slice(0, 60),
                runningFor: Date.now() - s.startTime,
            })),
            tools: this.config.tools,
        };
    }
    sleep(ms) {
        return new Promise((r) => {
            const t = setTimeout(r, ms);
            t.unref();
        });
    }
}
exports.CommanderAgentLoop = CommanderAgentLoop;
CommanderAgentLoop.MAX_QUEUE_SIZE = 1000;
