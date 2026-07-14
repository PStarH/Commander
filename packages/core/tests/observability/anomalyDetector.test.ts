import { describe, it, expect, beforeEach } from 'vitest';
import {
  TokenUsageAnomalyDetector,
  getAnomalyDetector,
  resetAnomalyDetector,
} from '../../src/observability/anomalyDetector';

describe('TokenUsageAnomalyDetector', () => {
  let detector: TokenUsageAnomalyDetector;

  beforeEach(() => {
    resetAnomalyDetector();
    detector = new TokenUsageAnomalyDetector();
  });

  describe('recordUsage', () => {
    it('initializes history on first sample', () => {
      detector.recordUsage('agent-a', 100);
      const history = detector.getHistory('agent-a')!;
      expect(history.mean).toBe(100);
      expect(history.stdDev).toBe(0);
      expect(history.samples).toBe(1);
    });

    it('updates running mean and stdDev over multiple samples', () => {
      const values = [100, 110, 90, 105, 95];
      for (const v of values) detector.recordUsage('agent-a', v);
      const history = detector.getHistory('agent-a')!;
      expect(history.samples).toBe(values.length);
      expect(history.mean).toBeCloseTo(100, 0);
      expect(history.stdDev).toBeGreaterThan(0);
    });

    it('caps sample count at the window size', () => {
      for (let i = 0; i < 60; i++) detector.recordUsage('agent-a', 100);
      expect(detector.getHistory('agent-a')!.samples).toBe(50);
    });
  });

  describe('checkForAnomaly', () => {
    it('returns null until enough samples are recorded', () => {
      for (let i = 0; i < 9; i++) detector.recordUsage('agent-a', 100);
      expect(detector.checkForAnomaly('agent-a', 'run-1', 1, 200)).toBeNull();
    });

    it('returns null when usage is within the z-score threshold', () => {
      for (let i = 0; i < 20; i++) detector.recordUsage('agent-a', i % 2 === 0 ? 100 : 110);
      expect(detector.checkForAnomaly('agent-a', 'run-1', 1, 105)).toBeNull();
    });

    it('returns a warning alert for moderate deviation', () => {
      for (let i = 0; i < 20; i++) detector.recordUsage('agent-a', i % 2 === 0 ? 100 : 110);
      const alert = detector.checkForAnomaly('agent-a', 'run-1', 1, 120);
      expect(alert).not.toBeNull();
      expect(alert!.severity).toBe('warning');
      expect(alert!.agentId).toBe('agent-a');
    });

    it('returns a critical alert for extreme deviation', () => {
      for (let i = 0; i < 20; i++) detector.recordUsage('agent-a', i % 2 === 0 ? 100 : 110);
      const alert = detector.checkForAnomaly('agent-a', 'run-1', 1, 145);
      expect(alert).not.toBeNull();
      expect(alert!.severity).toBe('critical');
    });

    it('returns critical when stdDev is zero and usage differs from mean', () => {
      for (let i = 0; i < 15; i++) detector.recordUsage('agent-a', 100);
      const alert = detector.checkForAnomaly('agent-a', 'run-1', 1, 101);
      expect(alert).not.toBeNull();
      expect(alert!.severity).toBe('critical');
      expect(alert!.zScore).toBe(Infinity);
    });

    it('returns null when stdDev is zero and usage equals mean', () => {
      for (let i = 0; i < 15; i++) detector.recordUsage('agent-a', 100);
      expect(detector.checkForAnomaly('agent-a', 'run-1', 1, 100)).toBeNull();
    });

    it('records metrics for detected anomalies', () => {
      for (let i = 0; i < 20; i++) detector.recordUsage('agent-a', i % 2 === 0 ? 100 : 110);
      const alert = detector.checkForAnomaly('agent-a', 'run-1', 1, 140);
      expect(alert).not.toBeNull();
    });

    it('caps the alert buffer at 1000 entries', () => {
      for (let i = 0; i < 20; i++) detector.recordUsage('agent-a', i % 2 === 0 ? 100 : 110);
      for (let i = 0; i < 1002; i++) {
        detector.checkForAnomaly('agent-a', `run-${i}`, i, 140);
      }
      expect(detector.getAlerts().length).toBe(1000);
    });
  });

  describe('query helpers', () => {
    it('getAlerts filters by agentId', () => {
      for (let i = 0; i < 15; i++) detector.recordUsage('agent-a', 100);
      for (let i = 0; i < 15; i++) detector.recordUsage('agent-b', 50);
      detector.checkForAnomaly('agent-a', 'run-1', 1, 300);
      detector.checkForAnomaly('agent-b', 'run-2', 1, 150);

      expect(detector.getAlerts('agent-a').length).toBe(1);
      expect(detector.getAlerts('agent-b').length).toBe(1);
      expect(detector.getAlerts().length).toBe(2);
    });

    it('getHistory returns undefined for unknown agents', () => {
      expect(detector.getHistory('unknown')).toBeUndefined();
    });

    it('getBaseline returns the mean or zero', () => {
      detector.recordUsage('agent-a', 123);
      expect(detector.getBaseline('agent-a')).toBe(123);
      expect(detector.getBaseline('unknown')).toBe(0);
    });
  });

  describe('singleton', () => {
    it('getAnomalyDetector returns the same instance', () => {
      const a = getAnomalyDetector();
      const b = getAnomalyDetector();
      expect(a).toBe(b);
    });

    it('resetAnomalyDetector creates a fresh instance', () => {
      const a = getAnomalyDetector();
      resetAnomalyDetector();
      const b = getAnomalyDetector();
      expect(a).not.toBe(b);
    });
  });
});
