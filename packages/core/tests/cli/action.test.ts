import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAction, resolveActionApiConfig } from '../../src/cli/commands/action';

describe('commander action kill CLI', () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.COMMANDER_API_KEY;
  const originalApiUrl = process.env.COMMANDER_API_URL;

  beforeEach(() => {
    process.env.COMMANDER_API_KEY = 'test-api-key';
    process.env.COMMANDER_API_URL = 'http://127.0.0.1:4000';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.COMMANDER_API_KEY;
    else process.env.COMMANDER_API_KEY = originalApiKey;
    if (originalApiUrl === undefined) delete process.env.COMMANDER_API_URL;
    else process.env.COMMANDER_API_URL = originalApiUrl;
  });

  it('requires COMMANDER_API_KEY', () => {
    delete process.env.COMMANDER_API_KEY;
    expect(() => resolveActionApiConfig()).toThrow(/COMMANDER_API_KEY/);
  });

  it('lists kill switches via GET /v1/actions/kill-switches', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            killSwitches: [
              {
                scope: 'tool',
                value: 'ticket.create',
                enabled: true,
                reason: 'maintenance',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdAction(['kill', 'list'], {}, { fetchImpl: fetchMock as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4000/v1/actions/kill-switches');
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(headers.get('authorization')).toBe('Bearer test-api-key');
    expect(requestInit.method).toBe('GET');
    expect(log).toHaveBeenCalledWith('tool\tticket.create\tenabled\tmaintenance');
  });

  it('enables a kill switch via PUT /v1/actions/kill-switches/:scope/:value', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            killSwitch: { scope: 'tool', value: 'ticket.create', enabled: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await cmdAction(
      ['kill', 'enable', 'tool', 'ticket.create', '--reason=maintenance', '--idempotency-key=kill-1'],
      {},
      { fetchImpl: fetchMock as typeof fetch },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/actions/kill-switches/tool/ticket.create',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: true, reason: 'maintenance' }),
      }),
    );
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get('idempotency-key')).toBe('kill-1');
  });

  it('disables a kill switch via PUT with enabled=false', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            killSwitch: { scope: 'tool', value: 'ticket.create', enabled: false },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await cmdAction(
      ['kill', 'disable', 'tool', 'ticket.create', '--idempotency-key=kill-2'],
      {},
      {
        fetchImpl: fetchMock as typeof fetch,
      },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/actions/kill-switches/tool/ticket.create',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get('idempotency-key')).toBe('kill-2');
  });

  it('exits non-zero when the API returns an error', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    await expect(
      cmdAction(
        ['kill', 'list'],
        {},
        { fetchImpl: fetchMock as typeof fetch, exit: exit as never },
      ),
    ).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('commander action gateway CLI', () => {
  const env = {
    COMMANDER_API_KEY: 'test-api-key',
    COMMANDER_API_URL: 'http://127.0.0.1:4000',
  };

  const proposal = {
    source: 'cli',
    package: 'ops',
    model: 'none',
    tool: 'ticket.create',
    destination: 'servicenow://sandbox/incidents',
    effectType: 'connector.servicenow.incident.create',
    args: { title: 'Seat change' },
    idempotencyKey: 'cli-proposal-1',
  };

  it.each([
    { args: ['simulate', `--data=${JSON.stringify(proposal)}`], method: 'POST', path: '/v1/actions/simulate' },
    { args: ['propose', `--data=${JSON.stringify(proposal)}`], method: 'POST', path: '/v1/actions' },
    { args: ['get', 'run-1'], method: 'GET', path: '/v1/actions/run-1' },
    {
      args: [
        'approve',
        'run-1',
        '--idempotency-key=approve-1',
        `--data=${JSON.stringify({ actionDigest: 'a'.repeat(64), simulationId: 'sim-1', policySnapshotId: 'policy-1' })}`,
      ],
      method: 'POST',
      path: '/v1/actions/run-1/approve',
    },
    { args: ['reject', 'run-1', '--reason=unsafe', '--idempotency-key=reject-1'], method: 'POST', path: '/v1/actions/run-1/reject' },
    { args: ['reconcile', 'run-1', '--idempotency-key=reconcile-1'], method: 'POST', path: '/v1/actions/run-1/reconcile' },
    { args: ['evidence', 'verify', 'run-1'], method: 'GET', path: '/v1/actions/run-1/evidence' },
  ])('routes $args through the action gateway', async ({ args, method, path }) => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ verification: { ok: true } }), {
          status: path.endsWith('/reconcile') ? 202 : 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmdAction([...args, '--json'], {}, { env, fetchImpl: fetchMock as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:4000${path}`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe(method);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-api-key');
    if (method === 'POST') {
      const expected =
        args[0] === 'simulate' || args[0] === 'propose'
          ? proposal.idempotencyKey
          : args.find((arg) => arg.startsWith('--idempotency-key='))?.split('=')[1];
      expect(new Headers(init.headers).get('idempotency-key')).toBe(expected);
    }
  });

  it('exits 1 when canonical evidence verification is invalid', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ verification: { ok: false, reason: 'hash mismatch' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      cmdAction(
        ['evidence', 'verify', 'run-1', '--json'],
        {},
        { env, fetchImpl: fetchMock as typeof fetch, exit: exit as never },
      ),
    ).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uses exit 2 for invalid local input and exit 1 for gateway failure', async () => {
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    await expect(
      cmdAction(['propose', '--data={'], {}, { env, exit: exit as never }),
    ).rejects.toThrow('exit:2');

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'ACTION_POLICY_DENIED' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      cmdAction(['get', 'run-1'], {}, { env, fetchImpl: fetchMock as typeof fetch, exit: exit as never }),
    ).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(2);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
