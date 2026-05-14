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
import { deliberate, deliberateWithLLM } from './packages/core/src/ultimate/deliberation';
import { classifyEffortLevel } from './packages/core/src/ultimate/effortScaler';
import { AgentRuntime } from './packages/core/src/runtime/agentRuntime';
import { OpenAIProvider } from './packages/core/src/runtime/providers/openaiProvider';
import { AnthropicProvider } from './packages/core/src/runtime/providers/anthropicProvider';
import { getModelRouter } from './packages/core/src/runtime/modelRouter';
import { createAllTools } from './packages/core/src/tools/index';
import type { ModelConfig } from './packages/core/src/runtime/types';
import { UltimateOrchestrator } from './packages/core/src/ultimate/orchestrator';
import { TELOSOrchestrator } from './packages/core/src/telos/telosOrchestrator';
import { CompanyEngine } from './packages/core/src/company';
import { SSEStream } from './packages/core/src/runtime/sseStream';

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
  console.log(`\n  ${$.bold}${$.blue}━━━ ${title} ${$.reset}${$.dim}${'━'.repeat(Math.max(0, 60 - title.length - 6))}${$.reset}`);
}

function kv(key: string, value: string, valColor = '') {
  console.log(`  ${$.dim}${key}${$.reset} ${valColor}${value}${$.reset}`);
}

// ============================================================================
// Config
// ============================================================================

function loadConfig() {
  return {
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    openaiKey: process.env.OPENAI_API_KEY || '',
    tools: (process.env.COMMANDER_TOOLS || 'web_search,web_fetch,file_read,file_write,file_edit,file_search,file_list,python_execute,shell_execute,git').split(',').map(s => s.trim()),
    effort: (process.env.COMMANDER_EFFORT || '') as any,
  };
}

function createRuntime(config: ReturnType<typeof loadConfig>): AgentRuntime | null {
  const runtime = new AgentRuntime({ budgetHardCapTokens: 256000 });
  const allTools = createAllTools();
  for (const [name, tool] of allTools) {
    runtime.registerTool(name, tool);
  }

  if (config.anthropicKey) {
    runtime.registerProvider('anthropic', new AnthropicProvider({ apiKey: config.anthropicKey }));
  }
  if (config.openaiKey) {
    const modelId = process.env.OPENAI_MODEL || 'gpt-4o';
    runtime.registerProvider('openai', new OpenAIProvider({
      apiKey: config.openaiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
      defaultModel: modelId,
    }));

    // Register custom model on EVERY tier so all complexity levels use our provider.
    // ModelRouter uses Map keyed by id, so use tier-suffixed IDs.
    // The provider's defaultModel (mimo-v2.5-pro) is used for ALL API calls
    // regardless of which tier-specific model ID the router picks.
    const router = getModelRouter();
    for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
      router.registerModel({
        id: `${modelId}@${tier}`,
        provider: 'openai',
        tier,
        costPer1KInput: 0.0008,
        costPer1KOutput: 0.004,
        capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
        contextWindow: 128000,
        priority: -1,
      });
    }
  }

  if (!config.anthropicKey && !config.openaiKey) return null;
  return runtime;
}

// ============================================================================
// Subcommands
// ============================================================================

async function cmdPlan(task: string) {
  const config = loadConfig();
  const runtime = createRuntime(config);

  section('DELIBERATION PLAN');

  const plan = runtime
    ? await deliberateWithLLM(task, runtime.getProvider('openai') ?? runtime.getProvider('anthropic'))
    : deliberate(task);

  const effort = classifyEffortLevel(task);

  kv('Task', task.length > 80 ? task.slice(0, 80) + '...' : task, $.cyan);
  kv('Type', plan.taskType, $.yellow);
  kv('Effort', `${effort} (${plan.estimatedAgentCount} agents, ${plan.estimatedSteps} steps)`, $.magenta);
  kv('Topology', plan.recommendedTopology, $.green);
  kv('Confidence', `${(plan.confidence * 100).toFixed(0)}%`, plan.confidence > 0.7 ? $.green : $.yellow);
  kv('External info', plan.requiresExternalInfo ? 'Yes' : 'No', plan.requiresExternalInfo ? $.yellow : $.dim);
  kv('Tokens est.', `${plan.estimatedTokens.toLocaleString()} (thinking: ${plan.tokenBudget.thinking.toLocaleString()}, exec: ${plan.tokenBudget.execution.toLocaleString()}, synth: ${plan.tokenBudget.synthesis.toLocaleString()})`);

  section('CAPABILITIES');
  for (const cap of plan.capabilitiesNeeded) {
    console.log(`  ${$.dim}•${$.reset} ${cap}`);
  }

  section('REASONING');
  for (const r of plan.reasoning.slice(0, 8)) {
    console.log(`  ${$.dim}>${$.reset} ${r}`);
  }
}

