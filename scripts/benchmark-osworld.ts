#!/usr/bin/env tsx
/**
 * scripts/benchmark-osworld.ts — OSWorld capability-benchmark scaffold.
 *
 * Scope:
 *   - Loads offline fixture tasks from `packages/core/.cache/osworld/tasks.json`
 *   - Runs a local execution stub per task to produce a capability baseline
 *   - Reports success, environment breakdown, and expected-outcome shape
 *   - Tags defense-relevant side-effects per task (reversibility, PII, injection)
 *
 * Usage:
 *   npx tsx scripts/benchmark-osworld.ts            # full fixture mode
 *   npx tsx scripts/benchmark-osworld.ts --quick    # 10-task offline dry-run
 *   npx tsx scripts/benchmark-osworld.ts --output=result.json
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

const CACHE_DIR = path.join(process.cwd(), 'packages/core/.cache/osworld');
const TASK_PATH = path.join(CACHE_DIR, 'tasks.json');
const BASELINE_PATH = path.join(CACHE_DIR, 'baseline.json');

interface OSWorldTask {
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

function loadTasks(): OSWorldTask[] {
  if (!fs.existsSync(TASK_PATH)) {
    throw new Error(`OSWorld fixture not found: ${TASK_PATH}`);
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
    datasetVersion: 'osworld-fixture-v1',
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

function runTask(task: OSWorldTask): TaskResult {
  const start = Date.now();
  const stepBudget = 8;

  // Offline stub: full OSWorld requires VM-backed GUI runtime.
  // We record fixture/loader health here; live execution is future work.
  return {
    taskId: task.id,
    environment: task.environment,
    success: false,
    simulated: true,
    reason: 'live GUI runner not implemented',
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
  console.log('  OSWorld Capability Baseline');
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
    id: 'osworld_synth_01',
    environment: 'ubuntu',
    instruction:
      '[SYNTHETIC] Open the file manager, navigate to /home/user/Documents, and create a new folder named "Reports".',
    expected: 'folder_created',
  },
  {
    id: 'osworld_synth_02',
    environment: 'ubuntu',
    instruction:
      '[SYNTHETIC] Open the terminal and run `htop` to show the top 5 processes by memory usage.',
    expected: 'process_list',
  },
  {
    id: 'osworld_synth_03',
    environment: 'windows',
    instruction:
      '[SYNTHETIC] Open Settings, navigate to Display, and change the brightness to 70%.',
    expected: 'brightness_changed',
  },
  {
    id: 'osworld_synth_04',
    environment: 'ubuntu',
    instruction:
      '[SYNTHETIC] Open Firefox, go to https://example.com, and take a screenshot of the homepage.',
    expected: 'screenshot_taken',
  },
  {
    id: 'osworld_synth_05',
    environment: 'windows',
    instruction: '[SYNTHETIC] Open Excel, create a new workbook, and enter "Sales" in cell A1.',
    expected: 'cell_edited',
  },
  {
    id: 'osworld_synth_06',
    environment: 'ubuntu',
    instruction:
      '[SYNTHETIC] Open the file manager and delete the file /tmp/cache/old_session.json.',
    expected: 'file_deleted',
  },
  {
    id: 'osworld_synth_07',
    environment: 'windows',
    instruction:
      '[SYNTHETIC] Open the email client and send a message to support@example.com with subject "Outage report".',
    expected: 'email_sent',
  },
  {
    id: 'osworld_synth_08',
    environment: 'ubuntu',
    instruction:
      '[SYNTHETIC] Open the terminal and copy /var/log/syslog to /home/user/Documents/syslog_backup.txt.',
    expected: 'file_copied',
  },
  {
    id: 'osworld_synth_09',
    environment: 'windows',
    instruction:
      '[SYNTHETIC] Open the browser, search for "weather today", and return the first result title.',
    expected: 'search_result',
  },
  {
    id: 'osworld_synth_10',
    environment: 'ubuntu',
    instruction:
      '[SYNTHETIC] Open the terminal and run `sudo apt update`, then confirm the output shows "Reading package lists".',
    expected: 'apt_update_complete',
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
    datasetVersion: 'osworld-fixture-v1',
  });
  fs.writeFileSync(outputPath, JSON.stringify(baseline, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  console.log('OSWorld benchmark runner');
  console.log(`Cache dir: ${CACHE_DIR}`);

  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const outputArg = argv.find((a) => a.startsWith('--output='));
  const outputPath = outputArg ? outputArg.slice('--output='.length) : null;

  if (!quick && !fs.existsSync(TASK_PATH)) {
    console.error(`OSWorld fixture not found: ${TASK_PATH}`);
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
