import * as fs from 'fs';
import * as path from 'path';
import { deliberate, deliberateWithLLM } from '../ultimate/deliberation';
import { classifyEffortLevel } from '../ultimate/effortScaler';
import { AgentRuntime } from '../runtime/agentRuntime';
import { OpenAIProvider } from '../runtime/providers/openaiProvider';
import { AnthropicProvider } from '../runtime/providers/anthropicProvider';
import { GoogleProvider } from '../runtime/providers/googleProvider';
import { OpenRouterProvider } from '../runtime/providers/openRouterProvider';
import { DeepSeekProvider } from '../runtime/providers/deepseekProvider';
import { GLMProvider } from '../runtime/providers/glmProvider';
import { MiMoProvider } from '../runtime/providers/mimoProvider';
import { XiaomiProvider } from '../runtime/providers/xiaomiProvider';
import { OllamaProvider } from '../runtime/providers/ollamaProvider';
import { VLLMProvider } from '../runtime/providers/vllmProvider';
import { CohereProvider } from '../runtime/providers/cohereProvider';
import { MistralProvider } from '../runtime/providers/mistralProvider';
import { GroqProvider } from '../runtime/providers/groqProvider';
import { TogetherProvider } from '../runtime/providers/togetherProvider';
import { PerplexityProvider } from '../runtime/providers/perplexityProvider';
import { FireworksProvider } from '../runtime/providers/fireworksProvider';
import { ReplicateProvider } from '../runtime/providers/replicateProvider';
import { BedrockProvider } from '../runtime/providers/bedrockProvider';
import { XAIProvider } from '../runtime/providers/xaiProvider';
import { AnyscaleProvider } from '../runtime/providers/anyscaleProvider';
import { DeepInfraProvider } from '../runtime/providers/deepinfraProvider';
import { getModelRouter } from '../runtime/modelRouter';
import { createAllTools } from '../tools/index';
import { executeReview, formatReviewOutput, reviewReportToJson, loadReviewGuidelines } from '../reviewAgent';
import type { ModelConfig } from '../runtime/types';
import type { EffortLevel, OrchestrationTopology } from '../ultimate/types';
import { UltimateOrchestrator } from '../ultimate/orchestrator';
import { TELOSOrchestrator } from '../telos/telosOrchestrator';
import { CompanyEngine } from '../company';
import { SSEStream } from '../runtime/sseStream';
import { getMessageBus } from '../runtime/messageBus';
import { getTraceRecorder } from '../runtime/executionTrace';
import { getMetaLearner } from '../selfEvolution/metaLearner';
import {
  detectProvider, getEffectiveModel, setConfig, showConfig, listProviders, listModels, resetConfig,
} from '../config/commanderConfig';
import type { ProviderInfo } from '../config/commanderConfig';
import { getApprovalSystem } from '../sandbox';
import type { ApprovalMode } from '../sandbox';
import { getGlobalLogger, setGlobalLogLevel } from '../logging';
import { StateCheckpointer } from '../runtime/stateCheckpointer';
import { startTUI } from '../tui';
import { spawn } from 'child_process';
import { TaskPool } from '../orchestration/taskPool';
import { GoalOrchestrator } from '../goal/goalOrchestrator';
import type { GoalConfig } from '../goal/types';
import { SwarmOrchestrator } from '../swarm/swarmOrchestrator';
import type { SwarmConfig } from '../swarm/types';
import { DriveOrchestrator } from '../drive/driveOrchestrator';
import type { DriveConfig } from '../drive/types';
import { Scheduler, WorkflowRegistry } from '../scheduler';
import type { ScheduleEntry, WorkflowTrigger } from '../scheduler';
import { section, kv, bullet, cmdHeader, startSpinner, onboardingMessage, $ } from './util';
const DEFAULT_TOOLS = 'web_search,web_fetch,file_read,file_write,file_edit,file_search,file_list,python_execute,shell_execute,git';

function loadTools(): string[] {
  return (process.env.COMMANDER_TOOLS || DEFAULT_TOOLS).split(',').map(s => s.trim());
}

