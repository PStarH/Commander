/**
 * commander debug intent <runId> — Why did the agent do that?
 *
 * Reads the IntentLog and ExecutionTrace for a given runId and renders
 * a decision chain tree: User Goal → Model Selected → Thompson Sample →
 * Strategy → Tool Choice → Verification Result.
 *
 * Usage:
 *   commander debug intent <runId>
 *   commander debug intent           List all runs with captured intent
 */

import { reportSilentFailure } from '../../silentFailureReporter';
import { getIntentLog } from '../../runtime/intentLog';
import { getTraceRecorder } from '../../runtime/executionTrace';
import { getMetaLearner } from '../../selfEvolution/metaLearner';
import type { IntentRecord } from '../../runtime/intentLog';
import type { ExecutionTrace } from '../../runtime/types';

// ============================================================================
// ANSI helpers
// ============================================================================

const $ = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

function section(text: string): void {
  console.log(`\n  ${$.cyan}${$.bold}╭─ ${text}${$.reset}`);
}

function kv(key: string, value: string, color = $.reset): void {
  console.log(`  ${$.dim}${key.padEnd(18)}${$.reset} ${color}${value}${$.reset}`);
}

function bullet(text: string, color = $.reset): void {
  console.log(`    ${color}•${$.reset} ${text}`);
}

function bar(value: number, maxWidth = 16): string {
  const filled = Math.round(value * maxWidth);
  const bg = '░'.repeat(maxWidth);
  const fg = '█'.repeat(filled);
  return `${$.green}${fg}${$.dim}${bg.slice(filled)}${$.reset}`;
}

function trunc(text: string, len = 70): string {
  return text.length > len ? text.slice(0, len - 3) + '...' : text;
}

// ============================================================================
// Renderers
// ============================================================================

function renderGoal(record: IntentRecord): void {
  section('GOAL');
  if (record.goal) {
    console.log(`  ${$.bold}${record.goal}${$.reset}`);
  }
  if (record.taskType || record.effortLevel) {
    const parts: string[] = [];
    if (record.taskType) parts.push(`Task: ${record.taskType}`);
    if (record.effortLevel) parts.push(`Effort: ${record.effortLevel}`);
    if (record.confidence !== undefined)
      parts.push(`Confidence: ${(record.confidence * 100).toFixed(0)}%`);
    console.log(`  ${$.dim}${parts.join(' · ')}${$.reset}`);
  }
  if (record.estimatedAgentCount || record.estimatedSteps) {
    const parts: string[] = [];
    if (record.estimatedAgentCount) parts.push(`${record.estimatedAgentCount} agents`);
    if (record.estimatedSteps) parts.push(`${record.estimatedSteps} steps`);
    if (record.estimatedTokens) parts.push(`${record.estimatedTokens.toLocaleString()} tok`);
    if (record.estimatedDurationMs)
      parts.push(`${(record.estimatedDurationMs / 1000).toFixed(1)}s`);
    console.log(`  ${$.dim}Estimated: ${parts.join(' · ')}${$.reset}`);
  }
}

function renderModelSelection(record: IntentRecord): void {
  section('MODEL SELECTION');
  if (record.chosenModel) {
    const m = record.chosenModel;
    kv('Model', `${m.id}`, $.cyan);
    kv('Provider', m.provider, $.dim);
    kv('Tier', m.tier, $.dim);
  } else {
    kv('Model', 'Not recorded', $.dim);
  }
  if (record.routingReasoning && record.routingReasoning.length > 0) {
    console.log(`  ${$.dim}Routing reason:${$.reset}`);
    for (const r of record.routingReasoning.slice(0, 5)) {
      bullet(r, $.dim);
    }
  }
}

