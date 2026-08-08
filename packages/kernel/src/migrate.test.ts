import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTask1OwnerCommandMode,
  parseTask1ClosureMigrationPhase,
  resolveMigrationDatabaseUrl,
  runTask1OwnerMode,
  currentTask1Operation,
  createTask1ProofRuntime,
  migrationFailureDiagnostic,
  readTask1OwnerInput,
  seedTenantAuthorityAllowedTenants,
  shouldSeedTenantAuthorityAllowedTenants,
} from './migrate.js';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import type { Task1RolloutProofReceipt } from './task1RolloutProof.js';

describe('kernel owner migration entrypoint', () => {
  const digest = (value: string): string => value.repeat(64).slice(0, 64);

  it('uses the dedicated owner DSN before legacy migration variables', () => {
    assert.equal(
      resolveMigrationDatabaseUrl({
        COMMANDER_OWNER_DATABASE_URL: 'postgres://owner',
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel',
        DATABASE_URL: 'postgres://legacy',
      }),
      'postgres://owner',
    );
  });

  it('reports only fixed migration stages and sanitized error codes', () => {
    const databaseError = Object.assign(new Error('password authentication failed for user foo'), {
      code: '28P01',
    });
    assert.equal(
      migrationFailureDiagnostic('kernel-migrations', databaseError),
      'stage=kernel-migrations code=28P01',
    );
    assert.equal(
      migrationFailureDiagnostic(
        'adapter-ops-login',
        new Error('COMMANDER_DATABASE_SERVER_SPKI_MISMATCH'),
      ),
      'stage=adapter-ops-login code=COMMANDER_DATABASE_SERVER_SPKI_MISMATCH',
    );
    assert.equal(
      migrationFailureDiagnostic('worker-tenant-seed', {
        code: 'unsafe code postgres://owner:secret@db',
      }),
      'stage=worker-tenant-seed',
    );
  });

  it('retains a bounded proof invariant detail alongside its machine error code', () => {
    const proofError = Object.assign(new Error('proof details must not be trusted'), {
      code: 'TENANT_CUTOVER_KUBERNETES_PROOF_INVALID',
      diagnostic: 'task1KubernetesProofObserver.ts:761:7',
    });
    assert.equal(
      migrationFailureDiagnostic('owner-command', proofError),
      'stage=owner-command code=TENANT_CUTOVER_KUBERNETES_PROOF_INVALID detail=task1KubernetesProofObserver.ts:761:7',
    );
  });

  it('runs closure descriptors only for the explicit phase-bound action', () => {
    assert.equal(parseTask1ClosureMigrationPhase([], {}), undefined);
    assert.equal(
      parseTask1ClosureMigrationPhase(['tenant-cutover-migrate'], {
        COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'expand',
      }),
      'expand',
    );
    assert.equal(
      parseTask1ClosureMigrationPhase(['tenant-cutover-migrate'], {
        COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'enforce',
      }),
      'enforce',
    );
    assert.throws(
      () => parseTask1ClosureMigrationPhase(['tenant-cutover-migrate'], {}),
      /TASK1_CLOSURE_PHASE_REQUIRED/,
    );
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-plan'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-append'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-recover'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-prove'), true);
    assert.equal(isTask1OwnerCommandMode('tenant-cutover-restore'), true);
    assert.equal(isTask1OwnerCommandMode('migration'), false);
  });

  it('seeds the closure tenant authority allowlist with parameterized owner queries', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
      },
    };

    await seedTenantAuthorityAllowedTenants(client, [' tenant-a ', 'tenant-b']);

    assert.equal(calls.length, 2);
    assert.match(
      calls[0]!.sql,
      /INSERT INTO public\.commander_tenant_authority_allowed_tenants \(tenant_id, enabled\)/i,
    );
    assert.match(calls[0]!.sql, /VALUES \(\$1, true\)/i);
    assert.match(calls[0]!.sql, /ON CONFLICT \(tenant_id\) DO UPDATE SET enabled = true/i);
    assert.deepEqual(
      calls.map((call) => call.values),
      [['tenant-a'], ['tenant-b']],
    );
    assert.doesNotMatch(calls[0]!.sql, /tenant-a|tenant-b/);

    await seedTenantAuthorityAllowedTenants(client, []);
    assert.equal(calls.length, 2, 'empty tenant input must not query the closure table');
    await assert.rejects(
      () => seedTenantAuthorityAllowedTenants(client, ['  ']),
      /TENANT_AUTHORITY_ALLOWED_TENANT_INVALID/,
    );
    await assert.rejects(
      () => seedTenantAuthorityAllowedTenants(client, ['*']),
      /TENANT_AUTHORITY_ALLOWED_TENANT_INVALID/,
    );
    assert.equal(calls.length, 2, 'invalid tenant input must not query the closure table');
  });

  it('gates authority allowlist seeding on applied closure phase and non-empty tenants', () => {
    assert.equal(shouldSeedTenantAuthorityAllowedTenants(undefined, ['tenant-a']), false);
    assert.equal(shouldSeedTenantAuthorityAllowedTenants('expand', []), false);
    assert.equal(shouldSeedTenantAuthorityAllowedTenants('expand', ['tenant-a']), true);
    assert.equal(shouldSeedTenantAuthorityAllowedTenants('enforce', ['tenant-a']), true);
    assert.equal(shouldSeedTenantAuthorityAllowedTenants('enforce', []), false);
  });

  it('reads owner requests only from stdin or the fixed in-cluster request mount', async () => {
    let stdinReads = 0;
    let fileReads = 0;
    assert.equal(
      await readTask1OwnerInput(
        {},
        async () => {
          stdinReads += 1;
          return '{"source":"stdin"}';
        },
        async () => {
          fileReads += 1;
          return '';
        },
      ),
      '{"source":"stdin"}',
    );
    assert.equal(stdinReads, 1);
    assert.equal(fileReads, 0);

    assert.equal(
      await readTask1OwnerInput(
        { COMMANDER_TENANT_CUTOVER_INPUT_FILE: '/run/commander/tenant-cutover/request.json' },
        async () => {
          throw new Error('stdin must not be read');
        },
        async (path, encoding) => {
          fileReads += 1;
          assert.equal(path, '/run/commander/tenant-cutover/request.json');
          assert.equal(encoding, 'utf8');
          return '{"source":"file"}';
        },
      ),
      '{"source":"file"}',
    );
    assert.equal(fileReads, 1);

    await assert.rejects(
      readTask1OwnerInput(
        { COMMANDER_TENANT_CUTOVER_INPUT_FILE: '/tmp/request.json' },
        async () => '',
        async () => '',
      ),
      /TENANT_CUTOVER_INPUT_FILE_INVALID/,
    );
    await assert.rejects(
      readTask1OwnerInput(
        {},
        async () => 'x'.repeat(128 * 1024 + 1),
        async () => '',
      ),
      /TENANT_CUTOVER_INPUT_TOO_LARGE/,
    );
  });

  it('wires prove mode to the atomic proof runtime instead of the current-row boolean', async () => {
    const operation = {
      installation_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operation_version: '7',
      predecessor_state_version: '6',
      resulting_state_version: '7',
      predecessor_state: 'expanded',
      resulting_state: 'enforced',
      operation_kind: 'enforce',
      runtime_phase: 'enforce',
      platform_kind: 'compose',
      previous_binding_jcs: null,
      previous_binding_sha256: null,
      requested_binding_jcs: '{"kind":"compose"}',
      requested_binding_sha256: 'a'.repeat(64),
      previous_configuration_jcs: null,
      previous_configuration_sha256: null,
      requested_configuration_jcs: '{}',
      requested_configuration_sha256: 'b'.repeat(64),
      previous_business_configuration_sha256: null,
      requested_business_configuration_sha256: 'c'.repeat(64),
      origin_binding_sha256: 'd'.repeat(64),
      database_peer_binding_sha256: 'e'.repeat(64),
      proof_key_sha256: 'f'.repeat(64),
      descriptor_set: [],
      predecessor_evidence_jcs: '{}',
      predecessor_evidence_sha256: '1'.repeat(64),
      result: 'committed',
    };
    let provedVersion: string | undefined;
    const pool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? {
              rows: [
                {
                  state_table: 'commander_tenant_cutover_state',
                  operation_table: 'commander_tenant_cutover_operations',
                },
              ],
              rowCount: 1,
            }
          : { rows: [{ operation, proofs: [] }], rowCount: 1 },
    };
    const receipt: Task1RolloutProofReceipt = {
      operationVersion: '7',
      proofSequence: '1',
      proofAttemptId: '11111111-1111-4111-8111-111111111111',
      rolloutProofSha256: '9'.repeat(64),
    };
    const output = await runTask1OwnerMode('tenant-cutover-prove', '', pool as never, {
      proveCurrent: async (current) => {
        provedVersion = current.operationVersion;
        return receipt;
      },
    });
    assert.equal(provedVersion, '7');
    assert.equal(output.rolloutProofSha256, '9'.repeat(64));
  });

  it('selects exactly one contained platform proof runtime', () => {
    const pool = {} as never;
    assert.equal(createTask1ProofRuntime(pool, {}), undefined);
    assert.ok(
      createTask1ProofRuntime(pool, {
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET: '/tmp/relay.sock',
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT: 'attempt-1',
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN: 't'.repeat(43),
      }),
    );
    assert.ok(
      createTask1ProofRuntime(pool, {
        COMMANDER_KUBERNETES_PROOF_RUNTIME: '1',
        KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
        KUBERNETES_SERVICE_PORT_HTTPS: '443',
      }),
    );
    assert.throws(
      () =>
        createTask1ProofRuntime(pool, {
          COMMANDER_KUBERNETES_PROOF_RUNTIME: '1',
          KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
          KUBERNETES_SERVICE_PORT_HTTPS: '443',
          COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET: '/tmp/relay.sock',
          COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT: 'attempt-1',
          COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN: 't'.repeat(43),
        }),
      /TENANT_CUTOVER_PROOF_PLATFORM_AMBIGUOUS/,
    );
    assert.throws(
      () =>
        createTask1ProofRuntime(pool, {
          COMMANDER_KUBERNETES_PROOF_RUNTIME: '1',
          KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
        }),
      /TENANT_CUTOVER_KUBERNETES_CONFIGURATION_INVALID/,
    );
  });

  it('loads the immediate predecessor operation from the append-only ledger', async () => {
    const current = {
      installation_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operation_version: '7',
      predecessor_state_version: '6',
      resulting_state_version: '7',
      predecessor_state: 'expanded',
      resulting_state: 'enforced',
      operation_kind: 'enforce',
      runtime_phase: 'enforce',
      platform_kind: 'compose',
      previous_binding_jcs: '{"kind":"compose"}',
      previous_binding_sha256: '0'.repeat(64),
      requested_binding_jcs: '{"kind":"compose"}',
      requested_binding_sha256: 'a'.repeat(64),
      previous_configuration_jcs: '{}',
      previous_configuration_sha256: '0'.repeat(64),
      requested_configuration_jcs: '{}',
      requested_configuration_sha256: 'b'.repeat(64),
      previous_business_configuration_sha256: '0'.repeat(64),
      requested_business_configuration_sha256: 'c'.repeat(64),
      origin_binding_sha256: 'd'.repeat(64),
      database_peer_binding_sha256: 'e'.repeat(64),
      proof_key_sha256: 'f'.repeat(64),
      descriptor_set: [],
      predecessor_evidence_jcs: '{}',
      predecessor_evidence_sha256: '1'.repeat(64),
      result: 'committed',
    };
    const predecessor = {
      ...current,
      operation_version: '6',
      predecessor_state_version: '5',
      resulting_state_version: '6',
      operation_kind: 'legacy_expand',
      runtime_phase: 'expand',
    };
    const pool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : { rows: [{ operation: current, predecessor, proofs: [] }], rowCount: 1 },
    };
    const result = await currentTask1Operation(pool as never);
    assert.equal(result.operation?.operationVersion, '7');
    assert.equal(result.predecessor?.operationVersion, '6');
    assert.equal(result.predecessor?.operationKind, 'legacy_expand');
  });

  it('maps only a proven Helm proof projection into restore evidence', async () => {
    const binding = {
      kind: 'helm',
      namespace: 'commander',
      releaseName: 'commander',
      chartContentSha256: digest('a'),
      phase: 'enforce',
      apiImageDigest: `sha256:${digest('b')}`,
    };
    const configuration = { operationAuditNonce: 'n'.repeat(43) };
    const operation = {
      installation_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operation_version: '7',
      predecessor_state_version: '6',
      resulting_state_version: '7',
      predecessor_state: 'expanded',
      resulting_state: 'enforced',
      operation_kind: 'enforce',
      runtime_phase: 'enforce',
      platform_kind: 'helm',
      previous_binding_jcs: null,
      previous_binding_sha256: null,
      requested_binding_jcs: canonicalBootstrapJson(binding),
      requested_binding_sha256: canonicalBootstrapSha256(binding),
      previous_configuration_jcs: null,
      previous_configuration_sha256: null,
      requested_configuration_jcs: canonicalBootstrapJson(configuration),
      requested_configuration_sha256: canonicalBootstrapSha256(configuration),
      previous_business_configuration_sha256: null,
      requested_business_configuration_sha256: digest('c'),
      origin_binding_sha256: digest('d'),
      database_peer_binding_sha256: digest('e'),
      proof_key_sha256: digest('f'),
      descriptor_set: [],
      predecessor_evidence_jcs: canonicalBootstrapJson({ kind: 'fresh-no-predecessor/v1' }),
      predecessor_evidence_sha256: digest('1'),
      result: 'committed',
    };
    const platformArtifact = {
      format: 'helm-release-projection/v1',
      namespace: 'commander',
      releaseName: 'commander',
      revision: '12',
      chartContentSha256: digest('a'),
      objects: [],
      hooks: [],
      rendererInput: {
        format: 'helm-renderer-input-projection/v1',
        values: {
          tenantAuthority: { chartContentSha256: digest('a') },
          database: { existingSecret: 'commander-database' },
        },
        secretReferences: [],
      },
    };
    const challengedResponse = {
      challenge: 'c'.repeat(43),
      operationVersion: '7',
      phase: 'enforce',
      installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      databasePeerBindingSha256: digest('e'),
      imageDigest: `sha256:${digest('b')}`,
      configurationSha256: canonicalBootstrapSha256(configuration),
    };
    const proof = {
      format: 'rollout-proof/v1',
      installationId: operation.installation_uuid,
      operationVersion: '7',
      proofSequence: '2',
      proofAttemptId: '11111111-1111-4111-8111-111111111111',
      lifecycleCommand: 'enforce',
      topology: 'helm',
      configurationSha256: operation.requested_configuration_sha256,
      platformBindingSha256: operation.requested_binding_sha256,
      requestedImageDigest: `sha256:${digest('b')}`,
      proofKeySha256: operation.proof_key_sha256,
      challengedResponse,
      challengedResponseSha256: canonicalBootstrapSha256(challengedResponse),
      platformArtifact,
      platformArtifactSha256: canonicalBootstrapSha256(platformArtifact),
      workload: {
        uid: 'deployment-uid',
        generation: '1',
        observedGeneration: '1',
        templateSha256: digest('2'),
        ready: ['commander-api-1'],
      },
      startedAt: '2026-07-29T00:00:00.000Z',
      provenAt: '2026-07-29T00:00:01.000Z',
      pinned: { chart: digest('a') },
      metadata: {
        specRevision: 27,
        evidenceLevel: 'live',
        writeOwner: 'commander_owner',
        publicationPoint: 'commander_tenant_cutover_rollout_proofs',
      },
    };
    const pool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : {
              rows: [
                {
                  operation,
                  predecessor: null,
                  proofs: [
                    {
                      jcs: canonicalBootstrapJson(proof),
                      sha256: canonicalBootstrapSha256(proof),
                      sequence: '2',
                    },
                  ],
                },
              ],
              rowCount: 1,
            },
    };
    const result = await currentTask1Operation(pool as never);
    assert.equal(result.proven, true);
    assert.equal(result.restoreEvidence?.revision, '12');
    assert.equal(
      result.restoreEvidence?.releaseProjectionSha256,
      canonicalBootstrapSha256(platformArtifact),
    );

    const secretArtifact = {
      ...platformArtifact,
      objects: [
        {
          identity: { apiVersion: 'v1', kind: 'Secret', namespace: 'commander', name: 'db' },
          comparator: { format: 'kubernetes-field-comparator/v1', data: { url: 'fixture-secret' } },
          secretReferences: [],
        },
      ],
    };
    const secretProof = {
      ...proof,
      platformArtifact: secretArtifact,
      platformArtifactSha256: canonicalBootstrapSha256(secretArtifact),
    };
    const secretPool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : {
              rows: [
                {
                  operation,
                  predecessor: null,
                  proofs: [
                    {
                      jcs: canonicalBootstrapJson(secretProof),
                      sha256: canonicalBootstrapSha256(secretProof),
                      sequence: '2',
                    },
                  ],
                },
              ],
              rowCount: 1,
            },
    };
    const secretResult = await currentTask1Operation(secretPool as never);
    assert.equal(secretResult.proven, true);
    assert.equal(secretResult.restoreEvidence, undefined);

    const newerSecretProof = { ...secretProof, proofSequence: '3' };
    const mixedPool = {
      query: async (sql: string) =>
        sql.includes('to_regclass')
          ? { rows: [{ state_table: 'state', operation_table: 'operations' }], rowCount: 1 }
          : {
              rows: [
                {
                  operation,
                  predecessor: null,
                  proofs: [
                    {
                      jcs: canonicalBootstrapJson(proof),
                      sha256: canonicalBootstrapSha256(proof),
                      sequence: '2',
                    },
                    {
                      jcs: canonicalBootstrapJson(newerSecretProof),
                      sha256: canonicalBootstrapSha256(newerSecretProof),
                      sequence: '3',
                    },
                  ],
                },
              ],
              rowCount: 1,
            },
    };
    const mixedResult = await currentTask1Operation(mixedPool as never);
    assert.equal(mixedResult.proven, true);
    assert.equal(mixedResult.restoreEvidence, undefined);
  });
});
