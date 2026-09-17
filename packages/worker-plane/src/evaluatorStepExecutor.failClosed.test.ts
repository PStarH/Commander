/**
 * WP-06: the evaluator fabricated passing scores. An unknown/custom evaluator returned
 * `score: 0.5` and a rule set with no rules returned `score: 1.0, passed: true`, so a
 * quality gate that had measured nothing reported a pass. Unevaluable input must fail
 * closed (`EVALUATION_UNMEASURED` / `INVALID_INPUT`), never pass.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EvaluatorStepExecutor } from './evaluatorStepExecutor.js';
import type { ClaimedStep } from './types.js';
import { WorkerExecutionError } from './types.js';

function step(input: Record<string, unknown>): ClaimedStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    tenantId: 'tenant-a',
    kind: 'evaluator',
    state: 'RUNNING',
    attempt: 1,
    version: 1,
    input,
    lease: {
      workerId: 'w1',
      workerGeneration: 1,
      token: 'lease',
      fencingEpoch: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  } as ClaimedStep;
}

const ctx = { signal: AbortSignal.timeout(5_000), worker: { id: 'w1' } as never };

function isCode(code: string) {
  return (err: unknown) => err instanceof WorkerExecutionError && err.options.code === code;
}

describe('EvaluatorStepExecutor fail-closed contract (WP-06)', () => {
  it('refuses to pass an evaluation with no rules', async () => {
    const executor = new EvaluatorStepExecutor();
    await assert.rejects(
      () => executor.execute(step({ subject: {}, method: 'rules', criteria: { rules: [] } }), ctx),
      isCode('EVALUATION_UNMEASURED'),
    );
  });

  it('refuses to pass an evaluation with no rule set at all', async () => {
    const executor = new EvaluatorStepExecutor();
    await assert.rejects(
      () => executor.execute(step({ subject: {}, method: 'rules', criteria: {} }), ctx),
      isCode('EVALUATION_UNMEASURED'),
    );
  });

  it('refuses the unimplemented custom evaluator instead of inventing a score', async () => {
    const executor = new EvaluatorStepExecutor();
    await assert.rejects(
      () =>
        executor.execute(
          step({
            subject: {},
            method: 'custom',
            criteria: { customEvaluator: 'not-registered', rules: [] },
          }),
          ctx,
        ),
      isCode('EVALUATION_UNMEASURED'),
    );
  });

  it('refuses an llm evaluation with no rules (no AgentRuntime is wired)', async () => {
    const executor = new EvaluatorStepExecutor();
    await assert.rejects(
      () =>
        executor.execute(
          step({ subject: {}, method: 'llm', criteria: { promptTemplate: 'score this' } }),
          ctx,
        ),
      isCode('EVALUATION_UNMEASURED'),
    );
  });

  it('rejects a rule weight that would silently disable the rule', async () => {
    const executor = new EvaluatorStepExecutor();
    for (const weight of [0, -1, Number.NaN]) {
      await assert.rejects(
        () =>
          executor.execute(
            step({
              subject: { name: 'x' },
              method: 'rules',
              criteria: { rules: [{ name: 'has-name', path: 'name', check: 'exists', weight }] },
            }),
            ctx,
          ),
        isCode('INVALID_INPUT'),
      );
    }
  });

  it('rejects a minScore outside 0..1 instead of widening the gate', async () => {
    const executor = new EvaluatorStepExecutor();
    for (const minScore of [-1, 2, Number.NaN]) {
      await assert.rejects(
        () =>
          executor.execute(
            step({
              subject: { name: 'x' },
              method: 'rules',
              minScore,
              criteria: { rules: [{ name: 'has-name', path: 'name', check: 'exists' }] },
            }),
            ctx,
          ),
        isCode('INVALID_INPUT'),
      );
    }
  });

  it('still measures a real rule set', async () => {
    const executor = new EvaluatorStepExecutor();
    const run = (minScore: number) =>
      executor.execute(
        step({
          subject: { name: 'x' },
          method: 'rules',
          minScore,
          criteria: {
            rules: [
              { name: 'has-name', path: 'name', check: 'exists', weight: 1 },
              { name: 'has-value', path: 'value', check: 'exists', weight: 1 },
            ],
          },
        }),
        ctx,
      );
    const half = await run(0.5);
    assert.equal((half as { score?: number }).score, 0.5);
    assert.equal((half as { passed?: boolean }).passed, true);
    const strict = await run(0.8);
    assert.equal((strict as { score?: number }).score, 0.5);
    assert.equal((strict as { passed?: boolean }).passed, false);
  });
});
