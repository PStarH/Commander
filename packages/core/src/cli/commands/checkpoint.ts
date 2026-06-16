/**
 * CLI: commander checkpoint — MiMo-style checkpoint writer interface.
 *
 *  commander checkpoint              List all checkpoint files
 *  commander checkpoint <runId>      View a specific checkpoint (formatted)
 *  commander checkpoint --prune N    Keep only the N newest checkpoints
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCheckpointWriter } from '../../runtime/checkpointWriter';

export async function cmdCheckpoint(args: string[]): Promise<void> {
  const writer = getCheckpointWriter();
  const $ = {
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    reset: '\x1b[0m',
  };

  const runId = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const pruneIdx = args.indexOf('--prune');
  const pruneCount = pruneIdx >= 0 && args[pruneIdx + 1] ? parseInt(args[pruneIdx + 1], 10) : null;

  // --prune: keep only the N newest checkpoints
  if (pruneCount !== null && !isNaN(pruneCount)) {
    const all = writer.listCheckpoints();
    if (all.length <= pruneCount) {
      console.log(`  Only ${all.length} checkpoints — nothing to prune (keep=${pruneCount})`);
      return;
    }
    const toDelete = all.slice(pruneCount);
    for (const cp of toDelete) {
      writer.deleteCheckpoints(cp.runId);
    }
    console.log(
      `  ${$.green}✓${$.reset} Pruned ${toDelete.length} old checkpoints (kept ${pruneCount} newest)`,
    );
    return;
  }

  // View a specific checkpoint
  if (runId) {
    const doc = writer.loadCheckpoint(runId);
    if (!doc) {
      console.log(`  ${$.red}✗${$.reset} No checkpoint found for run ${$.cyan}${runId}${$.reset}`);
      return;
    }

    console.log(`\n${$.bold}Checkpoint — ${runId}${$.reset}\n`);
    console.log(`  ${$.bold}Version:${$.reset}     ${doc.version}`);
    console.log(
      `  ${$.bold}Trigger:${$.reset}     ${doc.triggerPercent > 0 ? `${doc.triggerPercent}%` : 'manual'}`,
    );
    console.log(`  ${$.bold}Timestamp:${$.reset}   ${doc.timestamp}`);
    console.log(`  ${$.bold}Phase:${$.reset}       ${doc.phase}`);
    console.log(`  ${$.bold}Step:${$.reset}        ${doc.stepNumber}`);
    console.log(``);
    console.log(`  ${$.bold}Goal:${$.reset}        ${doc.goal.slice(0, 120)}`);
    console.log(``);

    // Progress bar
    const completedColor = doc.completedSubtasks.length > 0 ? $.green : $.dim;
    const pendingColor = doc.pendingSubtasks.length > 0 ? $.yellow : $.dim;
    const failedColor = doc.failedSubtasks.length > 0 ? $.red : $.dim;

    console.log(`  ${completedColor}✓ Completed:${$.reset} ${doc.completedSubtasks.length}`);
    for (const s of doc.completedSubtasks.slice(0, 5)) {
      console.log(`    - ${s.id}: ${s.goal.slice(0, 80)}`);
    }
    if (doc.completedSubtasks.length > 5) {
      console.log(`    ${$.dim}... and ${doc.completedSubtasks.length - 5} more${$.reset}`);
    }

    console.log(`  ${pendingColor}⏳ Pending:${$.reset}   ${doc.pendingSubtasks.length}`);
    for (const s of doc.pendingSubtasks.slice(0, 3)) {
      console.log(`    - ${s.id}: ${s.goal.slice(0, 80)}`);
    }

    console.log(`  ${failedColor}✗ Failed:${$.reset}    ${doc.failedSubtasks.length}`);
    for (const s of doc.failedSubtasks.slice(0, 3)) {
      console.log(`    - ${s.id}: ${s.goal.slice(0, 80)}`);
    }

    // Token budget bar
    const budgetPct = doc.budgetHardCap > 0 ? (doc.tokensUsed / doc.budgetHardCap) * 100 : 0;
    const barWidth = 30;
    const filled = Math.min(barWidth, Math.round((budgetPct / 100) * barWidth));
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const budgetColor = budgetPct > 90 ? $.red : budgetPct > 70 ? $.yellow : $.green;

    console.log(``);
    console.log(
      `  ${$.bold}Token Budget:${$.reset}  ${budgetColor}${bar}${$.reset} ${budgetPct.toFixed(0)}%`,
    );
    console.log(
      `                  ${doc.tokensUsed.toLocaleString()} / ${doc.budgetHardCap.toLocaleString()} tokens`,
    );

    if (doc.keyDecisions.length > 0) {
      console.log(``);
      console.log(`  ${$.bold}Key Decisions:${$.reset}`);
      for (const d of doc.keyDecisions.slice(0, 5)) {
        console.log(`    • ${d}`);
      }
    }

    if (doc.errors.length > 0) {
      console.log(``);
      console.log(`  ${$.bold}Errors:${$.reset}`);
      for (const e of doc.errors.slice(0, 5)) {
        const icon = e.recovered ? $.yellow + '↻' : $.red + '✗';
        console.log(`    ${icon}${$.reset} [${e.nodeId}] ${e.message.slice(0, 120)}`);
      }
    }

    console.log(``);
    console.log(`  ${$.bold}Next Action:${$.reset}  ${doc.nextAction}`);
    console.log(``);

    // Show file path
    const filePath = path.join(process.cwd(), '.commander', 'memory', 'checkpoints', `${runId}.md`);
    console.log(`  ${$.dim}Full file: ${filePath}${$.reset}`);
    console.log(``);
    return;
  }

  // List all checkpoints
  const checkpoints = writer.listCheckpoints();

  if (checkpoints.length === 0) {
    console.log(
      `  ${$.dim}No checkpoints yet. Checkpoints are written automatically during execution at 20%, 45%, and 70% token budget.${$.reset}`,
    );
    return;
  }

  console.log(`\n${$.bold}Checkpoints (${checkpoints.length})${$.reset}\n`);

  for (const cp of checkpoints) {
    const doc = writer.loadCheckpoint(cp.runId);
    const triggerPct = doc?.triggerPercent ?? 0;
    const triggerLabel = triggerPct > 0 ? `${triggerPct}%` : 'manual';
    const completedCount = doc?.completedSubtasks.length ?? 0;
    const pendingCount = doc?.pendingSubtasks.length ?? 0;
    const failedCount = doc?.failedSubtasks.length ?? 0;
    const tokensUsed = doc?.tokensUsed ?? 0;
    const budgetHardCap = doc?.budgetHardCap ?? 0;

    const progressBar = buildMiniBar(completedCount, pendingCount, failedCount);
    const budgetBar =
      budgetHardCap > 0 ? ` [${Math.round((tokensUsed / budgetHardCap) * 100)}% budget]` : '';

    console.log(`  ${$.cyan}${cp.runId.slice(0, 32)}${$.reset}`);
    console.log(
      `    Trigger: ${triggerLabel} | ${progressBar} | v${doc?.version ?? '?'}${budgetBar}`,
    );
    console.log(`    Written: ${cp.modifiedAt} | ${(cp.size / 1024).toFixed(1)}KB`);
    console.log(``);
  }
}

function buildMiniBar(completed: number, pending: number, failed: number): string {
  const $ = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  };
  const total = completed + pending + failed;
  if (total === 0) return 'no tasks';
  const parts: string[] = [];
  if (completed > 0) parts.push($.green(`✓${completed}`));
  if (pending > 0) parts.push($.yellow(`⏳${pending}`));
  if (failed > 0) parts.push($.red(`✗${failed}`));
  return parts.join(' ');
}
