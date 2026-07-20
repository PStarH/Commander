import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import { createWorkerPolicyEvaluator } from './bootstrap.js';

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
};

const digest = (value: Record<string, unknown>): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

const envelope = {
  tenantId: 'tenant-a',
  source: 'test-agent',
  package: 'test-package',
  model: 'test-model',
  tool: 'ticket.create',
  destination: 'demo://tickets',
  effectType: 'demo.ticket.create',
  args: { title: 'Reset a demo password' },
  idempotencyKey: 'action-key-0001',
};

async function createActionRun(
  repository: InMemoryKernelRepository,
  options: {
    runId?: string;
    tenantId?: string;
    effect?: 'allow' | 'deny' | 'require_approval';
    actionDigest?: string;
    decisionId?: string;
    metadataEffectId?: string;
    metadataPolicySnapshotId?: string;
    runPolicySnapshotId?: string;
    simulationId?: string;
    simulationActionDigest?: string;
    simulationDecisionId?: string;
  } = {},
) {
  const tenantId = options.tenantId ?? envelope.tenantId;
  const runId = options.runId ?? 'run-action';
  const stepId = `${runId}-step`;
  const effectId = `${runId}-effect`;
  const interactionId = `${runId}-interaction`;
  const effect = options.effect ?? 'allow';
  const actionEnvelope = { ...envelope, tenantId };
  const actionDigest = options.actionDigest ?? digest(actionEnvelope);
  const policySnapshotId = options.metadataPolicySnapshotId ?? 'action-gateway-mvp-v1';
  const decisionId = options.decisionId ?? `action-gateway-${effect}`;
  const simulationId = options.simulationId ?? `${runId}-simulation`;
  await repository.createRun(
    {
      id: runId,
      tenantId,
      intentHash: 'intent',
      workGraphHash: 'graph',
      workGraphVersion: 'action-gateway/v1',
      policySnapshotId: options.runPolicySnapshotId ?? 'action-gateway-mvp-v1',
      metadata: {
        actionGateway: {
          authority: 'commander.action-gateway/v1',
          stepId,
          effectId: options.metadataEffectId ?? effectId,
          interactionId: effect === 'require_approval' ? interactionId : undefined,
          actionDigest,
          policySnapshotId,
          decision: {
            effect,
            decisionId,
            reason: effect,
            policySnapshotId,
          },
          simulation: {
            simulationId,
            actionDigest: options.simulationActionDigest ?? actionDigest,
            effect,
            decisionId: options.simulationDecisionId ?? decisionId,
            reason: effect,
            policySnapshotId,
          },
          envelope: actionEnvelope,
        },
      },
      steps: [
        {
          id: stepId,
          kind: 'tool',
          initialState: effect === 'require_approval' ? 'WAITING_FOR_HUMAN' : 'PENDING',
          interaction:
            effect === 'require_approval'
              ? { id: interactionId, prompt: 'Approve demo ticket creation?' }
              : undefined,
          input: {
            toolName: actionEnvelope.tool,
            effectType: actionEnvelope.effectType,
            args: actionEnvelope.args,
            actionEnvelope,
            effectId,
            idempotencyKey: actionEnvelope.idempotencyKey,
          },
        },
      ],
    },
    'action-gateway',
  );
  return {
    runId,
    stepId,
    interactionId,
    actionEnvelope,
    actionDigest,
    simulationId,
    policySnapshotId,
  };
}

function evaluate(
  repository: InMemoryKernelRepository,
  input: { tenantId: string; runId: string; stepId: string; request?: Record<string, unknown> },
) {
  return createWorkerPolicyEvaluator(repository).evaluate({
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    type: 'demo.ticket.create',
    request: input.request ?? envelope,
    token: {} as never,
  });
}

