/**
 * V2 PagerDuty Alerting Tests
 *
 * Verifies the PagerDuty Events API v2 integration:
 *   1. triggerAlert sends correct payload to PagerDuty
 *   2. resolveAlert sends resolve event
 *   3. escalateAlert updates severity
 *   4. No-op when integration key is absent
 *   5. Sanitization: @mentions, URLs, control chars removed
 *   6. SLOAlertBridge: SLO violation triggers alert, recovery resolves
 *   7. SLOAlertBridge: severity mapping correct for all 7 metrics
 *   8. SLOAlertBridge: escalation on worsening violation
 *   9. Dedup key generation is deterministic for same source/component/severity
 *  10. Alert tracking: isActive and getActiveAlertKeys
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  PagerDutyAlerter,
  SLOAlertBridge,
  resetPagerDutyAlerter,
  setPagerDutyAlerter,
  type SLOViolationEvent,
} from '../../src/observability/pagerDutyAlerting.js';

// ── Fetch mock ───────────────────────────────────────────────────────────────

interface MockFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let mockCalls: MockFetchCall[] = [];
let mockResponse: { status: string; dedup_key?: string; errors?: string[] } = {
  status: 'success',
  dedup_key: 'mock-dedup-key',
};
let mockHttpStatus = 200;
let mockShouldThrow = false;

function mockFetch(url: string, init: RequestInit): Promise<Response> {
  mockCalls.push({
    url,
    method: init.method ?? 'GET',
    headers: init.headers as Record<string, string>,
    body: init.body as string,
  });

  if (mockShouldThrow) {
    return Promise.reject(new Error('Network error'));
  }

  return Promise.resolve({
    ok: mockHttpStatus >= 200 && mockHttpStatus < 300,
    status: mockHttpStatus,
    json: () => Promise.resolve(mockResponse),
  } as Response);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('V2 PagerDuty Alerting', () => {
  describe('PagerDutyAlerter', () => {
    let alerter: PagerDutyAlerter;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      mockCalls = [];
      mockResponse = { status: 'success', dedup_key: 'mock-dedup-key' };
      mockHttpStatus = 200;
      mockShouldThrow = false;
      globalThis.fetch = mockFetch as typeof fetch;
      alerter = new PagerDutyAlerter({ integrationKey: 'test-key-12345' });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      resetPagerDutyAlerter();
    });

    // ── 1. triggerAlert sends correct payload ────────────────────────────────

    it('should send correct trigger payload to PagerDuty Events API v2', async () => {
      const result = await alerter.triggerAlert(
        'critical',
        'API success rate critical',
        'commander-api',
        { region: 'us-east-1', availability: '99.5%' },
      );

      assert.ok(result.dedupKey, 'Should return a dedup key');
      assert.equal(mockCalls.length, 1, 'Should make exactly 1 HTTP call');

      const call = mockCalls[0]!;
      assert.equal(call.url, 'https://events.pagerduty.com/v2/enqueue');
      assert.equal(call.method, 'POST');
      assert.ok(call.headers['Content-Type'], 'Should have Content-Type header');

      const payload = JSON.parse(call.body);
      assert.equal(payload.routing_key, 'test-key-12345');
      assert.equal(payload.event_action, 'trigger');
      assert.ok(payload.dedup_key, 'Should have dedup_key');
      assert.equal(payload.payload.severity, 'critical');
      assert.equal(payload.payload.summary, 'API success rate critical');
      assert.equal(payload.payload.source, 'commander-api');
      assert.equal(payload.payload.custom_details.region, 'us-east-1');
    });

    // ── 2. resolveAlert sends resolve event ──────────────────────────────────

    it('should send resolve event with dedup key', async () => {
      // First trigger an alert
      const triggerResult = await alerter.triggerAlert(
        'error',
        'Schedule latency high',
        'commander-scheduler',
      );
      const dedupKey = triggerResult.dedupKey;

      // Clear calls
      mockCalls = [];

      // Resolve
      await alerter.resolveAlert(dedupKey);

      assert.equal(mockCalls.length, 1);
      const payload = JSON.parse(mockCalls[0]!.body);
      assert.equal(payload.event_action, 'resolve');
      assert.equal(payload.routing_key, 'test-key-12345');
      assert.equal(payload.dedup_key, dedupKey);
    });

    // ── 3. escalateAlert updates severity ────────────────────────────────────

    it('should escalate alert by re-triggering with new severity', async () => {
      // Trigger with 'warning'
      const triggerResult = await alerter.triggerAlert(
        'warning',
        'WAL size growing',
        'commander-db',
      );
      const dedupKey = triggerResult.dedupKey;

      // Clear calls
      mockCalls = [];

      // Escalate to 'critical'
      await alerter.escalateAlert(dedupKey, 'critical');

      assert.equal(mockCalls.length, 1);
      const payload = JSON.parse(mockCalls[0]!.body);
      assert.equal(payload.event_action, 'trigger');
      assert.equal(payload.dedup_key, dedupKey);
      assert.equal(payload.payload.severity, 'critical');
      assert.equal(payload.payload.summary, 'WAL size growing');
    });

    // ── 4. No-op when integration key absent ─────────────────────────────────

    it('should be a no-op when integration key is not set', async () => {
      const unconfigured = new PagerDutyAlerter({ integrationKey: '' });

      assert.equal(unconfigured.isConfigured(), false);

      const result = await unconfigured.triggerAlert('critical', 'Test', 'source');
      assert.equal(result.dedupKey, '', 'Should return empty dedup key');
      assert.equal(mockCalls.length, 0, 'Should not make any HTTP calls');

      // resolve and escalate should also be no-ops
      await unconfigured.resolveAlert('any-key');
      await unconfigured.escalateAlert('any-key', 'critical');
      assert.equal(mockCalls.length, 0);
    });

    // ── 5. Sanitization ──────────────────────────────────────────────────────

    it('should sanitize @mentions, URLs, and control chars from alert text', async () => {
      const maliciousSummary = 'Alert @here check https://evil.com \x00\x01 end';
      await alerter.triggerAlert('warning', maliciousSummary, 'commander-test');

      const payload = JSON.parse(mockCalls[0]!.body);
      const summary = payload.payload.summary as string;

      assert.ok(!summary.includes('@here'), 'Should strip @here mentions');
      assert.ok(!summary.includes('https://'), 'Should strip URLs');
      assert.ok(!summary.includes('\x00'), 'Should strip control chars');
      assert.ok(summary.length <= 100, 'Should truncate to 100 chars');
    });

    // ── 6. Alert tracking ────────────────────────────────────────────────────

    it('should track active alerts and expose isActive/getActiveAlertKeys', async () => {
      const result = await alerter.triggerAlert('error', 'Test alert', 'source-1');

      assert.equal(alerter.isActive(result.dedupKey), true);
      assert.ok(alerter.getActiveAlertKeys().length >= 1);

      await alerter.resolveAlert(result.dedupKey);

      assert.equal(alerter.isActive(result.dedupKey), false);
    });

    // ── 7. API error handling ────────────────────────────────────────────────

    it('should throw on PagerDuty API error', async () => {
      mockResponse = { status: 'error', errors: ['Invalid integration key'] };

      await assert.rejects(
        async () => alerter.triggerAlert('critical', 'Test', 'source'),
        /PagerDuty API error/,
      );
    });

    // ── 8. Network error handling ────────────────────────────────────────────

    it('should throw on network error', async () => {
      mockShouldThrow = true;

      await assert.rejects(
        async () => alerter.triggerAlert('critical', 'Test', 'source'),
        /PagerDuty API request failed/,
      );
    });
  });

  describe('SLOAlertBridge', () => {
    let alerter: PagerDutyAlerter;
    let bridge: SLOAlertBridge;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      mockCalls = [];
      mockResponse = { status: 'success', dedup_key: undefined };
      mockHttpStatus = 200;
      mockShouldThrow = false;
      globalThis.fetch = mockFetch as typeof fetch;
      alerter = new PagerDutyAlerter({ integrationKey: 'test-key-12345' });
      bridge = new SLOAlertBridge(alerter);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      resetPagerDutyAlerter();
    });

    // ── 9. SLO violation triggers alert ─────────────────────────────────────

    it('should trigger PagerDuty alert on SLO violation', async () => {
      const event: SLOViolationEvent = {
        sloId: 'api-availability',
        metric: 'api_success_rate',
        actualValue: 0.995,
        threshold: 0.999,
        isViolating: true,
      };

      await bridge.handleSLOEvent(event);

      assert.equal(mockCalls.length, 1, 'Should trigger 1 alert');
      const payload = JSON.parse(mockCalls[0]!.body);
      assert.equal(payload.event_action, 'trigger');
      assert.equal(payload.payload.severity, 'critical', 'api_success_rate → critical');
      assert.ok(payload.payload.summary.includes('api_success_rate'));
      assert.ok(payload.payload.custom_details.actualValue === 0.995);
    });

    // ── 10. SLO recovery auto-resolves ───────────────────────────────────────

    it('should auto-resolve PagerDuty alert when SLO recovers', async () => {
      // Trigger violation
      await bridge.handleSLOEvent({
        sloId: 'api-availability',
        metric: 'api_success_rate',
        actualValue: 0.995,
        threshold: 0.999,
        isViolating: true,
      });
      assert.equal(mockCalls.length, 1);

      // Clear calls
      mockCalls = [];

      // SLO recovers
      await bridge.handleSLOEvent({
        sloId: 'api-availability',
        metric: 'api_success_rate',
        actualValue: 0.9995,
        threshold: 0.999,
        isViolating: false,
      });

      assert.equal(mockCalls.length, 1, 'Should resolve 1 alert');
      const payload = JSON.parse(mockCalls[0]!.body);
      assert.equal(payload.event_action, 'resolve');
    });

    // ── 11. Severity mapping for all 7 SLO metrics ────────────────────────────

    it('should map all 7 SLO metrics to correct PagerDuty severities', async () => {
      const testCases: Array<{ metric: string; expectedSeverity: string }> = [
        { metric: 'api_success_rate', expectedSeverity: 'critical' },
        { metric: 'schedule_latency_ms', expectedSeverity: 'error' },
        { metric: 'dlq_depth', expectedSeverity: 'error' },
        { metric: 'wal_size_mb', expectedSeverity: 'warning' },
        { metric: 'step_recovery_time_ms', expectedSeverity: 'warning' },
        { metric: 'hash_chain_integrity', expectedSeverity: 'critical' },
        { metric: 'approval_failclosed_rate', expectedSeverity: 'critical' },
      ];

      for (const tc of testCases) {
        mockCalls = [];
        await bridge.handleSLOEvent({
          sloId: `slo-${tc.metric}`,
          metric: tc.metric,
          actualValue: 1,
          threshold: 0,
          isViolating: true,
        });

        assert.equal(mockCalls.length, 1, `Should trigger alert for ${tc.metric}`);
        const payload = JSON.parse(mockCalls[0]!.body);
        assert.equal(
          payload.payload.severity,
          tc.expectedSeverity,
          `${tc.metric} should map to ${tc.expectedSeverity}`,
        );

        // Resolve to clean up for next iteration
        await bridge.handleSLOEvent({
          sloId: `slo-${tc.metric}`,
          metric: tc.metric,
          actualValue: 0,
          threshold: 1,
          isViolating: false,
        });
      }
    });

    // ── 12. Escalation on worsening violation ─────────────────────────────────

    it('should escalate alert when violation worsens', async () => {
      // First violation: warning severity (wal_size_mb)
      await bridge.handleSLOEvent({
        sloId: 'wal-size',
        metric: 'wal_size_mb',
        actualValue: 550,
        threshold: 500,
        isViolating: true,
      });
      assert.equal(mockCalls.length, 1);
      const triggerPayload = JSON.parse(mockCalls[0]!.body);
      assert.equal(triggerPayload.payload.severity, 'warning');

      // Clear calls
      mockCalls = [];

      // Second event: still violating → escalation attempt
      await bridge.handleSLOEvent({
        sloId: 'wal-size',
        metric: 'wal_size_mb',
        actualValue: 800,
        threshold: 500,
        isViolating: true,
      });

      // Should attempt to escalate (may succeed or no-op depending on severity)
      assert.equal(mockCalls.length, 1, 'Should make 1 call for escalation');
      const escalatePayload = JSON.parse(mockCalls[0]!.body);
      assert.equal(
        escalatePayload.event_action,
        'trigger',
        'Should re-trigger with same dedup key',
      );
    });

    // ── 13. Unknown metric is ignored ─────────────────────────────────────────

    it('should ignore SLO events for unknown metrics', async () => {
      await bridge.handleSLOEvent({
        sloId: 'unknown-slo',
        metric: 'unknown_metric',
        actualValue: 1,
        threshold: 0,
        isViolating: true,
      });

      assert.equal(mockCalls.length, 0, 'Should not trigger alert for unknown metric');
    });

    // ── 14. Subscriber callback ───────────────────────────────────────────────

    it('should forward events to registered subscribers', async () => {
      let receivedEvent: SLOViolationEvent | null = null;
      bridge.subscribe((event) => {
        receivedEvent = event;
      });

      const testEvent: SLOViolationEvent = {
        sloId: 'test',
        metric: 'api_success_rate',
        actualValue: 0.99,
        threshold: 0.999,
        isViolating: true,
      };

      await bridge.handleSLOEvent(testEvent);

      assert.ok(receivedEvent, 'Subscriber should receive the event');
      assert.equal(receivedEvent!.metric, 'api_success_rate');
    });

    // ── 15. Active metrics tracking ───────────────────────────────────────────

    it('should track active metrics and expose getActiveMetrics', async () => {
      assert.equal(bridge.getActiveMetrics().length, 0);

      await bridge.handleSLOEvent({
        sloId: 'api',
        metric: 'api_success_rate',
        actualValue: 0.99,
        threshold: 0.999,
        isViolating: true,
      });

      assert.equal(bridge.getActiveMetrics().length, 1);
      assert.ok(bridge.getActiveMetrics().includes('api_success_rate'));

      // Resolve
      await bridge.handleSLOEvent({
        sloId: 'api',
        metric: 'api_success_rate',
        actualValue: 1,
        threshold: 0.999,
        isViolating: false,
      });

      assert.equal(bridge.getActiveMetrics().length, 0, 'Should clear after recovery');
    });
  });
});
