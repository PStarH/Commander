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

/**
 * commander intelligence — Show intelligence data
 */
export async function cmdIntelligence(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Intelligence${$.reset}\n`);

  try {
    const { getCostPredictor } = await import('../../intelligence/costPredictor');
    const { getFailurePatternLearner } = await import('../../intelligence/failurePatterns');
    const { getSkillExtractor } = await import('../../intelligence/skillExtractor');

    // Cost history
    const costPredictor = getCostPredictor();
    console.log(`  ${$.bold}成本预测:${$.reset} 已学习历史数据`);

    // Failure patterns
    const failureLearner = getFailurePatternLearner();
    const patterns = failureLearner.getPatterns();
    if (patterns.length > 0) {
      console.log(`\n  ${$.bold}失败模式 (${patterns.length}):${$.reset}`);
      for (const pattern of patterns.slice(0, 5)) {
        const icon = pattern.occurrences.length >= 5 ? '🔴' : pattern.occurrences.length >= 3 ? '🟡' : '🟢';
        console.log(`    ${icon} ${pattern.description} (${pattern.occurrences.length}次)`);
      }
    } else {
      console.log(`\n  ${$.dim}失败模式: 暂无数据${$.reset}`);
    }

    // Extracted skills
    const skillExtractor = getSkillExtractor();
    const skills = skillExtractor.getSkills();
    if (skills.length > 0) {
      console.log(`\n  ${$.bold}已学技能 (${skills.length}):${$.reset}`);
      for (const skill of skills.slice(0, 5)) {
        console.log(`    💡 ${skill.name} (使用${skill.usageCount}次, 成功率${(skill.successRate * 100).toFixed(0)}%)`);
      }
    } else {
      console.log(`\n  ${$.dim}已学技能: 暂无数据${$.reset}`);
    }
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

/**
 * commander trace — View execution traces
 */
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
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}
