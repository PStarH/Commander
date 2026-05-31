import * as fs from 'fs';
import * as path from 'path';
import { deliberate, deliberateWithLLM } from '../../ultimate/deliberation';
import { classifyEffortLevel } from '../../ultimate/effortScaler';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { OpenAIProvider } from '../../runtime/providers/openaiProvider';
import { AnthropicProvider } from '../../runtime/providers/anthropicProvider';
import { GoogleProvider } from '../../runtime/providers/googleProvider';
import { OpenRouterProvider } from '../../runtime/providers/openRouterProvider';
import { DeepSeekProvider } from '../../runtime/providers/deepseekProvider';
import { GLMProvider } from '../../runtime/providers/glmProvider';
import { MiMoProvider } from '../../runtime/providers/mimoProvider';
import { XiaomiProvider } from '../../runtime/providers/xiaomiProvider';
import { OllamaProvider } from '../../runtime/providers/ollamaProvider';
import { VLLMProvider } from '../../runtime/providers/vllmProvider';
import { CohereProvider } from '../../runtime/providers/cohereProvider';
import { MistralProvider } from '../../runtime/providers/mistralProvider';
import { GroqProvider } from '../../runtime/providers/groqProvider';
import { TogetherProvider } from '../../runtime/providers/togetherProvider';
import { PerplexityProvider } from '../../runtime/providers/perplexityProvider';
import { FireworksProvider } from '../../runtime/providers/fireworksProvider';
import { ReplicateProvider } from '../../runtime/providers/replicateProvider';
import { BedrockProvider } from '../../runtime/providers/bedrockProvider';
import { XAIProvider } from '../../runtime/providers/xaiProvider';
import { AnyscaleProvider } from '../../runtime/providers/anyscaleProvider';
import { DeepInfraProvider } from '../../runtime/providers/deepinfraProvider';
import { getModelRouter } from '../../runtime/modelRouter';
import { createAllTools } from '../../tools/index';
import { executeReview, formatReviewOutput, reviewReportToJson, loadReviewGuidelines } from '../../reviewAgent';
import type { LLMProvider, ModelConfig } from '../../runtime/types';
import type { EffortLevel, OrchestrationTopology } from '../../ultimate/types';
import { UltimateOrchestrator } from '../../ultimate/orchestrator';
import { TELOSOrchestrator } from '../../telos/telosOrchestrator';
import { CompanyEngine } from '../../company';
import { SSEStream } from '../../runtime/sseStream';
import { getMessageBus } from '../../runtime/messageBus';
import { getTraceRecorder } from '../../runtime/executionTrace';
import { getMetaLearner } from '../../selfEvolution/metaLearner';
import {
  detectProvider, getEffectiveModel, setConfig, showConfig, listProviders, listModels, resetConfig,
} from '../../config/commanderConfig';
import type { ProviderInfo } from '../../config/commanderConfig';
import { getApprovalSystem } from '../../sandbox';
import type { ApprovalMode } from '../../sandbox';
import { getGlobalLogger, setGlobalLogLevel } from '../../logging';
import { StateCheckpointer } from '../../runtime/stateCheckpointer';
import { startTUI } from '../../tui';
import { spawn } from 'child_process';
import { TaskPool } from '../../orchestration/taskPool';
import { GoalOrchestrator } from '../../goal/goalOrchestrator';
import type { GoalConfig } from '../../goal/types';
import { SwarmOrchestrator } from '../../swarm/swarmOrchestrator';
import type { SwarmConfig } from '../../swarm/types';
import { DriveOrchestrator } from '../../drive/driveOrchestrator';
import type { DriveConfig } from '../../drive/types';
import { Scheduler, WorkflowRegistry } from '../../scheduler';
import type { ScheduleEntry, WorkflowTrigger } from '../../scheduler';
import { section, kv, bullet, cmdHeader, startSpinner, startSpinnerWithFailure, progressBar, StepProgress, onboardingMessage, $, parseFlags, fatalError, warn, setTheme, getThemeName, listThemes } from '../util';

const DEFAULT_TOOLS = 'web_search,web_fetch,file_read,file_write,file_edit,file_search,file_list,python_execute,shell_execute,git';

export function loadTools(): string[] {
  return (process.env.COMMANDER_TOOLS || DEFAULT_TOOLS).split(',').map(s => s.trim());
}

export function createRuntime(): AgentRuntime | null {
  const provider = detectProvider();
  if (!provider) return null;

  const modelId = getEffectiveModel();
  const runtime = new AgentRuntime({ budgetHardCapTokens: 200000 });
  const allTools = createAllTools();
  for (const [name, tool] of allTools) {
    runtime.registerTool(name, tool);
  }

  type ProviderConstructor = new (config: {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
    name?: string;
  }) => LLMProvider;

  const ProviderMap: Record<string, ProviderConstructor> = {
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
    google: GoogleProvider,
    openrouter: OpenRouterProvider,
    deepseek: DeepSeekProvider,
    glm: GLMProvider,
    mimo: MiMoProvider,
    xiaomi: XiaomiProvider,
    ollama: OllamaProvider,
    vllm: VLLMProvider,
    cohere: CohereProvider,
    mistral: MistralProvider,
    groq: GroqProvider,
    together: TogetherProvider,
    perplexity: PerplexityProvider,
    fireworks: FireworksProvider,
    replicate: ReplicateProvider,
    bedrock: BedrockProvider,
    xai: XAIProvider,
    anyscale: AnyscaleProvider,
    deepinfra: DeepInfraProvider,
  };
  const ProviderClass = ProviderMap[provider.type] ?? OpenAIProvider;

  runtime.registerProvider(provider.type, new ProviderClass({
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    defaultModel: modelId,
  }));

  const router = getModelRouter();
  for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
    router.registerModel({
      id: `${modelId}@${tier}`,
      provider: provider.type,
      tier,
      costPer1KInput: 0.0008,
      costPer1KOutput: 0.004,
      capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
      contextWindow: 128000,
      priority: -1,
    });
  }

  return runtime;
}

export type { EffortLevel, OrchestrationTopology };
export {
  deliberate, deliberateWithLLM, classifyEffortLevel,
  detectProvider, getEffectiveModel, onboardingMessage, $, section, kv, bullet, cmdHeader, startSpinner,
  startSpinnerWithFailure, progressBar, StepProgress,
  parseFlags, fatalError, warn,
  setTheme, getThemeName, listThemes,
  getGlobalLogger, getMetaLearner, getApprovalSystem, StateCheckpointer, spawn, TaskPool,
  GoalOrchestrator, GoalConfig, SwarmOrchestrator, SwarmConfig, DriveOrchestrator, DriveConfig,
  CompanyEngine, SSEStream, TELOSOrchestrator, UltimateOrchestrator,
  executeReview, formatReviewOutput, reviewReportToJson, loadReviewGuidelines,
  Scheduler, WorkflowRegistry, ScheduleEntry, WorkflowTrigger,
  AgentRuntime,
};
