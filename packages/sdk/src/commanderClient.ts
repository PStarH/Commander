/**
 * CommanderClient — the primary entry point for the Commander Agent SDK.
 *
 * Provides a clean programmatic interface for embedding Commander's
 * multi-agent orchestration into your own applications.
 *
 * @example
 * ```typescript
 * import { CommanderClient } from '@commander/sdk';
 *
 * const client = new CommanderClient({ provider: 'openai' });
 * await client.connect();
 * const result = await client.run('analyze this repository');
 * console.log(result.summary);
 * await client.disconnect();
 * ```
 */

import type { LLMProvider, AgentRuntimeConfig } from '@commander/core';
import {
  AgentRuntime,
  createAllTools,
  TELOSOrchestrator,
  UltimateOrchestrator,
  SSEStream,
  getMessageBus,
  getModelRouter,
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
  DeepSeekProvider,
  GLMProvider,
  MiMoProvider,
  XiaomiProvider,
} from '@commander/core';

import type {
  CommanderClientConfig,
  ExecutionResult,
  ExecutionEvent,
  SessionSummary,
  SystemStatus,
} from './types';

type ProviderConstructor = new (config: { apiKey: string; baseUrl?: string; defaultModel?: string }) => LLMProvider;

export class CommanderClient {
  private config: CommanderClientConfig;
  private runtime: AgentRuntime | null = null;
  private orchestrator: UltimateOrchestrator | null = null;
  private telos: TELOSOrchestrator | null = null;
  private sse: SSEStream | null = null;
  private connected = false;
  private startTime: number = 0;
  private runCount = 0;
  private eventHandlers: Set<(event: ExecutionEvent) => void> = new Set();
  private unsubBus: (() => void) | null = null;
  private sessions: SessionSummary[] = [];

  constructor(config: CommanderClientConfig = {}) {
    this.config = { tokenBudget: 64000, ...config };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.startTime = Date.now();

    const providerType = this.config.provider ?? this.detectProviderFromEnv();
    if (!providerType) {
      throw new Error(
        'No LLM provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or ' +
        'similar env var, or pass `provider` + `apiKey` in config.'
      );
    }

    const apiKey = this.config.apiKey ?? this.readApiKey(providerType);
    const ProviderClass = resolveProviderClass(providerType);
    const modelId = this.config.model ?? this.defaultModelForProvider(providerType);

    const runtime = new AgentRuntime({ budgetHardCapTokens: this.config.tokenBudget ?? 64000 } as Partial<AgentRuntimeConfig>);

    const allTools = createAllTools();
    for (const [name, tool] of allTools) {
      runtime.registerTool(name, tool);
    }

    runtime.registerProvider(
      providerType,
      new ProviderClass({
        apiKey: apiKey ?? '',
        baseUrl: this.config.baseUrl,
        defaultModel: modelId,
      }),
    );

    const router = getModelRouter();
    for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
      router.registerModel({
        id: `${modelId}@${tier}`,
        provider: providerType,
        tier,
        costPer1KInput: 0.001,
        costPer1KOutput: 0.003,
        capabilities: ['code', 'reasoning', 'analysis'],
        contextWindow: 128000,
        priority: 0,
      });
    }

    this.runtime = runtime;
    this.telos = new TELOSOrchestrator(runtime);
    this.orchestrator = new UltimateOrchestrator(this.telos, runtime);

    this.sse = new SSEStream();
    this.sse.onEvent((rawEvent: string) => {
      try {
        const data = JSON.parse(rawEvent.replace(/^data: /, '').trim());
        if (data.topic) {
          const event: ExecutionEvent = {
            type: data.topic,
            timestamp: data.timestamp ?? new Date().toISOString(),
            data,
          };
          for (const handler of this.eventHandlers) {
            try { handler(event); } catch { /* handler errors are isolated */ }
          }
        }
      } catch { /* malformed events silently ignored */ }
    });

