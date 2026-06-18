import { TELOSOrchestrator } from '../../telos/telosOrchestrator';
import { UltimateOrchestrator } from '../../ultimate/orchestrator';
import { SSEStream } from '../../runtime/sseStream';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { deliberate } from '../../ultimate/deliberation';
import { classifyEffortLevel } from '../../ultimate/effortScaler';
import { getGlobalLogger } from '../../logging';
import { CompanyEngine as LegacyCompanyEngine } from '../../company';
import { CompanyEngine, createCompanyEngine } from '../../ultimate/companyEngine';
import { detectProvider } from '../../config/commanderConfig';
import { GoalOrchestrator } from '../../goal/goalOrchestrator';
import type { GoalConfig } from '../../goal/types';
import {
  createRuntime,
  loadTools,
  $,
  section,
  kv,
  bullet,
  cmdHeader,
  startSpinner,
  onboardingMessage,
  fatalError,
} from './_shared';
import { runShowcase } from '../../showcase/showcaseRunner';
import { startTUI } from '../../tui';
import { getMetaLearner } from '../../selfEvolution/metaLearner';

// Routing-flag plumbing (audit P0-2 / P1-1 surface). Declared at top-of-file so it
// hoists before the first reference (cmdRun / cmdRunInternal / cmdWatchInternal).
interface RoutingFlags {
  model?: string;
  tier?: 'speed' | 'balanced' | 'power';
  topology?: 'SINGLE' | 'SEQUENTIAL' | 'PARALLEL' | 'HIERARCHICAL' | 'HYBRID' | 'DEBATE' | 'ENSEMBLE' | 'EVALUATOR_OPTIMIZER';
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
  cascade?: boolean;
  qualityThreshold?: number;
}

function parseRoutingFlags(flags: Record<string, string>): RoutingFlags {
  const allowedTiers = ['speed', 'balanced', 'power'] as const;
  const allowedEfforts = ['minimal', 'low', 'medium', 'high', 'max'] as const;
  const allowedTopologies = ['SINGLE','SEQUENTIAL','PARALLEL','HIERARCHICAL','HYBRID','DEBATE','ENSEMBLE','EVALUATOR_OPTIMIZER'] as const;
  let tier: RoutingFlags['tier'];
  const tierRaw = flags.tier?.toLowerCase();
  if (tierRaw !== undefined) {
    if (!(allowedTiers as readonly string[]).includes(tierRaw)) {
      const closest = didYouMean(tierRaw, allowedTiers);
      fatalError(
        `Invalid --tier="${tierRaw}".`,
        `Allowed: ${allowedTiers.join(', ')}.${
          closest ? ` Did you mean --tier=${closest}?` : ''
        } Run commander run --help`,
      );
    }
    tier = tierRaw as RoutingFlags['tier'];
  }
  let effort: RoutingFlags['effort'];
  const effortRaw = flags.effort?.toLowerCase();
  if (effortRaw !== undefined) {
    if (!(allowedEfforts as readonly string[]).includes(effortRaw)) {
      const closest = didYouMean(effortRaw, allowedEfforts);
      fatalError(
        `Invalid --effort="${effortRaw}".`,
        `Allowed: ${allowedEfforts.join(', ')}.${
          closest ? ` Did you mean --effort=${closest}?` : ''
        } Run commander run --help`,
      );
    }
    effort = effortRaw as RoutingFlags['effort'];
  }
  let topology: RoutingFlags['topology'];
  const topologyRaw = flags.topology?.toUpperCase();
  if (topologyRaw !== undefined) {
    if (!(allowedTopologies as readonly string[]).includes(topologyRaw)) {
      const closest = didYouMean(topologyRaw, allowedTopologies);
      fatalError(
        `Invalid --topology="${topologyRaw}".`,
        `Allowed: ${allowedTopologies.join(', ')}.${
          closest ? ` Did you mean --topology=${closest}?` : ''
        } Run commander run --help`,
      );
    }
    topology = topologyRaw as RoutingFlags['topology'];
  }
  let qualityThreshold: number | undefined;
  if (flags['quality-threshold'] !== undefined) {
    const parsed = Number(flags['quality-threshold']);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      fatalError(
        `Invalid --quality-threshold="${flags['quality-threshold']}".`,
        'Must be a number between 0 and 1 (e.g. 0.8). Run commander run --help',
      );
    }
    qualityThreshold = parsed;
  }
  return {
    model: flags.model,
    tier,
    topology,
    effort,
    // Cascade is `undefined` when --cascade is absent so that the
    // agentRuntime's late-stage override does NOT clobber the constructor
    // default (smartRouterActive = true). Only an explicit --cascade flips
    // it to true. (Audit P0-2 follow-up — fixes the regression where
    // boolean-default disabled the smart router for every CLI invocation.)
    cascade: 'cascade' in flags ? true : undefined,
    qualityThreshold,
  };
}

