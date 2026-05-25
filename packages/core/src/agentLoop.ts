import { AgentRuntime } from './runtime/agentRuntime';
import { OpenAIProvider } from './runtime/providers/openaiProvider';
import { AnthropicProvider } from './runtime/providers/anthropicProvider';
import { GoogleProvider } from './runtime/providers/googleProvider';
import { OpenRouterProvider } from './runtime/providers/openRouterProvider';
import { DeepSeekProvider } from './runtime/providers/deepseekProvider';
import { GLMProvider } from './runtime/providers/glmProvider';
import { MiMoProvider } from './runtime/providers/mimoProvider';
import { XiaomiProvider } from './runtime/providers/xiaomiProvider';
import { OllamaProvider } from './runtime/providers/ollamaProvider';
import { VLLMProvider } from './runtime/providers/vllmProvider';
import { CohereProvider } from './runtime/providers/cohereProvider';
import { MistralProvider } from './runtime/providers/mistralProvider';
import { GroqProvider } from './runtime/providers/groqProvider';
import { TogetherProvider } from './runtime/providers/togetherProvider';
import { PerplexityProvider } from './runtime/providers/perplexityProvider';
import { FireworksProvider } from './runtime/providers/fireworksProvider';
import { ReplicateProvider } from './runtime/providers/replicateProvider';
import { BedrockProvider } from './runtime/providers/bedrockProvider';
import { XAIProvider } from './runtime/providers/xaiProvider';
import { AnyscaleProvider } from './runtime/providers/anyscaleProvider';
import { DeepInfraProvider } from './runtime/providers/deepinfraProvider';
import { getMessageBus } from './runtime/messageBus';
import { createAllTools } from './tools/index';
import { UltimateOrchestrator } from './ultimate/orchestrator';
import { TELOSOrchestrator } from './telos/telosOrchestrator';
import { deliberate } from './ultimate/deliberation';
import * as fs from 'fs';
import * as path from 'path';
import { MCPIntegrationManager, readMCPConfig } from './tools/mcpToolAdapter';
import { A2AServer, createA2AServer } from './mcp/a2aServer';
import { A2ADiscoveryManager } from './mcp/a2aClient';
import { A2ADelegateTool } from './tools/a2aDelegateTool';
import type { A2AAgentCard } from './mcp/a2aCompliance';
import { getGlobalLogger } from './logging';

export interface AgentLoopConfig {
  projectRoot: string;
  maxConcurrentTasks: number;
  sessionTimeoutMs: number;
  stateFile: string;
  tools: string[];
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  projectRoot: process.cwd(),
  maxConcurrentTasks: 5,
  sessionTimeoutMs: 3600000,
  stateFile: '.commander_state.json',
  tools: ['web_search', 'web_fetch', 'file_read', 'file_write', 'file_edit', 'file_search', 'file_list', 'python_execute', 'shell_execute'],
};

export class CommanderAgentLoop {
  private runtime: AgentRuntime;
  private telos: TELOSOrchestrator;
  private orchestrator: UltimateOrchestrator;
  private config: AgentLoopConfig;
  private taskQueue: Array<{ id: string; goal: string; priority: number; status: string; createdAt: string }> = [];
  private activeSessions: Map<string, { startTime: number; goal: string }> = new Map();
  private isRunning = false;
  private mcpManager: MCPIntegrationManager | null = null;
  private a2aServer: A2AServer | null = null;
  private a2aDiscoveryManager: A2ADiscoveryManager | null = null;
  private logger = getGlobalLogger();