    const bus = getMessageBus();
    const unsub1 = bus.subscribe('agent.started', () => { this.runCount++; });
    const unsub2 = bus.subscribe('agent.completed', () => { this.runCount++; });
    const unsub3 = bus.subscribe('agent.failed', () => { this.runCount++; });
    this.unsubBus = () => { unsub1(); unsub2(); unsub3(); };

    this.connected = true;
  }

  async plan(task: string) {
    this.ensureConnected();
    const { deliberate } = await import('@commander/core');
    return deliberate(task);
  }

  async run(task: string): Promise<ExecutionResult> {
    this.ensureConnected();
    const startTime = Date.now();
    const result = await this.orchestrator!.execute({
      projectId: 'sdk',
      agentId: 'commander-sdk',
      goal: task,
      contextData: {
        availableTools: [],
        governanceProfile: { riskLevel: 'LOW' },
      },
    });

    this.sessions.push({
      runId: `run_${Date.now()}`,
      task: task.slice(0, 80),
      status: result.status ?? 'unknown',
      timestamp: new Date().toISOString(),
    });

    return {
      status: result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      summary: result.summary ?? `Execution ${(result.status ?? 'unknown').toLowerCase()}`,
      steps: [],
      totalTokenUsage: 0,
      totalDurationMs: Date.now() - startTime,
    };
  }

  onEvent(handler: (event: ExecutionEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => { this.eventHandlers.delete(handler); };
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  async getStatus(): Promise<SystemStatus> {
    this.ensureConnected();
    const uptime = this.startTime
      ? `${Math.floor((Date.now() - this.startTime) / 1000)}s`
      : '0s';
    return {
      provider: this.config.provider ?? 'auto',
      model: this.config.model ?? 'auto',
      uptime,
      totalRuns: this.runCount,
      activeSessions: 1,
      memoryUsage: process.memoryUsage().heapUsed,
    };
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.sse?.close();
    this.unsubBus?.();
    this.eventHandlers.clear();
    this.runtime = null;
    this.orchestrator = null;
    this.telos = null;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private ensureConnected(): void {
    if (!this.connected || !this.runtime || !this.orchestrator) {
      throw new Error('CommanderClient not connected. Call client.connect() first.');
    }
  }

  private detectProviderFromEnv(): string | null {
    const keyMap: Record<string, string> = {
      OPENAI_API_KEY: 'openai',
      ANTHROPIC_API_KEY: 'anthropic',
      GOOGLE_API_KEY: 'google',
      DEEPSEEK_API_KEY: 'deepseek',
      ZHIPU_API_KEY: 'glm',
      MIMO_API_KEY: 'mimo',
      XIAOMI_API_KEY: 'xiaomi',
    };
    for (const [envVar, provider] of Object.entries(keyMap)) {
      if (process.env[envVar]) return provider;
    }
    return null;
  }

  private readApiKey(provider: string): string | undefined {
    const envMap: Record<string, string> = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      google: 'GOOGLE_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      glm: 'ZHIPU_API_KEY',
      mimo: 'MIMO_API_KEY',
      xiaomi: 'XIAOMI_API_KEY',
    };
    return process.env[envMap[provider]];
  }

  private defaultModelForProvider(provider: string): string {
    const models: Record<string, string> = {
      openai: 'gpt-4o',
      anthropic: 'claude-3-5-sonnet',
      google: 'gemini-2-pro',
      deepseek: 'deepseek-chat',
      glm: 'glm-4-plus',
      mimo: 'mimo-pro',
      xiaomi: 'mimo-pro',
    };
    return models[provider] ?? 'gpt-4o';
  }
}

const PROVIDER_MAP: Record<string, ProviderConstructor> = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  google: GoogleProvider,
  deepseek: DeepSeekProvider,
  glm: GLMProvider,
  mimo: MiMoProvider,
  xiaomi: XiaomiProvider,
};

function resolveProviderClass(type: string): ProviderConstructor {
  const cls = PROVIDER_MAP[type];
  if (!cls) {
    throw new Error(
      `Unsupported provider: "${type}". Supported: ${Object.keys(PROVIDER_MAP).join(', ')}.`
    );
  }
  return cls;
}