// Single source of truth for --tier → model-tier mapping. Both cmdRunInternal
// and cmdWatchInternal's contextData lift prefix preferredModelTier with
// TIER_MAP[flags.tier] so the smart router and effort→tier cascade agree.
// Exported would be better, but core.ts is CLI-only so inline is fine.
// (Audit P0-2 follow-up.)
const TIER_MAP: Record<
  NonNullable<RoutingFlags['tier']>,
  'eco' | 'standard' | 'power' | 'consensus'
> = {
  speed: 'eco',
  balanced: 'standard',
  power: 'power',
};

// ── Tiny edit-distance helpers (UX audit P0-1 follow-up) ───────────────────
// Used by parseRoutingFlags to render "Did you mean --tier=balanced?"-style
// suggestions instead of ejecting the user with a dead-end. Standard
// Wagner-Fischer dynamic programming, in-place swap, no deps. Returned
// suggestion is the closest allowed value whose edit-distance is ≤ 2 and
// less than half the input length — both gates prevent nonsense matches
// like "Did you mean --tier=power?" for "?".
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function didYouMean(
  input: string,
  allowed: readonly string[],
): string | undefined {
  const lower = input.toLowerCase();
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of allowed) {
    const d = levenshtein(lower, candidate.toLowerCase());
    if (!best || d < best.distance) best = { candidate, distance: d };
  }
  // Single-gate threshold: cap at min(2, ceil(length*0.4)). The previous
  // two-gate (`distance ≤ 2 AND distance < length/2`) silently dropped the
  // genuine typo case "spd" → "speed" (distance 2, length 3, 2<1.5=false).
  // Reviewer catch (UX audit P0-1 follow-up).
  if (
    best &&
    best.distance <= Math.min(2, Math.ceil(lower.length * 0.4))
  ) {
    return best.candidate;
  }
  return undefined;
}

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
  // Reject empty or whitespace-only tasks
  if (!task || !task.trim()) {
    console.error(
      `\n  ${$.red}${$.bold}ERROR${$.reset} No task provided.\n\n  Usage: ${$.cyan}commander run "<task>"${$.reset}\n  Example: ${$.cyan}commander run "analyze this codebase"${$.reset}\n`,
    );
    process.exit(1);
  }
  task = task.trim();

  // ── Special: showcase ─────────────────────────────────────────────
  if (task.toLowerCase() === 'showcase') {
    return cmdShowcase();
  }

  // ── --tui: terminal dashboard (runs alongside execution) ──────────
  if ('tui' in flags) {
    // Start TUI in background — it subscribes to the message bus
    // so any concurrent execution will appear in the dashboard
    startTUI();
    // startTUI() blocks indefinitely with the blessed event loop,
    // so this effectively makes --tui a monitoring-only mode.
    // For task execution with TUI, open a second terminal.
    return;
  }

  const dryRun = 'dry-run' in flags;
  const stream = 'stream' in flags;
  const mode = flags.mode || 'balanced';
  const providerFlag = flags.provider?.toLowerCase();
  const budget = flags.budget ? parseInt(flags.budget, 10) : undefined;
  const maxRounds = flags['max-rounds'] ? parseInt(flags['max-rounds'], 10) : undefined;

  // --dry-run: show plan only (replaces `plan` command)
  if (dryRun) {
    return cmdPlanInternal(task);
  }

  // --mode=goal: multi-agent goal loop (replaces `goal` command)
  if (mode === 'goal') {
    return cmdGoalInternal(task, {
      mode: mode as GoalConfig['mode'],
      budgetTokens: budget,
      maxRounds,
      provider: providerFlag,
    });
  }

  // --stream: real-time SSE progress (replaces `watch` command)
  if (stream) {
    return cmdWatchInternal(task, parseRoutingFlags(flags));
  }

  // Default: full pipeline execution
  return cmdRunInternal(task, parseRoutingFlags(flags));
}