describe('L4-01 Action Gateway worker policy', () => {
  it('allows only a trusted persisted Action Gateway envelope', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository);
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.decisionId, 'action-gateway-allow');
    assert.equal(decision.policySnapshotId, 'action-gateway-mvp-v1');
  });

  it('fails closed for missing, forged, cross-tenant, and snapshot-mismatched metadata', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun(
      {
        id: 'run-generic',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'action-gateway-mvp-v1',
        steps: [{ id: 'step-generic', kind: 'tool', input: {} }],
      },
      'generic-gateway',
    );
    const missing = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: 'run-generic',
      stepId: 'step-generic',
    });
    assert.equal(missing.effect, 'deny');

    const forged = await createActionRun(repository, {
      runId: 'run-forged',
      actionDigest: 'forged-digest',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: forged.runId,
          stepId: forged.stepId,
          request: forged.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    const mismatch = await createActionRun(repository, {
      runId: 'run-snapshot-mismatch',
      metadataPolicySnapshotId: 'policy-forged',
    });
    const drifted = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: mismatch.runId,
      stepId: mismatch.stepId,
      request: mismatch.actionEnvelope,
    });
    assert.equal(drifted.effect, 'deny');
    assert.equal(drifted.reason, 'POLICY_SNAPSHOT_DRIFT');

    const forgedDecision = await createActionRun(repository, {
      runId: 'run-forged-decision',
      decisionId: 'forged-allow',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: forgedDecision.runId,
          stepId: forgedDecision.stepId,
          request: forgedDecision.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    const forgedEffect = await createActionRun(repository, {
      runId: 'run-forged-effect',
      metadataEffectId: 'effect-not-bound-to-step',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: forgedEffect.runId,
          stepId: forgedEffect.stepId,
          request: forgedEffect.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-b',
          runId: forged.runId,
          stepId: forged.stepId,
          request: forged.actionEnvelope,
        })
      ).effect,
      'deny',
    );
  });

  it('allows approval-required metadata only after a positive bound interaction response', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-approval',
      effect: 'require_approval',
    });

    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: action.runId,
          stepId: action.stepId,
          request: action.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    await repository.answerInteraction({
      interactionId: action.interactionId,
      runId: action.runId,
      tenantId: 'tenant-a',
      response: {
        approved: true,
        actionDigest: action.actionDigest,
        simulationId: action.simulationId,
        policySnapshotId: action.policySnapshotId,
        reviewer: 'reviewer-a',
        runId: action.runId,
        tenantId: 'tenant-a',
      },
      actor: 'reviewer-a',
    });
    const approved = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(approved.effect, 'allow');
    assert.equal(approved.decisionId, 'action-gateway-allow-after-approval');
  });

  it('rejects exact execution argument mutation with ACTION_DIGEST_MISMATCH', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-args-mutated',
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: {
        ...action.actionEnvelope,
        args: { title: 'Mutated after approval' },
      },
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'ACTION_DIGEST_MISMATCH');
  });

  it('rejects a simulation that is not exactly bound to its persisted action', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-simulation-mismatch',
      simulationActionDigest: 'f'.repeat(64),
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'SIMULATION_MISMATCH');
  });

  it('rejects an approval whose digest, simulation, snapshot, or reviewer binding is invalid', async () => {
    for (const [name, override] of [
      ['digest', { actionDigest: 'f'.repeat(64) }],
      ['simulation', { simulationId: 'simulation-from-another-action' }],
      ['snapshot', { policySnapshotId: 'policy-from-another-action' }],
      ['reviewer', { reviewer: '' }],
    ] as const) {
      const repository = new InMemoryKernelRepository();
      const action = await createActionRun(repository, {
        runId: `run-approval-binding-${name}`,
        effect: 'require_approval',
      });
      await repository.answerInteraction({
        interactionId: action.interactionId,
        runId: action.runId,
        tenantId: 'tenant-a',
        response: {
          approved: true,
          actionDigest: action.actionDigest,
          simulationId: action.simulationId,
          policySnapshotId: action.policySnapshotId,
          reviewer: 'reviewer-a',
          runId: action.runId,
          tenantId: 'tenant-a',
          ...override,
        },
        actor: 'reviewer-a',
      });
      const decision = await evaluate(repository, {
        tenantId: 'tenant-a',
        runId: action.runId,
        stepId: action.stepId,
        request: action.actionEnvelope,
      });
      assert.equal(decision.effect, 'deny', name);
      assert.equal(decision.reason, 'APPROVAL_BINDING_MISMATCH', name);
    }
  });

  it('rejects replay of an approval from another run or tenant', async () => {
    const repository = new InMemoryKernelRepository();
    const source = await createActionRun(repository, {
      runId: 'run-approval-source',
      effect: 'require_approval',
    });
    const sourceApproval = {
      approved: true,
      actionDigest: source.actionDigest,
      simulationId: source.simulationId,
      policySnapshotId: source.policySnapshotId,
      reviewer: 'reviewer-a',
      runId: source.runId,
      tenantId: 'tenant-a',
    };

    const crossRun = await createActionRun(repository, {
      runId: 'run-approval-cross-run',
      effect: 'require_approval',
      simulationId: source.simulationId,
    });
    await repository.answerInteraction({
      interactionId: crossRun.interactionId,
      runId: crossRun.runId,
      tenantId: 'tenant-a',
      response: sourceApproval,
      actor: 'reviewer-a',
    });
    const crossRunDecision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: crossRun.runId,
      stepId: crossRun.stepId,
      request: crossRun.actionEnvelope,
    });
    assert.equal(crossRunDecision.effect, 'deny');
    assert.equal(crossRunDecision.reason, 'APPROVAL_BINDING_MISMATCH');

    const crossTenant = await createActionRun(repository, {
      runId: 'run-approval-cross-tenant',
      tenantId: 'tenant-b',
      effect: 'require_approval',
    });
    await repository.answerInteraction({
      interactionId: crossTenant.interactionId,
      runId: crossTenant.runId,
      tenantId: 'tenant-b',
      response: sourceApproval,
      actor: 'reviewer-a',
    });
    const crossTenantDecision = await evaluate(repository, {
      tenantId: 'tenant-b',
      runId: crossTenant.runId,
      stepId: crossTenant.stepId,
      request: crossTenant.actionEnvelope,
    });
    assert.equal(crossTenantDecision.effect, 'deny');
    assert.equal(crossTenantDecision.reason, 'APPROVAL_BINDING_MISMATCH');
  });

  it('never allows a rejected interaction or a persisted deny decision', async () => {
    const repository = new InMemoryKernelRepository();
    const rejected = await createActionRun(repository, {
      runId: 'run-rejected',
      effect: 'require_approval',
    });
    await repository.answerInteraction({
      interactionId: rejected.interactionId,
      runId: rejected.runId,
      tenantId: 'tenant-a',
      response: { approved: false, reviewer: 'reviewer-a' },
      actor: 'reviewer-a',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: rejected.runId,
          stepId: rejected.stepId,
          request: rejected.actionEnvelope,
        })
      ).effect,
      'deny',
    );

    const denied = await createActionRun(repository, {
      runId: 'run-denied',
      effect: 'deny',
    });
    assert.equal(
      (
        await evaluate(repository, {
          tenantId: 'tenant-a',
          runId: denied.runId,
          stepId: denied.stepId,
          request: denied.actionEnvelope,
        })
      ).effect,
      'deny',
    );
  });
});

