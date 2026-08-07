import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assessKubernetesRollbackProof,
  countReconciliationWrites,
  createRepositoryKubernetesRollbackKindDriver,
  kubernetesRollbackProofExitCode,
  repositoryKubernetesRollbackKindConfigFromEnv,
  receiptMatchesGovernedRollback,
  runKubernetesRollbackKindProof,
  type KubernetesRollbackCommandResult,
  type KubernetesGovernedRollbackSubmission,
  type KubernetesRollbackProofObservation,
} from './kubernetes-rollback-kind.js';

function observed(
  overrides: Partial<KubernetesRollbackProofObservation> = {},
): KubernetesRollbackProofObservation {
  return {
    marker: 'commander:tenant-a:rollback-1',
    expectedRevision: '7',
    observations: [
      { marker: 'commander:tenant-a:rollback-1', markerMatches: 1, revision: '7' },
      { marker: 'commander:tenant-a:rollback-1', markerMatches: 1, revision: '7' },
    ],
    signedReceiptVerified: true,
    receiptCorrelated: true,
    prerequisites: {
      kindNamespaceReady: true,
      twoRevisionsObserved: true,
      governedRollbackAccepted: true,
      workerKilledAfterAcceptance: true,
      workerRestarted: true,
    },
    reconciliation: {
      outcome: 'APPLIED',
      startedAtMs: 1_000,
      resolvedAtMs: 1_500,
      deadlineAtMs: 2_000,
      observedAtMs: 1_500,
      writeCount: 1,
      writesDuringReconciliation: 0,
      queryFirstRecoveryObserved: true,
      auditEvidenceAvailable: true,
      writeAuditIds: ['audit-write-1'],
    },
    compensationDisposition: 'APPLIED',
    compensationEffectId: 'compensation-1',
    compensationRequestHash: 'c'.repeat(64),
    irreducibleUnknown: {
      injected: true,
      disposition: 'ESCALATED',
      effectId: 'unknown-1',
      escalationRecordId: 'escalation-1',
      startedAtMs: 2_100,
      deadlineAtMs: 3_100,
      escalatedAtMs: 3_000,
      writesDuringReconciliation: 0,
    },
    ...overrides,
  };
}

