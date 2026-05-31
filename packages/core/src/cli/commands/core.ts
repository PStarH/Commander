import { TELOSOrchestrator } from '../../telos/telosOrchestrator';
import { UltimateOrchestrator } from '../../ultimate/orchestrator';
import { SSEStream } from '../../runtime/sseStream';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { deliberateWithLLM, deliberate } from '../../ultimate/deliberation';
import { classifyEffortLevel } from '../../ultimate/effortScaler';
import { getGlobalLogger } from '../../logging';
import { CompanyEngine as LegacyCompanyEngine } from '../../company';
import { CompanyEngine, createCompanyEngine } from '../../ultimate/companyEngine';
import { detectProvider } from '../../config/commanderConfig';
import { GoalOrchestrator } from '../../goal/goalOrchestrator';
import type { GoalConfig } from '../../goal/types';
import { createRuntime, loadTools, $, section, kv, bullet, cmdHeader, startSpinner, onboardingMessage, fatalError } from './_shared';

/**
 * Unified run command — replaces plan, watch, and goal.
 *
 * Flags:
 *   --dry-run        Show plan without executing (replaces `plan`)
 *   --stream         Real-time SSE progress (replaces `watch`)
 *   --mode=goal      Multi-agent goal loop (replaces `goal`)
 *   --mode=fast      Fast execution mode
 *   --mode=balanced  Balanced mode (default)
 *   --mode=thorough  Thorough mode
 *   --provider=X     Force provider
 *   --budget=N       Token budget
 *   --max-rounds=N   Max rounds (goal mode only)
 */
export async function cmdRun(task: string, flags: Record<string, string> = {}) {
  const dryRun = 'dry-run' in flags;
  const stream = 'stream' in flags;
  const mode = flags.mode || 'balanced';
  const providerFlag = flags.provider?.toLowerCase();
  const budget = flags.budget ? parseInt(flags.budget, 10) : undefined;
  const maxRounds = flags['max-rounds'] ? parseInt(flags['max-rounds'], 10) : undefined;

  // --dry-run: show plan only (replaces `plan` command)
  if (dryRun) {
    return cmdPlanInternal(task, providerFlag);
  }

  // --mode=goal: multi-agent goal loop (replaces `goal` command)
  if (mode === 'goal') {
    return cmdGoalInternal(task, { mode: mode as GoalConfig['mode'], budgetTokens: budget, maxRounds, provider: providerFlag });
  }

  // --stream: real-time SSE progress (replaces `watch` command)
  if (stream) {
    return cmdWatchInternal(task);
  }

  // Default: full pipeline execution
  return cmdRunInternal(task);
}

// ============================================================================
// Internal implementations
// ============================================================================

async function cmdPlanInternal(task: string, providerFlag?: string) {
  cmdHeader(task);
  const done = startSpinner('Analyzing task...');
  const runtime = createRuntime();
  const provider = providerFlag
    ? runtime?.getProvider(providerFlag)
    : (runtime?.getProvider('openai')
      ?? runtime?.getProvider('anthropic')
      ?? runtime?.getProvider('openrouter')
      ?? runtime?.getProvider('mimo')
      ?? runtime?.getProvider('deepseek')
      ?? runtime?.getProvider('glm')
      ?? runtime?.getProvider('xiaomi')
      ?? runtime?.getProvider('google'));
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
  kv('Duration', `${(plan.estimatedDurationMs / 1000).toFixed(1)}s (per agent: ${(plan.timeBudgetPerAgentMs / 1000).toFixed(1)}s)`);
  kv('Task nature', plan.taskNature, plan.taskNature === 'IO_BOUND' ? $.cyan : plan.taskNature === 'COMPUTE_BOUND' ? $.yellow : $.dim);
  kv('Speculation', plan.suitableForSpeculation ? 'Yes — early steps can run in parallel' : 'No', plan.suitableForSpeculation ? $.green : $.dim);

  if (plan.capabilitiesNeeded.length > 0) {
    section('NEEDS');
    for (const cap of plan.capabilitiesNeeded) {
      bullet(cap);
    }
  }
}