async function cmdRun(task: string) {
  const config = loadConfig();
  const runtime = createRuntime(config);
  if (!runtime) {
    console.error(`  ${$.red}${$.bold}ERROR${$.reset} No API key configured.
  Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.`);
    process.exit(1);
    return;
  }
  const rt: AgentRuntime = runtime;

  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  section('EXECUTING');
  console.log();

  const startTime = Date.now();
  let lastPhase = '';

  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    goal: task,
    contextData: {
      availableTools: config.tools,
      governanceProfile: { riskLevel: config.effort === 'DEEP_RESEARCH' ? 'HIGH' : 'LOW' },
    },
    effortLevel: config.effort || undefined,
    onProgress: (phase, detail) => {
      if (phase !== lastPhase) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const colors: Record<string, string> = {
          DELIBERATION: $.blue, EFFORT_SCALING: $.magenta, TOPOLOGY_ROUTING: $.cyan,
          DECOMPOSITION: $.yellow, TEAM_FORMATION: $.green, EXECUTION: $.green,
          SYNTHESIS: $.blue, COMPLETE: $.green,
        };
        const color = colors[phase] || $.gray;
        console.log(`  ${$.dim}[${elapsed}s]${$.reset} ${color}${$.bold}${phase}${$.reset} ${$.dim}${detail.slice(0, 80)}${$.reset}`);
        lastPhase = phase;
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('RESULTS');
  const statusColor = result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red;
  kv('Status', result.status, statusColor);
  kv('Duration', `${elapsed}s`);
  kv('Tokens', result.metrics.totalTokens.toLocaleString());
  kv('Cost', `$${result.metrics.totalCostUsd.toFixed(4)}`);
  kv('Sub-agents', String(result.metrics.subAgentsSpawned));
  kv('Quality', `${(result.metrics.qualityScore * 100).toFixed(0)}%`, result.metrics.qualityScore > 0.7 ? $.green : $.yellow);

  if (result.synthesis) {
    section('SYNTHESIS');
    const lines = result.synthesis.split('\n').filter(l => l.trim());
    for (const line of lines.slice(0, 20)) {
      console.log(`  ${line}`);
    }
    if (lines.length > 20) {
      console.log(`  ${$.dim}... (${lines.length - 20} more lines)`);
    }
  }

  if (result.errors.length > 0) {
    section('ERRORS');
    for (const err of result.errors) {
      console.log(`  ${$.red}✗${$.reset} [${err.nodeId}] ${err.message.slice(0, 200)}`);
    }
  }

  section('REASONING');
  for (const r of result.reasoning.slice(0, 10)) {
    console.log(`  ${$.dim}>${$.reset} ${r}`);
  }

  console.log();
}

async function cmdWatch(task: string) {
  const config = loadConfig();
  const runtime = createRuntime(config);
  if (!runtime) {
    console.error(`  ${$.red}ERROR: No API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.${$.reset}`);
    process.exit(1);
    return;
  }
  const rt: AgentRuntime = runtime;

  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  const sse = new SSEStream();
  sse.onEvent((event) => {
    try {
      const data = JSON.parse(event.replace(/^data: /, '').trim());
      const ts = new Date(data.timestamp || Date.now()).toLocaleTimeString();
      const topicColors: Record<string, string> = {
        'agent.started': $.green, 'agent.completed': $.blue,
        'agent.failed': $.red, 'agent.message': $.cyan,
        'system.alert': $.yellow, 'tool.executed': $.gray,
      };
      const color = topicColors[data.topic] || $.gray;
      const payload = typeof data.payload === 'object' ? JSON.stringify(data.payload).slice(0, 120) : String(data.payload ?? '');
      console.log(`  ${$.dim}[${ts}]${$.reset} ${color}${data.topic}${$.reset} ${$.dim}${data.source}${$.reset} ${payload}`);
    } catch {}
  });

  section('WATCH');
  console.log(`  ${$.dim}Streaming real-time agent execution...${$.reset}\n`);

  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    goal: task,
    contextData: {
      availableTools: config.tools,
      governanceProfile: { riskLevel: 'LOW' },
    },
    effortLevel: config.effort || undefined,
  });

  sse.close();

  section('COMPLETE');
  const statusColor = result.status === 'SUCCESS' ? $.green : $.red;
  kv('Status', result.status, statusColor);
  kv('Duration', `${((Date.now() - 0) / 1000).toFixed(1)}s`);
  console.log();
}

