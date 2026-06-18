/**
 * commander budget — Token budget visibility
 *
 * Usage:
 *   commander budget                   List active budgets
 *   commander budget <runId>           Detailed budget breakdown for a run
 */
import { getTokenBudgetManager } from '../../runtime/tokenBudgetManager';
import type { RunBudgetStatus, SubAgentAllocation } from '../../runtime/tokenBudgetManager';

function kv(key: string, value: string): string {
  return `  ${key.padEnd(20)} ${value}`;
}

function section(title: string): string {
  return `\n  ┌─ ${title}`;
}

function barChart(used: number, total: number, width = 30): string {
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = total > 0 ? Math.round(ratio * 100) : 0;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}% (${used.toLocaleString()} / ${total.toLocaleString()})`;
}

function phaseLabel(phase: RunBudgetStatus['phase']): string {
  const labels: Record<RunBudgetStatus['phase'], string> = {
    relaxed: '🟢 Relaxed',
    moderate: '🟡 Moderate',
    tight: '🟠 Tight',
    critical: '🔴 Critical',
    exceeded: '⛔ Exceeded',
  };
  return labels[phase] || phase;
}

export async function cmdBudget(args: string[], _flags: Record<string, string>): Promise<void> {
  const bm = getTokenBudgetManager();
  const runId = args[0];

  if (runId) {
    // Show detailed breakdown for a specific run
    const status = bm.getRunStatus(runId);
    if (!status) {
      console.log(`No budget found for run: ${runId}`);
      return;
    }
    console.log(renderDetailedStatus(status));
  } else {
    // List all active budgets
    const budgets = bm.getActiveBudgets();
    if (budgets.length === 0) {
      console.log('No active token budgets.');
      console.log(`\nRun a task with 'commander run "<goal>"' to see budget tracking.`);
      return;
    }
    console.log(`Token Budgets (${budgets.length} active)\n`);
    for (const status of budgets) {
      console.log(renderSummary(status));
    }
  }
}

function renderSummary(status: RunBudgetStatus): string {
  const lines: string[] = [];
  lines.push(`  ${status.runId.slice(0, 16)}...  ${phaseLabel(status.phase)}`);
  lines.push(`    ${barChart(status.usedTokens, status.totalBudget, 40)}`);
  if (status.subAgents.length > 0) {
    lines.push(
      `    ${status.subAgents.length} sub-agents, ${status.subAgents.filter((a) => a.hardCapExceeded).length} over budget`,
    );
  }
  return lines.join('\n');
}

function renderDetailedStatus(status: RunBudgetStatus): string {
  const lines: string[] = [];
  lines.push(`\nToken Budget: ${status.runId}`);
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(kv('Status', phaseLabel(status.phase)));
  lines.push(kv('Total Budget', status.totalBudget.toLocaleString()));
  lines.push(kv('Used', status.usedTokens.toLocaleString()));
  lines.push(kv('Remaining', status.remainingTokens.toLocaleString()));
  lines.push(kv('Utilization', `${status.utilizationPercent}%`));
  lines.push(
    kv(
      'Soft Cap',
      `${status.softCap.toLocaleString()} (${Math.round((status.softCap / status.totalBudget) * 100)}% of total)`,
    ),
  );
  lines.push('');
  lines.push(kv('Created', new Date(status.createdAt).toLocaleString()));
  lines.push(kv('Updated', new Date(status.updatedAt).toLocaleString()));
  lines.push('');
  lines.push(`  ${barChart(status.usedTokens, status.totalBudget, 50)}`);

  if (status.subAgents.length > 0) {
    lines.push(section(`Sub-Agents (${status.subAgents.length})`));
    for (const agent of status.subAgents) {
      const icon = agent.hardCapExceeded
        ? '⚠️ '
        : agent.status === 'completed'
          ? '✅'
          : agent.status === 'running'
            ? '🔄'
            : '⏳';
      lines.push(`  ${icon} ${agent.nodeId.slice(0, 40)}`);
      lines.push(
        `    Budget: ${agent.allocatedBudget.toLocaleString()} → Used: ${agent.usedTokens.toLocaleString()} (${agent.allocatedBudget > 0 ? Math.round((agent.usedTokens / agent.allocatedBudget) * 100) : 0}%)`,
      );
      if (agent.hardCapExceeded) {
        lines.push(
          `    ⚠️  OVER BUDGET by ${(agent.usedTokens - agent.allocatedBudget).toLocaleString()} tokens`,
        );
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}