function createRuntime(): AgentRuntime | null {
  const provider = detectProvider();
  if (!provider) return null;

  const modelId = getEffectiveModel();
  const runtime = new AgentRuntime({ budgetHardCapTokens: 64000 });
  const allTools = createAllTools();
  for (const [name, tool] of allTools) {
    runtime.registerTool(name, tool);
  }

  const ProviderMap: Record<string, any> = {
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

// ============================================================================
// Subcommands
// ============================================================================

export async function cmdPlan(task: string) {
   cmdHeader(task);
   const done = startSpinner('Analyzing task...');
   const runtime = createRuntime();
   const provider = runtime?.getProvider('openai')
     ?? runtime?.getProvider('anthropic')
     ?? runtime?.getProvider('openrouter')
     ?? runtime?.getProvider('mimo')
     ?? runtime?.getProvider('deepseek')
     ?? runtime?.getProvider('glm')
     ?? runtime?.getProvider('xiaomi')
     ?? runtime?.getProvider('google');
   const plan = runtime
     ? await deliberateWithLLM(task, provider ?? runtime.getProvider('openai')!)
     : deliberate(task);
  const effort = classifyEffortLevel(task);
  done();

  section('PLAN');
  bullet(`${plan.taskType} · ${effort} effort · ${plan.recommendedTopology} topology`, $.cyan);
  console.log();
  kv('Agents', `${plan.estimatedAgentCount}`, $.yellow);
  kv('Steps', `${plan.estimatedSteps}`, $.yellow);
  kv('Confidence', `${(plan.confidence * 100).toFixed(0)}%`, plan.confidence > 0.7 ? $.green : $.yellow);
  kv('External info', plan.requiresExternalInfo ? 'Yes' : 'No', plan.requiresExternalInfo ? $.yellow : $.dim);
  kv('Tokens', `${plan.estimatedTokens.toLocaleString()} (think: ${plan.tokenBudget.thinking.toLocaleString()}, exec: ${plan.tokenBudget.execution.toLocaleString()})`);

  if (plan.capabilitiesNeeded.length > 0) {
    section('NEEDS');
    for (const cap of plan.capabilitiesNeeded) {
      bullet(cap);
    }
  }
}

export async function cmdRun(task: string) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
    return;
  }

  cmdHeader(task);
  const rt: AgentRuntime = runtime;
  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  let lastPhase = '';
  const startTime = Date.now();

  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    goal: task,
    contextData: { availableTools: loadTools(), governanceProfile: { riskLevel: 'LOW' } },
    onProgress: (phase, detail) => {
      if (phase === 'COMPLETE') return;
      if (phase !== lastPhase) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const icons: Record<string, string> = {
          INIT: '📋', DELIBERATION: '🧠', EFFORT_SCALING: '📊',
          TOPOLOGY_ROUTING: '🔀', DECOMPOSITION: '📦', TEAM_FORMATION: '👥',
          EXECUTION: '⚡', SYNTHESIS: '🔗',
        };
        console.log(`  ${$.dim}[${elapsed}s]${$.reset} ${icons[phase] || ' '} ${$.bold}${phase}${$.reset} ${$.dim}${detail.slice(0, 70)}${$.reset}`);
        lastPhase = phase;
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();

  section('RESULTS');
  const icon = result.status === 'SUCCESS' ? '✅' : result.status === 'PARTIAL' ? '⚠️' : '❌';
  const statusColor = result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red;
  console.log(`  ${icon} ${statusColor}${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s · ${result.metrics.totalTokens.toLocaleString()} tok · $${result.metrics.totalCostUsd.toFixed(4)}${$.reset}`);

  if (result.status !== 'SUCCESS' && result.errors.length > 0) {
    console.log();
    for (const err of result.errors) {
      console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
    }
  }

  if (result.synthesis) {
    const preview = result.synthesis.split('\n').filter(l => l.trim()).slice(0, 8).join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.synthesis.split('\n').filter(l => l.trim()).length;
    if (totalLines > 8) console.log(`  ${$.dim}... (${totalLines - 8} more lines)${$.reset}`);
  }
  console.log();
}

export async function cmdWatch(task: string) {
  const runtime = createRuntime();
  if (!runtime) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
    return;
  }
  const rt: AgentRuntime = runtime;

  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  cmdHeader(task);

  const sse = new SSEStream();
  sse.onEvent((event) => {
    try {
      const data = JSON.parse(event.replace(/^data: /, '').trim());
      const ts = new Date(data.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const icons: Record<string, string> = {
        'agent.started': '▶️', 'agent.completed': '✅', 'agent.failed': '❌',
        'agent.message': '💬', 'system.alert': '⚠️', 'tool.executed': '🔧',
      };
      const icon = icons[data.topic] || '📡';
      const payload = typeof data.payload === 'object' ? JSON.stringify(data.payload).slice(0, 80) : String(data.payload ?? '').slice(0, 80);
      console.log(`  ${$.dim}${ts}${$.reset} ${icon} ${$.bold}${data.topic}${$.reset} ${$.dim}${payload}${$.reset}`);
    } catch (err) {
      getGlobalLogger().debug('CLI', 'Failed to parse SSE event', { error: err instanceof Error ? err.message : String(err) });
    }
  });

  console.log();

  const startTime = Date.now();
  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    goal: task,
    contextData: {
      availableTools: loadTools(),
      governanceProfile: { riskLevel: 'LOW' },
    },
  });

  sse.close();

  section('COMPLETE');
  const statusColor = result.status === 'SUCCESS' ? $.green : $.red;
  kv('Status', result.status, statusColor);
  kv('Duration', `${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log();
}

export async function cmdCompany(task: string) {
  const runtime = createRuntime();
  if (!runtime) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
  }

  cmdHeader(task);
  const engine = new CompanyEngine();
  engine.start();

  const done = startSpinner('Running company mode...');
  const result = await engine.submit(task, 'analysis', 'commander-cli');
  done();

  section('REVIEW');
  const passed = result.review.passed;
  console.log(`  ${passed ? '✅' : '❌'} ${$.bold}${passed ? 'Passed' : 'Failed'}${$.reset}  ${$.dim}score: ${(result.review.score * 100).toFixed(0)}%${$.reset}`);
  if (result.review.issues.length > 0) {
    console.log();
    for (const issue of result.review.issues) {
      bullet(issue, $.yellow);
    }
  }
  console.log();
  engine.stop();
}

export async function cmdGoal(task: string, flags: Record<string, string>) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
  }

  cmdHeader(task);

  const llmProvider = runtime.getProvider('openai')
    ?? runtime.getProvider('anthropic')
    ?? runtime.getProvider('openrouter')
    ?? runtime.getProvider('mimo')
    ?? runtime.getProvider('deepseek')
    ?? runtime.getProvider('glm')
    ?? runtime.getProvider('xiaomi')
    ?? runtime.getProvider('google');

  if (!llmProvider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No LLM provider available.\n`);
    process.exit(1);
  }

  const config: Partial<GoalConfig> = {};
  if (flags['--mode']) config.mode = flags['--mode'] as GoalConfig['mode'];
  if (flags['--budget']) config.budgetTokens = parseInt(flags['--budget'], 10);
  if (flags['--max-rounds']) config.maxRounds = parseInt(flags['--max-rounds'], 10);

  const orch = new GoalOrchestrator(llmProvider, config);

  console.log(`  ${$.dim}Mode:${$.reset} ${$.cyan}${config.mode ?? 'balanced'}${$.reset}  ${$.dim}Budget:${$.reset} ${$.cyan}${(config.budgetTokens ?? 500000).toLocaleString()} tok${$.reset}  ${$.dim}Max rounds:${$.reset} ${$.cyan}${config.maxRounds ?? 10}${$.reset}\n`);

  const done = startSpinner('Goal loop running...');
  const startTime = Date.now();
  const result = await orch.execute(task);
  done();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('GOAL RESULT');
  const statusIcon = result.status === 'completed' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
  const statusColor = result.status === 'completed' ? $.green : result.status === 'partial' ? $.yellow : $.red;
  console.log(`  ${statusIcon} ${statusColor}${$.bold}${result.status.toUpperCase()}${$.reset}  ${$.dim}${elapsed}s · ${result.totalRounds} rounds · ${result.totalTokensUsed.toLocaleString()} tok${$.reset}\n`);

  console.log(`  ${$.bold}Rounds:${$.reset} ${result.totalRounds}`);
  console.log(`  ${$.bold}Tokens:${$.reset} ${result.totalTokensUsed.toLocaleString()}`);
  console.log(`  ${$.bold}Duration:${$.reset} ${elapsed}s`);
  console.log();

  const lastRound = result.ledger[result.ledger.length - 1];
  if (lastRound) {
    console.log(`  ${$.bold}Stop reason:${$.reset} ${$.yellow}${lastRound.decisionReason}${$.reset}`);
    if (lastRound.findingsTotal > 0) {
      console.log(`  ${$.bold}Remaining findings:${$.reset} ${$.red}${lastRound.findingsTotal}${$.reset}`);
    }
    console.log(`  ${$.bold}Improvement trend:${$.reset} ${lastRound.improvementRate > 0.05 ? $.green + 'improving' : $.dim + 'plateaued'}${$.reset}`);
  }

  if (result.ledger.length > 1) {
    console.log();
    section('ROUND HISTORY');
    for (const r of result.ledger) {
      const icon = r.decision === 'continue' ? '↻' : r.decision.startsWith('stop_') ? '■' : '?';
      const color = r.decision === 'continue' ? $.cyan : $.yellow;
      console.log(`  ${color}${icon}${$.reset} Round ${r.round}: ${r.findingsTotal} findings · ${(r.improvementRate * 100).toFixed(0)}% improvement · ${r.decision}`);
    }
  }

  console.log();
}

