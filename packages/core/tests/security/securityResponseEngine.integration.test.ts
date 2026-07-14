import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import {
  isAgentQuarantined,
  isAgentSuspended,
  resetSecurityResponseState,
  startSecurityResponseEngine,
} from '../../src/security/securityResponseEngine';

describe('SecurityResponseEngine bus integration', () => {
  beforeEach(() => {
    resetMessageBus();
    resetSecurityResponseState();
    startSecurityResponseEngine();
  });

  afterEach(() => {
    resetSecurityResponseState();
  });

  it('subscribes to security.alert on startup', () => {
    expect(getMessageBus().getSubscriberCount('security.alert')).toBe(1);
  });

  it('suspends agent when a RASP-shaped alert is published on the bus', () => {
    const bus = getMessageBus();
    bus.publish('security.alert', 'test', {
      type: 'prompt_injection_detected',
      severity: 'high',
      agentId: 'agent-bus-1',
      message: 'injection detected',
      timestamp: new Date(),
    });

    expect(isAgentSuspended('agent-bus-1')).toBe(true);
  });

  it('ignores monitor alerts without agent context', () => {
    const bus = getMessageBus();
    bus.publish('security.alert', 'SecurityMonitor', {
      id: 'alert-1',
      timestamp: new Date().toISOString(),
      level: 'critical',
      title: 'Burst',
      description: 'Many events',
      events: [
        {
          id: 'evt-1',
          timestamp: new Date().toISOString(),
          type: 'security_scan',
          severity: 'critical',
          source: 'SecurityMonitor',
          message: 'burst',
        },
      ],
      recommendation: 'investigate',
    });

    expect(isAgentSuspended('SecurityMonitor')).toBe(false);
  });

  it('responds when monitor alert includes agentId in event context', () => {
    const bus = getMessageBus();
    bus.publish('security.alert', 'SecurityMonitor', {
      id: 'alert-2',
      timestamp: new Date().toISOString(),
      level: 'critical',
      title: 'Agent threat',
      description: 'Critical agent event',
      events: [
        {
          id: 'evt-2',
          timestamp: new Date().toISOString(),
          type: 'security_scan',
          severity: 'critical',
          source: 'test',
          message: 'agent compromise',
          details: { context: { agentId: 'agent-monitor-1' } },
        },
      ],
      recommendation: 'quarantine',
    });

    expect(isAgentQuarantined('agent-monitor-1')).toBe(true);
  });
});
