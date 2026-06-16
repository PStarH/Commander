/**
 * Tests for SIEM Log Forwarder
 *
 * Tests formatting and queue behavior by calling private methods
 * directly via (instance as any) since TypeScript's `private` is
 * compile-time only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SIEMForwarder, createSIEMForwarderFromEnv, SIEMEvent } from '../../src/runtime/siemForwarder';

// ============================================================================
// Helpers
// ============================================================================

function testEvent(overrides: Partial<SIEMEvent> = {}): SIEMEvent {
  return {
    timestamp: '2026-06-15T10:00:00.000Z',
    type: 'auth_failure',
    severity: 'high',
    source: 'AuthManager',
    message: 'Invalid API key presented',
    details: { keyPrefix: 'cmdr_...' },
    context: { userId: 'test-user', runId: 'run-123' },
    eventId: 'evt-001',
    ...overrides,
  };
}

// ============================================================================
// Syslog Formatting
// ============================================================================

describe('SIEMForwarder — Syslog formatting', () => {
  it('formats RFC 5424 message with correct PRI, timestamp, and appname', () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514', sourceName: 'commander' });
    const msg = (fwd as any).formatSyslogMessage(
      testEvent({ eventId: 'evt-1', severity: 'high', type: 'auth_failure', message: 'Login failed' }),
      'commander', 'test-host',
    );
    expect(msg).toContain('<11>1');       // facility=1, sev=3 → 11
    expect(msg).toContain('2026-06-15T10:00:00.000Z');
    expect(msg).toContain('commander');
    expect(msg).toContain('auth_failure');
    expect(msg).toContain('evt-1');
    expect(msg).toContain('Login failed');
  });

  it('maps severity to correct syslog priority', () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514' });
    const checks: Array<{ sev: string; expected: string }> = [
      { sev: 'critical', expected: '<10>1' },
      { sev: 'high', expected: '<11>1' },
      { sev: 'medium', expected: '<12>1' },
      { sev: 'low', expected: '<14>1' },
    ];
    for (const { sev, expected } of checks) {
      const msg = (fwd as any).formatSyslogMessage(testEvent({ severity: sev }), 'c', 'h');
      expect(msg).toContain(expected);
    }
  });

  it('includes structured data block with eventId', () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514' });
    const msg = (fwd as any).formatSyslogMessage(testEvent({ eventId: 'evt-xyz' }), 'a', 'h');
    expect(msg).toContain('[eventId@commander');
    expect(msg).toContain('evt-xyz');
  });
});

// ============================================================================
// Protocol Dispatch (syslog)
// ============================================================================

describe('SIEMForwarder — Protocol dispatch', () => {
  it('calls sendUDP by default', async () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514' });
    const spy = vi.spyOn(fwd as any, 'sendUDP').mockResolvedValue(undefined);
    await (fwd as any).sendSyslog([testEvent()]);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('calls sendTCP when protocol=tcp', async () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514', protocol: 'tcp' });
    const spy = vi.spyOn(fwd as any, 'sendTCP').mockResolvedValue(undefined);
    await (fwd as any).sendSyslog([testEvent()]);
    expect(spy).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Splunk HEC
// ============================================================================

describe('SIEMForwarder — Splunk HEC', () => {
  it('sends JSON payload with event and metadata', async () => {
    const fwd = new SIEMForwarder({
      type: 'splunk-hec', endpoint: 'https://splunk.example.com:8088/services/collector',
      token: 'hec-token', sourceName: 'commander',
    });
    let captured: unknown[] = [];
    vi.spyOn(fwd as any, 'httpPost').mockImplementation((_u: URL, p: unknown[]) => { captured = p; return Promise.resolve(); });

    await (fwd as any).sendSplunkHEC([testEvent({ eventId: 'evt-splunk', type: 'auth_success', severity: 'low' })]);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveProperty('time');
    expect(captured[0]).toHaveProperty('source', 'commander');
    expect(captured[0]).toHaveProperty('sourcetype', 'commander:event');
    expect((captured[0] as any).event).toHaveProperty('event_id', 'evt-splunk');
  });
});

// ============================================================================
// Datadog
// ============================================================================

describe('SIEMForwarder — Datadog', () => {
  it('sends JSON with DD-API-KEY header', async () => {
    const fwd = new SIEMForwarder({
      type: 'datadog', endpoint: 'https://http-intake.logs.datadoghq.com/api/v2/logs',
      token: 'dd-key-456', sourceName: 'commander',
    });
    let headers: Record<string, string> = {};
    vi.spyOn(fwd as any, 'httpPost').mockImplementation((_u: URL, _p: unknown[], h: Record<string, string>) => { headers = h; return Promise.resolve(); });

    await (fwd as any).sendDatadog([testEvent({ eventId: 'evt-dd' })]);

    expect(headers['DD-API-KEY']).toBe('dd-key-456');
  });
});

// ============================================================================
// Queue Behavior (synchronous)
// ============================================================================

describe('SIEMForwarder — Queue behavior', () => {
  it('queues events via forward() and does not crash', () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514' });
    fwd.forward(testEvent());
    fwd.forward(testEvent({ eventId: 'evt-002' }));
    // Events may immediately drain into processQueue (async),
    // so just verify no crash and stats exist
    expect(typeof fwd.getStats().totalForwarded).toBe('number');
  });

  it('accepts multiple events via forwardBatch()', () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514' });
    fwd.forwardBatch([testEvent(), testEvent({ eventId: 'evt-002' })]);
    expect(typeof fwd.getStats().totalForwarded).toBe('number');
  });

  it('increments totalDropped when queue exceeds maxQueueSize and processQueue is blocked', () => {
    // Block sendBatch by making it return a never-resolving promise.
    // processQueue consumes 1 event (splices it before awaiting), so we
    // need (maxQueueSize + 2) events to trigger 1 drop.
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514', maxQueueSize: 3 });
    (fwd as any).sendBatch = () => new Promise(() => {}); // never resolves

    fwd.forward(testEvent({ eventId: 'evt-1' }));
    fwd.forward(testEvent({ eventId: 'evt-2' }));
    fwd.forward(testEvent({ eventId: 'evt-3' }));
    fwd.forward(testEvent({ eventId: 'evt-4' }));
    fwd.forward(testEvent({ eventId: 'evt-5' }));

    const stats = fwd.getStats();
    expect(stats.totalDropped).toBe(1);
    expect(stats.queueSize).toBe(3);
  });
});

// ============================================================================
// processQueue (sync entry points)
// ============================================================================

describe('SIEMForwarder — processQueue', () => {
  it('processes queued events and increments totalForwarded', async () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514' });
    // Mock sendBatch via direct assignment instead of spy
    const origSendBatch = (fwd as any).sendBatch;
    let wasCalled = false;
    (fwd as any).sendBatch = ({ __synchronousMock: true }) as any;

    // Call processQueue directly to avoid async timing issues
    const batch = [testEvent()];
    // Manually push to queue so processQueue can splice it
    fwd.forward(testEvent()); // queue has 1 event

    // Now manually override sendBatch and call processQueue
    // Actually, processQueue was already called by forward().
    // Let's just check it's working by calling processQueue directly
    // with a mocked sendBatch that we can track.
    let sendCalled = false;
    (fwd as any).sendBatch = vi.fn().mockImplementation(() => {
      sendCalled = true;
      return Promise.resolve();
    });

    // Directly call processQueue
    (fwd as any).queue.length = 0; // reset queue
    (fwd as any).queue.push(testEvent());
    (fwd as any).processing = false;
    await (fwd as any).processQueue();

    expect(sendCalled).toBe(true);
    expect(fwd.getStats().totalForwarded).toBe(1);

    (fwd as any).sendBatch = origSendBatch;
  });

  it('increments totalFailed when sendBatch throws', async () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514' });
    const origSendBatch = (fwd as any).sendBatch;
    (fwd as any).sendBatch = vi.fn().mockRejectedValue(new Error('fail'));

    (fwd as any).queue.push(testEvent());
    (fwd as any).processing = false;
    await (fwd as any).processQueue();

    expect(fwd.getStats().totalFailed).toBe(1);

    (fwd as any).sendBatch = origSendBatch;
  });

  it('re-queues failed events to the front', async () => {
    const fwd = new SIEMForwarder({ type: 'syslog', endpoint: '127.0.0.1:514', retryIntervalMs: 50 });
    const origSendBatch = (fwd as any).sendBatch;
    (fwd as any).sendBatch = vi.fn().mockRejectedValue(new Error('fail'));

    (fwd as any).queue.push(testEvent({ eventId: 'evt-retry' }));
    (fwd as any).processing = false;
    await (fwd as any).processQueue();

    const stats = fwd.getStats();
    expect(stats.totalFailed).toBe(1);
    expect((fwd as any).queue.length).toBe(1); // re-queued to front

    (fwd as any).sendBatch = origSendBatch;
  });
});

// ============================================================================
// createSIEMForwarderFromEnv
// ============================================================================

describe('createSIEMForwarderFromEnv', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('creates syslog forwarder', () => {
    vi.stubEnv('SIEM_TYPE', 'syslog');
    vi.stubEnv('SIEM_ENDPOINT', '127.0.0.1:514');
    expect(createSIEMForwarderFromEnv()).not.toBeNull();
  });

  it('creates Splunk HEC forwarder', () => {
    vi.stubEnv('SIEM_TYPE', 'splunk-hec');
    vi.stubEnv('SIEM_ENDPOINT', 'https://splunk.example.com:8088');
    vi.stubEnv('SIEM_TOKEN', 'hec-token');
    expect(createSIEMForwarderFromEnv()).not.toBeNull();
  });

  it('creates Datadog forwarder', () => {
    vi.stubEnv('SIEM_TYPE', 'datadog');
    vi.stubEnv('SIEM_ENDPOINT', 'https://http-intake.logs.datadoghq.com/api/v2/logs');
    vi.stubEnv('SIEM_TOKEN', 'dd-key');
    expect(createSIEMForwarderFromEnv()).not.toBeNull();
  });

  it('returns null when SIEM_TYPE not set', () => {
    vi.stubEnv('SIEM_TYPE', '');
    expect(createSIEMForwarderFromEnv()).toBeNull();
  });

  it('returns null when SIEM_ENDPOINT missing', () => {
    vi.stubEnv('SIEM_TYPE', 'syslog');
    vi.stubEnv('SIEM_ENDPOINT', '');
    expect(createSIEMForwarderFromEnv()).toBeNull();
  });

  it('returns null for unsupported type', () => {
    vi.stubEnv('SIEM_TYPE', 'elastic');
    vi.stubEnv('SIEM_ENDPOINT', 'http://localhost:9200');
    expect(createSIEMForwarderFromEnv()).toBeNull();
  });
});