export async function cmdSwarm(task: string, flags: Record<string, string>) {
  const runtime = createRuntime();
  if (!runtime) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
  }

  cmdHeader(task);

  const llmProvider = runtime.getProvider('openai')
    ?? runtime.getProvider('anthropic')
    ?? runtime.getProvider('openrouter')
    ?? runtime.getProvider('mimo')
    ?? runtime.getProvider('deepseek')
    ?? runtime.getProvider('glm')
    ?? runtime.getProvider('xiaomi')
    ?? runtime.getProvider('google');

  if (!llmProvider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No LLM provider available.\n`);
    process.exit(1);
  }

  const swarmConfig: Partial<SwarmConfig> = {};
  if (flags['--mode']) swarmConfig.goalConfig = { ...swarmConfig.goalConfig, mode: flags['--mode'] as GoalConfig['mode'] };
  if (flags['--budget']) swarmConfig.goalConfig = { ...swarmConfig.goalConfig, budgetTokens: parseInt(flags['--budget'], 10) };
  if (flags['--max-rounds']) swarmConfig.goalConfig = { ...swarmConfig.goalConfig, maxRounds: parseInt(flags['--max-rounds'], 10) };
  if (flags['--max-depth']) swarmConfig.maxDepth = parseInt(flags['--max-depth'], 10);
  if (flags['--max-workers']) swarmConfig.maxWorkers = parseInt(flags['--max-workers'], 10);

  const orch = new SwarmOrchestrator(llmProvider, swarmConfig);

  const modeLabel = flags['--mode'] ?? 'balanced';
  const depthLabel = flags['--max-depth'] ?? '3';
  console.log(`  ${$.dim}Mode:${$.reset} ${$.cyan}${modeLabel}${$.reset}  ${$.dim}Max depth:${$.reset} ${$.cyan}${depthLabel}${$.reset}  ${$.dim}Max workers:${$.reset} ${$.cyan}${flags['--max-workers'] ?? 10}${$.reset}\n`);

  const done = startSpinner('Swarm loop running...');
  const startTime = Date.now();
  const result = await orch.execute(task);
  done();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('SWARM RESULT');
  const statusIcon = result.status === 'completed' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
  const statusColor = result.status === 'completed' ? $.green : result.status === 'partial' ? $.yellow : $.red;
  console.log(`  ${statusIcon} ${statusColor}${$.bold}${result.status.toUpperCase()}${$.reset}  ${$.dim}${elapsed}s · ${result.totalRounds} rounds · ${result.totalTokensUsed.toLocaleString()} tok${$.reset}\n`);

  console.log(`  ${$.bold}Rounds:${$.reset} ${result.totalRounds}`);
  console.log(`  ${$.bold}Tokens:${$.reset} ${result.totalTokensUsed.toLocaleString()}`);
  console.log(`  ${$.bold}Duration:${$.reset} ${elapsed}s`);
  console.log(`  ${$.bold}Tree depth:${$.reset} ${result.topology.depth}`);
  console.log(`  ${$.bold}Managers:${$.reset} ${result.topology.managerCount}`);
  console.log(`  ${$.bold}Total nodes:${$.reset} ${result.topology.totalNodes}`);
  console.log(`  ${$.bold}Fusion conflicts:${$.reset} ${result.fusionReports.reduce((s, r) => s + r.conflicts.length, 0)}`);
  console.log();

  if (result.fusionReports.some(r => r.conflicts.length > 0)) {
    section('FUSION CONFLICTS');
    for (const report of result.fusionReports) {
      for (const conflict of report.conflicts) {
        const severityColor = conflict.severity === 'critical' ? $.red
          : conflict.severity === 'high' ? $.yellow
          : $.dim;
        console.log(`  ${severityColor}⚠ ${conflict.type}${$.reset} ${conflict.description}`);
        if (conflict.suggestedResolution) {
          console.log(`    ${$.dim}→ ${conflict.suggestedResolution}${$.reset}`);
        }
      }
    }
    console.log();
  }

  section('TOPOLOGY');
  console.log(`  ${$.bold}Levels:${$.reset} ${result.topology.levelBreaths.map((b, i) => `level ${i}: ${b} nodes`).join(' · ')}`);
  console.log();
}

export async function cmdDrive(task: string, flags: Record<string, string>) {
  const runtime = createRuntime();
  if (!runtime) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
  }

  cmdHeader(task);

  const llmProvider = runtime.getProvider('openai')
    ?? runtime.getProvider('anthropic')
    ?? runtime.getProvider('openrouter')
    ?? runtime.getProvider('mimo')
    ?? runtime.getProvider('deepseek')
    ?? runtime.getProvider('glm')
    ?? runtime.getProvider('xiaomi')
    ?? runtime.getProvider('google');

  if (!llmProvider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No LLM provider available.\n`);
    process.exit(1);
  }

  const driveConfig: Partial<DriveConfig> = {};
  if (flags['--mode']) driveConfig.mode = flags['--mode'] as DriveConfig['mode'];
  if (flags['--iterations']) driveConfig.maxIterations = parseInt(flags['--iterations'], 10);
  if (flags['--verbose']) driveConfig.verbose = true;

  const orch = new DriveOrchestrator(llmProvider, runtime, driveConfig);

  const modeLabel = flags['--mode'] ?? 'auto';
  console.log(`  ${$.dim}Mode:${$.reset} ${$.cyan}${modeLabel}${$.reset}  ${$.dim}Max iterations:${$.reset} ${$.cyan}${driveConfig.maxIterations ?? 20}${$.reset}\n`);

  const done = startSpinner('Drive loop running...');
  const startTime = Date.now();
  const result = await orch.execute(task);
  done();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('DRIVE RESULT');
  const statusIcon = result.status === 'completed' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
  const statusColor = result.status === 'completed' ? $.green : result.status === 'partial' ? $.yellow : $.red;
  console.log(`  ${statusIcon} ${statusColor}${$.bold}${result.status.toUpperCase()}${$.reset}  ${$.dim}${elapsed}s · ${result.totalIterations} iterations · ${result.totalTokensUsed.toLocaleString()} tok${$.reset}\n`);

  console.log(`  ${$.bold}Iterations:${$.reset} ${result.totalIterations}`);
  console.log(`  ${$.bold}Steps:${$.reset} ${result.steps.filter(s => s.status === 'completed').length}/${result.steps.length}`);
  console.log(`  ${$.bold}Tokens:${$.reset} ${result.totalTokensUsed.toLocaleString()}`);
  console.log(`  ${$.bold}Duration:${$.reset} ${elapsed}s`);
  console.log();

  const failed = result.steps.filter(s => s.status === 'failed' || s.status === 'blocked');
  if (failed.length > 0) {
    section('BLOCKED STEPS');
    for (const s of failed) {
      console.log(`  ${$.red}⚠${$.reset} ${s.description}`);
      if (s.error) console.log(`    ${$.dim}${s.error.slice(0, 200)}${$.reset}`);
    }
    console.log();
  }

  section('STEP BREAKDOWN');
  for (const s of result.steps) {
    const icon = s.status === 'completed' ? '✅' : s.status === 'running' ? '↻' : s.status === 'blocked' ? '🚫' : s.status === 'failed' ? '❌' : '○';
    const color = s.status === 'completed' ? $.green : s.status === 'blocked' ? $.red : $.yellow;
    const retries = s.retryCount > 0 ? ` ${$.dim}(retries: ${s.retryCount})${$.reset}` : '';
    console.log(`  ${color}${icon}${$.reset} ${s.description}${retries}`);
  }
  console.log();
}