  constructor(config?: Partial<AgentLoopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runtime = new AgentRuntime();

    // Register providers from environment
    if (process.env.OPENAI_API_KEY) {
      this.runtime.registerProvider('openai', new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        defaultModel: process.env.OPENAI_MODEL || 'gpt-4o',
      }));
    }
    if (process.env.ANTHROPIC_API_KEY) {
      this.runtime.registerProvider('anthropic', new AnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY,
      }));
    }
    if (process.env.GOOGLE_API_KEY) {
      this.runtime.registerProvider('google', new GoogleProvider({
        apiKey: process.env.GOOGLE_API_KEY,
      }));
    }
    if (process.env.OPENROUTER_API_KEY) {
      this.runtime.registerProvider('openrouter', new OpenRouterProvider({
        apiKey: process.env.OPENROUTER_API_KEY,
      }));
    }
    if (process.env.DEEPSEEK_API_KEY) {
      this.runtime.registerProvider('deepseek', new DeepSeekProvider({
        apiKey: process.env.DEEPSEEK_API_KEY,
      }));
    }
    if (process.env.ZHIPU_API_KEY) {
      this.runtime.registerProvider('glm', new GLMProvider({
        apiKey: process.env.ZHIPU_API_KEY,
      }));
    }
    if (process.env.MIMO_API_KEY) {
      this.runtime.registerProvider('mimo', new MiMoProvider({
        apiKey: process.env.MIMO_API_KEY,
      }));
    }
    if (process.env.XIAOMI_API_KEY) {
      this.runtime.registerProvider('xiaomi', new XiaomiProvider({
        apiKey: process.env.XIAOMI_API_KEY,
      }));
    }
    if (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
      this.runtime.registerProvider('ollama', new OllamaProvider({
        baseUrl: process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL,
        defaultModel: process.env.OLLAMA_MODEL,
      }));
    }
    if (process.env.VLLM_BASE_URL || process.env.VLLM_MODEL) {
      this.runtime.registerProvider('vllm', new VLLMProvider({
        baseUrl: process.env.VLLM_BASE_URL,
        defaultModel: process.env.VLLM_MODEL,
      }));
    }
    if (process.env.CO_API_KEY || process.env.COHERE_API_KEY) {
      this.runtime.registerProvider('cohere', new CohereProvider({
        apiKey: process.env.CO_API_KEY || process.env.COHERE_API_KEY || '',
      }));
    }
    if (process.env.MISTRAL_API_KEY) {
      this.runtime.registerProvider('mistral', new MistralProvider({
        apiKey: process.env.MISTRAL_API_KEY,
      }));
    }
    if (process.env.GROQ_API_KEY) {
      this.runtime.registerProvider('groq', new GroqProvider({
        apiKey: process.env.GROQ_API_KEY,
      }));
    }
    if (process.env.TOGETHER_API_KEY) {
      this.runtime.registerProvider('together', new TogetherProvider({
        apiKey: process.env.TOGETHER_API_KEY,
      }));
    }
    if (process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY) {
      this.runtime.registerProvider('perplexity', new PerplexityProvider({
        apiKey: process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY || '',
      }));
    }
    if (process.env.FIREWORKS_API_KEY) {
      this.runtime.registerProvider('fireworks', new FireworksProvider({
        apiKey: process.env.FIREWORKS_API_KEY,
      }));
    }
    if (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY) {
      this.runtime.registerProvider('replicate', new ReplicateProvider({
        apiKey: process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '',
      }));
    }
    if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
      this.runtime.registerProvider('bedrock', new BedrockProvider({}));
    }
    if (process.env.XAI_API_KEY) {
      this.runtime.registerProvider('xai', new XAIProvider({
        apiKey: process.env.XAI_API_KEY,
        baseUrl: process.env.XAI_BASE_URL,
        defaultModel: process.env.XAI_MODEL || 'grok-2-latest',
      }));
    }
    if (process.env.ANYSCALE_API_KEY) {
      this.runtime.registerProvider('anyscale', new AnyscaleProvider({
        apiKey: process.env.ANYSCALE_API_KEY,
        baseUrl: process.env.ANYSCALE_BASE_URL,
        defaultModel: process.env.ANYSCALE_MODEL || 'meta-llama/Llama-3.3-70B-Instruct',
      }));
    }
    if (process.env.DEEPINFRA_API_KEY) {
      this.runtime.registerProvider('deepinfra', new DeepInfraProvider({
        apiKey: process.env.DEEPINFRA_API_KEY,
        baseUrl: process.env.DEEPINFRA_BASE_URL,
        defaultModel: process.env.DEEPINFRA_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      }));
    }

    // Register all tools
    const allTools = createAllTools();
    for (const [name, tool] of allTools) {
      this.runtime.registerTool(name, tool);
    }

    this.telos = new TELOSOrchestrator(this.runtime);
    this.orchestrator = new UltimateOrchestrator(this.telos, this.runtime);
    this.loadState();
  }

  private loadState() {
    try {
      if (fs.existsSync(this.config.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf-8'));
        this.taskQueue = data.taskQueue || [];
        this.logger.info('AgentLoop', `Loaded state: ${this.taskQueue.length} pending tasks`);
      }
    } catch (e) {
      this.logger.warn('AgentLoop', 'Failed to load state', { error: (e as Error)?.message });
      this.taskQueue = [];
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(this.config.stateFile, JSON.stringify({
        taskQueue: this.taskQueue,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch (e) { console.debug('[AgentLoop] saveState error:', (e as Error)?.message); }
  }

  addTask(goal: string, priority = 0): string {
    const id = `task_${Date.now()}_${this.taskQueue.length}`;
    this.taskQueue.push({ id, goal, priority, status: 'pending', createdAt: new Date().toISOString() });
    this.taskQueue.sort((a, b) => b.priority - a.priority);
    this.saveState();
    this.logger.info('AgentLoop', `Task added: ${goal.slice(0, 60)}... (${id})`);
    return id;
  }

  getQueueLength(): number { return this.taskQueue.length; }
  getActiveCount(): number { return this.activeSessions.size; }

  /**
   * Initialize MCP/A2A external integrations.
   * Called once at the start of start() since connections are async.
   */
  private async initializeExternalIntegrations(): Promise<void> {
    try {
      const configPath = path.join(this.config.projectRoot, '.commander.json');
      let commanderConfig: Record<string, unknown> | undefined;
      try {
        if (fs.existsSync(configPath)) {
          commanderConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        }
      } catch {
        this.logger.warn('AgentLoop', 'Failed to read .commander.json config');
      }

      const mcpServers = readMCPConfig(commanderConfig as Parameters<typeof readMCPConfig>[0]);
      if (mcpServers.length > 0) {
        this.mcpManager = new MCPIntegrationManager();
        await this.mcpManager.connect(mcpServers);
        if (this.mcpManager.isConnected()) {
          this.mcpManager.registerIntoRuntime(this.runtime);
          this.logger.info('AgentLoop', `Registered ${this.mcpManager.getToolCount()} MCP tools from ${this.mcpManager.getServerCount()} servers`);
        }
      }

      const a2aConfig = commanderConfig?.a2a as Record<string, unknown> | undefined;
      if (a2aConfig?.server) {
        const serverCfg = a2aConfig.server as Record<string, unknown>;
        if (serverCfg.enabled !== false) {
          const agentCard: A2AAgentCard = {
            name: 'Commander',
            description: 'Multi-agent orchestration system. Supports deliberation, multi-agent topologies, MCP tools, and distributed execution.',
            version: '1.0.0',
            supportedInterfaces: [{
              url: `http://${serverCfg.host ?? '127.0.0.1'}:${serverCfg.port ?? 3002}`,
              protocolBinding: 'JSONRPC',
              protocolVersion: '1.0',
            }],
            capabilities: {
              streaming: false,
              pushNotifications: false,
              stateTransitionHistory: true,
            },
            defaultInputModes: ['text'],
            defaultOutputModes: ['text'],
            skills: [
              { id: 'deliberation', name: 'Task Deliberation', description: 'Analyze task complexity and select optimal execution topology', tags: ['planning', 'analysis'] },
              { id: 'orchestration', name: 'Multi-Agent Orchestration', description: 'Execute tasks using 8 topologies: single, sequential, parallel, hierarchical, hybrid, debate, ensemble, evaluator-opt', tags: ['execution', 'multi-agent'] },
              { id: 'tool-execution', name: 'Tool Execution', description: 'Execute 25+ built-in tools and any MCP-compatible external tools', tags: ['tools', 'mcp'] },
            ],
          };

          this.a2aServer = createA2AServer({
            port: (serverCfg.port as number) ?? 3002,
            host: (serverCfg.host as string) ?? '127.0.0.1',
            agentCard,
          }, this.runtime);
          await this.a2aServer.start();
          this.logger.info('AgentLoop', `A2A server started on ${serverCfg.host ?? '127.0.0.1'}:${serverCfg.port ?? 3002}`);
        }
      }

      if (a2aConfig?.remoteAgents && Array.isArray(a2aConfig.remoteAgents)) {
        this.a2aDiscoveryManager = new A2ADiscoveryManager();
        const remoteConfigs = a2aConfig.remoteAgents as Array<{ label: string; url: string; authToken?: string }>;
        if (remoteConfigs.length > 0) {
          await this.a2aDiscoveryManager.discoverFromConfig(remoteConfigs);
          this.logger.info('AgentLoop', `Connected to ${this.a2aDiscoveryManager.getAgentCount()} remote A2A agents`);
        }
      }

      {
        const dm = this.a2aDiscoveryManager ?? new A2ADiscoveryManager();
        this.runtime.registerTool('a2a_delegate', new A2ADelegateTool(dm));
      }

      const envJson = process.env.COMMANDER_A2A_AGENTS;
      if (envJson && !this.a2aDiscoveryManager) {
        try {
          const urls = JSON.parse(envJson) as string[];
          if (Array.isArray(urls) && urls.length > 0) {
            this.a2aDiscoveryManager = new A2ADiscoveryManager();
            await this.a2aDiscoveryManager.discoverFromConfig(
              urls.map((url, i) => ({ label: `a2a-env-${i}`, url })),
            );
            this.logger.info('AgentLoop', `Connected to ${this.a2aDiscoveryManager.getAgentCount()} env-configured A2A agents`);
          }
        } catch {
          this.logger.warn('AgentLoop', 'Failed to parse COMMANDER_A2A_AGENTS env var');
        }
      }
    } catch (err) {
      this.logger.error('AgentLoop', 'Failed to initialize external integrations', err instanceof Error ? err : new Error(String(err)));
    }
  }

  async start() {
    if (this.isRunning) return;

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
      if (!task) continue;

      this.executeTask(task).catch(err => {
        this.logger.error('AgentLoop', `Task ${task.id} failed`, err instanceof Error ? err : new Error(String(err)));
      });
    }

    this.logger.info('AgentLoop', 'Queue empty. Waiting for active sessions...');
  }

  private async executeTask(task: { id: string; goal: string }) {
    const bus = getMessageBus();
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
      const plan = deliberate(task.goal);
       this.logger.info('AgentLoop', `Type: ${plan.taskType} | Agents: ${plan.estimatedAgentCount} | Topology: ${plan.recommendedTopology}`);

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
        taskId: task.id, status: result.status,
        metrics: result.metrics,
      });

      return result;
    } catch (err) {
      this.logger.error('AgentLoop', 'Task error', err instanceof Error ? err : new Error(String(err)));
      bus.publish('agent.failed', 'commander-loop', { taskId: task.id, error: String(err) });
    } finally {
      this.activeSessions.delete(task.id);
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.a2aServer) {
      try {
        await this.a2aServer.stop();
        this.logger.info('AgentLoop', 'A2A server stopped');
      } catch (err) {
        this.logger.warn('AgentLoop', 'Failed to stop A2A server', err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (this.mcpManager) {
      try {
        await this.mcpManager.disconnect();
        this.logger.info('AgentLoop', 'MCP servers disconnected');
      } catch (err) {
        this.logger.warn('AgentLoop', 'Failed to disconnect MCP', err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.logger.info('AgentLoop', `Loop stopped. ${this.activeSessions.size} sessions remaining.`);
  }

  getStatus(): object {
    return {
      running: this.isRunning,
      queueLength: this.taskQueue.length,
      activeSessions: this.activeSessions.size,
      sessions: Array.from(this.activeSessions.entries()).map(([id, s]) => ({
        id, goal: s.goal.slice(0, 60), runningFor: Date.now() - s.startTime,
      })),
      tools: this.config.tools,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
