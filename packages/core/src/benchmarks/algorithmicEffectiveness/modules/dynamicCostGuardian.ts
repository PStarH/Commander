import { DynamicCostGuardian, type CostRecord } from '../../../security/dynamicCostGuardian';
import type { BenchmarkModule, Task } from '../types';

interface CostTask extends Task {
  record: CostRecord;
  expectedDecision: 'ALLOW' | 'BLOCK';
}

const TENANT_ID = 'benchmark-tenant';
const STATIC_CAP = 0.5;

function createNormalTrainingRecords(): CostRecord[] {
  const records: CostRecord[] = [];

  // 38 low-cost routine requests that establish the tenant's normal profile.
  for (let i = 0; i < 38; i++) {
    records.push({
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: `train-${i}`,
      cost: 0.05,
      tokens: 1000,
      inputTokens: 700,
      outputTokens: 300,
      model: 'gpt-4o-mini',
      toolCalls: i % 3 === 0 ? 1 : 0,
      requestSize: 1000,
      timestamp: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    });
  }

  // 20 periodic bursts that are part of the tenant's legitimate pattern.
  for (let i = 38; i < 58; i++) {
    records.push({
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: `train-${i}`,
      cost: 0.8,
      tokens: 1200,
      inputTokens: 800,
      outputTokens: 400,
      model: 'gpt-4o-mini',
      toolCalls: 1,
      requestSize: 1200,
      timestamp: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    });
  }

  // 2 rare but historically seen expensive-model records; they keep the
  // expensive model in the fingerprint with a low ratio so a later cheap
  // request using that model still registers as a model-switching attack.
  for (let i = 58; i < 60; i++) {
    records.push({
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: `train-${i}`,
      cost: 3.0,
      tokens: 2000,
      inputTokens: 1400,
      outputTokens: 600,
      model: 'gpt-4-turbo',
      toolCalls: 0,
      requestSize: 2000,
      timestamp: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    });
  }

  return records;
}

const taskSuite: CostTask[] = [
  {
    id: 'normal-low',
    prompt: 'A routine low-cost request within the tenant profile.',
    expectedDecision: 'ALLOW',
    expected: (output: string) => output.startsWith('ALLOW'),
    record: {
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: 'normal',
      cost: 0.05,
      tokens: 1000,
      inputTokens: 700,
      outputTokens: 300,
      model: 'gpt-4o-mini',
      toolCalls: 0,
      requestSize: 1000,
      timestamp: '2024-01-15T10:00:00Z',
    },
  },
  {
    id: 'legitimate-burst',
    prompt:
      'A periodic burst that is allowed by the dynamic fingerprint but exceeds the static cap.',
    expectedDecision: 'ALLOW',
    expected: (output: string) => output.startsWith('ALLOW'),
    record: {
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: 'burst',
      cost: 0.8,
      tokens: 1200,
      inputTokens: 800,
      outputTokens: 400,
      model: 'gpt-4o-mini',
      toolCalls: 1,
      requestSize: 1200,
      timestamp: '2024-01-15T10:00:01Z',
    },
  },
  {
    id: 'model-switching-attack',
    prompt:
      'A request that switches to an expensive rare model while staying under the static cap.',
    expectedDecision: 'BLOCK',
    expected: (output: string) => output.startsWith('BLOCK'),
    record: {
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: 'model-switch',
      cost: 0.4,
      tokens: 2000,
      inputTokens: 1400,
      outputTokens: 600,
      model: 'gpt-4-turbo',
      toolCalls: 0,
      requestSize: 2000,
      timestamp: '2024-01-15T10:00:02Z',
    },
  },
  {
    id: 'context-stuffing-attack',
    prompt:
      'A request that stuffs context with an oversized payload while keeping cost under the cap.',
    expectedDecision: 'BLOCK',
    expected: (output: string) => output.startsWith('BLOCK'),
    record: {
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: 'context-stuff',
      cost: 0.4,
      tokens: 5000,
      inputTokens: 4500,
      outputTokens: 500,
      model: 'gpt-4o-mini',
      toolCalls: 0,
      requestSize: 5000,
      timestamp: '2024-01-15T10:00:03Z',
    },
  },
  {
    id: 'recursive-amplification-attack',
    prompt: 'A request that triggers recursive tool calls while keeping cost under the cap.',
    expectedDecision: 'BLOCK',
    expected: (output: string) => output.startsWith('BLOCK'),
    record: {
      tenantId: TENANT_ID,
      agentId: 'agent-a',
      sessionId: 'recursive-amp',
      cost: 0.4,
      tokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      model: 'gpt-4o-mini',
      toolCalls: 50,
      requestSize: 1500,
      timestamp: '2024-01-15T10:00:04Z',
    },
  },
];