export async function cmdStatus() {
  const provider = detectProvider();

  section('SYSTEM STATUS');
  kv('Version', '1.0.0-alpha.1');
  kv('Node', process.version);
  kv('Platform', process.platform);

  if (provider) {
    section('ACTIVE PROVIDER');
    kv('Name', provider.type, $.cyan);
    kv('API URL', provider.baseUrl, $.dim);
    kv('Model', getEffectiveModel(), $.green);
  } else {
    kv('Provider', 'None — set an API key env var', $.red);
  }

  const envVars = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY', 'XIAOMI_API_KEY'];
  section('API KEYS');
  for (const v of envVars) {
    const exists = !!process.env[v];
    console.log(`  ${exists ? $.green + '✓' : $.dim + '✗'}${$.reset} ${v}`);
  }
  if (process.env.OPENAI_BASE_URL) console.log(`  ${$.dim}  (base URL: ${process.env.OPENAI_BASE_URL})${$.reset}`);

  const runtime = createRuntime();
  kv('Runtime', runtime ? `${$.green}ready${$.reset}` : `${$.red}no API key${$.reset}`);

  // MetaLearner stats
  try {
    const learner = getMetaLearner();
    const stats = learner.getStats();
    kv('Experiences', String(stats.totalExperiences));
    kv('Strategies', String(stats.trackedStrategies));
    kv('Avg success', (stats.avgSuccessRate * 100).toFixed(0) + '%');
    const suggestions = learner.getSuggestions();
    if (suggestions.length > 0) {
      section('OPTIMIZATIONS');
      for (const s of suggestions.slice(0, 3)) {
        console.log(`  ${$.yellow}!${$.reset} ${s.type}: ${s.from} → ${s.to} (${(s.confidence * 100).toFixed(0)}%)`);
      }
    }
  } catch (err) {
    getGlobalLogger().debug('CLI', 'Failed to load MetaLearner stats', { error: err instanceof Error ? err.message : String(err) });
  }

  const poolStatsPath = path.join(process.cwd(), '.commander_results');
  if (fs.existsSync(poolStatsPath)) {
    const files = fs.readdirSync(poolStatsPath).filter(f => f.endsWith('.txt'));
    if (files.length > 0) kv('Cached results', String(files.length));
  }
}

export async function cmdConfig(args: string[]) {
  if (args.length === 0 || args[0] === 'show') {
    section('CONFIGURATION');
    showConfig();
    console.log(`\n  ${$.dim}Set:  commander config set model <model-id>${$.reset}`);
    console.log(`  ${$.dim}      commander config set meta-tools on${$.reset}`);
    console.log(`  ${$.dim}      commander config list-providers${$.reset}`);
    console.log(`  ${$.dim}      commander config list-models${$.reset}`);
    console.log(`  ${$.dim}      commander config test${$.reset}`);
    return;
  }

  if (args[0] === 'set' && args.length >= 3) {
    try {
      setConfig(args[1], args.slice(2).join(' '));
      console.log(`  ${$.green}✓${$.reset} ${args[1]} = ${args.slice(2).join(' ')}`);
    } catch (e) {
      console.log(`  ${$.red}✗${$.reset} ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (args[0] === 'list-providers') {
    section('AVAILABLE PROVIDERS');
    console.log(`  ${$.dim}Set any API key env var to activate a provider:${$.reset}\n`);
    listProviders();
    console.log(`\n  ${$.dim}  ✓ = configured  ~ = via OPENAI_API_KEY  (space) = not set${$.reset}`);
    return;
  }

  if (args[0] === 'list-models') {
    section('AVAILABLE MODELS');
    listModels();
    return;
  }

  if (args[0] === 'test') {
    const provider = detectProvider();
    if (!provider) {
      console.log(`  ${$.red}No API key found. Set one of the env vars.${$.reset}`);
      return;
    }
    section('TESTING');
    console.log(`  Provider: ${provider.type}`);
    console.log(`  URL:      ${provider.baseUrl}`);
    process.stdout.write(`  Testing...`);
    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) console.log(` ${$.green}✓ Connection OK${$.reset}`);
      else console.log(` ${$.red}✗ ${res.status}${$.reset}`);
    } catch {
      console.log(` ${$.yellow}! Connection failed${$.reset}`);
    }
    return;
  }

  console.log(`  ${$.red}Usage:${$.reset} commander config [show|set <key> <val>|list-providers|list-models|test]`);
}

export async function cmdDoctor() {
  section('DOCTOR');
  const provider = detectProvider();
  const checks = [
    { label: 'Node.js v20+', pass: process.version.startsWith('v22') || process.version.startsWith('v20'), msg: '' },
    { label: `API key ${provider ? '✓' : '✗'}`, pass: !!provider, msg: 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.' },
    { label: 'Packages installed', pass: fs.existsSync(path.join(process.cwd(), 'node_modules')) || fs.existsSync(path.join(__dirname, '..', 'node_modules')), msg: 'Run: pnpm install' },
  ];
  let allOk = true;
  for (const c of checks) {
    if (!c.pass) allOk = false;
    console.log(`  ${c.pass ? $.green + '✓' : $.red + '✗'}${$.reset} ${c.label}${c.msg ? ' — ' + $.yellow + c.msg + $.reset : ''}`);
  }
  if (provider) {
    console.log(`  ${$.dim}Testing ${provider.type} at ${provider.baseUrl}...${$.reset}`);
    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      console.log(`  ${res.ok ? $.green + '✓' : $.red + '✗'}${$.reset} API: ${res.status}`);
    } catch {
      console.log(`  ${$.yellow}!${$.reset} API unreachable`);
    }
  }
  if (allOk) console.log(`\n  ${$.green}${$.bold}All checks passed${$.reset}`);
  else console.log(`\n  ${$.yellow}Some checks need attention${$.reset}`);
}

export async function cmdWorkers(topics: string[]) {
  if (topics.length === 0) {
    topics = ['LangGraph', 'CrewAI', 'AutoGen', 'MCP', 'Pydantic', 'LlamaIndex', 'Ollama', 'vLLM'];
  }

  const runtime = createRuntime();
  if (!runtime) { console.error(`  ${$.red}No provider configured${$.reset}`); process.exit(1); }

  const pool = new TaskPool(runtime, {
    maxWorkers: topics.length,
    defaultTokenBudget: 15000,
    globalTokenBudget: 300000,
    taskTimeoutMs: 120000,
  });

  const tasks = topics.map((topic, i) => ({
    id: 'worker-' + (i + 1),
    goal: 'Use browser_search to research: ' + topic + '. What is it? Key features? GitHub stars?',
    agentId: 'worker-' + (i + 1),
  }));

  console.log(`\n  ${$.bold}Spawning ${tasks.length} workers...${$.reset}\n`);
  const t0 = Date.now();
  const results = await pool.dispatch(tasks);
  const wallTime = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n  ${$.bold}Results (${wallTime}s):${$.reset}\n`);
  for (const r of results) {
    const icon = r.status === 'success' ? '✅' : '❌';
    const summary = (r.summary || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim().slice(0, 100);
    console.log(`  ${icon} ${r.taskId}: ${(r.durationMs / 1000).toFixed(1)}s, ${r.tokens} tok`);
    if (summary) console.log(`     ${summary}`);
    console.log();
  }
  const seqTime = results.reduce((s, r) => s + r.durationMs, 0) / 1000;
  console.log(`  ${$.dim}Sequential would be: ${seqTime.toFixed(1)}s | Speedup: ${(seqTime / parseFloat(wallTime)).toFixed(1)}x${$.reset}\n`);
}

export async function cmdGui() {
  section('GUI DASHBOARD');
  const apiDir = path.join(process.cwd(), 'apps', 'api');
  const webDir = path.join(process.cwd(), 'apps', 'web');

  if (!fs.existsSync(path.join(apiDir, 'src', 'index.ts'))) {
    console.log(`  ${$.red}API server not found at apps/api/${$.reset}`);
    return;
  }

  console.log(`  ${$.green}Starting API server...${$.reset}`);
  console.log(`  ${$.dim}API:${$.reset}  http://localhost:4000`);
  console.log(`  ${$.dim}Web:${$.reset}  cd apps/web && npx vite\n`);

  const api = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: apiDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: '4000' },
  });

  api.on('exit', (code: number) => {
    console.log(`\n  ${$.dim}API server exited (code ${code})${$.reset}`);
    process.exit(code ?? 0);
  });

  // Keep running — don't exit main()
  await new Promise(() => {});
}