// ============================================================================
// Showcase: 3-agent DEBATE topology code audit
// ============================================================================

async function cmdShowcase() {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    fatalError(
      'No API key found.',
      'Set an API key (e.g., OPENAI_API_KEY) and run: commander init',
    );
  }

  // ── Header ────────────────────────────────────────────────────────
  console.log(
    `\n  ${$.bold}${$.blue}╭──────────────────────────────────────────────────────────╮${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander Showcase${$.reset} — 3-Agent DEBATE Code Audit              ${$.bold}${$.blue}│${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}╰──────────────────────────────────────────────────────────╯${$.reset}\n`,
  );

  section('TOPOLOGY');
  console.log(`  ${$.cyan}🔴 红队${$.reset} ${$.dim}(攻击方)${$.reset}  →  找Bug、漏洞、反模式`);
  console.log(`  ${$.cyan}🔵 蓝队${$.reset} ${$.dim}(防守方)${$.reset}  →  架构优点、设计合理性`);
  console.log(`  ${$.cyan}🟡 裁判${$.reset} ${$.dim}(仲裁方)${$.reset}  →  综合评分、输出体检报告`);

  kv('Provider', `${provider.type} · ${provider.defaultModel}`, $.cyan);
  console.log();

  // ── Phase 1: Execution ─────────────────────────────────────────────
  let result;
  try {
    console.log(`  ${$.dim}🔴 红队 (攻击方)  →  找Bug、漏洞、反模式${$.reset}`);
    console.log(`  ${$.dim}🔵 蓝队 (防守方)  →  架构优点、设计合理性${$.reset}`);
    console.log(`  ${$.dim}🟡 裁判 (仲裁方)  →  综合评分、体检报告${$.reset}\n`);
    const agentDone = startSpinner('Scanning codebase + running 3-agent debate...');
    result = await runShowcase(runtime);
    agentDone();
  } catch (err) {
    console.error(
      `\n  ${$.red}${$.bold}ERROR${$.reset} Showcase failed: ${(err as Error).message}`,
    );
    console.error(`  ${$.dim}Check your API key and network connection.${$.reset}`);
    console.error(
      `  ${$.dim}Run ${$.cyan}commander init${$.reset}${$.dim} to verify provider connectivity.${$.reset}\n`,
    );
    return;
  }

  if (result.metrics.filesScanned === 0) {
    console.log(`\n  ${$.yellow}当前目录未找到可扫描的代码文件。${$.reset}`);
    console.log(`  ${$.dim}请在有代码文件的目录下运行 ${$.cyan}commander run showcase${$.reset}\n`);
    return;
  }

  // ── Results ───────────────────────────────────────────────────────
  section('EXECUTION COMPLETE');
  kv('Files scanned', `${result.metrics.filesScanned}`, $.cyan);
  kv(
    'Red team',
    result.redTeamRaw.length > 0
      ? `${$.green}completed${$.reset} (${result.metrics.redTeamTokens.toLocaleString()} tok)`
      : `${$.red}failed${$.reset}`,
    result.redTeamRaw.length > 0 ? $.green : $.red,
  );
  kv(
    'Blue team',
    result.blueTeamRaw.length > 0
      ? `${$.green}completed${$.reset} (${result.metrics.blueTeamTokens.toLocaleString()} tok)`
      : `${$.red}failed${$.reset}`,
    result.blueTeamRaw.length > 0 ? $.green : $.red,
  );
  kv(
    'Judge',
    result.judgeRaw.length > 0
      ? `${$.green}completed${$.reset} (${result.metrics.judgeTokens.toLocaleString()} tok)`
      : `${$.red}failed${$.reset}`,
    result.judgeRaw.length > 0 ? $.green : $.red,
  );
  kv('Total tokens', `${result.metrics.totalTokens.toLocaleString()}`, $.yellow);
  kv('Duration', `${(result.metrics.durationMs / 1000).toFixed(1)}s`, $.yellow);

  // ── Scores ────────────────────────────────────────────────────────
  section('CODE HEALTH SCORES');
  const scoreColor = (s: number) => (s >= 90 ? $.green : s >= 70 ? $.yellow : $.red);
  const grade = (s: number) =>
    s >= 90 ? 'S' : s >= 80 ? 'A' : s >= 70 ? 'B' : s >= 60 ? 'C' : 'D';

  console.log(
    `  🔒 ${$.bold}Security${$.reset}      ${scoreColor(result.metrics.securityScore)}${result.metrics.securityScore}/100${$.reset} ${$.dim}(${grade(result.metrics.securityScore)})${$.reset}`,
  );
  console.log(
    `  📝 ${$.bold}Code Quality${$.reset}   ${scoreColor(result.metrics.qualityScore)}${result.metrics.qualityScore}/100${$.reset} ${$.dim}(${grade(result.metrics.qualityScore)})${$.reset}`,
  );
  console.log(
    `  🏗️ ${$.bold}Architecture${$.reset}  ${scoreColor(result.metrics.architectureScore)}${result.metrics.architectureScore}/100${$.reset} ${$.dim}(${grade(result.metrics.architectureScore)})${$.reset}`,
  );
  console.log(`  ${$.dim}${'─'.repeat(30)}${$.reset}`);
  console.log(
    `  ${$.bold}⭐ Overall${$.reset}       ${scoreColor(result.metrics.overallScore)}${result.metrics.overallScore}/100${$.reset} ${$.dim}(${grade(result.metrics.overallScore)})${$.reset}\n`,
  );

  // ── Findings summary ─────────────────────────────────────────────
  const { critical, high, medium, low } = result.findings;
  if (critical.length > 0) {
    section(`🔴 CRITICAL (${critical.length})`);
    for (const f of critical.slice(0, 3)) {
      console.log(`  ${$.red}•${$.reset} ${f.slice(0, 120)}`);
    }
    if (critical.length > 3)
      console.log(`  ${$.dim}  ... and ${critical.length - 3} more${$.reset}`);
  }
  if (high.length > 0) {
    section(`🟠 HIGH (${high.length})`);
    for (const f of high.slice(0, 3)) {
      console.log(`  ${$.yellow}•${$.reset} ${f.slice(0, 120)}`);
    }
    if (high.length > 3) console.log(`  ${$.dim}  ... and ${high.length - 3} more${$.reset}`);
  }

  // ── Full report ───────────────────────────────────────────────────
  section('FULL REPORT');
  console.log(result.report);
  console.log();
}

