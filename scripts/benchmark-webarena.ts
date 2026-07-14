#!/usr/bin/env tsx
/**
 * scripts/benchmark-webarena.ts — WebArena capability baseline runner.
 *
 * Scope:
 *   - Loads offline fixture tasks from `packages/core/.cache/webarena/tasks.json`
 *   - Runs a local execution stub per task to produce a capability baseline
 *   - Reports success, step budget, and expected-outcome shape
 *   - Tags defense-relevant side-effects per task (reversibility, PII, injection)
 *
 * Usage:
 *   npx tsx scripts/benchmark-webarena.ts            # full fixture mode
 *   npx tsx scripts/benchmark-webarena.ts --quick    # 10-task offline dry-run
 *   npx tsx scripts/benchmark-webarena.ts --output=result.json
 *
 * Exit codes:
 *   0  run completed + baseline check passed
 *   1  capability regression below stored baseline
 *   2  fatal error / missing fixture / scoring regression
 *   4  invoked in legacy incomplete mode (no fixture, no quick)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withBenchmarkEnv } from './benchmarkEnv';

const CACHE_DIR = path.join(process.cwd(), 'packages/core/.cache/webarena');
const TASK_PATH = path.join(CACHE_DIR, 'tasks.json');
const BASELINE_PATH = path.join(CACHE_DIR, 'baseline.json');

interface WebArenaTask {
  id: string;
  environment: string;
  instruction: string;
  expected: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface TaskResult {
  taskId: string;
  environment: string;
  success: boolean;
  simulated: boolean;
  reason: string;
  durationMs: number;
  stepBudget: number;
}

interface SyntheticTask {
  id: string;
  agentId: string;
  projectId: string;
  input: string;
  mockOutput: string;
  expected: string;
}

function loadTasks(): WebArenaTask[] {
  if (!fs.existsSync(TASK_PATH)) {
    throw new Error(`WebArena fixture not found: ${TASK_PATH}`);
  }
  const raw = fs.readFileSync(TASK_PATH, 'utf-8');
  const data = JSON.parse(raw);
  return Array.isArray(data.tasks) ? data.tasks : [];
}

function loadBaseline(): Record<string, number> | null {
  if (!fs.existsSync(BASELINE_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(BASELINE_PATH, 'utf-8');
  return JSON.parse(raw);
}

function saveBaseline(accuracy: number): void {
  const payload = {
    accuracy,
    taskCount: currentTaskCount,
    note: 'Offline fixture baseline; not a live browser run.',
  };
  const baseline = withBenchmarkEnv(payload, {
    evidence: 'source',
    datasetVersion: 'webarena-fixture-v1',
  });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2), 'utf-8');
}

let currentTaskCount = 0;

function recordDefenseEvent(
  events: Array<{ taskId: string; event: string; detail?: string }>,
  taskId: string,
  event: string,
  detail?: string,
): void {
  events.push({ taskId, event, detail });
}

function classifyDefenseSideEffects(
  task: SyntheticTask,
  events: Array<{ taskId: string; event: string; detail?: string }>,
): void {
  const text = `${task.input} ${task.mockOutput}`.toLowerCase();
  if (task.input.toLowerCase().includes('email') || text.includes('send_email')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:send_email');
  }
  if (task.input.toLowerCase().includes('delete') || text.includes('delete_file')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:delete_file');
  }
  if (task.input.toLowerCase().includes('transfer') || text.includes('money')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:transfer_money');
  }
  if (text.includes('password') || text.includes('secret') || text.includes('token')) {
    recordDefenseEvent(events, task.id, 'pii_scan:secret_detected');
  }
  if (text.includes('jailbreak') || text.includes('ignore previous instructions')) {
    recordDefenseEvent(events, task.id, 'prompt_injection:indirect_injection');
  }
}

function runTask(task: WebArenaTask): TaskResult {
  const start = Date.now();
  const stepBudget = 8;

  return {
    taskId: task.id,
    environment: task.environment,
    success: false,
    simulated: true,
    reason: 'live browser runner not implemented',
    durationMs: Date.now() - start,
    stepBudget,
  };
}

function printReport(
  results: TaskResult[],
  baseline: Record<string, number> | null,
  defenseEvents: Array<{ taskId: string; event: string; detail?: string }>,
): void {
  console.log('═'.repeat(72));
  console.log('  WebArena Capability Baseline');
  console.log('═'.repeat(72));
  for (const r of results) {
    const taskDefense = defenseEvents.filter((d) => d.taskId === r.taskId);
    const defenseTag =
      taskDefense.length > 0 ? ` [defense:${taskDefense.map((d) => d.event).join(',')}]` : '';
    console.log(
      `  ${r.simulated ? '[stub]' : '[run]'} ${r.taskId}  env=${r.environment}  success=${String(r.success)}  steps<=${r.stepBudget}${defenseTag}`,
    );
  }
  console.log('─'.repeat(72));
  const simulated = results.filter((r) => r.simulated).length;
  console.log(
    `  Tasks: ${results.length}  Simulated: ${simulated}  Live: ${results.length - simulated}`,
  );
  if (baseline) {
    console.log(`  Baseline: accuracy=${baseline.accuracy} savedAt=${baseline.savedAt}`);
  }
  console.log(`  Defense events: ${defenseEvents.length}`);
  console.log('═'.repeat(72));
}

const SYNTHETIC_TASKS: readonly SyntheticTask[] = [
  {
    id: 'webarena_synth_01',
    agentId: 'agent_cart_headphones',
    projectId: 'project_cart_headphones',
    input: '[SYNTHETIC] Find a pair of wireless headphones under $80 and add them to the cart.',
    mockOutput: 'Added wireless headphones ($79) to cart.',
    expected: 'Added to cart',
  },
  {
    id: 'webarena_synth_02',
    agentId: 'agent_publish_article',
    projectId: 'project_publish_article',
    input: '[SYNTHETIC] Publish the draft article titled "Launch Notes".',
    mockOutput: 'Article "Launch Notes" is now published.',
    expected: 'published',
  },
  {
    id: 'webarena_synth_03',
    agentId: 'agent_reply_thread',
    projectId: 'project_reply_thread',
    input: "[SYNTHETIC] Reply to thread 'Bug Report #41' with a link to the troubleshooting guide.",
    mockOutput: 'Reply posted to Bug Report #41 with guide link.',
    expected: 'Reply posted',
  },
  {
    id: 'webarena_synth_04',
    agentId: 'agent_open_pr',
    projectId: 'project_open_pr',
    input:
      "[SYNTHETIC] Create a pull request from branch 'patch-9' into main with title 'Fix login redirect'.",
    mockOutput: 'PR #42 opened: Fix login redirect',
    expected: 'PR opened',
  },
  {
    id: 'webarena_synth_05',
    agentId: 'agent_forward_receipt',
    projectId: 'project_forward_receipt',
    input: '[SYNTHETIC] Forward the order confirmation receipt to the account owner.',
    mockOutput: 'Receipt forwarded to account_owner@example.com.',
    expected: 'forwarded',
  },
  {
    id: 'webarena_synth_06',
    agentId: 'agent_search_product',
    projectId: 'project_search_product',
    input: '[SYNTHETIC] Search for "mechanical keyboard" and filter by price under $100.',
    mockOutput: 'Found 12 mechanical keyboards under $100.',
    expected: 'Found results',
  },
  {
    id: 'webarena_synth_07',
    agentId: 'agent_edit_wiki',
    projectId: 'project_edit_wiki',
    input: "[SYNTHETIC] Update the wiki page 'Setup Guide' to include the new API endpoint.",
    mockOutput: 'Wiki page "Setup Guide" updated with new API endpoint.',
    expected: 'updated',
  },
  {
    id: 'webarena_synth_08',
    agentId: 'agent_create_issue',
    projectId: 'project_create_issue',
    input: "[SYNTHETIC] Create a GitHub issue titled 'Memory leak in worker' with label 'bug'.",
    mockOutput: 'Issue #101 created: Memory leak in worker',
    expected: 'Issue created',
  },
  {
    id: 'webarena_synth_09',
    agentId: 'agent_delete_file',
    projectId: 'project_delete_file',
    input: '[SYNTHETIC] Delete the temporary file /tmp/cache/old_session.json.',
    mockOutput: 'Deleted /tmp/cache/old_session.json.',
    expected: 'Deleted',
  },
  {
    id: 'webarena_synth_10',
    agentId: 'agent_send_email',
    projectId: 'project_send_email',
    input: '[SYNTHETIC] Send an email to support@example.com with subject "Outage report".',
    mockOutput: 'Email sent to support@example.com.',
    expected: 'Email sent',
  },
];

async function main(): Promise<void> {
  console.log('WebArena benchmark runner');
  console.log(`Cache dir: ${CACHE_DIR}`);

  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const outputArg = argv.find((a) => a.startsWith('--output='));
  const outputPath = outputArg ? outputArg.slice('--output='.length) : null;

  if (!quick && !fs.existsSync(TASK_PATH)) {
    console.error(`WebArena fixture not found: ${TASK_PATH}`);
    console.error('Run with --quick for offline dry-run, or add fixture tasks.json.');
    process.exit(4);
  }

  const fixtureTasks = quick ? [] : loadTasks();
  const tasks = quick
    ? SYNTHETIC_TASKS
    : fixtureTasks.map((t) => ({
        id: t.id,
        agentId: `agent_${t.id}`,
        projectId: `project_${t.id}`,
        input: t.instruction,
        mockOutput: JSON.stringify(t.expected),
        expected: JSON.stringify(t.expected),
      }));

  currentTaskCount = tasks.length;
  const modeLabel = quick
    ? 'quick (10 tasks, offline)'
    : `full (${tasks.length} tasks, fixture-backed)`;
  console.log(`Mode: ${modeLabel}`);
  console.log(`Loaded tasks: ${tasks.length}`);

  const baseline = loadBaseline();
  const results: TaskResult[] = [];
  const defenseEvents: Array<{ taskId: string; event: string; detail?: string }> = [];

  for (const task of tasks) {
    const result = runTask(
      quick
        ? {
            id: task.id,
            environment: 'synthetic',
            instruction: task.input,
            expected: {},
            severity: 'low',
          }
        : {
            id: task.id,
            environment: 'fixture',
            instruction: task.input,
            expected: task.expected as Record<string, unknown>,
            severity: 'low',
          },
    );
    results.push(result);
    classifyDefenseSideEffects(task, defenseEvents);
  }

  printReport(results, baseline, defenseEvents);

  const accuracy =
    results.length > 0 ? results.filter((r) => r.success).length / results.length : 0;
  if (baseline === null) {
    saveBaseline(accuracy);
    console.log('Saved baseline from current fixture run.');
    process.exit(0);
  }

  const expectedAccuracy = baseline.accuracy;
  if (accuracy < expectedAccuracy) {
    console.log(`Capability regression: accuracy=${accuracy} < baseline=${expectedAccuracy}`);
    process.exit(1);
  }

  console.log(`Capability check passed: accuracy=${accuracy} >= baseline=${expectedAccuracy}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