// ============================================================================
// Skill CLI — manage skills
// ============================================================================

export async function cmdSkill(subargs: string[]) {
  const { getSkillSystem, SkillCurator } = await import('../skills');
  const system = getSkillSystem();

  const sub = subargs[0] || 'help';

  if (sub === 'list' || sub === 'ls') {
    const catalog = await system.manager.list();
    if (catalog.length === 0) {
      console.log(`\n  ${$.dim}No skills found.${$.reset}\n`);
      return;
    }
    section(`SKILLS (${catalog.length})`);
    for (const entry of catalog) {
      const pin = entry.pinned ? '📌' : '  ';
      const qual = (entry.qualityScore * 100).toFixed(0);
      const used = entry.usageCount;
      console.log(`  ${pin} ${$.bold}${entry.name}${$.reset} ${$.dim}${entry.description.slice(0, 50)}${$.reset}`);
      console.log(`      ${$.gray}quality: ${qual}% · uses: ${used} · ${entry.category} · [${entry.tags.join(', ')}]${$.reset}`);
    }
    console.log();
    return;
  }

  if (sub === 'view') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill view <name>\n`); return; }
    const skill = await system.manager.get(name);
    if (!skill) { console.error(`  ${$.red}Skill "${name}" not found.${$.reset}\n`); return; }
    section(`SKILL: ${skill.name}`);
    kv('Description', skill.description);
    kv('Category', skill.metadata.category);
    kv('Tags', skill.metadata.tags.join(', '));
    kv('Quality', `${(skill.metadata.qualityScore * 100).toFixed(0)}%`);
    kv('Usage', `${skill.metadata.usageCount} · success rate: ${(skill.metadata.avgSuccessRate * 100).toFixed(0)}%`);
    kv('Pinned', skill.metadata.pinned ? 'Yes' : 'No', skill.metadata.pinned ? $.green : $.dim);
    kv('Source', skill.metadata.source);
    kv('Created', skill.metadata.createdAt.slice(0, 10));
    console.log(`\n  ${$.dim}${'-'.repeat(50)}${$.reset}`);
    console.log(`  ${skill.content.slice(0, 1000)}${skill.content.length > 1000 ? '\n  ...' : ''}`);
    console.log();
    return;
  }

  if (sub === 'create') {
    const name = subargs[1];
    const desc = subargs[2] || name;
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill create <name> [description]\n`); return; }
    const content = `# ${name}\n\n${desc}\n\n## Steps\n1. TBD`;
    const skill = await system.manager.create(name, content, {
      category: 'general', tags: [], source: 'user',
    });
    console.log(`  ${$.green}✓${$.reset} Created skill "${$.bold}${skill.name}${$.reset}"\n`);
    return;
  }

  if (sub === 'pin') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill pin <name>\n`); return; }
    await system.manager.setPinned(name, true);
    console.log(`  ${$.green}✓${$.reset} Pinned "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'unpin') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill unpin <name>\n`); return; }
    await system.manager.setPinned(name, false);
    console.log(`  ${$.green}✓${$.reset} Unpinned "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill delete <name>\n`); return; }
    await system.manager.delete(name);
    console.log(`  ${$.green}✓${$.reset} Deleted "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'curate') {
    section('CURATE');
    const done = startSpinner('Running curator...');
    const curator = new SkillCurator(system.manager);
    const report = await curator.curate();
    done();
    if (report.archived.length > 0) {
      console.log(`  ${$.yellow}Archived:${$.reset} ${report.archived.join(', ')}`);
    }
    if (report.consolidated.length > 0) {
      console.log(`  ${$.yellow}Consolidated:${$.reset} ${report.consolidated.join(', ')}`);
    }
    kv('Before', `${report.totalBefore}`, $.gray);
    kv('After', `${report.totalAfter}`, $.gray);
    kv('Archived', `${report.totalArchived}`, $.yellow);
    console.log();
    return;
  }

  console.log(`
  ${$.bold}SKILL COMMANDS${$.reset}
    ${$.cyan}commander skill list${$.reset}         List all skills
    ${$.cyan}commander skill view <name>${$.reset}  View skill details
    ${$.cyan}commander skill create <name>${$.reset} Create a new skill
    ${$.cyan}commander skill pin <name>${$.reset}    Pin a skill (protect from curator)
    ${$.cyan}commander skill unpin <name>${$.reset}  Unpin a skill
    ${$.cyan}commander skill delete <name>${$.reset} Delete a skill
    ${$.cyan}commander skill curate${$.reset}        Run curator (archive+consolidate)
  `);
}

export async function cmdReview(args: string[]) {
  const scope = args.includes('--commit') ? 'commit' as const
    : args.includes('--branch') ? 'branch' as const
    : 'uncommitted' as const;

  const baseIdx = args.indexOf('--base');
  const baseRef = baseIdx >= 0 && baseIdx + 1 < args.length ? args[baseIdx + 1] : undefined;

  const commitIdx = args.indexOf('--commit');
  const commitSha = commitIdx >= 0 && commitIdx + 1 < args.length ? args[commitIdx + 1] : undefined;

  const useJson = args.includes('--json');

  const guidelines = loadReviewGuidelines();

  const customGuidelineIdx = args.indexOf('--guidelines');
  const customGuidelines = customGuidelineIdx >= 0 && customGuidelineIdx + 1 < args.length
    ? args[customGuidelineIdx + 1].split('|')
    : [];

  section('CODE REVIEW');
  bullet(`Scope: ${scope}${baseRef ? ` (base: ${baseRef})` : ''}${commitSha ? ` (commit: ${commitSha})` : ''}`);
  if (guidelines.length > 0 || customGuidelines.length > 0) {
    bullet(`Guidelines: ${[...guidelines, ...customGuidelines].length} rule(s)`);
  }
  console.log();

  const done = startSpinner('Reviewing changes...');
  try {
    const report = await executeReview({
      scope,
      baseRef,
      commitSha,
      guidelines: [...guidelines, ...customGuidelines],
      outputFormat: useJson ? 'json' : 'text',
    });
    done();

    if (useJson) {
      console.log(reviewReportToJson(report));
    } else {
      console.log(formatReviewOutput(report));
    }

    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    done();
    console.error(`\n  ${$.red}Review failed: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
    process.exit(1);
  }
}