// ============================================================================
// Internal implementations
// ============================================================================

async function cmdPlanInternal(task: string) {
  cmdHeader(task);
  const done = startSpinner('Analyzing task...');
  const plan = deliberate(task);
  const effort = classifyEffortLevel(task);
  done();

  section('PLAN');
  bullet(`${plan.taskType} · ${effort} effort · ${plan.recommendedTopology} topology`, $.cyan);
  console.log();
  kv('Agents', `${plan.estimatedAgentCount}`, $.yellow);
  kv('Steps', `${plan.estimatedSteps}`, $.yellow);
  kv(
    'Confidence',
    `${(plan.confidence * 100).toFixed(0)}%`,
    plan.confidence > 0.7 ? $.green : $.yellow,
  );
  kv(
    'External info',
    plan.requiresExternalInfo ? 'Yes' : 'No',
    plan.requiresExternalInfo ? $.yellow : $.dim,
  );
  kv(
    'Tokens',
    `${plan.estimatedTokens.toLocaleString()} (think: ${plan.tokenBudget.thinking.toLocaleString()}, exec: ${plan.tokenBudget.execution.toLocaleString()})`,
  );
  kv(
    'Duration',
    `${(plan.estimatedDurationMs / 1000).toFixed(1)}s (per agent: ${(plan.timeBudgetPerAgentMs / 1000).toFixed(1)}s)`,
  );
  kv(
    'Task nature',
    plan.taskNature,
    plan.taskNature === 'IO_BOUND'
      ? $.cyan
      : plan.taskNature === 'COMPUTE_BOUND'
        ? $.yellow
        : $.dim,
  );
  kv(
    'Speculation',
    plan.suitableForSpeculation ? 'Yes — early steps can run in parallel' : 'No',
    plan.suitableForSpeculation ? $.green : $.dim,
  );

  if (plan.capabilitiesNeeded.length > 0) {
    section('NEEDS');
    for (const cap of plan.capabilitiesNeeded) {
      bullet(cap);
    }
  }
}

