import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTION_OPERATIONS_FAULT_POINTS,
  buildActionOperationsPreflight,
  parseActionOperationsProofArgs,
  runActionOperationsProof,
  verifyActionOperationsArtifactHashes,
  type ActionOperationsCampaignObservation,
  type ActionOperationsProofEnvironment,
} from './action-operations-proof.js';

const sha = (character: string): string => character.repeat(64);

function githubEnvironment(): ActionOperationsProofEnvironment {
  return {
    GITHUB_TOKEN: 'github-secret-token',
    COMMANDER_ACTION_PROOF_TENANT: 'proof-tenant',
    COMMANDER_ACTION_PROOF_DESTINATION: 'github://commander-proof/sandbox/pulls',
    COMMANDER_ACTION_PROOF_GATEWAY_URL: 'https://gateway.proof.invalid',
    COMMANDER_ACTION_PROOF_GATEWAY_PID: '101',
    COMMANDER_ACTION_PROOF_KERNEL_OPS_PID: '102',
    COMMANDER_ACTION_PROOF_ADAPTER_OPS_PID: '103',
    COMMANDER_ACTION_PROOF_APP_DATABASE_URL:
      'postgresql://commander_app:app-secret@db.proof.invalid/commander',
    COMMANDER_ACTION_PROOF_ADAPTER_OPS_DATABASE_URL:
      'postgresql://commander_adapter_ops:ops-secret@db.proof.invalid/commander',
    COMMANDER_ACTION_PROOF_OWNER_DATABASE_URL:
      'postgresql://commander_owner:owner-secret@db.proof.invalid/commander',
    COMMANDER_ACTION_PROOF_IMAGE: `ghcr.io/commander/api@sha256:${sha('a')}`,
    COMMANDER_ACTION_PROOF_PROTOCOL_VERSION: 'action-operations/v1',
    COMMANDER_ACTION_PROOF_CONTRACT_VERSION: 'v1',
    COMMANDER_ACTION_PROOF_POLICY_VERSION: 'proof-policy-v1',
    COMMANDER_ACTION_PROOF_ADAPTER_VERSION: 'github.pull-request.create/v1',
    COMMANDER_SIGNED_EVIDENCE: '1',
  };
}

function completeObservation(): ActionOperationsCampaignObservation {
  return {
    faultPoints: [...ACTION_OPERATIONS_FAULT_POINTS],
    counters: {
      forwardWrites: 1,
      forwardQueries: 1,
      compensationWrites: 1,
      compensationQueries: 1,
      duplicateWrites: 0,
      unresolvedUnknowns: 0,
      explicitEscalations: 0,
    },
    compensationAuthorizedSeparately: true,
    compensationDispositionAtomic: true,
    staleDrainReadinessDenied: true,
    evidenceVerified: true,
    log: { events: ['forward-query', 'compensation-query'] },
    evidence: { verification: 'valid' },
  };
}

