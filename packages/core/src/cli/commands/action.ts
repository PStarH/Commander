/**
 * commander action — Governed Action Gateway operations (L4-04).
 *
 * Usage:
 *   commander action kill list
 *   commander action kill enable <scope> <value> [--reason=...]
 *   commander action kill disable <scope> <value> [--reason=...]
 */
import { parseFlags } from '../util';

export interface ActionApiConfig {
  baseUrl: string;
  apiKey: string;
}

export function resolveActionApiConfig(env: NodeJS.ProcessEnv = process.env): ActionApiConfig {
  const baseUrl = (env.COMMANDER_API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
  const apiKey = env.COMMANDER_API_KEY?.trim() ?? '';
  if (!apiKey) {
    throw new Error('COMMANDER_API_KEY is required for commander action commands.');
  }
  return { baseUrl, apiKey };
}

export async function actionApiFetch(
  path: string,
  init: RequestInit,
  config: ActionApiConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  headers.set('authorization', `Bearer ${config.apiKey}`);
  return fetchImpl(`${config.baseUrl}${path}`, { ...init, headers });
}

async function killList(
  config: ActionApiConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await actionApiFetch('/v1/actions/kill-switches', { method: 'GET' }, config, fetchImpl);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kill switch list failed (${response.status}): ${body}`);
  }
  const payload = (await response.json()) as { killSwitches: Array<Record<string, unknown>> };
  if (payload.killSwitches.length === 0) {
    console.log('No kill switches configured.');
    return;
  }
  for (const entry of payload.killSwitches) {
    console.log(
      `${entry.scope}\t${entry.value}\t${entry.enabled ? 'enabled' : 'disabled'}\t${entry.reason ?? ''}`,
    );
  }
}

async function killSet(
  config: ActionApiConfig,
  fetchImpl: typeof fetch,
  scope: string,
  value: string,
  enabled: boolean,
  reason?: string,
): Promise<void> {
  const response = await actionApiFetch(
    `/v1/actions/kill-switches/${encodeURIComponent(scope)}/${encodeURIComponent(value)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ enabled, ...(reason ? { reason } : {}) }),
    },
    config,
    fetchImpl,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kill switch update failed (${response.status}): ${body}`);
  }
  const payload = (await response.json()) as { killSwitch: Record<string, unknown> };
  console.log(
    `Kill switch ${payload.killSwitch.scope}/${payload.killSwitch.value} is now ${
      payload.killSwitch.enabled ? 'enabled' : 'disabled'
    }.`,
  );
}

export async function cmdAction(
  args: string[],
  flags: Record<string, string> = {},
  deps: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    exit?: (code: number) => never;
  } = {},
): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const parsed = parseFlags(args);
  const subcommand = parsed.positional[0];
  const rest = parsed.positional.slice(1);
  const mergedFlags = { ...parsed.flags, ...flags };

  if (subcommand !== 'kill') {
    console.error('Usage: commander action kill list|enable|disable');
    exit(1);
  }

  const action = rest[0];
  if (!action) {
    console.error('Usage: commander action kill list|enable|disable');
    exit(1);
  }

  let config: ActionApiConfig | undefined;
  try {
    config = resolveActionApiConfig(deps.env);
  } catch (error) {
    console.error((error as Error).message);
    exit(1);
  }

  try {
    if (action === 'list') {
      await killList(config!, fetchImpl);
      return;
    }
    if (action === 'enable' || action === 'disable') {
      const scope = rest[1];
      const value = rest[2];
      if (!scope || !value) {
        console.error(`Usage: commander action kill ${action} <scope> <value> [--reason=...]`);
        exit(1);
      }
      await killSet(config!, fetchImpl, scope, value, action === 'enable', mergedFlags.reason);
      return;
    }
    console.error('Usage: commander action kill list|enable|disable');
    exit(1);
  } catch (error) {
    console.error((error as Error).message);
    exit(1);
  }
}