export async function cmdMode(modeArg?: string) {
  const approval = getApprovalSystem();

  if (!modeArg) {
    const current = approval.getMode();
    const modeLabels: Record<string, string> = {
      'suggest': 'Suggest mode — prompts before risky operations',
      'auto-edit': 'Auto-edit mode — allows most operations, flags sandbox escapes',
      'full-auto': 'Full-auto mode — no approval gates',
      'read-only': 'Read-only mode — no writes, no destructive ops',
      'plan': 'Plan mode — analysis only, no modifications',
    };
    section('APPROVAL MODE');
    kv('Mode', current, $.cyan);
    console.log(`  ${$.dim}${modeLabels[current] ?? ''}${$.reset}`);
    console.log(`\n  ${$.dim}Set:  commander mode <plan|read-only|auto-edit|full-auto|suggest>${$.reset}\n`);
    return;
  }

  const validModes: ApprovalMode[] = ['suggest', 'auto-edit', 'full-auto', 'read-only', 'plan'];
  if (!validModes.includes(modeArg as ApprovalMode)) {
    console.log(`  ${$.red}Invalid mode:${$.reset} "${modeArg}"`);
    console.log(`  ${$.dim}Valid modes:${$.reset} ${validModes.join(', ')}\n`);
    return;
  }

  approval.setMode(modeArg as ApprovalMode);
  console.log(`  ${$.green}✓${$.reset} Mode set to ${$.cyan}${modeArg}${$.reset}\n`);
}

// ============================================================================
// History — past execution sessions
// ============================================================================

export async function cmdHistory(subargs: string[]) {
  if (subargs[0] === 'view' && subargs[1]) {
    return cmdHistoryView(subargs[1]);
  }
  if (subargs[0] === 'delete' && subargs[1]) {
    const checkpointer = new StateCheckpointer();
    checkpointer.deleteCheckpoint(subargs[1]);
    console.log(`  ${$.green}✓${$.reset} Deleted session ${$.bold}${subargs[1]}${$.reset}\n`);
    return;
  }
  if (subargs[0] === 'prune' && subargs[1]) {
    const keep = parseInt(subargs[1], 10);
    if (isNaN(keep) || keep < 0) { console.error(`  ${$.red}Usage:${$.reset} commander history prune <keep-count>\n`); return; }
    const checkpointer = new StateCheckpointer();
    const before = checkpointer.listCheckpoints().length;
    checkpointer.prune(keep);
    console.log(`  ${$.green}✓${$.reset} Pruned to ${$.bold}${keep}${$.reset} sessions (removed ${before - Math.min(keep, before)})\n`);
    return;
  }

  const checkpointer = new StateCheckpointer();
  const entries = checkpointer.listCheckpoints();

  section('SESSION HISTORY');
  if (entries.length === 0) {
    console.log(`  ${$.dim}No saved sessions found.${$.reset}`);
    console.log(`  ${$.dim}Run a task first:${$.reset} ${$.cyan}commander run "<task>"${$.reset}\n`);
    return;
  }

  kv('Total', `${entries.length}`, $.cyan);

  for (const entry of entries) {
    const ts = new Date(entry.timestamp).toLocaleString();
    const phaseIcon: Record<string, string> = {
      completed: '✅', failed: '❌', started: '📋',
      llm_call: '🤖', tool_execution: '🔧', verification: '🔍',
    };
    const icon = phaseIcon[entry.phase] || '📄';
    const runIdShort = entry.runId.length > 20 ? entry.runId.slice(0, 20) + '…' : entry.runId;
    const statusColor = entry.phase === 'completed' ? $.green : entry.phase === 'failed' ? $.red : $.yellow;
    console.log(`  ${icon} ${statusColor}${entry.phase.padEnd(14)}${$.reset} ${$.dim}${ts}${$.reset}`);
    console.log(`      ${$.gray}${runIdShort}${$.reset}`);
  }
  console.log(`\n  ${$.dim}View:  commander history view <runId>${$.reset}`);
  console.log(`  ${$.dim}Prune: commander history prune <keep-count>${$.reset}`);
  console.log(`  ${$.dim}Del:   commander history delete <runId>${$.reset}\n`);
}

// ============================================================================
// Workflow / Scheduler commands
// ============================================================================