async function cmdRunInternal(task: string) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    fatalError('No API key found.', 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart');
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

async function cmdWatchInternal(task: string) {
  const runtime = createRuntime();
  if (!runtime) {
    fatalError('No API key found.', 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart');
  }
  const rt: AgentRuntime = runtime;

  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  cmdHeader(task);

  // Track metrics for live display
  let totalTokens = 0;
  let agentCount = 0;
  let toolCalls = 0;
  let eventCount = 0;
  const agents = new Map<string, { status: string; tokens: number }>();

  const sse = new SSEStream();
  sse.onEvent((event) => {
    try {
      const data = JSON.parse(event.replace(/^data: /, '').trim());
      eventCount++;
      const ts = new Date(data.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // Topic-specific rendering
      const topic = data.topic || 'unknown';
      const payload = data.payload || {};

      switch (topic) {
        case 'agent.started': {
          agentCount++;
          const agentId = payload.agentId || `agent-${agentCount}`;
          agents.set(agentId, { status: 'running', tokens: 0 });
          console.log(`  ${$.dim}${ts}${$.reset} ${$.green}▶${$.reset} ${$.bold}${agentId}${$.reset} ${$.dim}started${$.reset}`);
          break;
        }
        case 'agent.completed': {
          const agentId = payload.agentId || 'agent';
          const agent = agents.get(agentId);
          if (agent) agent.status = 'done';
          const tokens = payload.tokens || 0;
          if (tokens > 0) totalTokens += tokens;
          console.log(`  ${$.dim}${ts}${$.reset} ${$.green}✓${$.reset} ${$.bold}${agentId}${$.reset} ${$.dim}completed · ${tokens.toLocaleString()} tok${$.reset}`);
          break;
        }
        case 'agent.failed': {
          const agentId = payload.agentId || 'agent';
          const agent = agents.get(agentId);
          if (agent) agent.status = 'failed';
          const err = payload.error || 'unknown error';
          console.log(`  ${$.dim}${ts}${$.reset} ${$.red}✗${$.reset} ${$.bold}${agentId}${$.reset} ${$.red}${err.slice(0, 60)}${$.reset}`);
          break;
        }
        case 'tool.executed': {
          toolCalls++;
          const toolName = payload.tool || 'tool';
          const duration = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : '';
          const status = payload.success === false ? `${$.red}✗${$.reset}` : `${$.cyan}→${$.reset}`;
          console.log(`  ${$.dim}${ts}${$.reset} ${status} ${$.dim}${toolName}${$.reset} ${$.gray}${duration}${$.reset}`);
          break;
        }
        case 'agent.message': {
          const agentId = payload.agentId || 'agent';
          const msg = typeof payload.message === 'string' ? payload.message.slice(0, 80) : '';
          if (msg) {
            console.log(`  ${$.dim}${ts}${$.reset} ${$.cyan}💬${$.reset} ${$.dim}${agentId}:${$.reset} ${msg}`);
          }
          break;
        }
        case 'system.alert': {
          const level = payload.level || 'warn';
          const msg = payload.message || JSON.stringify(payload).slice(0, 80);
          const icon = level === 'error' ? `${$.red}⚠${$.reset}` : `${$.yellow}⚠${$.reset}`;
          console.log(`  ${$.dim}${ts}${$.reset} ${icon} ${msg}`);
          break;
        }
        case 'token.usage': {
          const tokens = payload.totalTokens || payload.tokens || 0;
          if (tokens > 0) totalTokens += tokens;
          break;
        }
        default: {
          // Generic event — only show in verbose mode
          const payloadStr = typeof payload === 'object' ? JSON.stringify(payload).slice(0, 60) : String(payload).slice(0, 60);
          console.log(`  ${$.dim}${ts}${$.reset} ${$.gray}·${$.reset} ${$.dim}${topic}${$.reset} ${$.gray}${payloadStr}${$.reset}`);
          break;
        }
      }
    } catch (err) {
      getGlobalLogger().debug('CLI', 'Failed to parse SSE event', { error: err instanceof Error ? err.message : String(err) });
    }
  });

  console.log();

  const startTime = Date.now();
  let result: Awaited<ReturnType<typeof orch.execute>>;
  try {
    result = await orch.execute({
      projectId: 'cli',
      agentId: 'commander-cli',
      goal: task,
      contextData: {
        availableTools: loadTools(),
        governanceProfile: { riskLevel: 'LOW' },
      },
    });
  } finally {
    sse.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Final summary with live metrics
  section('EXECUTION SUMMARY');
  const statusIcon = result.status === 'SUCCESS' ? `${$.green}✓${$.reset}` : result.status === 'PARTIAL' ? `${$.yellow}⚠${$.reset}` : `${$.red}✗${$.reset}`;
  console.log(`  ${statusIcon} ${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s${$.reset}`);
  console.log();
  kv('Agents', `${agentCount}`, $.cyan);
  kv('Tool calls', `${toolCalls}`, $.cyan);
  kv('Events', `${eventCount}`, $.dim);
  kv('Tokens', `${(totalTokens || result.metrics.totalTokens).toLocaleString()}`, $.yellow);
  kv('Cost', `$${(result.metrics.totalCostUsd || 0).toFixed(4)}`, $.dim);

  if (result.status !== 'SUCCESS' && result.errors.length > 0) {
    console.log();
    for (const err of result.errors) {
      console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
    }
  }

  if (result.synthesis) {
    const preview = result.synthesis.split('\n').filter(l => l.trim()).slice(0, 6).join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.synthesis.split('\n').filter(l => l.trim()).length;
    if (totalLines > 6) console.log(`  ${$.dim}... (${totalLines - 6} more lines)${$.reset}`);
  }
  console.log();
}

async function cmdGoalInternal(task: string, config: Partial<GoalConfig> & { provider?: string }) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    fatalError('No API key found.', 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart');
  }

  cmdHeader(task);

  // Support --provider flag to force a specific provider
  const forcedProvider = config.provider;
  let llmProvider: import('../../runtime/types').LLMProvider | undefined;

  if (forcedProvider) {
    llmProvider = runtime.getProvider(forcedProvider);
    if (!llmProvider) {
      console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} Provider "${forcedProvider}" not available. Check your API key.\n`);
      process.exit(1);
    }
  } else {
    llmProvider = runtime.getProvider('openai')
      ?? runtime.getProvider('anthropic')
      ?? runtime.getProvider('openrouter')
      ?? runtime.getProvider('mimo')
      ?? runtime.getProvider('deepseek')
      ?? runtime.getProvider('glm')
      ?? runtime.getProvider('xiaomi')
      ?? runtime.getProvider('google');
  }

  if (!llmProvider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No LLM provider available.\n`);
    process.exit(1);
  }

  const goalConfig: Partial<GoalConfig> = {};
  if (config.mode) goalConfig.mode = config.mode;
  if (config.budgetTokens) goalConfig.budgetTokens = config.budgetTokens;
  if (config.maxRounds) goalConfig.maxRounds = config.maxRounds;

  const orch = new GoalOrchestrator(llmProvider, goalConfig);

  console.log(`  ${$.dim}Provider:${$.reset} ${$.cyan}${forcedProvider ?? 'auto'}${$.reset}  ${$.dim}Mode:${$.reset} ${$.cyan}${goalConfig.mode ?? 'balanced'}${$.reset}  ${$.dim}Budget:${$.reset} ${$.cyan}${(goalConfig.budgetTokens ?? 100000).toLocaleString()} tok${$.reset}  ${$.dim}Max rounds:${$.reset} ${$.cyan}${goalConfig.maxRounds ?? 10}${$.reset}\n`);

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

  if (result.summary) {
    const preview = result.summary.split('\n').filter((l: string) => l.trim()).slice(0, 8).join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.summary.split('\n').filter((l: string) => l.trim()).length;
    if (totalLines > 8) console.log(`  ${$.dim}... (${totalLines - 8} more lines)${$.reset}`);
  }
  console.log();
}

export async function cmdCompany(task: string, options?: { mode?: string; budget?: number; userId?: string }) {
  const runtime = createRuntime();
  if (!runtime) {
    fatalError('No API key found.', 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart');
  }

  cmdHeader(task);
  section('COMPANY MODE');

  const telos = new TELOSOrchestrator(runtime);
  const orchestrator = new UltimateOrchestrator(telos, runtime);

  const engine = createCompanyEngine(orchestrator, {
    projectId: 'commander-cli',
    userId: options?.userId,
    enableCapabilityMatching: true,
    enableQualityGating: true,
    enableMemory: true,
    tokenBudget: options?.budget ?? 100000,
  });

  kv('Mode', options?.mode ?? 'auto', $.cyan);
  kv('Budget', `${(options?.budget ?? 100000).toLocaleString()} tokens`, $.yellow);
  kv('Capability Matching', 'ON', $.green);
  kv('Quality Gating', 'ON', $.green);
  kv('Memory', 'ON', $.green);
  console.log();

  const done = startSpinner('Executing with Company Engine...');

  try {
    const result = await engine.execute({
      goal: task,
      agentId: 'commander-cli',
      onProgress: (_phase: string, _detail: string) => {},
    });

    done();

    section('EXECUTION');
    kv('Status', result.status, result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red);
    kv('Mode', result.executionMode, $.cyan);
    kv('Agents', result.agentsUsed.map((a: { agentId: string }) => a.agentId).join(', '), $.dim);
    kv('Tokens', `${(result.metrics?.totalTokens ?? 0).toLocaleString()}`, $.yellow);
    kv('Duration', `${((result.metrics?.totalDurationMs ?? 0) / 1000).toFixed(1)}s`, $.yellow);
    kv('Quality', `${(result.qualityDecision.rollingQuality * 100).toFixed(0)}%`, result.qualityDecision.rollingQuality > 0.7 ? $.green : $.yellow);
    kv('Strategy', result.matchResult.strategy, $.dim);
    kv('Savings', `~${result.estimatedSavings}%`, $.green);
    console.log();

    section('QUALITY');
    kv('Action', result.qualityDecision.action, result.qualityDecision.action === 'escalate' ? $.yellow : result.qualityDecision.action === 'de-escalate' ? $.green : $.dim);
    kv('Reason', result.qualityDecision.reason, $.dim);
    kv('Confidence', `${(result.qualityDecision.confidence * 100).toFixed(0)}%`, $.dim);
    console.log();

    if (result.summary) {
      section('SUMMARY');
      console.log(`  ${result.summary}`);
      console.log();
    }

    const stats = engine.getStats();
    section('ENGINE STATS');
    kv('Total Executions', `${stats.totalExecutions}`, $.dim);
    kv('Avg Quality', `${(stats.averageQuality * 100).toFixed(0)}%`, $.dim);
    kv('Avg Tokens', `${stats.averageTokens.toLocaleString()}`, $.dim);
    kv('Pool Size', `${stats.poolSize}`, $.dim);

    return result;
  } catch (err) {
    done();
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} ${(err as Error).message}\n`);
    throw err;
  }
}

// Keep legacy exports for backward compatibility (deprecated)
export const cmdPlan = (task: string) => cmdRun(task, { '--dry-run': '' });
export const cmdWatch = (task: string) => cmdRun(task, { '--stream': '' });
