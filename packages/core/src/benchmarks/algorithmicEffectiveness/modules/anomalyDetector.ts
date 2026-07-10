import { TokenUsageAnomalyDetector } from '../../../observability/anomalyDetector';
import type { BenchmarkModule, Task, TokenUsage } from '../types';

interface UsageRecord {
  agentId: string;
  runId: string;
  stepNumber: number;
  tokenUsage: number;
  isAnomaly: boolean;
}

interface DetectionResult {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

interface DetectedAlert {
  severity: 'info' | 'warning' | 'critical';
}

interface AnomalyDetectorLike {
  reset(): void;
  recordUsage(agentId: string, tokenUsage: number): void;
  checkForAnomaly(
    agentId: string,
    runId: string,
    stepNumber: number,
    tokenUsage: number,
  ): DetectedAlert | null;
  getAlerts(agentId?: string): unknown[];
}

const BASELINE_TOKEN_USAGE: TokenUsage = {
  input: 1,
  output: 1,
  total: 2,
  cached: 0,
  reasoning: 0,
};

function buildSequence(id: string, records: UsageRecord[]): { id: string; records: UsageRecord[] } {
  return { id, records };
}

const sequences = [
  buildSequence('normal-steady', [
    ...Array.from({ length: 40 }, (_, i) => ({
      agentId: 'agent-a',
      runId: 'normal-steady',
      stepNumber: i + 1,
      tokenUsage: 1000,
      isAnomaly: false,
    })),
    ...Array.from({ length: 40 }, (_, i) => ({
      agentId: 'agent-b',
      runId: 'normal-steady',
      stepNumber: i + 1,
      tokenUsage: 2000,
      isAnomaly: false,
    })),
  ]),

  buildSequence('low-baseline-spike', [
    ...Array.from({ length: 20 }, (_, i) => ({
      agentId: 'low-usage-agent',
      runId: 'low-baseline-spike',
      stepNumber: i + 1,
      tokenUsage: 500,
      isAnomaly: false,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      agentId: 'high-usage-agent',
      runId: 'low-baseline-spike',
      stepNumber: i + 1,
      tokenUsage: 2500,
      isAnomaly: false,
    })),
    {
      agentId: 'low-usage-agent',
      runId: 'low-baseline-spike',
      stepNumber: 21,
      tokenUsage: 1500,
      isAnomaly: true,
    },
    {
      agentId: 'low-usage-agent',
      runId: 'low-baseline-spike',
      stepNumber: 22,
      tokenUsage: 1500,
      isAnomaly: true,
    },
  ]),

  buildSequence('multi-agent-mixed', [
    ...Array.from({ length: 15 }, (_, i) => ({
      agentId: 'agent-a',
      runId: 'multi-agent-mixed',
      stepNumber: i + 1,
      tokenUsage: 800,
      isAnomaly: false,
    })),
    ...Array.from({ length: 15 }, (_, i) => ({
      agentId: 'agent-b',
      runId: 'multi-agent-mixed',
      stepNumber: i + 1,
      tokenUsage: 1200,
      isAnomaly: false,
    })),
    ...Array.from({ length: 15 }, (_, i) => ({
      agentId: 'agent-c',
      runId: 'multi-agent-mixed',
      stepNumber: i + 1,
      tokenUsage: 3000,
      isAnomaly: false,
    })),
    {
      agentId: 'agent-a',
      runId: 'multi-agent-mixed',
      stepNumber: 16,
      tokenUsage: 1600,
      isAnomaly: true,
    },
    {
      agentId: 'agent-b',
      runId: 'multi-agent-mixed',
      stepNumber: 16,
      tokenUsage: 2400,
      isAnomaly: true,
    },
  ]),

  buildSequence('massive-global-spike', [
    ...Array.from({ length: 20 }, (_, i) => ({
      agentId: 'agent-a',
      runId: 'massive-global-spike',
      stepNumber: i + 1,
      tokenUsage: 1000,
      isAnomaly: false,
    })),
    {
      agentId: 'agent-a',
      runId: 'massive-global-spike',
      stepNumber: 21,
      tokenUsage: 4000,
      isAnomaly: true,
    },
  ]),

  buildSequence('gradual-drift-jump', [
    ...Array.from({ length: 30 }, (_, i) => ({
      agentId: 'drifting-agent',
      runId: 'gradual-drift-jump',
      stepNumber: i + 1,
      tokenUsage: 1000 + i * 10,
      isAnomaly: false,
    })),
    {
      agentId: 'drifting-agent',
      runId: 'gradual-drift-jump',
      stepNumber: 31,
      tokenUsage: 2200,
      isAnomaly: true,
    },
  ]),
];

const taskSuite: Task[] = sequences.map((seq) => ({
  id: seq.id,
  prompt: `Detect anomalies in the ${seq.id} token usage sequence.`,
  expected: (output: string) => {
    try {
      const result = JSON.parse(output) as DetectionResult;
      if (seq.id === 'normal-steady') {
        return result.fp === 0;
      }
      return result.precision >= 0.5 && result.recall >= 0.5;
    } catch {
      return false;
    }
  },
}));

function runSequence(detector: AnomalyDetectorLike, records: UsageRecord[]): DetectionResult {
  detector.reset();
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const record of records) {
    detector.recordUsage(record.agentId, record.tokenUsage);
    const alert = detector.checkForAnomaly(
      record.agentId,
      record.runId,
      record.stepNumber,
      record.tokenUsage,
    );
    const detected = alert !== null && (alert.severity === 'warning' || alert.severity === 'critical');

    if (detected && record.isAnomaly) {
      tp += 1;
    } else if (detected && !record.isAnomaly) {
      fp += 1;
    } else if (!detected && record.isAnomaly) {
      fn += 1;
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

  return { tp, fp, fn, precision, recall };
}

function createFixedThresholdDetector(): AnomalyDetectorLike {
  let records: number[] = [];

  return {
    reset: () => {
      records = [];
    },
    recordUsage: (_agentId: string, tokenUsage: number) => {
      records.push(tokenUsage);
    },
    checkForAnomaly: (
      agentId: string,
      runId: string,
      stepNumber: number,
      tokenUsage: number,
    ): DetectedAlert | null => {
      if (records.length < 2) return null;
      const globalAvg = records.reduce((a, b) => a + b, 0) / records.length;
      if (tokenUsage > 2 * globalAvg) {
        return { severity: 'critical' };
      }
      return null;
    },
    getAlerts: () => [],
  };
}

function createTreatmentDetector(): AnomalyDetectorLike {
  let detector = new TokenUsageAnomalyDetector();

  return {
    reset: () => {
      detector = new TokenUsageAnomalyDetector();
    },
    recordUsage: (agentId: string, tokenUsage: number) => {
      detector.recordUsage(agentId, tokenUsage);
    },
    checkForAnomaly: (
      agentId: string,
      runId: string,
      stepNumber: number,
      tokenUsage: number,
    ): DetectedAlert | null => {
      return detector.checkForAnomaly(agentId, runId, stepNumber, tokenUsage);
    },
    getAlerts: (agentId?: string) => detector.getAlerts(agentId),
  };
}

export const anomalyDetectorModule: BenchmarkModule = {
  id: 'anomalyDetector',
  name: 'Token Usage Anomaly Detector',
  description:
    'Validates that the per-agent sliding-window z-score detector outperforms a fixed 2x global-average threshold on synthetic token usage sequences.',
  path: 'observability/anomalyDetector.ts',
  baselineFactory: () => createFixedThresholdDetector(),
  treatmentFactory: () => createTreatmentDetector(),
  runTrial: async ({ implementation, task }) => {
    const detector = implementation as AnomalyDetectorLike;
    const sequence = sequences.find((s) => s.id === task.id);
    if (!sequence) {
      throw new Error(`Unknown anomaly detector task: ${task.id}`);
    }
    const result = runSequence(detector, sequence.records);
    return {
      output: JSON.stringify(result),
      tokenUsage: BASELINE_TOKEN_USAGE,
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