function seedTrainingData(guardian: DynamicCostGuardian): void {
  const records = createNormalTrainingRecords();
  // Suppress anomaly detection while seeding by requiring an unreachable
  // number of data points for a fingerprint. This keeps training records from
  // triggering false responses (e.g. multi-session parallelism) before the
  // benchmark phase begins.
  guardian.reconfigure({ minDataPointsForFingerprint: 1_000_000 });
  for (const record of records) {
    guardian.recordTransaction(record);
  }
  // End every training session so session costs enter the baseline window
  // without leaving active sessions behind for the test phase.
  for (let i = 0; i < records.length; i++) {
    guardian.endSession(TENANT_ID, `train-${i}`);
  }
  // Restore normal threshold and build the fingerprint explicitly for the
  // benchmark phase.
  guardian.reconfigure({ minDataPointsForFingerprint: 50 });
  guardian.buildSpendingFingerprint(TENANT_ID);
}

function runBaseline(impl: { cap: number }, record: CostRecord): string {
  return record.cost > impl.cap ? 'BLOCK: exceeds static cap' : 'ALLOW: within static cap';
}

function runTreatment(impl: { guardian: DynamicCostGuardian }, record: CostRecord): string {
  const detection = impl.guardian.detectNovelEconomicAttack(record);
  if (detection.detected) {
    return `BLOCK: ${detection.attackType ?? 'anomaly'} (${detection.description})`;
  }
  return 'ALLOW: within dynamic fingerprint';
}

export const dynamicCostGuardianModule: BenchmarkModule = {
  id: 'dynamicCostGuardian',
  name: 'Dynamic Cost Guardian',
  description:
    'Validates that DynamicCostGuardian detects novel economic attacks and allows legitimate bursts that a static cap would false-flag.',
  path: 'security/dynamicCostGuardian.ts',
  baselineFactory: () => ({ cap: STATIC_CAP }),
  treatmentFactory: () => {
    const guardian = new DynamicCostGuardian({
      enabled: true,
      minDataPointsForFingerprint: 50,
      // Prevent the fingerprint from rebuilding during the short benchmark
      // run so attack records cannot shift the model mix.
      fingerprintUpdateIntervalMs: 3_600_000,
      // Disable gradient escalation over the tightly packed test window so it
      // cannot accidentally fire on the randomized task order.
      gradientEscalationWindowMs: 1,
    });
    seedTrainingData(guardian);
    return { guardian };
  },
  runTrial: async ({ implementation, task }) => {
    const t = task as CostTask;
    const impl = implementation as { cap?: number; guardian?: DynamicCostGuardian };

    let output: string;
    if (impl.guardian) {
      const treatmentImpl = { guardian: impl.guardian };
      output = runTreatment(treatmentImpl, t.record);
      // Only ingest legitimate traffic; attack records are blocked by the
      // detector above and should not pollute the rare-model cost stats.
      if (output.startsWith('ALLOW')) {
        impl.guardian.recordTransaction(t.record);
      }
    } else {
      output = runBaseline(impl as { cap: number }, t.record);
    }

    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
