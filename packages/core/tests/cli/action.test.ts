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
    const fetchMock = vi.fn(async () =>
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
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          killSwitch: { scope: 'tool', value: 'ticket.create', enabled: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await cmdAction(
      ['kill', 'enable', 'tool', 'ticket.create', '--reason=maintenance'],
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
  });

  it('disables a kill switch via PUT with enabled=false', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          killSwitch: { scope: 'tool', value: 'ticket.create', enabled: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await cmdAction(['kill', 'disable', 'tool', 'ticket.create'], {}, {
      fetchImpl: fetchMock as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/actions/kill-switches/tool/ticket.create',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it('exits non-zero when the API returns an error', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    await expect(
      cmdAction(['kill', 'list'], {}, { fetchImpl: fetchMock as typeof fetch, exit: exit as never }),
    ).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