describe('L4-04 kill switch worker policy', () => {
  it('denies execution when an enabled kill switch matches the persisted envelope', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository);
    await repository.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'tool',
      value: 'ticket.create',
      enabled: true,
      actor: 'ops-a',
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'KILL_SWITCH_ACTIVE');
  });

  it('still denies after approval when kill switch is enabled later', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, {
      runId: 'run-kill-after-approval',
      effect: 'require_approval',
    });
    await repository.answerInteraction({
      interactionId: action.interactionId,
      runId: action.runId,
      tenantId: 'tenant-a',
      response: {
        approved: true,
        actionDigest: action.actionDigest,
        simulationId: action.simulationId,
        policySnapshotId: action.policySnapshotId,
        reviewer: 'reviewer-a',
        runId: action.runId,
        tenantId: 'tenant-a',
      },
      actor: 'reviewer-a',
    });
    await repository.putKillSwitch({
      tenantId: 'tenant-a',
      scope: 'destination',
      value: 'demo://tickets',
      enabled: true,
      actor: 'ops-a',
    });
    const decision = await evaluate(repository, {
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      request: action.actionEnvelope,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'KILL_SWITCH_ACTIVE');
  });

  it('denies when kill-switch lookup fails (fail-closed)', async () => {
    const repository = new InMemoryKernelRepository();
    const action = await createActionRun(repository, { runId: 'run-kill-lookup-fail' });
    const kernel = {
      getRun: (runId: string, tenantId: string) => repository.getRun(runId, tenantId),
      getStep: (stepId: string, tenantId: string) => repository.getStep(stepId, tenantId),
      listInteractions: (runId: string, tenantId: string) =>
        repository.listInteractions(runId, tenantId),
      findMatchingKillSwitch: async () => {
        throw new Error('kill switch store unavailable');
      },
    };
    const decision = await createWorkerPolicyEvaluator(kernel).evaluate({
      tenantId: 'tenant-a',
      runId: action.runId,
      stepId: action.stepId,
      type: 'demo.ticket.create',
      request: action.actionEnvelope,
      token: {} as never,
    });
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.reason, 'KILL_SWITCH_LOOKUP_FAILED');
  });
});
