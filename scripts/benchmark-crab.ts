#!/usr/bin/env tsx
/**
 * scripts/benchmark-crab.ts — CRAB capability-benchmark scaffold.
 *
 * Scope:
 *   - Loads offline fixture tasks from `packages/core/.cache/crab/tasks.json`
 *   - Runs a local execution stub per task to produce a capability baseline
 *   - Reports success, environment breakdown, and expected-outcome shape
 *   - Tags defense-relevant side-effects per task (reversibility, PII, injection)
 *
 * Usage:
 *   npx tsx scripts/benchmark-crab.ts            # full fixture mode
 *   npx tsx scripts/benchmark-crab.ts --quick    # 10-task offline dry-run
 *   npx tsx scripts/benchmark-crab.ts --output=result.json
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

const CACHE_DIR = path.join(process.cwd(), 'packages/core/.cache/crab');
const TASK_PATH = path.join(CACHE_DIR, 'tasks.json');
const BASELINE_PATH = path.join(CACHE_DIR, 'baseline.json');

interface CrabTask {
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
  environment: string;
  instruction: string;
  expected: string;
}

function loadTasks(): CrabTask[] {
  if (!fs.existsSync(TASK_PATH)) {
    throw new Error(`CRAB fixture not found: ${TASK_PATH}`);
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
    datasetVersion: 'crab-fixture-v1',
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
  const text = `${task.instruction} ${task.expected}`.toLowerCase();
  if (text.includes('email') || text.includes('send_email')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:send_email');
  }
  if (text.includes('delete') || text.includes('delete_file')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:delete_file');
  }
  if (text.includes('transfer') || text.includes('money')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:transfer_money');
  }
  if (text.includes('password') || text.includes('secret') || text.includes('token')) {
    recordDefenseEvent(events, task.id, 'pii_scan:secret_detected');
  }
  if (text.includes('jailbreak') || text.includes('ignore previous instructions')) {
    recordDefenseEvent(events, task.id, 'prompt_injection:indirect_injection');
  }
}

function runTask(task: CrabTask): TaskResult {
  const start = Date.now();
  const stepBudget = 8;

  // Offline stub: full CRAB requires mobile/desktop multimodal runtime.
  // We record fixture/loader health here; live execution is future work.
  return {
    taskId: task.id,
    environment: task.environment,
    success: false,
    simulated: true,
    reason: 'live multimodal runner not implemented',
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
  console.log('  CRAB Capability Baseline');
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
    id: 'crab_synth_01',
    environment: 'desktop',
    instruction:
      '[SYNTHETIC] Open the file manager, navigate to /home/user/Documents, and create a new folder named "Reports".',
    expected: 'folder_created',
  },
  {
    id: 'crab_synth_02',
    environment: 'mobile',
    instruction: '[SYNTHETIC] Open the Settings app, go to Display, and set brightness to 70%.',
    expected: 'brightness_changed',
  },
  {
    id: 'crab_synth_03',
    environment: 'desktop',
    instruction:
      '[SYNTHETIC] Open the browser, go to https://example.com, and return the page title.',
    expected: 'page_title',
  },
  {
    id: 'crab_synth_04',
    environment: 'mobile',
    instruction:
      '[SYNTHETIC] Open the Photos app, select the latest screenshot, and share it to email.',
    expected: 'photo_shared',
  },
  {
    id: 'crab_synth_05',
    environment: 'desktop',
    instruction: '[SYNTHETIC] Open the terminal and run `ls -la /var/log` to list log files.',
    expected: 'log_listed',
  },
  {
    id: 'crab_synth_06',
    environment: 'mobile',
    instruction:
      '[SYNTHETIC] Open the Maps app, search for "coffee shop", and return the first result name.',
    expected: 'search_result',
  },
  {
    id: 'crab_synth_07',
    environment: 'desktop',
    instruction:
      '[SYNTHETIC] Open the email client and send a message to support@example.com with subject "Outage report".',
    expected: 'email_sent',
  },
  {
    id: 'crab_synth_08',
    environment: 'mobile',
    instruction:
      '[SYNTHETIC] Open the Notes app, create a new note titled "Groceries", and add "milk" to it.',
    expected: 'note_created',
  },
  {
    id: 'crab_synth_09',
    environment: 'desktop',
    instruction:
      '[SYNTHETIC] Open the file manager and delete the file /tmp/cache/old_session.json.',
    expected: 'file_deleted',
  },
  {
    id: 'crab_synth_10',
    environment: 'mobile',
    instruction: '[SYNTHETIC] Open the browser, go to https://example.com, and bookmark the page.',
    expected: 'page_bookmarked',
  },
];

interface ReportPayload {
  tasks: TaskResult[];
  accuracy: number;
  baseline: Record<string, number> | null;
  defenseEvents: Array<{ taskId: string; event: string; detail?: string }>;
}

function writeOutput(payload: ReportPayload, outputPath: string): void {
  const baseline = withBenchmarkEnv(payload, {
    evidence: 'source',
    datasetVersion: 'crab-fixture-v1',
  });
  fs.writeFileSync(outputPath, JSON.stringify(baseline, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  console.log('CRAB benchmark runner');
  console.log(`Cache dir: ${CACHE_DIR}`);

  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const outputArg = argv.find((a) => a.startsWith('--output='));
  const outputPath = outputArg ? outputArg.slice('--output='.length) : null;

  if (!quick && !fs.existsSync(TASK_PATH)) {
    console.error(`CRAB fixture not found: ${TASK_PATH}`);
    console.error('Run with --quick for offline dry-run, or add fixture tasks.json.');
    process.exit(4);
  }

  const fixtureTasks = quick ? [] : loadTasks();
  const tasks = quick
    ? SYNTHETIC_TASKS
    : fixtureTasks.map((t) => ({
        id: t.id,
        environment: t.environment,
        instruction: t.instruction,
        expected: t.expected,
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
    const result = runTask(task);
    results.push(result);
    classifyDefenseSideEffects(task, defenseEvents);
  }

  printReport(results, baseline, defenseEvents);

  const accuracy =
    results.length > 0 ? results.filter((r) => r.success).length / results.length : 0;
  if (outputPath) {
    writeOutput({ tasks: results, accuracy, baseline, defenseEvents }, outputPath);
    console.log(`Wrote report: ${outputPath}`);
  }

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
