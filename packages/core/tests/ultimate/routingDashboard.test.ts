import { describe, it, expect } from 'vitest';
import { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { Socket } from 'net';
import {
  handleRoutingDashboardRequest,
  ROUTING_DASHBOARD_ROUTES,
} from '../../src/observability/routingDashboard';
import { ExplorationEventLog } from '../../src/ultimate/explorationEventLog';
import type { OrchestrationTopology } from '../../src/ultimate/types';

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  writeHead(code: number, headers: Record<string, string> = {}): this {
    this.statusCode = code;
    this.headers = { ...this.headers, ...headers };
    return this;
  }
  end(data?: string): this {
    if (data !== undefined) this.body = data;
    this.emit('finish');
    return this;
  }
}

function fakeRequest(headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  (req as EventEmitter).setMaxListeners(50);
  Object.assign(req, {
    headers,
    method: 'GET',
    url: '/',
    socket: new Socket(),
    setEncoding: () => {},
  });
  return req;
}

function makeEvent(
  overrides: Partial<{
    tenantId: string;
    taskType: string;
    chosenTopology: OrchestrationTopology;
    argmaxTopology: OrchestrationTopology;
    diverged: boolean;
    topCandidates: Array<{ topology: OrchestrationTopology; score: number }>;
  }> = {},
): Parameters<ExplorationEventLog['record']>[0] {
  return {
    tenantId: overrides.tenantId ?? 'tenant-A',
    taskType: overrides.taskType ?? 'CODING',
    chosenTopology: overrides.chosenTopology ?? 'PARALLEL',
    argmaxTopology: overrides.argmaxTopology ?? 'SEQUENTIAL',
    diverged: overrides.diverged ?? false,
    epsilon: 0.05,
    topCandidates: overrides.topCandidates ?? [
      { topology: 'PARALLEL', score: 5 },
      { topology: 'SEQUENTIAL', score: 4 },
    ],
  };
}

