import { describe, it, expect, beforeEach } from 'vitest';
import { TokenUsageAnomalyDetector } from '../src/anomalyDetector';

describe('TokenUsageAnomalyDetector', () => {
  let detector: TokenUsageAnomalyDetector;

  beforeEach(() => {
    detector = new TokenUsageAnomalyDetector();
  });

  it('returns null when insufficient history', () => {
    detector.recordUsage('agent-1', 100);
    const alert = detector.checkForAnomaly('agent-1', 'run-1', 1, 200);
    expect(alert).toBeNull();
  });

  it('detects anomalies with sufficient history', () => {
    for (let i = 0; i < 20; i++) {
      detector.recordUsage('agent-1', 100 + (i % 3));
    }
    const baseline = detector.getBaseline('agent-1');
    const history = detector.getHistory('agent-1')!;
    const threshold = baseline + history.stdDev * 3.2;
    const alert = detector.checkForAnomaly('agent-1', 'run-1', 21, threshold);
    expect(alert).not.toBeNull();
    expect(alert!.severity).toBe('warning');
    expect(alert!.agentId).toBe('agent-1');
  });

  it('returns null for normal values', () => {
    for (let i = 0; i < 15; i++) {
      detector.recordUsage('agent-1', 100);
    }
    const alert = detector.checkForAnomaly('agent-1', 'run-1', 1, 100);
    expect(alert).toBeNull();
  });

  it('detects critical anomalies', () => {
    for (let i = 0; i < 20; i++) {
      detector.recordUsage('agent-1', 100 + (i % 3));
    }
    const alert = detector.checkForAnomaly('agent-1', 'run-1', 21, 200);
    expect(alert).not.toBeNull();
    expect(alert!.severity).toBe('critical');
  });

  it('detects anomaly when stdDev is 0 and value differs from mean', () => {
    for (let i = 0; i < 15; i++) {
      detector.recordUsage('agent-1', 100);
    }
    const alert = detector.checkForAnomaly('agent-1', 'run-1', 1, 150);
    expect(alert).not.toBeNull();
    expect(alert!.zScore).toBe(Infinity);
  });

  it('getAlerts returns all alerts', () => {
    for (let i = 0; i < 20; i++) {
      detector.recordUsage('agent-1', 100 + (i % 3));
    }
    detector.checkForAnomaly('agent-1', 'run-1', 21, 110);
    expect(detector.getAlerts()).toHaveLength(1);
  });

  it('getAlerts filters by agentId', () => {
    for (let i = 0; i < 20; i++) {
      detector.recordUsage('agent-1', 100 + (i % 3));
      detector.recordUsage('agent-2', 200 + (i % 3));
    }
    detector.checkForAnomaly('agent-1', 'run-1', 21, 110);
    detector.checkForAnomaly('agent-2', 'run-2', 21, 210);
    expect(detector.getAlerts('agent-1')).toHaveLength(1);
    expect(detector.getAlerts('agent-2')).toHaveLength(1);
  });

  it('getBaseline returns mean', () => {
    detector.recordUsage('agent-1', 100);
    detector.recordUsage('agent-1', 200);
    expect(detector.getBaseline('agent-1')).toBe(150);
  });

  it('getBaseline returns 0 for unknown agent', () => {
    expect(detector.getBaseline('unknown')).toBe(0);
  });
});
