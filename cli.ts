#!/usr/bin/env node
/// <reference types="node" />
/**
 * Commander CLI — Multi-Agent Orchestration System
 *
 * Usage:
 *   commander <task>                    Quick plan (default)
 *   commander run <task>                Execute with full pipeline
 *   commander plan <task>               Show deliberation plan
 *   commander watch <task>              Real-time execution stream
 *   commander company <task>            Company mode execution
 *   commander workers [topics]          Parallel research workers
 *   commander review [options]          Code review (P0-P3 findings)
 *   commander --version                 Show version
 *   commander help                      Show this help
 *
 * Configuration via environment:
 *   ANTHROPIC_API_KEY                   Anthropic provider key
 *   OPENAI_API_KEY                      OpenAI provider key
 *   COMMANDER_TOOLS                     Comma-separated tool list
 *   COMMANDER_EFFORT                    SIMPLE|MODERATE|COMPLEX|DEEP_RESEARCH
 */
import * as fs from 'fs';
import * as path from 'path';
import { deliberate, deliberateWithLLM } from './packages/core/src/ultimate/deliberation';
import { classifyEffortLevel } from './packages/core/src/ultimate/effortScaler';
import { AgentRuntime } from './packages/core/src/runtime/agentRuntime';
import { OpenAIProvider } from './packages/core/src/runtime/providers/openaiProvider';
import { AnthropicProvider } from './packages/core/src/runtime/providers/anthropicProvider';
import { GoogleProvider } from './packages/core/src/runtime/providers/googleProvider';
import { OpenRouterProvider } from './packages/core/src/runtime/providers/openRouterProvider';
import { DeepSeekProvider } from './packages/core/src/runtime/providers/deepseekProvider';
import { GLMProvider } from './packages/core/src/runtime/providers/glmProvider';
import { MiMoProvider } from './packages/core/src/runtime/providers/mimoProvider';
import { XiaomiProvider } from './packages/core/src/runtime/providers/xiaomiProvider';
import { OllamaProvider } from './packages/core/src/runtime/providers/ollamaProvider';
import { VLLMProvider } from './packages/core/src/runtime/providers/vllmProvider';
import { CohereProvider } from './packages/core/src/runtime/providers/cohereProvider';
import { MistralProvider } from './packages/core/src/runtime/providers/mistralProvider';
import { GroqProvider } from './packages/core/src/runtime/providers/groqProvider';
import { TogetherProvider } from './packages/core/src/runtime/providers/togetherProvider';
import { PerplexityProvider } from './packages/core/src/runtime/providers/perplexityProvider';
import { FireworksProvider } from './packages/core/src/runtime/providers/fireworksProvider';
import { ReplicateProvider } from './packages/core/src/runtime/providers/replicateProvider';
import { BedrockProvider } from './packages/core/src/runtime/providers/bedrockProvider';
import { XAIProvider } from './packages/core/src/runtime/providers/xaiProvider';
import { AnyscaleProvider } from './packages/core/src/runtime/providers/anyscaleProvider';
import { DeepInfraProvider } from './packages/core/src/runtime/providers/deepinfraProvider';
import { getModelRouter } from './packages/core/src/runtime/modelRouter';
import { createAllTools } from './packages/core/src/tools/index';
import { executeReview, formatReviewOutput, reviewReportToJson, loadReviewGuidelines } from './packages/core/src/reviewAgent';
import type { ModelConfig } from './packages/core/src/runtime/types';
import { UltimateOrchestrator } from './packages/core/src/ultimate/orchestrator';
import { TELOSOrchestrator } from './packages/core/src/telos/telosOrchestrator';
import { CompanyEngine } from './packages/core/src/company';
import { SSEStream } from './packages/core/src/runtime/sseStream';
import { getMessageBus } from './packages/core/src/runtime/messageBus';
import { getTraceRecorder } from './packages/core/src/runtime/executionTrace';
import { getMetaLearner } from './packages/core/src/selfEvolution/metaLearner';
import {
  detectProvider, getEffectiveModel, setConfig, showConfig, listProviders, listModels, resetConfig,
} from './packages/core/src/config/commanderConfig';
import type { ProviderInfo } from './packages/core/src/config/commanderConfig';
import { getApprovalSystem } from './packages/core/src/sandbox';
import type { ApprovalMode } from './packages/core/src/sandbox';
import { setGlobalLogLevel } from './packages/core/src/logging';
import { StateCheckpointer } from './packages/core/src/runtime/stateCheckpointer';
import { startTUI } from './packages/core/src/tui';
import { spawn } from 'child_process';
import { TaskPool } from './packages/core/src/orchestration/taskPool';
import { GoalOrchestrator } from './packages/core/src/goal/goalOrchestrator';
import type { GoalConfig } from './packages/core/src/goal/types';
import { SwarmOrchestrator } from './packages/core/src/swarm/swarmOrchestrator';
import type { SwarmConfig } from './packages/core/src/swarm/types';