async function cmdRunInternal(task: string, routingFlags: RoutingFlags = {}) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
  }

  cmdHeader(task);
  const rt: AgentRuntime = runtime;
  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  // ── Live CLI override wiring (no runtime restart required) ───────────────
  // --cascade toggles SmartModelRouter participation live.
  // --quality-threshold mutates the orchestrator's quality-gate config in
  //   place so the very next execute() call sees the updated thresholds.
  // Both setters mutate the existing instance instead of re-constructing.
  // --quality-threshold is the only knob that requires orchestrator-side
  // mutation (orchestrator owns the gate config and re-reads it during
  // execute()). The remaining CLI flags (--cascade, --model, --tier)
  // flow through contextData and are lifted by agentRuntime.ts's
  // late-stage override block onto ctx.preferredModel /
  // ctx.preferredModelTier / smartRouterActive BEFORE the routing
  // decision runs. (Audit P0-2 follow-up.)
  if (routingFlags.qualityThreshold !== undefined) {
    orch.setQualityGateThreshold('all', routingFlags.qualityThreshold);
  }

  let lastPhase = '';
  const startTime = Date.now();

  // Inject preferredModel / preferredModelTier / cascadeEnabled into
  // contextData so agentRuntime.ts's late-stage override block lifts them
  // onto ctx.preferredModel / ctx.preferredModelTier / smartRouterActive
  // before the routing decision runs.
  const routingContextData: Record<string, unknown> = {
    availableTools: loadTools(),
    governanceProfile: { riskLevel: 'LOW' },
  };
  if (routingFlags.model !== undefined) routingContextData.preferredModel = routingFlags.model;
  if (routingFlags.tier !== undefined) {
    const tierMap: Record<string, 'eco' | 'standard' | 'power' | 'consensus'> = {
      speed: 'eco',
      balanced: 'standard',
      power: 'power',
    };
    routingContextData.preferredModelTier = tierMap[routingFlags.tier];
  }
  if (routingFlags.cascade === true) routingContextData.cascadeEnabled = true;

  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    goal: task,
    contextData: routingContextData,
    onProgress: (phase, detail) => {
      if (phase === 'COMPLETE') return;
      if (phase !== lastPhase) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const icons: Record<string, string> = {
          INIT: '📋',
          DELIBERATION: '🧠',
          EFFORT_SCALING: '📊',
          TOPOLOGY_ROUTING: '🔀',
          DECOMPOSITION: '📦',
          TEAM_FORMATION: '👥',
          EXECUTION: '⚡',
          SYNTHESIS: '🔗',
        };
        console.log(
          `  ${$.dim}[${elapsed}s]${$.reset} ${icons[phase] || ' '} ${$.bold}${phase}${$.reset} ${$.dim}${detail.slice(0, 70)}${$.reset}`,
        );
        lastPhase = phase;
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();

  section('RESULTS');
  const icon = result.status === 'SUCCESS' ? '✅' : result.status === 'PARTIAL' ? '⚠️' : '❌';
  const statusColor =
    result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red;
  console.log(
    `  ${icon} ${statusColor}${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s · ${result.metrics.totalTokens.toLocaleString()} tok · $${result.metrics.totalCostUsd.toFixed(4)}${$.reset}`,
  );

  if (result.status !== 'SUCCESS' && result.errors.length > 0) {
    console.log();
    for (const err of result.errors) {
      console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
    }
  }

  if (result.synthesis) {
    const preview = result.synthesis
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 8)
      .join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.synthesis.split('\n').filter((l) => l.trim()).length;
    if (totalLines > 8) console.log(`  ${$.dim}... (${totalLines - 8} more lines)${$.reset}`);
  }

  // ── Human feedback ──────────────────────────────────────────────
  await promptHumanFeedback(result.status === 'SUCCESS', task);

  console.log();
}