describe('routingDashboard HTTP handler', () => {
  it('exports the documented routes', () => {
    expect(ROUTING_DASHBOARD_ROUTES).toContain('GET /api/v1/topology/exploration');
    expect(ROUTING_DASHBOARD_ROUTES).toContain('GET /api/v1/topology/exploration/snapshot');
    expect(ROUTING_DASHBOARD_ROUTES).toContain('GET /api/v1/topology/exploration/events');
    expect(ROUTING_DASHBOARD_ROUTES).toContain('GET /api/v1/topology/exploration/tenants');
    expect(ROUTING_DASHBOARD_ROUTES).toContain('GET /api/v1/topology/exploration/histogram');
  });

  it('returns the full snapshot at the base path', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent());
    log.record(makeEvent({ tenantId: 'B', diverged: true }));

    const res = new FakeResponse();
    const result = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration'],
      '',
    );
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totals.routingCount).toBe(2);
    expect(body.globalStats.lifetimeRoutingCount).toBe(2);
    expect(body.tenants).toHaveLength(2);
    expect(Array.isArray(body.divergenceHistogram)).toBe(true);
    expect(body.divergenceHistogram).toHaveLength(6);
    expect(Array.isArray(body.recentEvents)).toBe(true);
  });

  it('returns the snapshot at the explicit /snapshot sub-route', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent());
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration', 'snapshot'],
      '',
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totals.routingCount).toBe(1);
    expect(body.globalStats).toBeDefined();
  });

  it('returns events at /events sub-route with limit honored', async () => {
    const log = new ExplorationEventLog();
    for (let i = 0; i < 5; i++) log.record(makeEvent({}));
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration', 'events'],
      'limit=2',
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(2);
    expect(body.events).toHaveLength(2);
    expect(body.globalStats).toBeDefined();
  });

  it('returns per-tenant aggregates at /tenants', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'A', diverged: true }));
    log.record(makeEvent({ tenantId: 'B' }));
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration', 'tenants'],
      '',
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(2);
    expect(body.tenants[0]?.tenantId).toBe('A');
    expect(body.tenants[0]?.explorationCount).toBe(1);
  });

  it('returns histogram at /histogram with all 6 buckets', async () => {
    const log = new ExplorationEventLog();
    log.record(
      makeEvent({
        chosenTopology: 'PARALLEL',
        argmaxTopology: 'SEQUENTIAL',
        diverged: true,
        topCandidates: [
          { topology: 'SEQUENTIAL', score: 10 },
          { topology: 'PARALLEL', score: 1 },
        ],
      }),
    );
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration', 'histogram'],
      '',
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.buckets).toHaveLength(6);
    const bucket = body.buckets.find(
      (b: { marginBucket: string; count: number }) => b.marginBucket === '>2.0',
    );
    expect(bucket?.count).toBe(1);
  });

  it('returns 405 for non-GET methods', async () => {
    const log = new ExplorationEventLog();
    const res = new FakeResponse();
    const req = fakeRequest();
    (req as { method: string }).method = 'POST';
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration'],
      '',
    );
    expect(r.status).toBe(405);
    expect(res.statusCode).toBe(405);
  });

  it('returns 404 for unknown sub-routes', async () => {
    const log = new ExplorationEventLog();
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration', 'totally-bogus'],
      '',
    );
    expect(r.status).toBe(404);
  });

  it('returns 400 for invalid since query', async () => {
    const log = new ExplorationEventLog();
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration'],
      'since=not-a-date',
    );
    expect(r.status).toBe(400);
  });

  it('respects tenantId query param when no auth tenant is set', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'B' }));
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration'],
      'tenantId=A',
    );
    const body = JSON.parse(res.body);
    expect(body.recentEvents.every((e: { tenantId: string }) => e.tenantId === 'A')).toBe(true);
    expect(body.totals.routingCount).toBe(1); // filter-aware
    expect(body.globalStats.lifetimeRoutingCount).toBe(2); // process-lifetime
  });

  it('returns 403 when caller asks for a tenant they are not (cross-tenant guard)', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'B' }));
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      {
        eventLog: log,
        resolveTenant: () => 'A',
      },
      ['exploration'],
      'tenantId=B',
    );
    expect(r.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Forbidden');
    expect(body.recentEvents).toBeUndefined();
  });

  it('honors divergedOnly query param', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ diverged: false }));
    log.record(makeEvent({ diverged: true }));
    log.record(makeEvent({ diverged: true }));
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration', 'events'],
      'divergedOnly=true',
    );
    const body = JSON.parse(res.body);
    expect(body.count).toBe(2);
    expect(body.events.every((e: { diverged: boolean }) => e.diverged)).toBe(true);
  });

  it('Content-Type is application/json on success', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent());
    const res = new FakeResponse();
    await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration'],
      '',
    );
    expect(res.headers['Content-Type']).toBe('application/json');
  });

  it('totals are scoped to the auth-tenant (privacy)', async () => {
    const log = new ExplorationEventLog();
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'A' }));
    log.record(makeEvent({ tenantId: 'B' }));
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => 'A' },
      ['exploration'],
      '',
    );
    const body = JSON.parse(res.body);
    expect(r.status).toBe(200);
    expect(body.totals.routingCount).toBe(2); // scoped to A
    expect(body.globalStats.lifetimeRoutingCount).toBe(3); // process-lifetime
  });
});

