import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SecurityAnomalyDetector,
  resetSecurityAnomalyDetector,
  type AnomalyEvent,
} from '../../src/security/securityAnomalyDetector';
import { resetMessageBus, getMessageBus } from '../../src/runtime/messageBus';

describe('SecurityAnomalyDetector', () => {
  let detector: SecurityAnomalyDetector;
  const anomalies: AnomalyEvent[] = [];

  beforeEach(() => {
    resetMessageBus();
    resetSecurityAnomalyDetector();
    anomalies.length = 0;
    detector = new SecurityAnomalyDetector({
      windowMs: 60_000,
      toolBurstThreshold: 5,
      capabilityAbuseThreshold: 3,
      errorCascadeThreshold: 3,
      irreversibleBurstThreshold: 3,
      outboundBlockThreshold: 2,
      approvalRejectionThreshold: 3,
      onAnomaly: (event) => anomalies.push(event),
    });
    detector.start();
  });

  describe('tool burst detection', () => {
    it('fires anomaly when tool call count exceeds threshold', () => {
      const bus = getMessageBus();
      for (let i = 0; i < 6; i++) {
        bus.publish('tool.started', 'agent-1', { runId: 'run-1' });
      }
      const burstAnomalies = anomalies.filter((a) => a.type === 'tool_burst');
      expect(burstAnomalies.length).toBeGreaterThan(0);
      expect(burstAnomalies[0].severity).toBe('critical');
      expect(burstAnomalies[0].count).toBeGreaterThan(5);
    });

    it('does not fire anomaly below threshold', () => {
      const bus = getMessageBus();
      for (let i = 0; i < 3; i++) {
        bus.publish('tool.started', 'agent-1', { runId: 'run-1' });
      }
      expect(anomalies.filter((a) => a.type === 'tool_burst')).toHaveLength(0);
    });
  });

  describe('capability abuse detection', () => {
    it('fires anomaly and revokes on too many capability rejections', () => {
      const revoked: string[] = [];
      detector.updateConfig({
        revokeCallback: (agentId) => revoked.push(agentId),
      });

      const bus = getMessageBus();
      for (let i = 0; i < 4; i++) {
        bus.publish('tool.blocked', 'agent-1', {
          runId: 'run-1',
          reason: 'capability_token_rejected',
        });
      }

      const abuseAnomalies = anomalies.filter((a) => a.type === 'capability_abuse');
      expect(abuseAnomalies.length).toBeGreaterThan(0);
      expect(revoked).toContain('agent-1');
    });
  });

  describe('error cascade detection', () => {
    it('fires warning on consecutive errors', () => {
      const bus = getMessageBus();
      for (let i = 0; i < 4; i++) {
        bus.publish('agent.failed', 'agent-1', { runId: 'run-1' });
      }

      const cascadeAnomalies = anomalies.filter((a) => a.type === 'error_cascade');
      expect(cascadeAnomalies.length).toBeGreaterThan(0);
      expect(cascadeAnomalies[0].severity).toBe('warning');
    });
  });

  describe('sandbox escape detection', () => {
    it('fires critical anomaly immediately on sandbox escape', () => {
      const bus = getMessageBus();
      bus.publish('sandbox.escape_attempted', 'agent-1', { runId: 'run-1' });

      const escapeAnomalies = anomalies.filter((a) => a.type === 'sandbox_escape');
      expect(escapeAnomalies).toHaveLength(1);
      expect(escapeAnomalies[0].severity).toBe('critical');
    });
  });

  describe('irreversible burst detection', () => {
    it('fires anomaly when irreversible tool blocks exceed threshold', () => {
      const revoked: string[] = [];
      detector.updateConfig({
        revokeCallback: (agentId) => revoked.push(agentId),
      });

      const bus = getMessageBus();
      for (let i = 0; i < 4; i++) {
        bus.publish('tool.blocked', 'agent-1', {
          runId: 'run-1',
          reason: 'irreversible_blocked',
          toolName: 'git_push',
        });
      }

      const irrevAnomalies = anomalies.filter((a) => a.type === 'irreversible_burst');
      expect(irrevAnomalies.length).toBeGreaterThan(0);
      expect(revoked).toContain('agent-1');
    });
  });

  describe('outbound block detection', () => {
    it('fires anomaly when outbound blocks exceed threshold', () => {
      const revoked: string[] = [];
      detector.updateConfig({
        revokeCallback: (agentId) => revoked.push(agentId),
      });

      const bus = getMessageBus();
      for (let i = 0; i < 3; i++) {
        bus.publish('tool.blocked', 'agent-1', {
          runId: 'run-1',
          reason: 'OUTBOUND_BLOCKED: evil.com',
        });
      }

      const outboundAnomalies = anomalies.filter((a) => a.type === 'outbound_blocked');
      expect(outboundAnomalies.length).toBeGreaterThan(0);
      expect(revoked).toContain('agent-1');
    });
  });

  describe('approval brute force detection', () => {
    it('fires anomaly on too many approval rejections', () => {
      const revoked: string[] = [];
      detector.updateConfig({
        revokeCallback: (agentId) => revoked.push(agentId),
      });

      const bus = getMessageBus();
      for (let i = 0; i < 4; i++) {
        bus.publish('human.approval_rejected', 'agent-1', { runId: 'run-1' });
      }

      const bruteForceAnomalies = anomalies.filter((a) => a.type === 'brute_force_approval');
      expect(bruteForceAnomalies.length).toBeGreaterThan(0);
      expect(revoked).toContain('agent-1');
    });
  });

  describe('per-agent isolation', () => {
    it('tracks agents independently', () => {
      const bus = getMessageBus();
      // Agent 1 has 3 tool calls (below threshold of 5)
      for (let i = 0; i < 3; i++) {
        bus.publish('tool.started', 'agent-1', { runId: 'run-1' });
      }
      // Agent 2 has 6 tool calls (above threshold)
      for (let i = 0; i < 6; i++) {
        bus.publish('tool.started', 'agent-2', { runId: 'run-2' });
      }

      const agent1Anomalies = anomalies.filter((a) => a.agentId === 'agent-1');
      const agent2Anomalies = anomalies.filter((a) => a.agentId === 'agent-2');
      expect(agent1Anomalies).toHaveLength(0);
      expect(agent2Anomalies.length).toBeGreaterThan(0);
    });
  });

  describe('deduplication', () => {
    it('does not fire duplicate anomalies for same type+count', () => {
      const bus = getMessageBus();
      // Fire exactly 6 tool calls (threshold is 5, so 6 triggers)
      for (let i = 0; i < 6; i++) {
        bus.publish('tool.started', 'agent-1', { runId: 'run-1' });
      }
      // 7th call — same count=7, should not produce a new anomaly
      bus.publish('tool.started', 'agent-1', { runId: 'run-1' });

      const burstAnomalies = anomalies.filter((a) => a.type === 'tool_burst');
      // Should have at most 2 anomalies (one at count=6, one at count=7)
      // because dedup checks type+agentId+count
      const uniqueCounts = new Set(burstAnomalies.map((a) => a.count));
      expect(uniqueCounts.size).toBe(burstAnomalies.length);
    });
  });

  describe('reset', () => {
    it('clears all agent windows and anomalies', () => {
      const bus = getMessageBus();
      bus.publish('sandbox.escape_attempted', 'agent-1', { runId: 'run-1' });
      expect(detector.getAnomalies().length).toBeGreaterThan(0);

      detector.reset();
      expect(detector.getAnomalies()).toHaveLength(0);
      expect(detector.getAgentWindow('agent-1')).toBeNull();
    });
  });
});