async function cmdWatchInternal(task: string, routingFlags: RoutingFlags = {}) {
  const runtime = createRuntime();
  if (!runtime) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
  }
  const rt: AgentRuntime = runtime;

  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  // Apply --quality-threshold live (orchestrator owns the gate config).
  // --cascade, --model, --tier flow through contextData below and are
  // lifted by agentRuntime.ts's late-stage override. (Audit P0-2 follow-up.)
  if (routingFlags.qualityThreshold !== undefined) {
    orch.setQualityGateThreshold('all', routingFlags.qualityThreshold);
  }

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
      const ts = new Date(data.timestamp || Date.now()).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      // Topic-specific rendering
      const topic = data.topic || 'unknown';
      const payload = data.payload || {};

      switch (topic) {
        case 'agent.started': {
          agentCount++;
          const agentId = payload.agentId || `agent-${agentCount}`;
          agents.set(agentId, { status: 'running', tokens: 0 });
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.green}▶${$.reset} ${$.bold}${agentId}${$.reset} ${$.dim}started${$.reset}`,
          );
          break;
        }
        case 'agent.completed': {
          const agentId = payload.agentId || 'agent';
          const agent = agents.get(agentId);
          if (agent) agent.status = 'done';
          const tokens = payload.tokens || 0;
          if (tokens > 0) totalTokens += tokens;
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.green}✓${$.reset} ${$.bold}${agentId}${$.reset} ${$.dim}completed · ${tokens.toLocaleString()} tok${$.reset}`,
          );
          break;
        }
        case 'agent.failed': {
          const agentId = payload.agentId || 'agent';
          const agent = agents.get(agentId);
          if (agent) agent.status = 'failed';
          const err = payload.error || 'unknown error';
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.red}✗${$.reset} ${$.bold}${agentId}${$.reset} ${$.red}${err.slice(0, 60)}${$.reset}`,
          );
          break;
        }
        case 'tool.executed': {
          toolCalls++;
          const toolName = payload.tool || 'tool';
          const duration = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : '';
          const status = payload.success === false ? `${$.red}✗${$.reset}` : `${$.cyan}→${$.reset}`;
          console.log(
            `  ${$.dim}${ts}${$.reset} ${status} ${$.dim}${toolName}${$.reset} ${$.gray}${duration}${$.reset}`,
          );
          break;
        }
        case 'agent.message': {
          const agentId = payload.agentId || 'agent';
          const msg = typeof payload.message === 'string' ? payload.message.slice(0, 80) : '';
          if (msg) {
            console.log(
              `  ${$.dim}${ts}${$.reset} ${$.cyan}💬${$.reset} ${$.dim}${agentId}:${$.reset} ${msg}`,
            );
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
          const payloadStr =
            typeof payload === 'object'
              ? JSON.stringify(payload).slice(0, 60)
              : String(payload).slice(0, 60);
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.gray}·${$.reset} ${$.dim}${topic}${$.reset} ${$.gray}${payloadStr}${$.reset}`,
          );
          break;
        }
      }
    } catch (err) {
      getGlobalLogger().debug('CLI', 'Failed to parse SSE event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  console.log();

  const startTime = Date.now();
  let result: Awaited<ReturnType<typeof orch.execute>>;
  try {
    // Build routing context the same way cmdRunInternal does so that
    // agentRuntime's late-stage override can lift --cascade / --model /
    // --tier from contextData onto ctx.preferredModel / preferredModelTier
    // / smartRouterActive before the routing decision runs. The module-
    // scope TIER_MAP is the single source of truth. (Audit P0-2 follow-up.)
    const watchContextData: Record<string, unknown> = {
      availableTools: loadTools(),
      governanceProfile: { riskLevel: 'LOW' },
    };
    if (routingFlags.model !== undefined) {
      watchContextData.preferredModel = routingFlags.model;
    }
    if (routingFlags.tier !== undefined) {
      watchContextData.preferredModelTier = TIER_MAP[routingFlags.tier];
    }
    if (routingFlags.cascade === true) {
      watchContextData.cascadeEnabled = true;
    }

    result = await orch.execute({
      projectId: 'cli',
      agentId: 'commander-cli',
      goal: task,
      contextData: watchContextData,
    });
  } finally {
    sse.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Final summary with live metrics
  section('EXECUTION SUMMARY');
  const statusIcon =
    result.status === 'SUCCESS'
      ? `${$.green}✓${$.reset}`
      : result.status === 'PARTIAL'
        ? `${$.yellow}⚠${$.reset}`
        : `${$.red}✗${$.reset}`;
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
    const preview = result.synthesis
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 6)
      .join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.synthesis.split('\n').filter((l) => l.trim()).length;
    if (totalLines > 6) console.log(`  ${$.dim}... (${totalLines - 6} more lines)${$.reset}`);
  }
  console.log();
}