describe('Kubernetes rollback kind proof', () => {
  it('counts distinct remote mutations observed across reconciliation', () => {
    assert.equal(countReconciliationWrites([]), 0);
    assert.equal(countReconciliationWrites(['stable', 'stable']), 0);
    assert.equal(countReconciliationWrites(['before', 'after', 'after']), 1);
    assert.equal(countReconciliationWrites(['one', 'two', 'three']), 2);
  });

  it('fails closed when repository live-driver credentials are absent', () => {
    assert.throws(
      () =>
        repositoryKubernetesRollbackKindConfigFromEnv({
          COMMANDER_KUBERNETES_PROOF_API_URL: 'http://commander.test',
          COMMANDER_KUBERNETES_PROOF_TENANT_ID: 'tenant-a',
        }),
      /COMMANDER_API_KEY_REQUIRED/,
    );
    assert.deepEqual(
      repositoryKubernetesRollbackKindConfigFromEnv({
        COMMANDER_KUBERNETES_PROOF_API_URL: 'http://commander.test',
        COMMANDER_API_KEY: 'proof-key',
        COMMANDER_KUBERNETES_PROOF_TENANT_ID: 'tenant-a',
        COMMANDER_KUBERNETES_CLUSTER: 'kind-proof',
        COMMANDER_KUBERNETES_PROOF_NAMESPACE: 'proof-ns',
      }),
      {
        apiBaseUrl: 'http://commander.test',
        apiKey: 'proof-key',
        tenantId: 'tenant-a',
        cluster: 'kind-proof',
        namespace: 'proof-ns',
        deployment: 'rollback-target',
        workerNamespace: 'commander',
        workerSelector: 'app.kubernetes.io/component=worker',
        controlPlaneContainer: 'kind-proof-control-plane',
        auditLogPath: '/var/log/kubernetes/audit.log',
        deadlineMs: 60_000,
      },
    );
  });

  it('owns the live Kind fixture and observes two distinct deployment revisions', async () => {
    const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    let deploymentReads = 0;
    const driver = createRepositoryKubernetesRollbackKindDriver({
      config: {
        apiBaseUrl: 'http://commander.test',
        apiKey: 'proof-key',
        tenantId: 'tenant-a',
        cluster: 'kind-proof',
        namespace: 'commander-proof',
        deployment: 'rollback-target',
        workerNamespace: 'commander-system',
        workerSelector: 'app.kubernetes.io/component=worker',
        controlPlaneContainer: 'kind-proof-control-plane',
        auditLogPath: '/var/log/kubernetes/audit.log',
        deadlineMs: 30_000,
      },
      ports: {
        async run(command, args, options): Promise<KubernetesRollbackCommandResult> {
          calls.push({ command, args: [...args], stdin: options?.stdin });
          if (args.includes('get') && args.includes('deployment/rollback-target')) {
            deploymentReads += 1;
            return {
              stdout: JSON.stringify({
                metadata: {
                  annotations: {
                    'deployment.kubernetes.io/revision': String(deploymentReads),
                  },
                },
              }),
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
        async fetch() {
          throw new Error('fixture creation must not call Commander');
        },
        now: () => 1_000,
        sleep: async () => {},
      },
    });

    const fixture = await driver.createDeploymentWithTwoRevisions();

    assert.equal(fixture.expectedRevision, '1');
    assert.equal(fixture.originalRevision, '2');
    assert.match(fixture.marker, /^[a-f0-9]{64}$/);
    assert.equal(deploymentReads, 2);
    const applied = calls.filter((call) => call.args.includes('apply'));
    assert.equal(applied.length, 3, 'namespace plus two deployment revisions');
    assert.match(applied[1]!.stdin ?? '', /proof-revision: "1"/);
    assert.match(applied[2]!.stdin ?? '', /proof-revision: "2"/);
    assert.equal(
      calls.filter((call) => call.args.includes('rollout') && call.args.includes('status')).length,
      2,
    );
  });

  it('submits the rollback through Commander before killing and restarting the worker', async () => {
    const events: string[] = [];
    const driver = createRepositoryKubernetesRollbackKindDriver({
      config: {
        apiBaseUrl: 'http://commander.test',
        apiKey: 'proof-key',
        tenantId: 'tenant-a',
        cluster: 'kind-proof',
        namespace: 'commander-proof',
        deployment: 'rollback-target',
        workerNamespace: 'commander-system',
        workerSelector: 'app.kubernetes.io/component=worker',
        controlPlaneContainer: 'kind-proof-control-plane',
        auditLogPath: '/var/log/kubernetes/audit.log',
        deadlineMs: 30_000,
      },
      ports: {
        async run(command, args) {
          events.push(`${command} ${args.join(' ')}`);
          if (args.includes('deployments')) {
            return {
              stdout: JSON.stringify({
                items: [
                  {
                    metadata: {
                      annotations: {
                        'commander.io/action-marker': 'b'.repeat(64),
                        'commander.io/action-target-revision': '1',
                      },
                    },
                    spec: { template: { metadata: { labels: { 'proof-revision': '1' } } } },
                  },
                ],
              }),
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
        async fetch(input, init) {
          events.push(`fetch ${init?.method ?? 'GET'}`);
          const headers = new Headers(init?.headers);
          assert.equal(headers.get('x-api-key'), 'proof-key');
          assert.equal(headers.get('x-tenant-id'), 'tenant-a');
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if (String(input).endsWith('/approve')) {
            assert.equal(body.actionDigest, 'a'.repeat(64));
            return Response.json({ action: { state: 'ADMITTED' } });
          }
          assert.equal(body.effectType, 'connector.kubernetes.deployment.rollback');
          assert.equal(
            body.destination,
            'k8s://kind-proof/commander-proof/deployments/rollback-target',
          );
          assert.deepEqual(body.args, {
            targetRevision: '1',
            reason: 'kind controlled-change rollback proof',
          });
          return Response.json(
            {
              action: {
                runId: 'run-1',
                effectId: 'effect-1',
                actionDigest: 'a'.repeat(64),
                state: 'AWAITING_APPROVAL',
                simulation: {
                  actionDigest: 'a'.repeat(64),
                  simulationId: 'simulation-1',
                  policySnapshotId: 'policy-1',
                },
              },
              idempotentReplay: false,
            },
            { status: 202 },
          );
        },
        now: () => 1_000,
        sleep: async () => {},
      },
    });

    const submission = await driver.submitGovernedRollback({
      marker: 'b'.repeat(64),
      expectedRevision: '1',
      originalRevision: '2',
    });
    await driver.killWorkerAfterAcceptedApiCall();
    await driver.restartWorker();

    assert.equal(submission.accepted, true);
    assert.equal(submission.runId, 'run-1');
    assert.deepEqual(events, [
      'fetch POST',
      'fetch POST',
      'kubectl --context kind-kind-proof --namespace commander-proof get deployments -o json',
      'kubectl --context kind-kind-proof --namespace commander-system delete pod --selector app.kubernetes.io/component=worker --wait=true',
      'kubectl --context kind-kind-proof --namespace commander-system wait --for=condition=Ready pod --selector app.kubernetes.io/component=worker --timeout=30s',
    ]);
  });

  it('collects independent Kubernetes observations and receipt dispositions after restart', async () => {
    const marker = 'b'.repeat(64);
    const calls: string[] = [];
    const receipt = {
      scope: { tenantId: 'tenant-a', runId: 'run-1', effectId: 'effect-1' },
      exportedAt: new Date(1_200).toISOString(),
      actionDigest: 'a'.repeat(64),
      terminalDisposition: 'ESCALATED',
      effects: [
        {
          effectId: 'effect-1',
          type: 'connector.kubernetes.deployment.rollback',
          state: 'COMPLETED',
          requestHash: 'a'.repeat(64),
        },
        {
          effectId: 'compensation-1',
          type: 'compensate.kubernetes.deployment.rollback',
          state: 'COMPLETED',
          requestHash: 'c'.repeat(64),
        },
        {
          effectId: 'unknown-1',
          type: 'connector.kubernetes.deployment.rollback',
          state: 'COMPLETION_UNKNOWN',
          requestHash: 'd'.repeat(64),
        },
      ],
      auditEvents: [
        {
          type: 'effect.reconcile_escalated',
          at: new Date(1_190).toISOString(),
          details: { effectId: 'unknown-1', escalationRecordId: 'escalation-1' },
        },
      ],
    };
    const unknownReceipt = {
      ...receipt,
      scope: { tenantId: 'tenant-a', runId: 'run-unknown', effectId: 'unknown-1' },
      effects: receipt.effects.filter((effect) => effect.effectId === 'unknown-1'),
    };
    let now = 1_000;
    let proposalCount = 0;
    let unknownStatusCount = 0;
    const driver = createRepositoryKubernetesRollbackKindDriver({
      config: {
        apiBaseUrl: 'http://commander.test',
        apiKey: 'proof-key',
        tenantId: 'tenant-a',
        cluster: 'kind-proof',
        namespace: 'commander-proof',
        deployment: 'rollback-target',
        workerNamespace: 'commander-system',
        workerSelector: 'app.kubernetes.io/component=worker',
        controlPlaneContainer: 'kind-proof-control-plane',
        auditLogPath: '/var/log/kubernetes/audit.log',
        deadlineMs: 30_000,
      },
      ports: {
        async run(command, args) {
          calls.push(`${command} ${args.join(' ')}`);
          if (command === 'docker') {
            return {
              stdout: `${JSON.stringify({
                auditID: 'audit-write-1',
                stage: 'ResponseComplete',
                verb: 'patch',
                requestReceivedTimestamp: new Date(1_000).toISOString(),
                objectRef: {
                  resource: 'deployments',
                  namespace: 'commander-proof',
                  name: 'rollback-target',
                },
                requestObject: {
                  metadata: { annotations: { 'commander.io/action-marker': marker } },
                },
                responseStatus: { code: 200 },
              })}\n`,
              stderr: '',
            };
          }
          if (args.includes('deployments')) {
            return {
              stdout: JSON.stringify({
                items: [
                  {
                    metadata: {
                      annotations: {
                        'commander.io/action-marker': marker,
                        'commander.io/action-target-revision': '1',
                      },
                    },
                    spec: { template: { metadata: { labels: { 'proof-revision': '1' } } } },
                  },
                ],
              }),
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        },
        async fetch(input, init) {
          const url = String(input);
          const method = init?.method ?? 'GET';
          calls.push(`${method} ${url}`);
          if (method === 'POST' && url.endsWith('/v1/actions')) {
            proposalCount += 1;
            const unknown = proposalCount === 2;
            return Response.json(
              {
                action: {
                  runId: unknown ? 'run-unknown' : 'run-1',
                  effectId: unknown ? 'unknown-1' : 'effect-1',
                  actionDigest: unknown ? 'd'.repeat(64) : 'a'.repeat(64),
                  state: 'AWAITING_APPROVAL',
                  simulation: {
                    actionDigest: unknown ? 'd'.repeat(64) : 'a'.repeat(64),
                    simulationId: unknown ? 'simulation-unknown' : 'simulation-1',
                    policySnapshotId: unknown ? 'policy-unknown' : 'policy-1',
                  },
                },
                idempotentReplay: false,
              },
              { status: 202 },
            );
          }
          if (method === 'POST' && url.endsWith('/approve')) {
            return Response.json({ action: { state: 'ADMITTED' } });
          }
          if (method === 'POST' && url.endsWith('/reconcile')) {
            return Response.json({ scheduled: true }, { status: 202 });
          }
          if (method === 'POST' && url.endsWith('/compensations')) {
            return Response.json(
              {
                state: 'AWAITING_APPROVAL',
                authorization: {
                  id: 'authorization-1',
                  actionDigest: 'e'.repeat(64),
                  policySnapshotId: 'policy-compensation-1',
                },
              },
              { status: 202 },
            );
          }
          if (method === 'POST' && url.endsWith('/compensations/authorization-1/approve')) {
            return Response.json({ accepted: true }, { status: 202 });
          }
          if (method === 'GET' && url.endsWith('/evidence')) {
            return Response.json({
              receipt: url.includes('/run-unknown/') ? unknownReceipt : receipt,
              verification: { ok: true },
            });
          }
          if (method === 'GET' && url.endsWith('/v1/actions/run-unknown')) {
            unknownStatusCount += 1;
            return Response.json({
              action: { state: unknownStatusCount < 2 ? 'COMPLETION_UNKNOWN' : 'ESCALATED' },
            });
          }
          if (method === 'GET' && url.endsWith('/v1/actions/run-1')) {
            now += 25;
            return Response.json({
              action: { state: now < 1_200 ? 'COMPLETION_UNKNOWN' : 'SUCCEEDED' },
            });
          }
          throw new Error(`unexpected request ${method} ${url}`);
        },
        now: () => now,
        sleep: async () => {
          now += 25;
        },
      },
    });
    const submission = await driver.submitGovernedRollback({
      marker,
      expectedRevision: '1',
      originalRevision: '2',
    });
    await driver.killWorkerAfterAcceptedApiCall();
    await driver.restartWorker();

    const observation = await driver.collectObservation({
      marker,
      expectedRevision: '1',
      submission,
    });

    assert.equal(observation.reconciliation.outcome, 'APPLIED');
    assert.equal(observation.reconciliation.writeCount, 1);
    assert.equal(observation.reconciliation.writesDuringReconciliation, 0);
    assert.equal(observation.observations.length, 2);
    assert.equal(observation.compensationDisposition, 'APPLIED');
    assert.equal(observation.compensationEffectId, 'compensation-1');
    assert.equal(observation.irreducibleUnknown.disposition, 'ESCALATED');
    assert.equal(observation.irreducibleUnknown.escalationRecordId, 'escalation-1');
    assert.deepEqual(observation.receipt, receipt);
    assert.ok(calls.some((call) => call.includes('/approve')));
    assert.ok(calls.filter((call) => call.includes(' get deployments -o json')).length >= 3);
  });

  it('does not claim PROVEN when the marker matches two deployments', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        observations: [
          { marker: 'commander:tenant-a:rollback-1', markerMatches: 2, revision: '7' },
          { marker: 'commander:tenant-a:rollback-1', markerMatches: 2, revision: '7' },
        ],
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('MARKER_MATCH_COUNT_INVALID'));
    assert.equal(kubernetesRollbackProofExitCode(result), 1);
  });

  it('does not claim PROVEN without an independently verified signed receipt', () => {
    const result = assessKubernetesRollbackProof(observed({ signedReceiptVerified: false }));

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('SIGNED_RECEIPT_REQUIRED'));
    assert.equal(kubernetesRollbackProofExitCode(result), 1);
  });

  it('keeps a live-driver run NOT_READY when no receipt and JWKS are collected', async () => {
    const result = await runKubernetesRollbackKindProof({
      async createDeploymentWithTwoRevisions() {
        return {
          marker: 'commander:tenant-a:rollback-1',
          expectedRevision: '7',
          originalRevision: '8',
        };
      },
      async submitGovernedRollback() {
        return {
          accepted: true,
          tenantId: 'tenant-a',
          runId: 'run-1',
          effectId: 'effect-1',
          actionDigest: 'a'.repeat(64),
          requestHash: 'b'.repeat(64),
          effectType: 'connector.kubernetes.deployment.rollback',
          destination: 'k8s://kind/commander/deployments/api',
          marker: 'commander:tenant-a:rollback-1',
          targetRevision: '7',
        };
      },
      async killWorkerAfterAcceptedApiCall() {},
      async restartWorker() {},
      async collectObservation() {
        const proof = observed();
        return {
          observations: proof.observations,
          reconciliation: proof.reconciliation,
          compensationDisposition: proof.compensationDisposition,
          irreducibleUnknown: proof.irreducibleUnknown,
        };
      },
    });

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('TRUSTED_JWKS_REQUIRED'));
    assert.ok(result.failures.includes('SIGNED_RECEIPT_REQUIRED'));
  });

  it('does not claim PROVEN when a Kind proof prerequisite is absent', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        prerequisites: {
          kindNamespaceReady: false,
          twoRevisionsObserved: true,
          governedRollbackAccepted: true,
          workerKilledAfterAcceptance: true,
          workerRestarted: true,
        },
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('KIND_PROOF_PREREQUISITES_REQUIRED'));
  });

  it('does not claim PROVEN after a reconciliation write', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        reconciliation: {
          outcome: 'APPLIED',
          startedAtMs: 1_000,
          resolvedAtMs: 1_500,
          deadlineAtMs: 2_000,
          observedAtMs: 1_500,
          writeCount: 2,
          writesDuringReconciliation: 1,
          queryFirstRecoveryObserved: true,
          auditEvidenceAvailable: true,
          writeAuditIds: ['audit-write-1', 'audit-write-2'],
        },
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('RECONCILIATION_WRITE_FORBIDDEN'));
    assert.equal(kubernetesRollbackProofExitCode(result), 1);
  });

  it('does not claim PROVEN when UNKNOWN remains unresolved beyond its deadline', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        reconciliation: {
          outcome: 'UNKNOWN',
          startedAtMs: 1_000,
          deadlineAtMs: 2_000,
          observedAtMs: 2_001,
          writeCount: 1,
          writesDuringReconciliation: 0,
          queryFirstRecoveryObserved: true,
          auditEvidenceAvailable: true,
          writeAuditIds: ['audit-write-1'],
        },
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('UNKNOWN_UNRESOLVED_BEYOND_DEADLINE'));
    assert.equal(kubernetesRollbackProofExitCode(result), 1);
  });

  it('does not claim PROVEN when a non-UNKNOWN outcome lacks a bounded resolution timestamp', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        reconciliation: {
          outcome: 'APPLIED',
          startedAtMs: 1_000,
          deadlineAtMs: 2_000,
          observedAtMs: 1_500,
          writeCount: 1,
          writesDuringReconciliation: 0,
          queryFirstRecoveryObserved: true,
          auditEvidenceAvailable: true,
          writeAuditIds: ['audit-write-1'],
        },
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('RECONCILIATION_RESOLUTION_REQUIRED'));
  });

  it('does not claim PROVEN when reconciliation observes NOT_APPLIED', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        reconciliation: {
          outcome: 'NOT_APPLIED',
          startedAtMs: 1_000,
          resolvedAtMs: 1_500,
          deadlineAtMs: 2_000,
          observedAtMs: 1_500,
          writeCount: 1,
          writesDuringReconciliation: 0,
          queryFirstRecoveryObserved: true,
          auditEvidenceAvailable: true,
          writeAuditIds: ['audit-write-1'],
        },
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('ROLLBACK_NOT_APPLIED'));
  });

  it('does not claim PROVEN without a completed compensation proof', () => {
    const result = assessKubernetesRollbackProof(observed({ compensationDisposition: 'NOT_RUN' }));

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('COMPENSATION_PROOF_REQUIRED'));
  });

  it('does not claim PROVEN for invalid runtime driver enum values', () => {
    const invalid = observed() as unknown as {
      reconciliation: KubernetesRollbackProofObservation['reconciliation'];
      compensationDisposition: KubernetesRollbackProofObservation['compensationDisposition'];
    };
    invalid.reconciliation.outcome = 'BOGUS' as never;
    invalid.compensationDisposition = 'BOGUS' as never;

    const result = assessKubernetesRollbackProof(
      invalid as unknown as KubernetesRollbackProofObservation,
    );
    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('DRIVER_OBSERVATION_INVALID'));
  });

  it('rejects boxed enums and string-valued timestamps from dynamic drivers', () => {
    const invalid = observed() as unknown as Record<string, unknown>;
    const reconciliation = invalid.reconciliation as Record<string, unknown>;
    const irreducibleUnknown = invalid.irreducibleUnknown as Record<string, unknown>;
    reconciliation.outcome = new String('APPLIED');
    irreducibleUnknown.startedAtMs = '2100';

    const result = assessKubernetesRollbackProof(
      invalid as unknown as KubernetesRollbackProofObservation,
    );
    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('DRIVER_OBSERVATION_INVALID'));
  });

  it('does not claim PROVEN for an observation before reconciliation starts', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        reconciliation: {
          outcome: 'APPLIED',
          startedAtMs: 1_000,
          resolvedAtMs: 1_500,
          deadlineAtMs: 2_000,
          observedAtMs: 999,
          writeCount: 1,
          writesDuringReconciliation: 0,
          queryFirstRecoveryObserved: true,
          auditEvidenceAvailable: true,
          writeAuditIds: ['audit-write-1'],
        },
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('RECONCILIATION_TIMING_INVALID'));
  });

  it('requires a bounded irreducible-unknown escalation record', () => {
    const result = assessKubernetesRollbackProof(
      observed({
        irreducibleUnknown: {
          injected: true,
          disposition: 'NOT_RUN',
          startedAtMs: 2_100,
          deadlineAtMs: 3_100,
          writesDuringReconciliation: 0,
        },
      }),
    );

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('UNKNOWN_ESCALATION_PROOF_REQUIRED'));
  });

  it('correlates a trusted receipt to the exact governed Kubernetes submission', () => {
    const proof = observed();
    const now = Date.now();
    const proofWindow = { startedAtMs: now - 10, completedAtMs: now + 10 };
    const submission: KubernetesGovernedRollbackSubmission = {
      accepted: true,
      tenantId: 'tenant-a',
      runId: 'run-1',
      effectId: 'effect-1',
      actionDigest: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      effectType: 'connector.kubernetes.deployment.rollback',
      destination: 'k8s://kind/commander/deployments/api',
      marker: 'commander:tenant-a:rollback-1',
      targetRevision: '7',
    };
    const receipt = {
      scope: { tenantId: 'tenant-a', runId: 'run-1', effectId: 'effect-1' },
      exportedAt: new Date(now).toISOString(),
      signature: { signedAt: new Date(now).toISOString() },
      actionDigest: 'a'.repeat(64),
      terminalDisposition: 'ESCALATED',
      effects: [
        {
          effectId: 'effect-1',
          type: 'connector.kubernetes.deployment.rollback',
          state: 'COMPLETED',
          requestHash: 'b'.repeat(64),
        },
        {
          effectId: 'compensation-1',
          type: 'compensate.kubernetes.deployment.rollback',
          state: 'COMPLETED',
          requestHash: 'c'.repeat(64),
        },
        {
          effectId: 'unknown-1',
          type: 'connector.kubernetes.deployment.rollback',
          state: 'COMPLETION_UNKNOWN',
          requestHash: 'd'.repeat(64),
        },
      ],
      auditEvents: [
        {
          type: 'kubernetes.rollback.observed',
          details: {
            destination: 'k8s://kind/commander/deployments/api',
            marker: 'commander:tenant-a:rollback-1',
            targetRevision: '7',
          },
        },
        {
          type: 'effect.reconcile_escalated',
          details: { effectId: 'unknown-1', escalationRecordId: 'escalation-1' },
        },
      ],
    } as unknown as Parameters<typeof receiptMatchesGovernedRollback>[0];

    assert.equal(receiptMatchesGovernedRollback(receipt, submission, proof, proofWindow), true);
    assert.equal(
      receiptMatchesGovernedRollback(
        {
          ...receipt,
          auditEvents: receipt.auditEvents.filter(
            (event) => event.type !== 'kubernetes.rollback.observed',
          ),
        },
        submission,
        proof,
        proofWindow,
      ),
      true,
    );
    assert.equal(
      receiptMatchesGovernedRollback(
        {
          ...receipt,
          scope: { ...receipt.scope, tenantId: 'tenant-b' },
        },
        submission,
        proof,
        proofWindow,
      ),
      false,
    );
    assert.equal(
      receiptMatchesGovernedRollback(
        {
          ...receipt,
          effects: [{ ...receipt.effects[0]!, type: 'http.write' }, ...receipt.effects.slice(1)],
        },
        submission,
        proof,
        proofWindow,
      ),
      false,
    );
    assert.equal(
      receiptMatchesGovernedRollback(
        {
          ...receipt,
          exportedAt: '2020-01-01T00:00:00.000Z',
          signature: { ...receipt.signature!, signedAt: '2020-01-01T00:00:00.000Z' },
        },
        submission,
        proof,
        proofWindow,
      ),
      false,
    );
  });

  it('requires stable marker and revision observations before reporting PROVEN', () => {
    const result = assessKubernetesRollbackProof(observed());

    assert.equal(result.verdict, 'PROVEN');
    assert.deepEqual(result.failures, []);
    assert.equal(kubernetesRollbackProofExitCode(result), 0);
    assert.equal(result.metrics.duplicateWriteCount, 0);
    assert.equal(result.metrics.reconciliationLatencyMs, 500);
  });
});