export async function cmdWorkflow(subargs: string[]) {
  const subcmd = subargs[0];
  const rest = subargs.slice(1);

  // Lazily initialize registry + scheduler
  const registry = new WorkflowRegistry([
    path.join(process.cwd(), '.commander', 'workflows'),
    path.join(process.env.HOME || process.env.USERPROFILE || '~', '.commander', 'workflows'),
  ]);
  const scheduler = new Scheduler();

  switch (subcmd) {
    case 'list':
    case 'ls': {
      const workflows = registry.scan();
      const schedules = scheduler.list();
      if (workflows.length === 0 && schedules.length === 0) {
        console.log(`  ${$.dim}No workflows found. Create one in .commander/workflows/*.md${$.reset}`);
        break;
      }
      console.log(`\n  ${$.bold}Available workflows${$.reset}\n`);
      for (const wf of workflows) {
        const trig = wf.triggers.map(t => t.label).join(', ') || 'manual only';
        console.log(`  ${$.cyan}${wf.id}${$.reset}`);
        console.log(`    ${$.dim}${wf.description}${$.reset}`);
        console.log(`    ${$.dim}triggers: ${trig}${$.reset}`);
        console.log(`    ${$.dim}steps: ${wf.steps.length} | file: ${wf.sourcePath}${$.reset}\n`);
      }
      if (schedules.length > 0) {
        console.log(`  ${$.bold}Scheduled tasks${$.reset}\n`);
        for (const s of schedules) {
          const status = s.enabled ? `${$.green}active${$.reset}` : `${$.gray}paused${$.reset}`;
          console.log(`  ${$.cyan}${s.id}${$.reset} ${status}`);
          console.log(`    ${$.dim}workflow: ${s.workflowName} | trigger: ${s.trigger.label}${$.reset}`);
          console.log(`    ${$.dim}runs: ${s.runCount} | next: ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'never'}${$.reset}\n`);
        }
      }
      break;
    }

    case 'run': {
      const wfId = rest[0];
      if (!wfId) {
        console.error(`  ${$.red}Usage: commander workflow run <workflow-id>${$.reset}\n`);
        break;
      }
      registry.scan();
      const wf = registry.get(wfId);
      if (!wf) {
        console.error(`  ${$.red}Workflow "${wfId}" not found${$.reset}\n`);
        break;
      }

      const provider = detectProvider();
      const runtime = createRuntime();
      if (!runtime || !provider) {
        console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
        onboardingMessage();
        break;
      }

      const rt: AgentRuntime = runtime;
      const telos = new TELOSOrchestrator(rt);
      const orch = new UltimateOrchestrator(telos, rt);

      console.log(`  ${$.yellow}→ Executing workflow: ${wf.name}${$.reset}\n`);
      console.log(`  ${$.dim}${wf.description} | ${wf.steps.length} steps${$.reset}\n`);

      const startTime = Date.now();
      const result = await orch.execute({
        projectId: 'workflow',
        agentId: `wf-${wf.id}`,
        goal: wf.goal,
        contextData: {
          availableTools: loadTools(),
          workflowId: wf.id,
          steps: wf.steps,
        },
        effortLevel: wf.effort ?? 'AUTO' as unknown as EffortLevel,
        topology: wf.topology,
        onProgress: (phase, detail) => {
          if (phase === 'COMPLETE') return;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  ${$.dim}[${elapsed}s]${$.reset} ${$.bold}${phase}${$.reset} ${$.dim}${detail.slice(0, 70)}${$.reset}`);
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const icon = result.status === 'SUCCESS' ? '✅' : result.status === 'PARTIAL' ? '⚠️' : '❌';
      const statusColor = result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red;
      console.log(`\n  ${icon} ${statusColor}${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s · ${result.metrics.totalTokens.toLocaleString()} tok · $${result.metrics.totalCostUsd.toFixed(4)}${$.reset}`);

      if (result.status !== 'SUCCESS' && result.errors.length > 0) {
        for (const err of result.errors) {
          console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
        }
      }
      if (result.synthesis) {
        const preview = result.synthesis.split('\n').filter(l => l.trim()).slice(0, 5).join('\n  ');
        console.log(`\n  ${preview}`);
      }
      console.log();
      break;
    }

    case 'schedule': {
      // commander workflow schedule <workflow-id> --cron="0 6 * * 1" --tag=nightly
      if (rest.length === 0) {
        console.error(`  ${$.red}Usage: commander workflow schedule <workflow-id> --cron="0 6 * * 1"${$.reset}\n`);
        break;
      }
      const wfId = rest[0];
      registry.scan();
      const wf = registry.get(wfId);
      if (!wf) {
        console.error(`  ${$.red}Workflow "${wfId}" not found${$.reset}\n`);
        break;
      }

      const flags: Record<string, string> = {};
      for (const arg of rest.slice(1)) {
        if (arg.startsWith('--') && arg.includes('=')) {
          const [k, v] = arg.split('=');
          flags[k.slice(2)] = v;
        } else if (arg.startsWith('--')) {
          flags[arg.slice(2)] = 'true';
        }
      }

      const trigger: WorkflowTrigger = flags.cron
        ? { type: 'cron', cron: flags.cron, label: `cron:${flags.cron}` }
        : flags.interval
          ? { type: 'interval', interval: flags.interval, label: `every ${flags.interval}` }
          : { type: 'interval', interval: '24h', label: 'every 24h' };

      const entry: ScheduleEntry = {
        id: `${wf.id}__${Date.now()}`,
        workflowId: wf.id,
        workflowName: wf.name,
        trigger,
        createdAt: new Date().toISOString(),
        runCount: 0,
        enabled: true,
        tags: flags.tag ? flags.tag.split(',') : [],
      };

      scheduler.add(entry);
      console.log(`  ${$.green}✓ Scheduled "${wf.name}"${$.reset}`);
      console.log(`  ${$.dim}  trigger: ${trigger.label}${$.reset}`);
      console.log(`  ${$.dim}  id: ${entry.id}${$.reset}\n`);
      break;
    }

    case 'unschedule':
    case 'rm': {
      const sId = rest[0];
      if (!sId) {
        console.error(`  ${$.red}Usage: commander workflow unschedule <schedule-id>${$.reset}\n`);
        break;
      }
      if (scheduler.remove(sId)) {
        console.log(`  ${$.green}✓ Removed schedule ${sId}${$.reset}\n`);
      } else {
        console.error(`  ${$.red}Schedule "${sId}" not found${$.reset}\n`);
      }
      break;
    }

    case 'pause': {
      const sId = rest[0];
      if (!sId || !scheduler.disable(sId)) {
        console.error(`  ${$.red}Schedule not found. Usage: commander workflow pause <schedule-id>${$.reset}\n`);
      } else {
        console.log(`  ${$.yellow}○ Paused schedule ${sId}${$.reset}\n`);
      }
      break;
    }

    case 'resume': {
      const sId = rest[0];
      if (!sId || !scheduler.enable(sId)) {
        console.error(`  ${$.red}Schedule not found. Usage: commander workflow resume <schedule-id>${$.reset}\n`);
      } else {
        console.log(`  ${$.green}✓ Resumed schedule ${sId}${$.reset}\n`);
      }
      break;
    }

    case 'history':
    case 'log': {
      const wfId = rest[0];
      const records = scheduler.getHistory(wfId || undefined);
      if (records.length === 0) {
        console.log(`  ${$.dim}No execution records found${$.reset}\n`);
        break;
      }
      console.log(`\n  ${$.bold}Execution history${$.reset}\n`);
      for (const r of records.slice(-10).reverse()) {
        const statusColor = r.status === 'success' ? $.green : r.status === 'failed' ? $.red : $.yellow;
        const started = new Date(r.startedAt).toLocaleString();
        const dur = r.durationMs ? ` | ${(r.durationMs / 1000).toFixed(1)}s` : '';
        console.log(`  ${statusColor}${r.status.padEnd(8)}${$.reset} ${started}${$.dim}${dur} | ${r.workflowId}${$.reset}`);
        if (r.summary) console.log(`  ${$.dim}  ${r.summary.slice(0, 120)}${$.reset}`);
      }
      console.log();
      break;
    }

    case 'create': {
      const name = rest[0];
      if (!name) {
        console.error(`  ${$.red}Usage: commander workflow create <name> [--description=...] [--cron="0 6 * * *"]${$.reset}\n`);
        break;
      }
      const flags: Record<string, string> = {};
      for (const arg of rest.slice(1)) {
        if (arg.startsWith('--') && arg.includes('=')) {
          const [k, v] = arg.split('=');
          flags[k.slice(2)] = v;
        }
      }

      const wfDir = path.join(process.cwd(), '.commander', 'workflows');
      fs.mkdirSync(wfDir, { recursive: true });
      const filePath = path.join(wfDir, `${name}.md`);

      if (fs.existsSync(filePath)) {
        console.error(`  ${$.red}Workflow already exists: ${filePath}${$.reset}\n`);
        break;
      }

      const desc = flags.description || `Automated ${name} workflow`;
      const cron = flags.cron ? `  cron: "${flags.cron}"` : '#  cron: "0 6 * * 1-5"';

      const template = `---
name: ${name}
description: ${desc}
topology: SEQUENTIAL
effort: auto
trigger:
${cron}
---

## Steps

### 1. Analysis
goal: Analyze the current state and gather context
tools: [Read, Grep, Glob]
model-tier: standard
parallelizable: false

### 2. Execution
goal: Perform the main work
tools: [Read, Write, Edit, Bash]
model-tier: best
parallelizable: true
depends-on: [analysis]

### 3. Verification
goal: Verify the results are correct
tools: [Bash, Read]
model-tier: standard
depends-on: [execution]
`;
      fs.writeFileSync(filePath, template);
      console.log(`  ${$.green}✓ Created workflow: ${filePath}${$.reset}\n`);
      break;
    }

    case 'daemon':
    case 'start': {
      const provider = detectProvider();
      const runtime = createRuntime();
      if (!runtime || !provider) {
        console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
        onboardingMessage();
        break;
      }

      const rt: AgentRuntime = runtime;
      const telos = new TELOSOrchestrator(rt);
      const orch = new UltimateOrchestrator(telos, rt);
      scheduler.setOrchestrator(orch);

      // Watch workflow directory for changes
      const watchDir = path.join(process.cwd(), '.commander', 'workflows');
      if (fs.existsSync(watchDir)) {
        fs.watch(watchDir, (eventType, filename) => {
          if (filename?.endsWith('.md')) {
            const wfId = filename.replace(/\.md$/, '');
            const reloaded = registry.reload(wfId);
            if (reloaded) {
              console.log(`  ${$.dim}[${new Date().toLocaleTimeString()}] reloaded: ${wfId}${$.reset}`);
            }
          }
        });
      }

      scheduler.start();
      console.log(`  ${$.green}✓ Scheduler daemon running${$.reset}`);
      console.log(`  ${$.dim}  Tick: ${scheduler.getConfig().tickIntervalMs / 1000}s`);
      console.log(`  ${$.dim}  State: ${path.join(process.cwd(), '.commander', 'scheduler')}${$.reset}`);
      console.log(`  ${$.dim}  Workflows: ${registry.list().length} loaded${$.reset}\n`);

      process.on('SIGINT', () => {
        scheduler.stop();
        console.log(`\n  ${$.yellow}○ Scheduler daemon stopped${$.reset}\n`);
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        scheduler.stop();
        process.exit(0);
      });

      await new Promise(() => {});
      break;
    }

    case 'stop':
      scheduler.stop();
      console.log(`  ${$.yellow}○ Scheduler stopped${$.reset}\n`);
      break;

    default:
      console.log(`
  ${$.bold}WORKFLOW COMMANDS${$.reset}
    ${$.cyan}commander workflow ls${$.reset}              List available and scheduled workflows
    ${$.cyan}commander workflow run <id>${$.reset}        Show workflow details
    ${$.cyan}commander workflow schedule <id>${$.reset}   Schedule a workflow (--cron="..." --interval="30m")
    ${$.cyan}commander workflow unschedule <id>${$.reset} Remove a scheduled workflow
    ${$.cyan}commander workflow pause <id>${$.reset}      Pause a scheduled workflow
    ${$.cyan}commander workflow resume <id>${$.reset}     Resume a scheduled workflow
    ${$.cyan}commander workflow history${$.reset}          Show execution history
    ${$.cyan}commander workflow daemon${$.reset}           Start the scheduler daemon
    ${$.cyan}commander workflow stop${$.reset}             Stop the scheduler daemon
      `);
      break;
  }
}

export async function cmdHistoryView(runId: string) {
  const checkpointer = new StateCheckpointer();
  const state = checkpointer.resume(runId);
  if (!state) {
    console.error(`  ${$.red}Session not found:${$.reset} ${runId}\n`);
    return;
  }

  section('SESSION DETAIL');
  kv('Run ID', runId, $.cyan);
  kv('Agent', state.agentId);
  kv('Phase', state.phase, state.phase === 'completed' ? $.green : state.phase === 'failed' ? $.red : $.yellow);
  kv('Goal', state.context.goal.slice(0, 120));
  kv('Steps', `${state.stepNumber}`, $.yellow);
  kv('Tokens', `${state.tokenUsage.totalTokens?.toLocaleString() ?? 'N/A'}`, $.yellow);
  kv('Duration', `${(state.totalDurationMs / 1000).toFixed(1)}s`);
  kv('Timestamp', new Date(state.timestamp).toLocaleString());
  if (state.lastError) {
    kv('Error', state.lastError.slice(0, 200), $.red);
  }
  if (state.context.availableTools.length > 0) {
    kv('Tools', state.context.availableTools.slice(0, 8).join(', '));
  }
  console.log();
}

export function cmdHelp() {
  console.log(`
  ${$.bold}${$.blue}╭──────────────────────────────────────────────╮${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander${$.reset} — multi-agent orchestration      ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.dim}619+ tests · 20 providers · GAIA 69.7%${$.reset}       ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}╰──────────────────────────────────────────────╯${$.reset}

  ${$.bold}GET STARTED${$.reset}
    Set an API key and run:
    ${$.gray}$ export OPENAI_API_KEY=sk-...${$.reset}
    ${$.gray}$ commander "Hello, world!"${$.reset}

  ${$.bold}COMMANDS${$.reset}
    ${$.cyan}commander <task>${$.reset}        Quick task analysis
    ${$.cyan}commander run <task>${$.reset}     Full multi-agent execution
    ${$.cyan}commander plan <task>${$.reset}    Show deliberation plan
    ${$.cyan}commander watch <task>${$.reset}   Real-time execution stream
    ${$.cyan}commander status${$.reset}         System status
    ${$.cyan}commander config${$.reset}         View / change settings
    ${$.cyan}commander doctor${$.reset}         Run diagnostics
    ${$.cyan}commander gui${$.reset}            Start the Agent War Room dashboard
    ${$.cyan}commander tui${$.reset}            Terminal dashboard (live events, sessions)
    ${$.cyan}commander workers <topics>${$.reset}  Parallel research workers
    ${$.cyan}commander company <task>${$.reset}   Company mode execution
    ${$.cyan}commander goal <task>${$.reset}      Multi-agent goal loop
    ${$.cyan}commander swarm <task>${$.reset}     Recursive swarm (fission + fusion)
    ${$.cyan}commander drive <task>${$.reset}     Autonomous drive
    ${$.cyan}commander skill${$.reset}             Manage learnable skills
    ${$.cyan}commander mode${$.reset}              Show/set approval mode
    ${$.cyan}commander review${$.reset}            Review code changes
    ${$.cyan}commander workflow${$.reset}            Schedule and run repeatable workflows
    ${$.cyan}commander history${$.reset}           List past execution sessions

  ${$.bold}OPTIONS${$.reset}
    ${$.cyan}--version${$.reset}              Show version
    ${$.cyan}--help${$.reset}                 Show this help
  `);
}

// ============================================================================
// Main entry
// ============================================================================