async function cmdCompany(task: string) {
  const config = loadConfig();
  const runtime = createRuntime(config);
  if (!runtime) {
    console.error(`  ${$.red}ERROR: No API key configured.${$.reset}`);
    process.exit(1);
  }

  const engine = new CompanyEngine();
  engine.start();

  section('COMPANY MODE');
  kv('Task', task.length > 80 ? task.slice(0, 80) + '...' : task, $.cyan);

  const result = await engine.submit(task, 'analysis', 'commander-cli');
  console.log(`  ${$.dim}Quality score:${$.reset} ${(result.review.score * 100).toFixed(0)}%`);
  console.log(`  ${$.dim}Passed:${$.reset} ${result.review.passed ? $.green + 'Yes' : $.red + 'No'}${$.reset}`);

  if (result.review.issues.length > 0) {
    section('ISSUES');
    for (const issue of result.review.issues) {
      console.log(`  ${$.yellow}!${$.reset} ${issue}`);
    }
  }

  engine.stop();
}

async function cmdStatus() {
  section('SYSTEM STATUS');
  kv('Version', '0.2.0');
  kv('Node', process.version);
  kv('Platform', process.platform);

  const config = loadConfig();
  kv('API Key (Anthropic)', config.anthropicKey ? `${$.green}configured${$.reset}` : `${$.red}missing${$.reset}`);
  kv('API Key (OpenAI)', config.openaiKey ? `${$.green}configured${$.reset}` : `${$.red}missing${$.reset}`);
  kv('Tools', config.tools.join(', '));

  // Test runtime
  const runtime = createRuntime(config);
  kv('Runtime', runtime ? `${$.green}ready${$.reset}` : `${$.red}no provider${$.reset}`);

  section('AVAILABLE SUBCOMMANDS');
  const cmds = [
    ['commander <task>', 'Quick plan (default)'],
    ['commander run <task>', 'Full execution with streaming progress'],
    ['commander plan <task>', 'Show deliberation plan'],
    ['commander watch <task>', 'Execute with real-time SSE stream'],
    ['commander company <task>', 'Company mode execution'],
    ['commander status', 'Show system status'],
    ['commander help', 'Show this help'],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${$.cyan}${cmd.padEnd(30)}${$.reset} ${$.dim}${desc}${$.reset}`);
  }
}

function cmdHelp() {
  console.log(`
  ${$.bold}${$.blue}Commander — Multi-Agent Orchestration System${$.reset}
  ${$.dim}Dynamic Topology · 13 Tools · Quality Gates · Self-Evolution${$.reset}

  ${$.bold}USAGE${$.reset}

    ${$.cyan}commander <task>${$.reset}              Quick plan (default)
    ${$.cyan}commander run <task>${$.reset}           Full execution
    ${$.cyan}commander plan <task>${$.reset}          Show deliberation plan
    ${$.cyan}commander watch <task>${$.reset}         Execute with SSE streaming
    ${$.cyan}commander company <task>${$.reset}       Company mode
    ${$.cyan}commander status${$.reset}               System status
    ${$.cyan}commander help${$.reset}                 This help

  ${$.bold}EXAMPLES${$.reset}

    ${$.dim}$ commander "What is 2+2?"${$.reset}
    ${$.dim}$ commander run "Research microservices vs monoliths"${$.reset}
    ${$.dim}$ commander watch "Deploy the API server"${$.reset}

  ${$.bold}ENVIRONMENT${$.reset}

    ${$.cyan}ANTHROPIC_API_KEY${$.reset}              Anthropic provider key
    ${$.cyan}OPENAI_API_KEY${$.reset}                 OpenAI provider key
    ${$.cyan}COMMANDER_TOOLS${$.reset}                 Comma-separated tool list
    ${$.cyan}COMMANDER_EFFORT${$.reset}                SIMPLE|MODERATE|COMPLEX|DEEP_RESEARCH

  ${$.bold}BENCHMARKS${$.reset}
    GAIA: 70.0% (beats OWL 69.09%)  ·  Simple task: 52 tokens  ·  Quality gates: built-in
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

  const cmd = args[0];

  switch (cmd) {
    case 'run': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`${$.red}Usage: commander run "<task>"${$.reset}`); process.exit(1); }
      await cmdRun(task);
      break;
    }
    case 'plan': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`${$.red}Usage: commander plan "<task>"${$.reset}`); process.exit(1); }
      await cmdPlan(task);
      break;
    }
    case 'watch': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`${$.red}Usage: commander watch "<task>"${$.reset}`); process.exit(1); }
      await cmdWatch(task);
      break;
    }
    case 'company': {
      const task = args.slice(1).join(' ');
      if (!task) { console.error(`${$.red}Usage: commander company "<task>"${$.reset}`); process.exit(1); }
      await cmdCompany(task);
      break;
    }
    case 'status':
      await cmdStatus();
      break;
    default:
      // Default: quick plan
      await cmdPlan(args.join(' '));
  }
}

main().catch(err => {
  console.error(`\n  ${$.red}${$.bold}FATAL${$.reset} ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  process.exit(1);
});