// ============================================================================
// ANSI styling — zero dependencies
// ============================================================================
const $ = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgGray: '\x1b[100m',
};

function section(title: string) {
  console.log(`\n  ${$.bold}${$.blue}┃ ${title}${$.reset}`);
}

function kv(key: string, value: string, valColor = '') {
  console.log(`  ${$.dim}${key}${$.reset} ${valColor}${value}${$.reset}`);
}

function bullet(text: string, color = '') {
  console.log(`  ${color}•${$.reset} ${text}`);
}

function cmdHeader(task: string) {
  const provider = detectProvider();
  const model = getEffectiveModel();
  const providerTag = provider ? `${provider.type} · ${model}` : 'no provider';
  console.log(`\n  ${$.bold}${$.blue}╭────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander${$.reset} ${$.dim}multi-agent orchestration${$.reset}  ${$.bold}${$.blue}│${$.reset}`);
  console.log(`  ${$.bold}${$.blue}│${$.reset}  ${$.dim}${providerTag}${$.reset}${' '.repeat(Math.max(0, 36 - providerTag.length))} ${$.bold}${$.blue}│${$.reset}`);
  console.log(`  ${$.bold}${$.blue}╰────────────────────────────────────────────╯${$.reset}`);
  console.log(`  ${$.dim}Task:${$.reset} ${task.length > 70 ? task.slice(0, 70) + '...' : task}\n`);
}

// Simple spinner for long operations
function startSpinner(label: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r  ${$.cyan}${frames[i]}${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}`);
    i = (i + 1) % frames.length;
  }, 80);
  return () => {
    clearInterval(timer);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r  ${$.green}✓${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}\n`);
  };
}

function onboardingMessage() {
  console.log(`\n  ${$.bold}${$.blue}╭────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Welcome to Commander${$.reset}                  ${$.bold}${$.blue}│${$.reset}`);
  console.log(`  ${$.bold}${$.blue}╰────────────────────────────────────────────╯${$.reset}`);
  console.log(`\n  To get started, set one of these environment variables:\n`);
  const vars = [
    ['OPENAI_API_KEY', 'OpenAI / DeepSeek / GLM / MiMo'],
    ['ANTHROPIC_API_KEY', 'Anthropic Claude'],
    ['GOOGLE_API_KEY', 'Google Gemini'],
    ['OPENROUTER_API_KEY', 'OpenRouter (200+ models)'],
    ['DEEPSEEK_API_KEY', 'DeepSeek (dedicated)'],
    ['ZHIPU_API_KEY', 'GLM (Zhipu AI)'],
    ['MIMO_API_KEY', 'MiMo (dedicated)'],
    ['XIAOMI_API_KEY', 'Xiaomi MiMo'],
    ['OLLAMA_HOST', 'Ollama (local) — http://localhost:11434/v1'],    // OLLAMA_BASE_URL also accepted
    ['VLLM_BASE_URL', 'vLLM (local) — http://localhost:8000/v1'],
    ['CO_API_KEY', 'Cohere'],                                          // COHERE_API_KEY also accepted
    ['MISTRAL_API_KEY', 'Mistral AI'],
    ['GROQ_API_KEY', 'Groq (fast inference)'],
    ['TOGETHER_API_KEY', 'Together AI'],
    ['PERPLEXITY_API_KEY', 'Perplexity'],                              // PPLX_API_KEY also accepted
    ['FIREWORKS_API_KEY', 'Fireworks AI'],
    ['REPLICATE_API_TOKEN', 'Replicate'],                              // REPLICATE_API_KEY also accepted
    ['AWS_ACCESS_KEY_ID', 'AWS Bedrock (+ AWS_SECRET_ACCESS_KEY)'],
  ];
  for (const [key, desc] of vars) {
    console.log(`    ${$.cyan}${key.padEnd(22)}${$.reset} ${$.dim}${desc}${$.reset}`);
  }
  console.log(`\n  ${$.dim}Example:${$.reset}`);
  console.log(`    ${$.gray}$ export OPENAI_API_KEY=sk-...${$.reset}`);
  console.log(`    ${$.gray}$ commander "Hello, world!"${$.reset}\n`);
}