describe('routingDashboard HTTP handler — ε override (P6)', () => {
  it('exports the new /epsilon routes', () => {
    expect(ROUTING_DASHBOARD_ROUTES).toContain('GET /api/v1/topology/exploration/epsilon');
    expect(ROUTING_DASHBOARD_ROUTES).toContain('PUT /api/v1/topology/exploration/epsilon');
    expect(ROUTING_DASHBOARD_ROUTES).toContain('DELETE /api/v1/topology/exploration/epsilon');
  });

  it('GET /epsilon lists all overrides for an admin caller', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    store.set('A', 0.1);
    store.set('B', 0.2);
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      '',
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(2);
    expect(body.overrides.map((o: { tenantId: string }) => o.tenantId)).toEqual(['A', 'B']);
  });

  it('GET /epsilon?tenantId=X returns a single override', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    store.set('A', 0.1);
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      'tenantId=A',
    );
    const body = JSON.parse(res.body);
    expect(body.override.tenantId).toBe('A');
    expect(body.override.epsilon).toBe(0.1);
  });

  it('GET /epsilon?tenantId=UNKNOWN returns override=null', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      'tenantId=UNKNOWN',
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.override).toBeNull();
  });

  it('GET /epsilon as tenant-A only returns tenant-A override', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    store.set('A', 0.1);
    store.set('B', 0.2);
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => 'A' },
      ['exploration', 'epsilon'],
      '',
    );
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.overrides[0]?.tenantId).toBe('A');
  });

  it('GET /epsilon?tenantId=B returns 403 for tenant-A caller (cross-tenant guard)', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    store.set('B', 0.2);
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => 'A' },
      ['exploration', 'epsilon'],
      'tenantId=B',
    );
    expect(r.status).toBe(403);
  });

  it('PUT /epsilon with JSON body sets the override', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const req = fakeRequest();
    (req as { method: string }).method = 'PUT';
    // Inject a JSON body via the event emitter
    setImmediate(() => {
      req.emit('data', JSON.stringify({ tenantId: 'A', epsilon: 0.1 }));
      req.emit('end');
    });
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      '',
    );
    expect(r.status).toBe(200);
    expect(store.get('A')?.epsilon).toBe(0.1);
  });

  it('PUT /epsilon with query params sets the override', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const req = fakeRequest();
    (req as { method: string }).method = 'PUT';
    setImmediate(() => {
      req.emit('end');
    });
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      'tenantId=A&epsilon=0.2',
    );
    expect(r.status).toBe(200);
    expect(store.get('A')?.epsilon).toBe(0.2);
  });

  it('PUT /epsilon clamps out-of-range values to [0, 1]', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const req = fakeRequest();
    (req as { method: string }).method = 'PUT';
    setImmediate(() => {
      req.emit('data', JSON.stringify({ tenantId: 'A', epsilon: 1.5 }));
      req.emit('end');
    });
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      '',
    );
    expect(r.status).toBe(200);
    expect(store.get('A')?.epsilon).toBe(1);
  });

  it('PUT /epsilon returns 400 when tenantId is missing', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const req = fakeRequest();
    (req as { method: string }).method = 'PUT';
    setImmediate(() => {
      req.emit('data', JSON.stringify({ epsilon: 0.1 }));
      req.emit('end');
    });
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      '',
    );
    expect(r.status).toBe(400);
  });

  it('PUT /epsilon returns 400 when epsilon is missing', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const req = fakeRequest();
    (req as { method: string }).method = 'PUT';
    setImmediate(() => {
      req.emit('data', JSON.stringify({ tenantId: 'A' }));
      req.emit('end');
    });
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      '',
    );
    expect(r.status).toBe(400);
  });

  it('PUT /epsilon returns 403 on cross-tenant set', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const req = fakeRequest();
    (req as { method: string }).method = 'PUT';
    setImmediate(() => {
      req.emit('data', JSON.stringify({ tenantId: 'B', epsilon: 0.1 }));
      req.emit('end');
    });
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => 'A' },
      ['exploration', 'epsilon'],
      '',
    );
    expect(r.status).toBe(403);
  });

  it('DELETE /epsilon clears the override', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    store.set('A', 0.1);
    const req = fakeRequest();
    (req as { method: string }).method = 'DELETE';
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      'tenantId=A',
    );
    expect(r.status).toBe(200);
    expect(store.get('A')).toBeUndefined();
  });

  it('DELETE /epsilon returns 200 with cleared=false when there was nothing to clear', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    const req = fakeRequest();
    (req as { method: string }).method = 'DELETE';
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      'tenantId=A',
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.cleared).toBe(false);
  });

  it('DELETE /epsilon returns 403 on cross-tenant clear', async () => {
    const log = new ExplorationEventLog();
    const store = (
      log as unknown as {
        getEpsilonStore(): import('../../src/ultimate/epsilonStore').EpsilonStore;
      }
    ).getEpsilonStore();
    store.set('B', 0.2);
    const req = fakeRequest();
    (req as { method: string }).method = 'DELETE';
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      req,
      res as unknown as ServerResponse,
      { eventLog: log, epsilonStore: store, resolveTenant: () => 'A' },
      ['exploration', 'epsilon'],
      'tenantId=B',
    );
    expect(r.status).toBe(403);
  });

  it('GET /epsilon returns 503 when no store is injected', async () => {
    const log = new ExplorationEventLog();
    const res = new FakeResponse();
    const r = await handleRoutingDashboardRequest(
      fakeRequest(),
      res as unknown as ServerResponse,
      { eventLog: log, resolveTenant: () => undefined },
      ['exploration', 'epsilon'],
      '',
    );
    expect(r.status).toBe(503);
  });
});