// ============================================================================
// Human-in-the-Loop Feedback
// ============================================================================

async function promptHumanFeedback(success: boolean, task: string): Promise<void> {
  // Only prompt in interactive TTY mode
  if (!process.stdin.isTTY) return;

  console.log(
    `  ${$.dim}Was this helpful?${$.reset} ${$.green}[👍 Good]${$.reset} ${$.red}[👎 Wrong]${$.reset} ${$.dim}[Enter skip]${$.reset}`,
  );

  try {
    const answer = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 15000); // Auto-skip after 15s
      const onData = (data: Buffer) => {
        clearTimeout(timer);
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) process.stdin.pause();
        resolve(data.toString().trim().toLowerCase());
      };
      process.stdin.resume();
      process.stdin.on('data', onData);
    });

    if (!answer) return; // Skip / timeout

    const ratedGood =
      answer.includes('👍') ||
      answer.includes('good') ||
      answer === 'y' ||
      answer === 'yes' ||
      answer === '1';
    const ratedBad =
      answer.includes('👎') ||
      answer.includes('wrong') ||
      answer.includes('bad') ||
      answer === 'n' ||
      answer === 'no' ||
      answer === '2';

    if (ratedGood || ratedBad) {
      try {
        const ml = getMetaLearner();
        // Human feedback carries 2x weight compared to automatic signals
        const exp = {
          runId: `human_feedback_${Date.now()}`,
          agentId: 'human-feedback',
          taskType: 'general',
          strategyUsed: 'UNKNOWN',
          success: ratedGood,
          durationMs: 0,
          tokenCost: 0,
          lessons: ratedGood ? ['Human rated this as helpful'] : ['Human rated this as incorrect'],
          errorPattern: ratedBad ? 'human_negative_feedback' : undefined,
          timestamp: new Date().toISOString(),
          modelUsed: 'human',
          id: `hf_${Date.now()}`,
          toolsUsed: [],
          topology: undefined,
        } as import('../../runtime/types').ExecutionExperience;
        ml.recordExperience(exp);
      } catch {
        /* best-effort */
      }
      const result = ratedGood
        ? `${$.green}👍 Thanks!${$.reset}`
        : `${$.red}👎 Noted. Will improve.${$.reset}`;
      console.log(`  ${result}`);
    }
  } catch {
    // Timeout or read error — silently skip
  }
}