// ============================================================================
// Config — Multi-Provider Support
// ============================================================================

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

async function cmdPlan(task: string) {
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

async function cmdRun(task: string) {
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

async function cmdWatch(task: string) {
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
    } catch {}
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

async function cmdCompany(task: string) {
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

async function cmdGoal(task: string, flags: Record<string, string>) {
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

async function cmdSwarm(task: string, flags: Record<string, string>) {
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

async function cmdStatus() {
  const provider = detectProvider();

  section('SYSTEM STATUS');
  kv('Version', '0.2.0');
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
  } catch {}

  // TaskPool stats
  const poolStatsPath = path.join(process.cwd(), '.commander_results');
  if (fs.existsSync(poolStatsPath)) {
    const files = fs.readdirSync(poolStatsPath).filter(f => f.endsWith('.txt'));
    if (files.length > 0) kv('Cached results', String(files.length));
  }
}

async function cmdConfig(args: string[]) {
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
    } catch (e: any) {
      console.log(`  ${$.red}✗${$.reset} ${e.message}`);
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

async function cmdDoctor() {
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

async function cmdWorkers(topics: string[]) {
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

async function cmdGui() {
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
// TUI — Terminal Dashboard
// ============================================================================

function cmdTUI() {
  startTUI();
}

// ============================================================================
// Skill CLI — manage skills
// ============================================================================

async function cmdSkill(subargs: string[]) {
  const { getSkillSystem, SkillCurator } = await import('./packages/core/src/skills');
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

  // Default: help
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

async function cmdReview(args: string[]) {
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

async function cmdMode(modeArg?: string) {
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

async function cmdHistory(subargs: string[]) {
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

  // Default: list all sessions
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

async function cmdHistoryView(runId: string) {
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

function cmdHelp() {
  console.log(`
  ${$.bold}${$.blue}╭──────────────────────────────────────────────╮${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander${$.reset} — multi-agent orchestration      ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.dim}126 tests · 8 providers · GAIA-ready${$.reset}       ${$.bold}${$.blue}│${$.reset}
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
    ${$.cyan}commander goal <task>${$.reset}      Multi-agent goal loop (decompose → execute → critique → repeat)
    ${$.cyan}commander goal <task> --mode thorough${$.reset}  Keep going until near-zero findings
    ${$.cyan}commander goal <task> --budget 200000${$.reset}  Set token budget
    ${$.cyan}commander goal <task> --max-rounds 5${$.reset}   Limit rounds
    ${$.cyan}commander swarm <task>${$.reset}     Recursive swarm (fission + fusion)
    ${$.cyan}commander swarm <task> --mode thorough${$.reset}  Strict mode
    ${$.cyan}commander swarm <task> --max-depth 4${$.reset}    Max recursion depth
    ${$.cyan}commander swarm <task> --max-workers 15${$.reset} Max parallel workers
    ${$.cyan}commander mode${$.reset}              Show/set approval mode (plan|read-only|auto-edit|full-auto|suggest)
    ${$.cyan}commander review${$.reset}            Review uncommitted changes
    ${$.cyan}commander review --base main${$.reset}  Review branch diff
    ${$.cyan}commander review --commit <sha>${$.reset}  Review specific commit
    ${$.cyan}commander review --json${$.reset}     JSON output for CI integration
    ${$.cyan}commander review --guidelines "rule1|rule2"${$.reset}  Custom rules
    ${$.cyan}commander history${$.reset}               List past execution sessions
    ${$.cyan}commander history view <runId>${$.reset}  View session details
    ${$.cyan}commander history prune <n>${$.reset}     Keep only N most recent sessions
    ${$.cyan}commander history delete <runId>${$.reset} Delete a specific session
    ${$.cyan}commander --debug${$.reset}               Enable debug logging (verbose output)
    ${$.cyan}commander --verbose${$.reset}             Alias for --debug

  ${$.bold}API KEYS (set any one)${$.reset}
    ${$.cyan}OPENAI_API_KEY${$.reset}          OpenAI / DeepSeek / GLM / MiMo
    ${$.cyan}ANTHROPIC_API_KEY${$.reset}       Anthropic Claude
    ${$.cyan}GOOGLE_API_KEY${$.reset}          Google Gemini
    ${$.cyan}OPENROUTER_API_KEY${$.reset}      OpenRouter (200+ models)
    ${$.cyan}DEEPSEEK_API_KEY${$.reset}        DeepSeek
    ${$.cyan}ZHIPU_API_KEY${$.reset}           GLM (Zhipu AI)
    ${$.cyan}MIMO_API_KEY${$.reset}            MiMo
    ${$.cyan}XIAOMI_API_KEY${$.reset}          Xiaomi MiMo
`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Handle --debug / --verbose flags before command parsing
  const debugFlags = new Set(['--debug', '--verbose']);
  const cleanArgs = args.filter(a => !debugFlags.has(a));
  const debugMode = args.some(a => debugFlags.has(a));

  if (debugMode) {
    setGlobalLogLevel('debug');
    console.log(`  ${$.dim}[debug] Logger level set to debug${$.reset}`);
  }

  if (cleanArgs.length === 0 || cleanArgs[0] === 'help' || cleanArgs[0] === '--help' || cleanArgs[0] === '-h') {
    cmdHelp();
    return;
  }

  if (cleanArgs[0] === '--version' || cleanArgs[0] === '-v') {
    console.log(`Commander v0.2.0`);
    return;
  }

  // First-run detection: no API key → show onboarding
  if (!detectProvider() && cleanArgs[0] !== 'config' && cleanArgs[0] !== 'doctor' && cleanArgs[0] !== 'status') {
    onboardingMessage();
    return;
  }

  const cmd = cleanArgs[0];

  switch (cmd) {
    case 'run': {
      const task = cleanArgs.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander run "<task>"`); process.exit(1); }
      await cmdRun(task);
      break;
    }
    case 'plan': {
      const task = cleanArgs.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander plan "<task>"`); process.exit(1); }
      await cmdPlan(task);
      break;
    }
    case 'watch': {
      const task = cleanArgs.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander watch "<task>"`); process.exit(1); }
      await cmdWatch(task);
      break;
    }
    case 'company': {
      const task = cleanArgs.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander company "<task>"`); process.exit(1); }
      await cmdCompany(task);
      break;
    }
    case 'goal': {
      const knownFlags = new Set(['--mode', '--budget', '--max-rounds']);
      const goalArgs = cleanArgs.slice(1);
      const flagMap: Record<string, string> = {};
      const taskParts: string[] = [];
      for (let i = 0; i < goalArgs.length; i++) {
        if (knownFlags.has(goalArgs[i]) && i + 1 < goalArgs.length) {
          flagMap[goalArgs[i]] = goalArgs[i + 1];
          i++;
        } else {
          taskParts.push(goalArgs[i]);
        }
      }
      const goalTask = taskParts.join(' ');
      if (!goalTask) { console.error(`  ${$.red}Usage:${$.reset} commander goal "<task>" [--mode quick|balanced|thorough] [--budget N] [--max-rounds N]`); process.exit(1); }
      await cmdGoal(goalTask, flagMap);
      break;
    }
    case 'swarm': {
      const knownFlags = new Set(['--mode', '--budget', '--max-rounds', '--max-depth', '--max-workers']);
      const swarmArgs = cleanArgs.slice(1);
      const flagMap: Record<string, string> = {};
      const taskParts: string[] = [];
      for (let i = 0; i < swarmArgs.length; i++) {
        if (knownFlags.has(swarmArgs[i]) && i + 1 < swarmArgs.length) {
          flagMap[swarmArgs[i]] = swarmArgs[i + 1];
          i++;
        } else {
          taskParts.push(swarmArgs[i]);
        }
      }
      const swarmTask = taskParts.join(' ');
      if (!swarmTask) { console.error(`  ${$.red}Usage:${$.reset} commander swarm "<task>" [--mode quick|balanced|thorough] [--budget N] [--max-rounds N] [--max-depth N] [--max-workers N]`); process.exit(1); }
      await cmdSwarm(swarmTask, flagMap);
      break;
    }
    case 'status':
      await cmdStatus();
      break;
    case 'config':
      await cmdConfig(cleanArgs.slice(1));
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'gui':
      await cmdGui();
      break;
    case 'tui':
      cmdTUI();
      break;
    case 'review':
      await cmdReview(cleanArgs.slice(1));
      break;
    case 'mode':
      await cmdMode(cleanArgs[1]);
      break;
    case 'history':
      await cmdHistory(cleanArgs.slice(1));
      break;
    case 'workers': {
      const topics = cleanArgs.slice(1);
      await cmdWorkers(topics);
      break;
    }
    default:
      await cmdPlan(cleanArgs.join(' '));
  }
}

main().catch(err => {
  console.error(`\n  ${$.red}${$.bold}FATAL${$.reset} ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  process.exit(1);
});