function renderTopologyChoice(record: IntentRecord, ml: ReturnType<typeof getMetaLearner>): void {
  section('STRATEGY SELECTION');
  if (record.chosenTopology) {
    kv('Topology', record.chosenTopology, $.cyan);
  }
  if (record.taskType) {
    try {
      const scores = ml.getStrategyScores(record.taskType);
      if (scores.length > 0) {
        const maxScore = Math.max(...scores.map((s) => s.score));
        for (const s of scores.slice(0, 5)) {
          const normalized = maxScore > 0 ? s.score / maxScore : 0;
          const chosen = s.strategy === record.chosenTopology;
          const prefix = chosen ? `${$.green}▶${$.reset}` : ' ';
          const name = chosen ? `${$.bold}${s.strategy}${$.reset}` : s.strategy;
          const scorePct = (s.score * 100).toFixed(0);
          console.log(
            `  ${prefix} ${name.padEnd(14)} ${bar(normalized)} ${$.dim}${scorePct}%${$.reset} ${$.dim}(${s.trials} trials)${$.reset}`,
          );
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'debug:127');
      /* best-effort */
    }
  }
}

function renderExecutionTrace(trace: ExecutionTrace): void {
  section('EXECUTION TRACE');

  const llmCalls = trace.events.filter((e) => e.type === 'llm_call');
  const toolCalls = trace.events.filter((e) => e.type === 'tool_execution');
  const verifications = trace.events.filter((e) => e.type === 'verification');
  const errors = trace.events.filter((e) => e.type === 'error');
  const decisions = trace.events.filter((e) => e.type === 'decision');

  // Show LLM calls
  if (llmCalls.length > 0) {
    console.log(`  ${$.dim}LLM Calls (${llmCalls.length}):${$.reset}`);
    for (const e of llmCalls.slice(0, 8)) {
      const model = e.data?.modelInfo?.model ?? 'unknown';
      const tokens = e.data?.tokenUsage?.totalTokens ?? 0;
      const dur = e.durationMs > 0 ? `${(e.durationMs / 1000).toFixed(1)}s` : '';
      console.log(
        `    ${$.cyan}→${$.reset} ${model} ${$.dim}${tokens.toLocaleString()} tok${$.reset} ${$.gray}${dur}${$.reset}`,
      );
    }
    if (llmCalls.length > 8)
      console.log(`    ${$.dim}... and ${llmCalls.length - 8} more${$.reset}`);
  }

  // Show tool calls
  if (toolCalls.length > 0) {
    console.log(`\n  ${$.dim}Tool Calls (${toolCalls.length}):${$.reset}`);
    for (const e of toolCalls.slice(0, 10)) {
      const inputData = e.data?.input as Record<string, unknown> | undefined;
      const outputData = e.data?.output as Record<string, unknown> | undefined;
      const toolName = inputData?.tool ?? outputData?.tool ?? 'tool';
      const dur = e.durationMs > 0 ? `${e.durationMs}ms` : '';
      const err = e.data?.error ? ` ${$.red}✗${$.reset} ${trunc(String(e.data.error), 30)}` : '';
      console.log(
        `    ${$.yellow}◆${$.reset} ${trunc(String(toolName), 30)} ${$.gray}${dur}${$.reset}${err}`,
      );
    }
    if (toolCalls.length > 10)
      console.log(`    ${$.dim}... and ${toolCalls.length - 10} more${$.reset}`);
  }

  // Show decisions
  if (decisions.length > 0) {
    console.log(`\n  ${$.dim}Decisions (${decisions.length}):${$.reset}`);
    for (const e of decisions.slice(0, 5)) {
      const decision =
        typeof e.data?.output === 'string'
          ? e.data.output
          : JSON.stringify(e.data?.output ?? '').slice(0, 60);
      console.log(`    ${$.blue}◉${$.reset} ${trunc(decision, 60)}`);
    }
  }

  // Show verifications
  if (verifications.length > 0) {
    console.log(`\n  ${$.dim}Verifications (${verifications.length}):${$.reset}`);
    for (const e of verifications.slice(0, 5)) {
      const passed = e.data?.evaluationPassed === true;
      const confidence = e.data?.evaluationScore ?? 0;
      const icon = passed ? `${$.green}✓${$.reset}` : `${$.red}✗${$.reset}`;
      console.log(
        `    ${icon} ${passed ? 'PASSED' : 'FAILED'} ${$.dim}confidence: ${(Number(confidence) * 100).toFixed(0)}%${$.reset}`,
      );
    }
  }

  // Show errors
  if (errors.length > 0) {
    console.log(`\n  ${$.dim}Errors (${errors.length}):${$.reset}`);
    for (const e of errors.slice(0, 5)) {
      const err = e.data?.error ? String(e.data.error).slice(0, 70) : 'unknown';
      console.log(`    ${$.red}✗${$.reset} ${trunc(err, 70)}`);
    }
  }
}

function renderVerdict(trace: ExecutionTrace, record: IntentRecord): void {
  section('VERDICT');
  const completed = !!trace.completedAt;
  const totalTokens = trace.summary.totalTokens;
  const totalDur = trace.summary.totalDurationMs;
  const errors = trace.summary.errors;
  const llmCalls = trace.summary.llmCalls;
  const toolCalls = trace.summary.toolExecutions;
  const modelUsed = trace.summary.modelUsed || record.chosenModel?.id || 'unknown';

  const statusIcon =
    completed && errors === 0
      ? `${$.green}✅${$.reset}`
      : completed
        ? `${$.yellow}⚠️${$.reset}`
        : `${$.red}❌${$.reset}`;
  const statusText = completed && errors === 0 ? 'SUCCESS' : completed ? 'PARTIAL' : 'INCOMPLETE';

  console.log(`  ${statusIcon} ${$.bold}${statusText}${$.reset}`);
  console.log();
  kv('Model', modelUsed, $.cyan);
  kv('LLM calls', `${llmCalls}`, $.dim);
  kv('Tool calls', `${toolCalls}`, $.dim);
  kv('Tokens', `${totalTokens.toLocaleString()}`, $.yellow);
  kv('Duration', `${(totalDur / 1000).toFixed(1)}s`, $.yellow);
  kv('Errors', `${errors}`, errors > 0 ? $.red : $.green);
  if (trace.startedAt) kv('Started', trace.startedAt, $.dim);
  if (trace.completedAt) kv('Completed', trace.completedAt, $.dim);
}

function renderEscalations(record: IntentRecord): void {
  if (!record.escalations || record.escalations.length === 0) return;
  section('CASCADE ESCALATIONS');
  for (const esc of record.escalations) {
    console.log(`    ${$.yellow}↑${$.reset} ${esc.from} → ${$.cyan}${esc.to}${$.reset}`);
    console.log(`      ${$.dim}${esc.reason}${$.reset} (${esc.timestamp})`);
  }
}

// ============================================================================
// Main entry: debug intent
// ============================================================================

export async function cmdDebugIntent(
  args: string[],
  _flags: Record<string, string>,
): Promise<void> {
  const intentLog = getIntentLog();

  // Handle 'intent' subcommand prefix: commander debug intent [runId]
  let runId: string | undefined;
  if (args[0] === 'intent') {
    runId = args[1]; // commander debug intent <runId>
  } else {
    runId = args[0]; // commander debug <runId> (short form)
  }

  // No runId → list all runs with captured intent
  if (!runId) {
    const runs = intentLog.listRuns();
    console.log(
      `\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`,
    );
    console.log(
      `  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}Debug: Captured Intent Runs${$.reset}                          ${$.cyan}${$.bold}│${$.reset}`,
    );
    console.log(
      `  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`,
    );

    if (runs.length === 0) {
      console.log(`\n  ${$.dim}No intent-captured runs found.${$.reset}`);
      console.log(
        `  ${$.dim}Runs are captured when using the full pipeline (commander run).${$.reset}`,
      );
      console.log(
        `  ${$.dim}Run a task first, then use ${$.cyan}commander debug intent <runId>${$.reset}${$.dim} to inspect.${$.reset}\n`,
      );
      return;
    }

    console.log(`\n  ${$.dim}RunId${$.reset}\n`);
    // Show recent runs with quick summaries
    const recent = runs.slice(-20).reverse();
    for (const runId of recent) {
      const record = intentLog.readIntent(runId);
      const goal = record?.goal ? trunc(record.goal, 50) : '(unknown goal)';
      const ts = record?.capturedAt ? new Date(record.capturedAt).toLocaleString() : '';
      const topology = record?.chosenTopology ? ` ${$.cyan}${record.chosenTopology}${$.reset}` : '';
      console.log(`  ${$.bold}${runId}${$.reset}`);
      console.log(`    ${goal}${topology}`);
      if (ts) console.log(`    ${$.dim}${ts}${$.reset}`);
      console.log();
    }

    console.log(`  ${$.dim}Inspect: ${$.cyan}commander debug intent <runId>${$.reset}\n`);
    return;
  }

  console.log(
    `\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`,
  );
  const padLen = Math.max(0, 34 - runId.length);
  console.log(
    `  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}Intent Debug: ${runId}${$.reset}${' '.repeat(padLen)}${$.cyan}${$.bold}│${$.reset}`,
  );
  console.log(
    `  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`,
  );

  // 1. Read IntentLog
  const record = intentLog.readIntent(runId);
  if (!record) {
    console.log(`\n  ${$.yellow}No intent record found for run:${$.reset} ${runId}`);
    console.log(`  ${$.dim}Intent may not have been captured for this run.${$.reset}`);
    console.log(
      `  ${$.dim}Use ${$.cyan}commander debug intent${$.reset}${$.dim} to list captured runs.${$.reset}\n`,
    );
    return;
  }

  // 2. Read ExecutionTrace
  const tracer = getTraceRecorder();
  const trace = tracer.getTrace(runId);

  // 3. Get MetaLearner for strategy scores
  let ml: ReturnType<typeof getMetaLearner> | null = null;
  try {
    ml = getMetaLearner();
  } catch (err) {
    reportSilentFailure(err, 'debug:339');
    /* best-effort */
  }

  // 4. Render decision chain
  renderGoal(record);
  renderModelSelection(record);
  if (ml) renderTopologyChoice(record, ml);

  if (trace) {
    renderExecutionTrace(trace);
    renderVerdict(trace, record);
  } else {
    section('EXECUTION TRACE');
    console.log(`  ${$.dim}No execution trace found for this run.${$.reset}`);
    console.log(`  ${$.dim}Traces are held in-memory and may have been evicted.${$.reset}`);
  }

  renderEscalations(record);

  console.log();
}