async function cmdGoalInternal(task: string, config: Partial<GoalConfig> & { provider?: string }) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
  }

  cmdHeader(task);

  // Support --provider flag to force a specific provider
  const forcedProvider = config.provider;
  let llmProvider: import('../../runtime/types').LLMProvider | undefined;

  if (forcedProvider) {
    llmProvider = runtime.getProvider(forcedProvider);
    if (!llmProvider) {
      console.error(
        `\n  ${$.red}${$.bold}ERROR${$.reset} Provider "${forcedProvider}" not available. Check your API key.\n`,
      );
      process.exit(1);
    }
  } else {
    llmProvider =
      runtime.getProvider('openai') ??
      runtime.getProvider('anthropic') ??
      runtime.getProvider('openrouter') ??
      runtime.getProvider('mimo') ??
      runtime.getProvider('deepseek') ??
      runtime.getProvider('glm') ??
      runtime.getProvider('xiaomi') ??
      runtime.getProvider('google');
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

  console.log(
    `  ${$.dim}Provider:${$.reset} ${$.cyan}${forcedProvider ?? 'auto'}${$.reset}  ${$.dim}Mode:${$.reset} ${$.cyan}${goalConfig.mode ?? 'balanced'}${$.reset}  ${$.dim}Budget:${$.reset} ${$.cyan}${(goalConfig.budgetTokens ?? 100000).toLocaleString()} tok${$.reset}  ${$.dim}Max rounds:${$.reset} ${$.cyan}${goalConfig.maxRounds ?? 10}${$.reset}\n`,
  );

  const done = startSpinner('Goal loop running...');
  const startTime = Date.now();
  const result = await orch.execute(task);
  done();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('GOAL RESULT');
  const statusIcon =
    result.status === 'completed' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
  const statusColor =
    result.status === 'completed' ? $.green : result.status === 'partial' ? $.yellow : $.red;
  console.log(
    `  ${statusIcon} ${statusColor}${$.bold}${result.status.toUpperCase()}${$.reset}  ${$.dim}${elapsed}s · ${result.totalRounds} rounds · ${result.totalTokensUsed.toLocaleString()} tok${$.reset}\n`,
  );

  console.log(`  ${$.bold}Rounds:${$.reset} ${result.totalRounds}`);
  console.log(`  ${$.bold}Tokens:${$.reset} ${result.totalTokensUsed.toLocaleString()}`);
  console.log(`  ${$.bold}Duration:${$.reset} ${elapsed}s`);
  console.log();

  const lastRound = result.ledger[result.ledger.length - 1];
  if (lastRound) {
    console.log(
      `  ${$.bold}Stop reason:${$.reset} ${$.yellow}${lastRound.decisionReason}${$.reset}`,
    );
    if (lastRound.findingsTotal > 0) {
      console.log(
        `  ${$.bold}Remaining findings:${$.reset} ${$.red}${lastRound.findingsTotal}${$.reset}`,
      );
    }
    console.log(
      `  ${$.bold}Improvement trend:${$.reset} ${lastRound.improvementRate > 0.05 ? $.green + 'improving' : $.dim + 'plateaued'}${$.reset}`,
    );
  }

  if (result.summary) {
    const preview = result.summary
      .split('\n')
      .filter((l: string) => l.trim())
      .slice(0, 8)
      .join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.summary.split('\n').filter((l: string) => l.trim()).length;
    if (totalLines > 8) console.log(`  ${$.dim}... (${totalLines - 8} more lines)${$.reset}`);
  }
  console.log();
}

export async function cmdCompany(
  task: string,
  options?: { mode?: string; budget?: number; userId?: string },
) {
  const runtime = createRuntime();
  if (!runtime) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
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
    kv(
      'Status',
      result.status,
      result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red,
    );
    kv('Mode', result.executionMode, $.cyan);
    kv('Agents', result.agentsUsed.map((a: { agentId: string }) => a.agentId).join(', '), $.dim);
    kv('Tokens', `${(result.metrics?.totalTokens ?? 0).toLocaleString()}`, $.yellow);
    kv('Duration', `${((result.metrics?.totalDurationMs ?? 0) / 1000).toFixed(1)}s`, $.yellow);
    kv(
      'Quality',
      `${(result.qualityDecision.rollingQuality * 100).toFixed(0)}%`,
      result.qualityDecision.rollingQuality > 0.7 ? $.green : $.yellow,
    );
    kv('Strategy', result.matchResult.strategy, $.dim);
    kv('Savings', `~${result.estimatedSavings}%`, $.green);
    console.log();

    section('QUALITY');
    kv(
      'Action',
      result.qualityDecision.action,
      result.qualityDecision.action === 'escalate'
        ? $.yellow
        : result.qualityDecision.action === 'de-escalate'
          ? $.green
          : $.dim,
    );
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
