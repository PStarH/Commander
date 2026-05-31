import { $, section, kv } from './_shared';
import { StateCheckpointer } from '../../runtime/stateCheckpointer';

export async function cmdHistory(subargs: string[]) {
  try {
    if (subargs[0] === 'view' && subargs[1]) {
      return cmdHistoryView(subargs[1]);
    }
    if (subargs[0] === 'delete' && subargs[1]) {
      const checkpointer = new StateCheckpointer();
      checkpointer.deleteCheckpoint(subargs[1]);
      console.log(`  ${$.green}✓${$.reset} Deleted session ${$.bold}${subargs[1]}${$.reset}\n`);
      return;
    }
    if (subargs[0] === 'prune' && subargs[1]) {
      const keep = parseInt(subargs[1], 10);
      if (isNaN(keep) || keep < 0) { console.error(`  ${$.red}Usage:${$.reset} commander history prune <keep-count>\n`); return; }
      const checkpointer = new StateCheckpointer();
      const before = checkpointer.listCheckpoints().length;
      checkpointer.prune(keep);
      console.log(`  ${$.green}✓${$.reset} Pruned to ${$.bold}${keep}${$.reset} sessions (removed ${before - Math.min(keep, before)})\n`);
      return;
    }

    const checkpointer = new StateCheckpointer();
    const entries = checkpointer.listCheckpoints();

  section('SESSION HISTORY');
  if (entries.length === 0) {
    console.log(`  ${$.dim}No saved sessions found.${$.reset}`);
    console.log(`  ${$.dim}Run a task first:${$.reset} ${$.cyan}commander run "<task>"${$.reset}\n`);
    return;
  }

  kv('Total', `${entries.length}`, $.cyan);

  for (const entry of entries) {
    const ts = new Date(entry.timestamp).toLocaleString();
    const phaseIcon: Record<string, string> = {
      completed: '✅', failed: '❌', started: '📋',
      llm_call: '🤖', tool_execution: '🔧', verification: '🔍',
    };
    const icon = phaseIcon[entry.phase] || '📄';
    const runIdShort = entry.runId.length > 20 ? entry.runId.slice(0, 20) + '…' : entry.runId;
    const statusColor = entry.phase === 'completed' ? $.green : entry.phase === 'failed' ? $.red : $.yellow;
    console.log(`  ${icon} ${statusColor}${entry.phase.padEnd(14)}${$.reset} ${$.dim}${ts}${$.reset}`);
    console.log(`      ${$.gray}${runIdShort}${$.reset}`);
  }
  console.log(`\n  ${$.dim}View:  commander history view <runId>${$.reset}`);
  console.log(`  ${$.dim}Prune: commander history prune <keep-count>${$.reset}`);
  console.log(`  ${$.dim}Del:   commander history delete <runId>${$.reset}\n`);
  } catch (err) {
    console.error(`\n  ${$.red}ERROR${$.reset} Failed to read session history: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  ${$.dim}→ Check that .commander/ directory exists and is readable.${$.reset}\n`);
  }
}

export async function cmdHistoryView(runId: string) {
  try {
    const checkpointer = new StateCheckpointer();
    const state = checkpointer.resume(runId);
    if (!state) {
      console.error(`  ${$.red}Session not found:${$.reset} ${runId}\n`);
      console.error(`  ${$.dim}Run ${$.cyan}commander history${$.reset}${$.dim} to list available sessions.${$.reset}\n`);
      return;
    }

  section('SESSION DETAIL');
  kv('Run ID', runId, $.cyan);
  kv('Agent', state.agentId);
  kv('Phase', state.phase, state.phase === 'completed' ? $.green : state.phase === 'failed' ? $.red : $.yellow);
  kv('Goal', state.context.goal.slice(0, 120));
  kv('Steps', `${state.stepNumber}`, $.yellow);
  kv('Tokens', `${state.tokenUsage.totalTokens?.toLocaleString() ?? 'N/A'}`, $.yellow);
  kv('Duration', `${(state.totalDurationMs / 1000).toFixed(1)}s`);
  kv('Timestamp', new Date(state.timestamp).toLocaleString());
  if (state.lastError) {
    kv('Error', state.lastError.slice(0, 200), $.red);
  }
  if (state.context.availableTools.length > 0) {
    kv('Tools', state.context.availableTools.slice(0, 8).join(', '));
  }
  console.log();
  } catch (err) {
    console.error(`\n  ${$.red}ERROR${$.reset} Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  ${$.dim}The session file may be corrupted or missing.${$.reset}\n`);
  }
}
