#!/usr/bin/env node
/// <reference types="node" />
/**
 * Commander CLI — Multi-Agent Orchestration System
 *
 * Usage:
 *   commander "task"                    Quick plan (default)
 *   commander run "task"                Execute with full pipeline
 *   commander plan "task"               Show deliberation plan
 *   commander watch "task"              Execute with real-time streaming
 *   commander company "task"            Company mode execution
 *   commander status                    Show system status
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
import { getModelRouter } from './packages/core/src/runtime/modelRouter';
import { createAllTools } from './packages/core/src/tools/index';
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

function cmdConfig(args: string[]) {
  if (args.length === 0 || args[0] === 'show') {
    section('CONFIGURATION');
    showConfig();
    console.log(`\n  ${$.dim}Set:  commander config set model <model-id>${$.reset}`);
    console.log(`  ${$.dim}      commander config set meta-tools on${$.reset}`);
    console.log(`  ${$.dim}      commander config list-providers${$.reset}`);
    console.log(`  ${$.dim}      commander config list-models${$.reset}`);
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
    console.log(`  Testing...`);
    fetch(`${provider.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(5000),
    }).then(res => {
      if (res.ok) console.log(`  ${$.green}✓ Connection OK${$.reset}`);
      else console.log(`  ${$.red}✗ ${res.status}${$.reset}`);
    }).catch(() => {
      console.log(`  ${$.yellow}! Connection failed${$.reset}`);
    });
    return;
  }

  console.log(`  ${$.red}Usage:${$.reset} commander config [show|set <key> <val>|list-providers|list-models|test]`);
}

function cmdDoctor() {
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
    fetch(`${provider.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(5000),
    }).then(res => {
      console.log(`  ${res.ok ? $.green + '✓' : $.red + '✗'}${$.reset} API: ${res.status}`);
    }).catch(() => {
      console.log(`  ${$.yellow}!${$.reset} API unreachable`);
    });
  }
  if (allOk) console.log(`\n  ${$.green}${$.bold}All checks passed${$.reset}`);
  else console.log(`\n  ${$.yellow}Some checks need attention${$.reset}`);
}

async function cmdWorkers(topics: string[]) {
  const { TaskPool } = require('./packages/core/src/orchestration/taskPool');

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

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    cmdHelp();
    return;
  }

  // First-run detection: no API key → show onboarding
  if (!detectProvider() && args[0] !== 'config' && args[0] !== 'doctor' && args[0] !== 'status') {
    onboardingMessage();
    return;
  }

  const cmd = args[0];

  switch (cmd) {
    case 'run': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander run "<task>"`); process.exit(1); }
      await cmdRun(task);
      break;
    }
    case 'plan': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander plan "<task>"`); process.exit(1); }
      await cmdPlan(task);
      break;
    }
    case 'watch': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander watch "<task>"`); process.exit(1); }
      await cmdWatch(task);
      break;
    }
    case 'company': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`  ${$.red}Usage:${$.reset} commander company "<task>"`); process.exit(1); }
      await cmdCompany(task);
      break;
    }
    case 'status':
      await cmdStatus();
      break;
    case 'config':
      cmdConfig(args.slice(1));
      break;
    case 'doctor':
      cmdDoctor();
      break;
    case 'workers': {
      const topics = args.slice(1);
      await cmdWorkers(topics);
      break;
    }
    default:
      await cmdPlan(args.join(' '));
  }
}

main().catch(err => {
  console.error(`\n  ${$.red}${$.bold}FATAL${$.reset} ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  process.exit(1);
});