describe('action-operations proof preflight', () => {
  it('requires an explicit real provider and the full fault campaign', () => {
    assert.throws(() => parseActionOperationsProofArgs([]), /--provider/);
    assert.throws(
      () => parseActionOperationsProofArgs(['--provider', 'mock', '--fault-campaign', 'full']),
      /github\|servicenow/,
    );
    assert.throws(
      () => parseActionOperationsProofArgs(['--provider', 'github']),
      /--fault-campaign full/,
    );
  });

  it("accepts pnpm's argument separator before the proof flags", () => {
    assert.deepEqual(
      parseActionOperationsProofArgs([
        '--',
        '--provider',
        'github',
        '--fault-campaign',
        'full',
        '--output',
        'artifacts/proof',
      ]),
      { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
    );
  });

  it('rejects missing credentials, fake destinations, non-Postgres storage, and shared processes', () => {
    const cases: Array<[string, (environment: ActionOperationsProofEnvironment) => void]> = [
      [
        'GITHUB_TOKEN',
        (environment) => {
          delete environment.GITHUB_TOKEN;
        },
      ],
      [
        'destination',
        (environment) => {
          environment.COMMANDER_ACTION_PROOF_DESTINATION = 'github://octo/example';
        },
      ],
      [
        'PostgreSQL',
        (environment) => {
          environment.COMMANDER_ACTION_PROOF_APP_DATABASE_URL = 'file:local.db';
        },
      ],
      [
        'distinct',
        (environment) => {
          environment.COMMANDER_ACTION_PROOF_ADAPTER_OPS_PID = '101';
        },
      ],
      [
        'signed evidence',
        (environment) => {
          delete environment.COMMANDER_SIGNED_EVIDENCE;
        },
      ],
    ];

    for (const [expected, mutate] of cases) {
      const environment = githubEnvironment();
      mutate(environment);
      assert.throws(
        () =>
          buildActionOperationsPreflight(
            { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
            environment,
          ),
        new RegExp(expected, 'i'),
      );
    }
  });

  it('fails before invoking any campaign port when metadata is incomplete', async () => {
    const environment = githubEnvironment();
    delete environment.COMMANDER_ACTION_PROOF_POLICY_VERSION;
    let campaignCalls = 0;
    await assert.rejects(
      () =>
        runActionOperationsProof(
          { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
          {
            environment,
            source: async () => ({
              commit: sha('b'),
              dirty: false,
              trackedDiffSha256: sha('c'),
              untrackedFiles: [],
            }),
            runCampaign: async () => {
              campaignCalls += 1;
              return completeObservation();
            },
          },
        ),
      /POLICY_VERSION/,
    );
    assert.equal(campaignCalls, 0);
  });
});

describe('action-operations proof artifacts', () => {
  it('emits PROVEN only for a clean full real-provider campaign', async () => {
    const result = await runActionOperationsProof(
      { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
      {
        environment: githubEnvironment(),
        source: async () => ({
          commit: sha('b'),
          dirty: false,
          trackedDiffSha256: sha('c'),
          untrackedFiles: [],
        }),
        runCampaign: async () => completeObservation(),
        now: (() => {
          const values = ['2026-07-29T00:00:00.000Z', '2026-07-29T00:00:01.000Z'];
          return () => values.shift() ?? '2026-07-29T00:00:01.000Z';
        })(),
      },
    );
    assert.equal(result.passed, true);
    assert.equal(result.evidenceLevel, 'PROVEN');
    assert.deepEqual(result.metadata.fault.injectionPoints, ACTION_OPERATIONS_FAULT_POINTS);
    assert.deepEqual(verifyActionOperationsArtifactHashes(result), []);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /github-secret-token|app-secret|ops-secret|owner-secret/);
  });

  it('rejects dirty source, missing faults, invalid counters, and artifact tampering', async () => {
    const basePorts = {
      environment: githubEnvironment(),
      source: async () => ({
        commit: sha('b'),
        dirty: false,
        trackedDiffSha256: sha('c'),
        untrackedFiles: [],
      }),
    };
    await assert.rejects(
      () =>
        runActionOperationsProof(
          { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
          {
            ...basePorts,
            source: async () => ({
              commit: sha('b'),
              dirty: true,
              trackedDiffSha256: sha('c'),
              untrackedFiles: [],
            }),
            runCampaign: async () => completeObservation(),
          },
        ),
      /clean source/i,
    );
    await assert.rejects(
      () =>
        runActionOperationsProof(
          { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
          {
            ...basePorts,
            runCampaign: async () => ({
              ...completeObservation(),
              faultPoints: ACTION_OPERATIONS_FAULT_POINTS.slice(1),
            }),
          },
        ),
      /fault point/i,
    );
    await assert.rejects(
      () =>
        runActionOperationsProof(
          { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
          {
            ...basePorts,
            runCampaign: async () => ({
              ...completeObservation(),
              counters: { ...completeObservation().counters, forwardWrites: 2 },
            }),
          },
        ),
      /forwardWrites=1/,
    );

    const valid = await runActionOperationsProof(
      { provider: 'github', faultCampaign: 'full', output: 'artifacts/proof' },
      { ...basePorts, runCampaign: async () => completeObservation() },
    );
    valid.artifacts.log.body = '{"tampered":true}\n';
    assert.match(verifyActionOperationsArtifactHashes(valid).join('\n'), /log/i);
  });
});
