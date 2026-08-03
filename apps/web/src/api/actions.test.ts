import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionGatewayClient, ActionGatewayError } from './actions';

describe('ActionGatewayClient', () => {
  it('routes every write through /v1/actions with explicit auth and idempotency', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ActionGatewayClient({
      baseUrl: 'https://commander.example/',
      token: 'token-1',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({ action: { runId: 'run-1' }, idempotentReplay: false }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as typeof fetch,
    });

    await client.proposeAction({
      source: 'web',
      package: 'ops',
      model: 'none',
      tool: 'ticket.create',
      destination: 'servicenow://sandbox/incidents',
      effectType: 'connector.servicenow.incident.create',
      args: { title: 'Seat change' },
      idempotencyKey: 'web-action-1',
    });

    assert.equal(calls[0]?.url, 'https://commander.example/v1/actions');
    const headers = new Headers(calls[0]?.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer token-1');
    assert.equal(headers.get('idempotency-key'), 'web-action-1');
  });

  it('preserves status and stable gateway error code', async () => {
    const client = new ActionGatewayClient({
      token: 'token-1',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: { code: 'OPERATIONS_NOT_READY', message: 'closed' } }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        )) as typeof fetch,
    });

    await assert.rejects(
      client.getAction('run-1'),
      (error: unknown) =>
        error instanceof ActionGatewayError &&
        error.status === 503 &&
        error.code === 'OPERATIONS_NOT_READY',
    );
  });

  it('sends an explicit idempotency key for every action write', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ActionGatewayClient({
      baseUrl: 'https://commander.example',
      token: 'token-1',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        const body = String(url).endsWith('/reconcile')
          ? {
              scheduled: true,
              effectId: 'effect-1',
              state: 'COMPLETION_UNKNOWN',
              reconcileAfter: '2026-07-29T08:30:00.000Z',
              alreadyScheduled: false,
            }
          : String(url).includes('/kill-switches/')
            ? {
                killSwitch: {
                  tenantId: 'tenant-1',
                  scope: 'tool',
                  value: 'ticket.create',
                  enabled: true,
                  actor: 'operator-1',
                  updatedAt: '2026-07-29T08:00:00.000Z',
                },
              }
            : { action: { runId: 'run-1' } };
        return new Response(JSON.stringify(body), {
          status: String(url).endsWith('/reconcile') ? 202 : 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    await client.approveAction(
      'run-1',
      { actionDigest: 'a'.repeat(64), simulationId: 'sim-1', policySnapshotId: 'policy-1' },
      'approve-1',
    );
    await client.rejectAction('run-1', undefined, 'reject-1');
    await client.reconcileAction('run-1', 'reconcile-1');
    await client.setKillSwitch({ scope: 'tool', value: 'ticket.create', enabled: true }, 'kill-1');

    assert.deepEqual(
      calls.map(({ init }) => new Headers(init.headers).get('idempotency-key')),
      ['approve-1', 'reject-1', 'reconcile-1', 'kill-1'],
    );
  });

  it('preserves the canonical evidence verification result', async () => {
    const evidence = {
      receipt: { bundleId: 'bundle-1', scope: { runId: 'run-1' } },
      verification: { ok: true },
    };
    const client = new ActionGatewayClient({
      token: 'token-1',
      fetchImpl: (async () =>
        new Response(JSON.stringify(evidence), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });

    assert.deepEqual(await client.getActionEvidence('run-1'), evidence);
  });

  it('routes compensation request and approval through the gateway', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ActionGatewayClient({
      baseUrl: 'https://commander.example',
      token: 'token-1',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ state: 'AWAITING_APPROVAL' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    const input = {
      originalEffectId: 'effect-1',
      adapterVersion: 'demo.adapter.v1',
      compensationEffectType: 'compensate.demo.ticket.create',
      compensationPatch: { ticketId: 'ticket-1' },
      forwardReceiptHash: 'a'.repeat(64),
    };

    await client.requestCompensation('run-1', input, 'compensation-request-1');
    await client.approveCompensation(
      'run-1',
      'authorization-1',
      { actionDigest: 'b'.repeat(64), policySnapshotId: 'policy-1' },
      'compensation-approve-1',
    );

    assert.deepEqual(
      calls.map(({ url }) => url),
      [
        'https://commander.example/v1/actions/run-1/compensations',
        'https://commander.example/v1/actions/run-1/compensations/authorization-1/approve',
      ],
    );
    assert.deepEqual(
      calls.map(({ init }) => new Headers(init.headers).get('idempotency-key')),
      ['compensation-request-1', 'compensation-approve-1'],
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input);
  });
});
