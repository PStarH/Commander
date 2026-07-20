import { $, section, kv } from './_shared';
import { StateCheckpointer } from '../../runtime/stateCheckpointer';

export interface V1RunListItem {
  id: string;
  state: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Gateway API base when enterprise/API mode is active; otherwise null (local SKU).
 * Only COMMANDER_API_URL — never reuse LLM file-config keys (apiBase/apiKey).
 */
export function resolveGatewayApiBase(): string | null {
  const fromEnv = (process.env.COMMANDER_API_URL ?? '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return null;
}

/** Gateway auth: COMMANDER_API_KEY only (not LLM provider apiKey). */
export function resolveGatewayApiKey(): string | undefined {
  const fromEnv = (process.env.COMMANDER_API_KEY ?? '').trim();
  return fromEnv || undefined;
}

export class GatewayListRunsError extends Error {
  readonly status?: number;
  readonly kind: 'http' | 'network' | 'invalid_json';

  constructor(
    message: string,
    options?: { status?: number; kind?: 'http' | 'network' | 'invalid_json' },
  ) {
    super(message);
    this.name = 'GatewayListRunsError';
    this.status = options?.status;
    this.kind = options?.kind ?? 'http';
  }
}

export async function fetchV1Runs(apiBase: string, limit = 50): Promise<V1RunListItem[]> {
  const headers = new Headers({ accept: 'application/json' });
  const apiKey = resolveGatewayApiKey();
  if (apiKey) headers.set('x-api-key', apiKey);

  let response: Response;
  try {
    response = await fetch(`${apiBase}/v1/runs?limit=${limit}`, { headers });
  } catch (err) {
    throw new GatewayListRunsError(
      `Gateway unreachable at ${apiBase}: ${err instanceof Error ? err.message : String(err)}`,
      { kind: 'network' },
    );
  }

  if (!response.ok) {
    const body = await response.text();
    const authHint =
      response.status === 401 || response.status === 403
        ? ' Check COMMANDER_API_KEY.'
        : '';
    throw new GatewayListRunsError(
      `Gateway list runs failed (${response.status}): ${body}${authHint}`,
      { status: response.status, kind: 'http' },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GatewayListRunsError(`Gateway returned non-JSON for ${apiBase}/v1/runs`, {
      status: response.status,
      kind: 'invalid_json',
    });
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { runs?: unknown }).runs)
  ) {
    throw new GatewayListRunsError(`Gateway list runs response missing runs[]`, {
      status: response.status,
      kind: 'invalid_json',
    });
  }

  return (payload as { runs: V1RunListItem[] }).runs;
}

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
      if (isNaN(keep) || keep < 0) {
        console.error(`  ${$.red}Usage:${$.reset} commander history prune <keep-count>\n`);
        return;
      }
      const checkpointer = new StateCheckpointer();
      const before = checkpointer.listCheckpoints().length;
      checkpointer.prune(keep);
      console.log(
        `  ${$.green}✓${$.reset} Pruned to ${$.bold}${keep}${$.reset} sessions (removed ${before - Math.min(keep, before)})\n`,
      );
      return;
    }

    const apiBase = resolveGatewayApiBase();
    if (apiBase) {
      await cmdHistoryFromApi(apiBase);
      return;
    }

    const checkpointer = new StateCheckpointer();
    const entries = checkpointer.listCheckpoints();

    section('SESSION HISTORY');
    console.log(
      `  ${$.dim}Source: local StateCheckpointer (not durable /v1 authority)${$.reset}`,
    );
    if (entries.length === 0) {
      console.log(`  ${$.dim}No saved sessions found.${$.reset}`);
      console.log(
        `  ${$.dim}Run a task first:${$.reset} ${$.cyan}commander run "<task>"${$.reset}\n`,
      );
      return;
    }

    kv('Total', `${entries.length}`, $.cyan);

    for (const entry of entries) {
      const ts = new Date(entry.timestamp).toLocaleString();
      const phaseIcon: Record<string, string> = {
        completed: '✅',
        failed: '❌',
        started: '📋',
        llm_call: '🤖',
        tool_execution: '🔧',
        verification: '🔍',
      };
      const icon = phaseIcon[entry.phase] || '📄';
      const runIdShort = entry.runId.length > 20 ? entry.runId.slice(0, 20) + '…' : entry.runId;
      const statusColor =
        entry.phase === 'completed' ? $.green : entry.phase === 'failed' ? $.red : $.yellow;
      console.log(
        `  ${icon} ${statusColor}${entry.phase.padEnd(14)}${$.reset} ${$.dim}${ts}${$.reset}`,
      );
      console.log(`      ${$.gray}${runIdShort}${$.reset}`);
    }
    console.log(`\n  ${$.dim}View:  commander history view <runId>${$.reset}`);
    console.log(`  ${$.dim}Prune: commander history prune <keep-count>${$.reset}`);
    console.log(`  ${$.dim}Del:   commander history delete <runId>${$.reset}\n`);
  } catch (err) {
    console.error(
      `\n  ${$.red}ERROR${$.reset} Failed to read session history: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof GatewayListRunsError) {
      console.error(
        `  ${$.dim}→ Check COMMANDER_API_URL / COMMANDER_API_KEY and Gateway availability.${$.reset}\n`,
      );
    } else {
      console.error(
        `  ${$.dim}→ Check that .commander/ directory exists and is readable.${$.reset}\n`,
      );
    }
  }
}

async function cmdHistoryFromApi(apiBase: string) {
  const runs = await fetchV1Runs(apiBase);
  section('RUN HISTORY (/v1)');
  console.log(`  ${$.dim}Source: ${apiBase}/v1/runs (durable kernel authority)${$.reset}`);
  if (runs.length === 0) {
    console.log(`  ${$.dim}No runs found for the authenticated tenant.${$.reset}\n`);
    return;
  }

  kv('Total', `${runs.length}`, $.cyan);
  for (const run of runs) {
    const ts = new Date(run.updatedAt).toLocaleString();
    const statusColor =
      run.state === 'SUCCEEDED'
        ? $.green
        : run.state === 'FAILED' || run.state === 'CANCELLED'
          ? $.red
          : $.yellow;
    const runIdShort = run.id.length > 20 ? run.id.slice(0, 20) + '…' : run.id;
    console.log(`  ${statusColor}${run.state.padEnd(14)}${$.reset} ${$.dim}${ts}${$.reset}`);
    console.log(`      ${$.gray}${runIdShort}${$.reset}`);
  }
  console.log(
    `\n  ${$.dim}View/delete/prune remain local-only (StateCheckpointer); use GET /v1/runs/:id for remote status.${$.reset}\n`,
  );
}

export async function cmdHistoryView(runId: string) {
  try {
    const checkpointer = new StateCheckpointer();
    const state = checkpointer.resume(runId);
    if (!state) {
      console.error(`  ${$.red}Session not found:${$.reset} ${runId}\n`);
      console.error(
        `  ${$.dim}Run ${$.cyan}commander history${$.reset}${$.dim} to list available sessions.${$.reset}\n`,
      );
      return;
    }

    section('SESSION DETAIL');
    kv('Run ID', runId, $.cyan);
    kv('Agent', state.agentId);
    kv(
      'Phase',
      state.phase,
      state.phase === 'completed' ? $.green : state.phase === 'failed' ? $.red : $.yellow,
    );
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
    console.error(
      `\n  ${$.red}ERROR${$.reset} Failed to load session: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(`  ${$.dim}The session file may be corrupted or missing.${$.reset}\n`);
  }
}
