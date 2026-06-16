/**
 * Small Features — Quick commands and flags for better UX
 *
 * Implements 10 small features that users love:
 * 1. commander ask "question" — Quick Q&A mode
 * 2. commander diff — View recent changes
 * 3. commander cost — View token usage
 * 4. commander undo — Undo last operation
 * 5. --verbose/--quiet — Log level control
 * 6. --output=json — Machine-readable output
 * 7. --topology= — Force topology selection
 * 8. command aliases (r, s, d, etc.)
 * 9. approval history viewing
 * 10. history --export
 */

import { $, parseFlags } from '../util';
import { deliberate } from '../../ultimate/deliberation';
import {
  readLLMCallRecords,
  aggregateCost,
  formatCostTable,
  formatCostJson,
  formatCostCsv,
  type CostFilter,
} from '../../intelligence/costAggregator';

// ============================================================================
// 1. commander ask — Quick Q&A mode
// ============================================================================

export async function cmdAsk(question: string, flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Ask${$.reset} — Quick Q&A Mode\n`);
  console.log(`  ${$.dim}Question:${$.reset} ${question}\n`);

  // Use deliberation to classify the question
  const plan = deliberate(question);

  console.log(`  ${$.dim}Type:${$.reset} ${plan.taskType}`);
  console.log(`  ${$.dim}Effort:${$.reset} ${plan.effortLevel}`);
  console.log(`  ${$.dim}Confidence:${$.reset} ${(plan.confidence * 100).toFixed(0)}%`);

  if (plan.requiresExternalInfo) {
    console.log(`  ${$.yellow}⚠${$.reset} ${$.dim}This question may require web search.${$.reset}`);
  }

  console.log(`\n  ${$.dim}For full execution, use:${$.reset} commander run "${question}"`);
  console.log(
    `  ${$.dim}For quick answer, use:${$.reset} commander run "${question}" --mode=fast\n`,
  );
}

// ============================================================================
// 2. commander diff — View recent changes
// ============================================================================

export async function cmdDiff(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Diff${$.reset} — Recent Changes\n`);

  try {
    const { execSync } = await import('child_process');

    // Get git status
    const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd() });
    if (status.trim()) {
      console.log(`  ${$.bold}Modified files:${$.reset}`);
      for (const line of status.trim().split('\n').slice(0, 20)) {
        const indicator = line.slice(0, 2).trim();
        const file = line.slice(3);
        const color = indicator === '??' ? $.green : indicator === 'M' ? $.yellow : $.dim;
        console.log(`    ${color}${indicator}${$.reset} ${file}`);
      }
      if (status.trim().split('\n').length > 20) {
        console.log(`    ${$.dim}... and ${status.trim().split('\n').length - 20} more${$.reset}`);
      }
    } else {
      console.log(`  ${$.green}No changes detected.${$.reset}`);
    }

    // Get recent commits
    console.log(`\n  ${$.bold}Recent commits:${$.reset}`);
    const log = execSync('git log --oneline -5', { encoding: 'utf-8', cwd: process.cwd() });
    for (const line of log.trim().split('\n')) {
      console.log(`    ${$.dim}${line}${$.reset}`);
    }
  } catch (err) {
    console.log(`  ${$.red}Error reading git status: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 3. commander cost — View token usage
// ============================================================================

function parseDateFlag(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
}

export async function cmdCost(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Cost${$.reset} — Token Usage\n`);

  try {
    const { records, parseErrors } = readLLMCallRecords();
    if (records.length === 0) {
      console.log(`  ${$.dim}No LLM call records found at .commander_samples/llm_calls.ndjson.${$.reset}`);
      console.log(`  ${$.dim}Run a task first: ${$.cyan}commander run "<task>"${$.reset}\n`);
      return;
    }

    const filter: CostFilter = {
      since: parseDateFlag(flags['since']),
      until: parseDateFlag(flags['until']),
      model: flags['model'],
      agent: flags['agent'],
      provider: flags['provider'],
    };

    const report = aggregateCost(records, filter);
    const format = flags['format'] ?? flags['output'] ?? 'table';

    if (format === 'json') {
      console.log(formatCostJson(report));
    } else if (format === 'csv') {
      process.stdout.write(formatCostCsv(report));
    } else {
      console.log(formatCostTable(report));
    }

    if (parseErrors > 0) {
      console.log(`\n  ${$.yellow}Note:${$.reset} ${parseErrors} malformed line(s) in llm_calls.ndjson were skipped.`);
    }
    if (filter.since || filter.until || filter.model || filter.agent || filter.provider) {
      const parts: string[] = [];
      if (filter.since) parts.push(`since=${filter.since.toISOString().slice(0, 10)}`);
      if (filter.until) parts.push(`until=${filter.until.toISOString().slice(0, 10)}`);
      if (filter.model) parts.push(`model=${filter.model}`);
      if (filter.agent) parts.push(`agent=${filter.agent}`);
      if (filter.provider) parts.push(`provider=${filter.provider}`);
      console.log(`\n  ${$.dim}Filters applied: ${parts.join(', ')}${$.reset}`);
    }
    console.log('');
  } catch (err) {
    console.log(`  ${$.red}Error computing cost: ${err instanceof Error ? err.message : String(err)}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 4. commander undo — Undo last operation
// ============================================================================

export async function cmdUndo(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Undo${$.reset}\n`);

  try {
    const { execSync } = await import('child_process');

    // Check if there are uncommitted changes
    const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd() });
    if (status.trim()) {
      console.log(`  ${$.yellow}⚠${$.reset} You have uncommitted changes:${$.reset}`);
      for (const line of status.trim().split('\n').slice(0, 5)) {
        console.log(`    ${line}`);
      }
      console.log(`\n  ${$.dim}To undo Commander changes, use:${$.reset}`);
      console.log(`    git checkout -- <file>     Restore specific file`);
      console.log(`    git stash                  Stash all changes`);
      console.log(
        `    git reset --hard HEAD      Discard all changes ${$.red}(destructive)${$.reset}`,
      );
    } else {
      console.log(`  ${$.green}No changes to undo.${$.reset}`);
    }
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 5-7. Flag processing (verbose, output, topology)
// ============================================================================

export function processGlobalFlags(flags: Record<string, string>): {
  verbose: boolean;
  quiet: boolean;
  output: string;
  topology: string | null;
} {
  const verbose = !!flags['--verbose'] || !!flags['-v'];
  const quiet = !!flags['--quiet'] || !!flags['-q'];
  const output = flags['--output'] || 'text';
  const topology = flags['--topology'] || null;

  // Set log level
  if (verbose) {
    process.env.COMMANDER_LOG_LEVEL = 'debug';
  } else if (quiet) {
    process.env.COMMANDER_LOG_LEVEL = 'error';
  }

  return { verbose, quiet, output, topology };
}

// ============================================================================
// 8. Command aliases
// ============================================================================

export const COMMAND_ALIASES: Record<string, string> = {
  r: 'run',
  s: 'status',
  d: 'drive',
  g: 'goal',
  c: 'company',
  sw: 'swarm',
  rv: 'review',
  h: 'history',
  sk: 'skill',
  p: 'plugin',
  m: 'mode',
  q: 'ask',
  '?': 'help',
  t: 'test',
  e: 'explain',
  f: 'fix',
  w: 'watch',
  i: 'intelligence',
};

export function resolveAlias(cmd: string): string {
  return COMMAND_ALIASES[cmd] || cmd;
}

// ============================================================================
// 9. Approval history
// ============================================================================

export async function cmdApprovalHistory(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Approval History${$.reset}\n`);

  try {
    const fs = await import('fs');
    const path = await import('path');

    const auditFile = path.join(process.cwd(), '.commander', 'security-audit.json');
    if (!fs.existsSync(auditFile)) {
      console.log(`  ${$.dim}No approval history found.${$.reset}\n`);
      return;
    }

    const data = JSON.parse(fs.readFileSync(auditFile, 'utf-8'));
    const entries = Array.isArray(data) ? data : data.entries || [];

    if (entries.length === 0) {
      console.log(`  ${$.dim}No approval history found.${$.reset}\n`);
      return;
    }

    console.log(`  ${$.bold}Recent approvals:${$.reset}`);
    for (const entry of entries.slice(-10)) {
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown';
      const action = entry.action || entry.type || 'unknown';
      const decision = entry.decision || entry.result || 'unknown';
      const color = decision === 'approved' ? $.green : decision === 'denied' ? $.red : $.yellow;
      console.log(`    ${$.dim}${time}${$.reset} ${color}${decision}${$.reset} ${action}`);
    }

    console.log(`\n  ${$.dim}Total entries: ${entries.length}${$.reset}`);
  } catch (err) {
    console.log(`  ${$.red}Error reading approval history: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 10. history --export
// ============================================================================

export function addHistoryExportFlags(): string[] {
  return ['--export', '--json', '--format='];
}

// ============================================================================
// Intelligence commands (user-facing views)
// ============================================================================

// Re-export from the dedicated intelligence command module
export { cmdIntelligence } from './intelligence';

/**
 * commander trace — View execution traces
 */
// ============================================================================
// 11. commander resume — Resume a crashed run from checkpoint
// ============================================================================

export async function cmdResume(args: string[], flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Resume${$.reset} — Crash Recovery\n`);

  try {
    const { AgentRuntime } = await import('../../runtime/agentRuntime');
    const runtime = new AgentRuntime();

    if (args.length === 0 || args[0] === '--list') {
      // List resumable runs
      const runs = runtime.listResumableRuns();
      if (runs.length === 0) {
        console.log(`  ${$.dim}No resumable runs found.${$.reset}`);
        console.log(`  ${$.dim}Run a task first: ${$.cyan}commander run "<task>"${$.reset}\n`);
        return;
      }
      console.log(`  ${$.bold}Resumable runs:${$.reset}`);
      for (const run of runs) {
        console.log(`    ${$.cyan}${run.runId}${$.reset}  ${$.dim}phase=${run.phase}  ${run.timestamp}${$.reset}`);
      }
      console.log(`\n  ${$.dim}To resume: ${$.cyan}commander resume <runId>${$.reset}\n`);
      return;
    }

    const runId = args[0];
    console.log(`  ${$.dim}Attempting to resume run ${$.cyan}${runId}${$.reset}${$.dim}...${$.reset}\n`);

    const result = await runtime.resume(runId);
    if (!result) {
      console.log(`  ${$.red}✗${$.reset} Recovery failed. The checkpoint may not exist or the lease was lost.`);
      console.log(`  ${$.dim}Run ${$.cyan}commander resume --list${$.reset}${$.dim} to see available checkpoints.${$.reset}\n`);
      return;
    }

    console.log(`  ${$.green}✓${$.reset} Run recovered from checkpoint`);
    console.log(`  ${$.dim}Status:${$.reset} ${result.status}`);
    console.log(`  ${$.dim}Resume from step:${$.reset} ${result.resumeFromStep ?? 'N/A'}`);
    console.log(`  ${$.dim}Completed tool calls:${$.reset} ${result.completedToolCallIds.size}`);
    if (result.state) {
      console.log(`  ${$.dim}Phase:${$.reset} ${result.state.phase}`);
      console.log(`  ${$.dim}Goal:${$.reset} ${result.state.context?.goal?.slice(0, 120) ?? 'N/A'}`);
    }
    console.log(`\n  ${$.dim}Use ${$.cyan}commander run "<continue>"${$.reset}${$.dim} to continue execution.${$.reset}\n`);
  } catch (err) {
    console.log(`  ${$.red}Error: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  }
}

// ============================================================================
// 12. commander compensation — Manage durable compensation queue
// ============================================================================

export async function cmdCompensation(args: string[], flags: Record<string, string>): Promise<void> {
  console.log(`
  ${$.cyan}${$.bold}Commander Compensation${$.reset} — Durable Retry Queue
`);

  try {
    const { getCompensationQueue } = await import('../../atr/compensationQueue');
    const queue = getCompensationQueue();

    if (args.length === 0 || args[0] === 'status') {
      const counts = queue.countByStatus();
      console.log(`  ${$.bold}Queue Summary:${$.reset}`);
      console.log(`    ${$.yellow}Pending:${$.reset}     ${counts.pending}`);
      console.log(`    ${$.cyan}In Progress:${$.reset} ${counts.in_progress}`);
      console.log(`    ${$.red}Escalated:${$.reset}   ${counts.escalated}`);
      console.log(`
  ${$.dim}Commands:${$.reset}`);
      console.log(`    ${$.cyan}commander compensation list${$.reset}         ${$.dim}View all queue items${$.reset}`);
      console.log(`    ${$.cyan}commander compensation retry <id>${$.reset}    ${$.dim}Retry an escalated item${$.reset}
`);
      return;
    }

    if (args[0] === 'list') {
      const parsed = parseInt(flags['limit'] ?? '50', 10);
      const limit = isNaN(parsed) ? 50 : parsed;
      const status = flags['status'] as 'pending' | 'in_progress' | 'escalated' | undefined;
      const items = queue.list({ limit, status });
      if (items.length === 0) {
        console.log(`  ${$.dim}No items in the compensation queue.${$.reset}
`);
        return;
      }
      console.log(`  ${$.bold}Compensation Queue Items (${items.length}):${$.reset}
`);
      for (const item of items) {
        const statusIcon = item.status === 'escalated' ? `${$.red}⬆${$.reset}`
          : item.status === 'in_progress' ? `${$.cyan}↻${$.reset}`
          : `${$.yellow}○${$.reset}`;
        const age = getAge(item.enqueuedAt);
        console.log(`    ${statusIcon} ${$.cyan}${item.id}${$.reset}`);
        console.log(`      ${$.dim}Tool:${$.reset} ${item.toolName}  ${$.dim}Run:${$.reset} ${item.runId}`);
        console.log(`      ${$.dim}Attempts:${$.reset} ${item.attemptCount}/${item.maxAttempts}  ${$.dim}Age:${$.reset} ${age}  ${$.dim}Status:${$.reset} ${item.status}`);
        if (item.lastError) console.log(`      ${$.dim}Error:${$.reset} ${item.lastError.slice(0, 100)}`);
        if (item.nextAttemptAt && item.status === 'pending') console.log(`      ${$.dim}Next attempt:${$.reset} ${item.nextAttemptAt}`);
        console.log('');
      }
      return;
    }

    if (args[0] === 'retry' && !args[1]) {
      console.log(`  ${$.red}Missing item ID.${$.reset} Usage: ${$.cyan}commander compensation retry <id>${$.reset}\n`);
      return;
    }

    if (args[0] === 'retry' && args[1]) {
      const id = args[1];
      const ok = queue.retry(id);
      if (ok) {
        console.log(`  ${$.green}✓${$.reset} Item ${$.cyan}${id}${$.reset} reset to pending for immediate retry.
`);
      } else {
        console.log(`  ${$.red}✗${$.reset} Item ${$.cyan}${id}${$.reset} not found or not in escalated status.
`);
      }
      return;
    }

    console.log(`  ${$.yellow}Unknown subcommand: ${args[0]}${$.reset}`);
    console.log(`  ${$.dim}Usage: commander compensation [list|retry <id>|status]${$.reset}
`);
  } catch (err) {
    console.log(`  ${$.red}Error: ${err instanceof Error ? err.message : String(err)}${$.reset}`);
    console.log(`  ${$.dim}Compensation queue requires better-sqlite3.${$.reset}
`);
  }
}

function getAge(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export async function cmdTrace(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Traces${$.reset}\n`);

  try {
    const fs = await import('fs');
    const path = await import('path');

    const traceDir = path.join(process.cwd(), '.commander', 'traces');
    if (!fs.existsSync(traceDir)) {
      console.log(`  ${$.dim}No traces found. Run a task first.${$.reset}\n`);
      return;
    }

    const files = fs.readdirSync(traceDir).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) {
      console.log(`  ${$.dim}No traces found.${$.reset}\n`);
      return;
    }

    console.log(`  ${$.bold}Recent traces:${$.reset}`);
    for (const file of files.slice(-10)) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf-8'));
        const status = data.status === 'success' ? '✅' : data.status === 'failed' ? '❌' : '🔄';
        const duration = data.totalDurationMs ? `${(data.totalDurationMs / 1000).toFixed(1)}s` : '?';
        const tokens = data.totalTokens ? `${data.totalTokens.toLocaleString()} tok` : '?';
        console.log(`    ${status} ${$.bold}${file}${$.reset} [${duration}, ${tokens}]`);
      } catch {
        console.log(`    ${$.dim}${file}${$.reset}`);
      }
    }

    console.log(`\n  ${$.dim}Total: ${files.length} traces${$.reset}`);
    console.log(`  ${$.dim}View OpenTelemetry: ${$.bold}http://localhost:16686${$.reset}${$.dim} (Jaeger)${$.reset}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${$.red}Error: ${msg}${$.reset}`);
    if (msg.includes('better-sqlite3') || msg.includes('Cannot find module')) {
      console.log(`  ${$.dim}Compensation queue requires better-sqlite3. Install: pnpm add better-sqlite3${$.reset}\n`);
    } else {
      console.log(`  ${$.dim}Run ${$.cyan}commander doctor${$.reset}${$.dim} to diagnose.${$.reset}\n`);
    }
  }

  console.log('');
}
