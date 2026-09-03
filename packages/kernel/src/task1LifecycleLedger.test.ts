import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
  createDatabasePeerBinding,
  createDatabasePeerBindingInput,
  createOriginBinding,
  createPrebootstrapSnapshots,
} from './canonicalBootstrap.js';
import type { SqlClient, SqlPool, SqlQueryResult } from './postgres.js';
import {
  PostgresTask1LifecycleOwnerTransactions,
  TASK1_LIFECYCLE_DESCRIPTOR_SQL,
  TASK1_LIFECYCLE_LOCK_STATE_SQL,
  Task1LifecycleLedger,
  createTask1OperationAuditNonce,
  verifyTask1FreshPendingRetry,
  type Task1LifecycleLockedState,
  type Task1LifecycleOperation,
  type Task1LifecycleOwnerTransaction,
  type Task1LifecycleOwnerTransactions,
} from './task1LifecycleLedger.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);

function operation(overrides: Partial<Task1LifecycleOperation> = {}): Task1LifecycleOperation {
  return {
    installationUuid: 'installation-1',
    operationVersion: '7',
    predecessorStateVersion: '6',
    resultingStateVersion: '7',
    predecessorState: 'expanded',
    resultingState: 'enforced',
    operationKind: 'enforce',
    runtimePhase: 'enforce',
    platformKind: 'compose',
    previousBindingJcs: JSON.stringify(composeBindingForFixture('expand', digest('a'))),
    previousBindingSha256: digest('a'),
    requestedBindingJcs: '{"kind":"compose"}',
    requestedBindingSha256: digest('b'),
    previousConfigurationJcs: null,
    previousConfigurationSha256: digest('c'),
    requestedConfigurationJcs: '{"allowlist":["tenant-1"],"operationAuditNonce":"old-nonce"}',
    requestedConfigurationSha256: digest('d'),
    previousBusinessConfigurationSha256: digest('e'),
    requestedBusinessConfigurationSha256: digest('f'),
    originBindingSha256: digest('3'),
    databasePeerBindingSha256: digest('1'),
    proofKeySha256: digest('2'),
    descriptorSet: ['lifecycle', 'expand', 'enforce'],
    predecessorEvidenceJcs: '{"kind":"fresh-no-predecessor/v1"}',
    predecessorEvidenceSha256: digest('p'),
    predecessorProof: 'fresh-no-predecessor',
    result: 'committed',
    ...overrides,
  };
}

function composeBindingForFixture(phase: 'expand' | 'enforce', content = digest('b')) {
  return {
    kind: 'compose' as const,
    projectName: 'commander',
    composeVariant: 'prod' as const,
    composeCredentialInventory: 'runtime-v1' as const,
    composeSourceSha256: digest('s'),
    composeCliVersion: '5.3.1' as const,
    composeContentSha256: content,
    phase,
    apiImageDigest: `sha256:${digest(phase === 'expand' ? '4' : '5')}`,
    apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
  };
}

function lockedState(
  currentOperation: Task1LifecycleOperation | undefined = operation(),
  overrides: Partial<Task1LifecycleLockedState> = {},
): Task1LifecycleLockedState {
  return {
    installationUuid: 'installation-1',
    databaseState: 'enforced',
    stateVersion: '7',
    platformKind: 'compose',
    platformBindingSha256: currentOperation?.requestedBindingSha256 ?? digest('b'),
    databasePeerBindingSha256: digest('1'),
    proofKeySha256: digest('2'),
    originBindingSha256: digest('3'),
    pendingConfigurationSha256: null,
    currentConfigurationSha256: currentOperation?.requestedConfigurationSha256 ?? null,
    currentRuntimeOperationVersion: currentOperation?.operationVersion ?? null,
    recordedExpandOperation: operation({
      operationVersion: '4',
      resultingStateVersion: '4',
      operationKind: 'legacy_expand',
      runtimePhase: 'expand',
      requestedBindingSha256: digest('r'),
      requestedBusinessConfigurationSha256: digest('s'),
      requestedConfigurationJcs:
        '{"allowlist":["tenant-recorded"],"operationAuditNonce":"recorded-nonce"}',
      requestedConfigurationSha256: digest('t'),
      resultingState: 'expanded',
    }),
    currentOperation,
    ...overrides,
  };
}

class MemoryTransaction implements Task1LifecycleOwnerTransaction {
  appended: Task1LifecycleOperation[] = [];
  writes = 0;

  constructor(public state: Task1LifecycleLockedState) {}

  async lockState(): Promise<Task1LifecycleLockedState> {
    return this.state;
  }

  async appendOperation(value: Task1LifecycleOperation): Promise<void> {
    this.appended.push(value);
  }

  async compareAndSwapState(
    expected: Task1LifecycleLockedState,
    next: Task1LifecycleLockedState,
  ): Promise<boolean> {
    assert.equal(expected, this.state);
    this.state = next;
    this.writes += 1;
    return true;
  }
}

class MemoryTransactions implements Task1LifecycleOwnerTransactions {
  constructor(readonly transaction: MemoryTransaction) {}

  async withLockedOwnerTransaction<T>(
    work: (transaction: Task1LifecycleOwnerTransaction) => Promise<T>,
  ): Promise<T> {
    return work(this.transaction);
  }
}

function ledger(
  state: Task1LifecycleLockedState,
  nonces: string[] = ['fresh-nonce'],
): { ledger: Task1LifecycleLedger; tx: MemoryTransaction } {
  const tx = new MemoryTransaction(state);
  return {
    tx,
    ledger: new Task1LifecycleLedger(new MemoryTransactions(tx), {
      createNonce: () => {
        const nonce = nonces.shift();
        assert.ok(nonce, 'unexpected nonce generation');
        return nonce;
      },
    }),
  };
}

const composeBinding = composeBindingForFixture;

describe('Task 1 lifecycle operation ledger', () => {
  it('generates a 32-byte unpadded-base64url audit nonce by default', () => {
    const nonces = Array.from({ length: 16 }, createTask1OperationAuditNonce);
    assert.equal(new Set(nonces).size, nonces.length);
    for (const nonce of nonces) assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  });

  it('persists the complete nonce-bearing configuration and reuses it on an exact unproven retry', async () => {
    const current = operation({
      operationKind: 'recover_runtime_after_enforce_failure',
      requestedBindingJcs: JSON.stringify(composeBinding('expand')),
      requestedBindingSha256: digest('b'),
      requestedBusinessConfigurationSha256: digest('f'),
      requestedConfigurationJcs:
        '{"allowlist":["tenant-1"],"operationAuditNonce":"persisted-nonce"}',
    });
    const fixture = ledger(lockedState(current), []);

    const result = await fixture.ledger.execute({
      command: 'recover_runtime_after_enforce_failure',
      platformBinding: composeBinding('expand'),
      businessConfiguration: { allowlist: ['tenant-1'] },
      descriptorSet: [],
      verifyCurrent: async () => ({ status: 'absent' }),
      applyTransition: async () => assert.fail('retry must not write'),
    });

    assert.equal(result.action, 'retry_rollout');
    assert.equal(result.operation.operationVersion, '7');
    assert.deepEqual(JSON.parse(result.operation.requestedConfigurationJcs), {
      allowlist: ['tenant-1'],
      operationAuditNonce: 'persisted-nonce',
    });
    assert.equal(fixture.tx.appended.length, 0);
    assert.equal(fixture.tx.writes, 0);
  });

  it('appends recorded-expand rollback from recorded business configuration with a fresh nonce', async () => {
    const state = lockedState();
    const recorded = state.recordedExpandOperation!;
    const requestedBinding = composeBinding('expand', digest('r'));
    const fixture = ledger(state, ['rollback-fresh-nonce']);

    const result = await fixture.ledger.execute({
      command: 'rollback_to_recorded_expand',
      platformBinding: requestedBinding,
      businessConfiguration: { allowlist: ['tenant-recorded'] },
      descriptorSet: [],
      verifyCurrent: async () => ({ status: 'proven', proof: { challenge: 'ok' } }),
      applyTransition: async ({ operation: next }) => {
        assert.equal(
          next.requestedBusinessConfigurationSha256,
          recorded.requestedBusinessConfigurationSha256,
        );
      },
    });

    assert.equal(result.action, 'append');
    assert.equal(result.operation.operationKind, 'rollback_to_recorded_expand');
    assert.equal(result.operation.resultingState, 'enforced');
    assert.deepEqual(JSON.parse(result.operation.requestedConfigurationJcs), {
      allowlist: ['tenant-recorded'],
      operationAuditNonce: 'rollback-fresh-nonce',
    });
    assert.notEqual(
      result.operation.requestedConfigurationSha256,
      recorded.requestedConfigurationSha256,
    );
    assert.equal(fixture.tx.state.currentRuntimeOperationVersion, '8');
    assert.equal(fixture.tx.state.recordedExpandOperation, recorded);
  });

  it('retries an unproven recovery row, then appends a new enforce only after recovery proof', async () => {
    const recovery = operation({
      operationKind: 'recover_runtime_after_enforce_failure',
      requestedBindingJcs: JSON.stringify(composeBinding('enforce')),
      requestedBusinessConfigurationSha256: digest('f'),
      requestedConfigurationJcs:
        '{"allowlist":["tenant-1"],"operationAuditNonce":"recovery-nonce"}',
    });
    const fixture = ledger(lockedState(recovery), ['next-enforce-nonce']);
    const base = {
      platformBinding: composeBinding('enforce'),
      businessConfiguration: { allowlist: ['tenant-1'] },
      descriptorSet: ['enforce'],
    } as const;

    const retry = await fixture.ledger.execute({
      ...base,
      command: 'recover_runtime_after_enforce_failure',
      verifyCurrent: async () => ({ status: 'absent' }),
      applyTransition: async () => assert.fail('retry must not write'),
    });
    assert.equal(retry.action, 'retry_rollout');

    const next = await fixture.ledger.execute({
      ...base,
      command: 'enforce',
      verifyCurrent: async (current) => {
        assert.equal(current, recovery);
        return { status: 'proven', proof: { challenge: 'live' } };
      },
      applyTransition: async () => undefined,
    });
    assert.equal(next.action, 'append');
    assert.equal(next.operation.operationKind, 'enforce');
    assert.match(next.operation.requestedConfigurationJcs, /next-enforce-nonce/);
  });

  it('derives failed-enforce recovery from the immediately previous proven binding and mappings', async () => {
    const predecessorBinding = composeBinding('expand', digest('p'));
    const predecessorConfiguration = {
      allowedTenants: ['tenant-old'],
      secretFileMappings: { databaseSecret: 'known-good', proofKeyPath: '/known-good/key' },
      stablePolicy: 'sealed-policy',
      operationAuditNonce: 'predecessor-nonce',
    };
    const failedConfiguration = {
      allowedTenants: ['tenant-new'],
      secretFileMappings: { databaseSecret: 'failed-new', proofKeyPath: '/failed/key' },
      stablePolicy: 'sealed-policy',
      operationAuditNonce: 'failed-nonce',
    };
    const failed = operation({
      operationKind: 'enforce',
      previousBindingJcs: JSON.stringify(predecessorBinding),
      previousBindingSha256: canonicalBootstrapSha256(predecessorBinding),
      previousConfigurationJcs: JSON.stringify(predecessorConfiguration),
      previousConfigurationSha256: canonicalBootstrapSha256(predecessorConfiguration),
      requestedBindingJcs: JSON.stringify(composeBinding('enforce', digest('n'))),
      requestedBindingSha256: canonicalBootstrapSha256(composeBinding('enforce', digest('n'))),
      requestedConfigurationJcs: JSON.stringify(failedConfiguration),
      requestedConfigurationSha256: canonicalBootstrapSha256(failedConfiguration),
      requestedBusinessConfigurationSha256: digest('z'),
    });
    const fixture = ledger(lockedState(failed), ['hybrid-nonce']);
    const result = await fixture.ledger.execute({
      command: 'recover_runtime_after_enforce_failure',
      platformBinding: composeBinding('enforce', digest('x')),
      businessConfiguration: {
        allowedTenants: ['caller-substitution'],
        secretFileMappings: { databaseSecret: 'caller-substitution' },
      },
      descriptorSet: ['caller-selected-descriptor'],
      verifyCurrent: async () => ({ status: 'absent' }),
      verifyRecoveryPredecessor: async (candidate) => {
        assert.deepEqual(candidate.platformBinding, predecessorBinding);
        assert.deepEqual(candidate.configuration, {
          allowedTenants: ['tenant-old'],
          secretFileMappings: { databaseSecret: 'known-good', proofKeyPath: '/known-good/key' },
          stablePolicy: 'sealed-policy',
          operationAuditNonce: 'predecessor-nonce',
        });
        return { status: 'proven', proof: { challenge: 'predecessor-live' } };
      },
      applyTransition: async () => undefined,
    });

    assert.equal(result.action, 'append');
    assert.equal(result.operation.operationKind, 'recover_runtime_after_enforce_failure');
    assert.deepEqual(JSON.parse(result.operation.requestedBindingJcs), predecessorBinding);
    assert.deepEqual(JSON.parse(result.operation.requestedConfigurationJcs), {
      allowedTenants: ['tenant-new'],
      secretFileMappings: { databaseSecret: 'known-good', proofKeyPath: '/known-good/key' },
      stablePolicy: 'sealed-policy',
      operationAuditNonce: 'hybrid-nonce',
    });
    assert.deepEqual(result.operation.descriptorSet, []);
  });

  it('rejects recovery when the immediately previous runtime cannot be proven live', async () => {
    const predecessorBinding = composeBinding('expand', digest('p'));
    const predecessorConfiguration = {
      allowedTenants: ['tenant-old'],
      secretFileMappings: { databaseSecret: 'known-good' },
      operationAuditNonce: 'predecessor-nonce',
    };
    const failed = operation({
      operationKind: 'enforce',
      previousBindingJcs: JSON.stringify(predecessorBinding),
      previousBindingSha256: canonicalBootstrapSha256(predecessorBinding),
      previousConfigurationJcs: JSON.stringify(predecessorConfiguration),
      previousConfigurationSha256: canonicalBootstrapSha256(predecessorConfiguration),
      requestedConfigurationJcs: JSON.stringify({
        allowedTenants: ['tenant-new'],
        secretFileMappings: { databaseSecret: 'failed-new' },
        operationAuditNonce: 'failed-nonce',
      }),
    });
    const fixture = ledger(lockedState(failed), []);

    await assert.rejects(
      () =>
        fixture.ledger.execute({
          command: 'recover_runtime_after_enforce_failure',
          platformBinding: composeBinding('enforce'),
          businessConfiguration: { allowedTenants: ['caller'] },
          descriptorSet: [],
          verifyCurrent: async () => ({ status: 'absent' }),
          verifyRecoveryPredecessor: async () => ({ status: 'absent' }),
          applyTransition: async () => assert.fail('unproven predecessor must not write'),
        }),
      /TENANT_CUTOVER_RECOVERY_PREDECESSOR_NOT_PROVEN/,
    );
    assert.equal(fixture.tx.appended.length, 0);
    assert.equal(fixture.tx.writes, 0);
  });

  it('fails recovery closed for missing, incomplete, or cross-platform predecessor evidence', async () => {
    const validPreviousConfigurationValue = {
      allowedTenants: ['tenant-old'],
      secretFileMappings: { databaseSecret: 'known-good' },
      operationAuditNonce: 'predecessor-nonce',
    };
    const validPreviousConfiguration = JSON.stringify(validPreviousConfigurationValue);
    const cases: Array<{
      name: string;
      current: Task1LifecycleOperation;
      error: RegExp;
    }> = [
      {
        name: 'missing binding',
        current: operation({
          operationKind: 'enforce',
          previousBindingJcs: null,
          previousConfigurationJcs: validPreviousConfiguration,
        }),
        error: /TENANT_CUTOVER_RECOVERY_PREDECESSOR_REQUIRED/,
      },
      {
        name: 'incomplete binding',
        current: operation({
          operationKind: 'enforce',
          previousBindingJcs: JSON.stringify({ kind: 'compose', projectName: 'commander' }),
          previousConfigurationJcs: validPreviousConfiguration,
        }),
        error: /TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE/,
      },
      {
        name: 'missing known-good mappings',
        current: operation({
          operationKind: 'enforce',
          previousBindingJcs: JSON.stringify(composeBinding('expand')),
          previousConfigurationJcs: JSON.stringify({
            allowedTenants: ['tenant-old'],
            operationAuditNonce: 'predecessor-nonce',
          }),
        }),
        error: /TENANT_CUTOVER_RECOVERY_PREDECESSOR_INCOMPLETE/,
      },
      {
        name: 'digest-mismatched predecessor',
        current: operation({
          operationKind: 'enforce',
          previousBindingJcs: JSON.stringify(composeBinding('expand')),
          previousBindingSha256: canonicalBootstrapSha256(composeBinding('expand')),
          previousConfigurationJcs: validPreviousConfiguration,
          previousConfigurationSha256: digest('0'),
        }),
        error: /TENANT_CUTOVER_RECOVERY_PREDECESSOR_MISMATCH/,
      },
      {
        name: 'cross-platform predecessor',
        current: operation({
          operationKind: 'enforce',
          previousBindingJcs: JSON.stringify({
            kind: 'helm',
            namespace: 'commander',
            releaseName: 'commander',
            chartContentSha256: digest('h'),
            phase: 'expand',
            apiImageDigest: `sha256:${digest('i')}`,
          }),
          previousConfigurationJcs: validPreviousConfiguration,
        }),
        error: /TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED/,
      },
    ];

    for (const testCase of cases) {
      const fixture = ledger(lockedState(testCase.current), []);
      await assert.rejects(
        () =>
          fixture.ledger.execute({
            command: 'recover_runtime_after_enforce_failure',
            platformBinding: composeBinding('enforce'),
            businessConfiguration: { allowedTenants: ['caller'] },
            descriptorSet: [],
            verifyCurrent: async () => ({ status: 'absent' }),
            verifyRecoveryPredecessor: async () => ({ status: 'absent' }),
            applyTransition: async () => assert.fail(`${testCase.name} must not write`),
          }),
        testCase.error,
        testCase.name,
      );
      assert.equal(fixture.tx.appended.length, 0, testCase.name);
      assert.equal(fixture.tx.writes, 0, testCase.name);
    }
  });

  it('uses the closed terminal transition table for legacy expand and direct fresh enforce', async () => {
    for (const testCase of [
      {
        databaseState: 'legacy' as const,
        command: 'expand' as const,
        resulting: 'expanded' as const,
      },
      {
        databaseState: 'fresh' as const,
        command: 'install_enforce' as const,
        resulting: 'enforced' as const,
      },
    ]) {
      const fixture = ledger(
        lockedState(undefined, {
          databaseState: testCase.databaseState,
          stateVersion: '0',
          platformKind: undefined,
          platformBindingSha256: null,
          currentRuntimeOperationVersion: null,
          currentConfigurationSha256: null,
          prebootstrapSnapshotsSha256: digest('o'),
          recordedExpandOperation: undefined,
        }),
        ['terminal-nonce'],
      );
      const result = await fixture.ledger.execute({
        command: testCase.command,
        platformBinding: composeBinding(testCase.command === 'expand' ? 'expand' : 'enforce'),
        businessConfiguration: { allowlist: ['tenant-1'] },
        descriptorSet: ['lifecycle'],
        legacyPredecessorArtifact:
          testCase.command === 'expand'
            ? {
                kind: 'compose',
                projectName: 'commander',
                composeSourceSha256: digest('q'),
                composeCliVersion: '5.3.1',
                resolvedModelSha256: digest('r'),
                imageDigest: `sha256:${digest('i')}`,
              }
            : undefined,
        applyTransition: async () => undefined,
      });
      assert.equal(result.action, 'append');
      assert.equal(result.operation.resultingState, testCase.resulting);
      assert.equal(fixture.tx.state.databaseState, testCase.resulting);
    }
  });

  it('rejects cross-platform and closed-state requests before nonce generation or writes', async () => {
    const fixture = ledger(lockedState(), []);
    await assert.rejects(
      () =>
        fixture.ledger.execute({
          command: 'enforce',
          platformBinding: {
            kind: 'helm',
            namespace: 'commander',
            releaseName: 'commander',
            chartContentSha256: digest('h'),
            phase: 'enforce',
            apiImageDigest: `sha256:${digest('i')}`,
          },
          businessConfiguration: { allowlist: ['tenant-1'] },
          descriptorSet: ['enforce'],
          verifyCurrent: async () => ({ status: 'proven', proof: {} }),
          applyTransition: async () => undefined,
        }),
      /TENANT_CUTOVER_CROSS_PLATFORM_UNSUPPORTED/,
    );
    assert.equal(fixture.tx.appended.length, 0);
    assert.equal(fixture.tx.writes, 0);
  });

  it('retries fresh pending from persisted origin only, then freshly observes owner and all six roles', async () => {
    const bootstrapIdentities = {
      format: 'bootstrap_identities/v1' as const,
      envelope: 'E2' as const,
      authority: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
      bootstrapSuperuser: { oid: '10', name: 'postgres', superuser: true, commanderNamed: false },
    };
    const inventory = {
      format: 'prebootstrap_inventory/v1',
      postgresVersion: '16.14',
      catalogVersion: '202307071',
      databaseIdentity: { oid: '16384', name: 'commander' },
      ledger: null,
      namespaces: [],
      relations: [],
      functions: [],
      types: [],
      extensions: [],
      policies: [],
      triggers: [],
      productSources: [],
      productHasRows: [],
      roles: [],
      memberships: [],
      roleSettings: [],
      databaseAcl: [],
      schemaAcls: [],
      defaultAcls: [],
      bootstrapIdentities,
    };
    const snapshots = createPrebootstrapSnapshots(inventory, structuredClone(inventory));
    const origin = createOriginBinding(snapshots);
    const roles = [
      'adapter-ops',
      'app',
      'owner',
      'scheduler',
      'tenant-authority',
      'worker',
    ] as const;
    const peerInput = createDatabasePeerBindingInput({
      roles: roles.map((role) => ({ role, host: 'db.example', port: 5432 })),
      expectedServerSpkiSha256: digest('a'),
      ca: { mountIdentity: 'database-ca', path: '/ca.crt', publicBytesSha256: digest('b') },
    });
    const observed = createDatabasePeerBinding({
      roles: roles.map((role) => ({
        role,
        host: 'db.example',
        port: 5432,
        tlsServerSans: { dns: ['db.example'], ip: [] },
        serverSpkiSha256: digest('a'),
        databaseOid: '16384',
        databaseName: 'commander',
      })),
    });
    const calls: string[] = [];
    await verifyTask1FreshPendingRetry({
      state: {
        databaseState: 'fresh_pending',
        pendingConfigurationSha256: digest('c'),
        prebootstrapSnapshotsJcs: canonicalBootstrapJson(snapshots),
        prebootstrapSnapshotsSha256: canonicalBootstrapSha256(snapshots),
        originBindingJcs: canonicalBootstrapJson(origin),
        originBindingSha256: canonicalBootstrapSha256(origin),
        databasePeerBindingInput: peerInput,
        databasePeerBindingJcs: canonicalBootstrapJson(observed),
        databasePeerBindingSha256: canonicalBootstrapSha256(observed),
      },
      request: { configurationSha256: digest('c') },
      reauthenticateBootstrapAuthority: async (identity) => {
        calls.push(`bootstrap:${identity.name}`);
      },
      observeOwner: async () => {
        calls.push('owner');
        return observed.roles.find(({ role }) => role === 'owner')!;
      },
      observeRole: async (role) => {
        calls.push(role);
        return observed.roles.find((entry) => entry.role === role)!;
      },
    });
    assert.deepEqual(calls, ['bootstrap:postgres', 'owner', ...roles]);
  });
});

class RecordingClient implements SqlClient {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  released = false;
  failInsert = false;

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, values });
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.includes('session_user::text AS session_user')) {
      return {
        rows: [
          {
            current_user: 'commander_owner',
            session_user: 'commander_owner',
            owns_state: true,
            owns_operations: true,
          } as T,
        ],
        rowCount: 1,
      };
    }
    if (normalized.includes('FOR UPDATE OF lifecycle_state')) {
      return {
        rows: [
          {
            installation_uuid: 'installation-1',
            state: 'fresh',
            state_version: '0',
            platform_kind: null,
            platform_binding_sha256: null,
            prebootstrap_snapshots_jcs: '{"format":"prebootstrap_snapshots/v1"}',
            prebootstrap_snapshots_sha256: digest('s'),
            origin_binding_jcs: '{"format":"origin_binding/v1"}',
            origin_binding_sha256: digest('3'),
            database_peer_binding_jcs: '{"format":"database_peer_binding_v1"}',
            database_peer_binding_sha256: digest('1'),
            proof_key_sha256: digest('2'),
            pending_configuration_sha256: null,
            current_configuration_sha256: null,
            current_runtime_operation_version: null,
            current_operation: null,
            recorded_expand_operation: null,
          } as T,
        ],
        rowCount: 1,
      };
    }
    if (
      normalized.startsWith('INSERT INTO public.commander_tenant_cutover_operations') &&
      this.failInsert
    ) {
      throw new Error('write failed');
    }
    return {
      rows: normalized.startsWith('UPDATE public.commander_tenant_cutover_state')
        ? [{ state_version: '1' } as T]
        : [],
      rowCount: normalized.startsWith('UPDATE public.commander_tenant_cutover_state') ? 1 : 0,
    };
  }

  release(): void {
    this.released = true;
  }
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect(): Promise<SqlClient> {
    return this.client;
  }
}

describe('PostgreSQL Task 1 locked owner transaction adapter', () => {
  it('defines an owner-only append-only ledger with a closed operation kind', () => {
    assert.match(
      TASK1_LIFECYCLE_DESCRIPTOR_SQL,
      /PRIMARY KEY \(installation_uuid, operation_version\)/i,
    );
    assert.match(
      TASK1_LIFECYCLE_DESCRIPTOR_SQL,
      /legacy_expand[\s\S]*fresh_enforce[\s\S]*recover_runtime_after_enforce_failure[\s\S]*rollback_to_recorded_expand/i,
    );
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /BEFORE UPDATE OR DELETE/i);
    assert.match(
      TASK1_LIFECYCLE_DESCRIPTOR_SQL,
      /RAISE EXCEPTION 'TENANT_CUTOVER_OPERATION_IMMUTABLE'/i,
    );
    assert.match(
      TASK1_LIFECYCLE_DESCRIPTOR_SQL,
      /REVOKE ALL ON TABLE[\s\S]*commander_tenant_cutover_operations[\s\S]*FROM PUBLIC/i,
    );
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /commander_runtime_configuration_identity\(\)/i);
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /prebootstrap_snapshots_jcs text NOT NULL/i);
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /origin_binding_jcs text NOT NULL/i);
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /origin_binding_sha256 text NOT NULL/i);
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /database_peer_binding_jcs text NOT NULL/i);
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /commander_tenant_cutover_rollout_proofs/i);
    assert.match(
      TASK1_LIFECYCLE_DESCRIPTOR_SQL,
      /UNIQUE \(installation_uuid, predecessor_state_version, requested_binding_sha256,\s*requested_configuration_sha256, origin_binding_sha256, database_peer_binding_sha256\)/i,
    );
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /predecessor_evidence_jcs text NOT NULL/i);
    assert.match(TASK1_LIFECYCLE_DESCRIPTOR_SQL, /rollout_proof_sha256 text NOT NULL/i);
    assert.match(
      TASK1_LIFECYCLE_DESCRIPTOR_SQL,
      /REVOKE ALL ON TABLE[\s\S]*commander_tenant_cutover_rollout_proofs[\s\S]*FROM PUBLIC/i,
    );
  });

  it('asserts owner authority and acquires the sole lifecycle row with SELECT FOR UPDATE', async () => {
    const client = new RecordingClient();
    const transactions = new PostgresTask1LifecycleOwnerTransactions(new RecordingPool(client));

    await transactions.withLockedOwnerTransaction(async (transaction) => {
      const state = await transaction.lockState();
      assert.equal(state.databaseState, 'fresh');
      return undefined;
    });

    assert.match(client.queries[0]!.sql, /session_user::text AS session_user/i);
    const normalized = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    const legacyLock = normalized.findIndex((sql) =>
      /pg_advisory_lock\(pg_catalog\.hashtext\('commander\.kernel\.migrations'\)\)/i.test(sql),
    );
    const lifecycleLock = normalized.findIndex((sql) =>
      /pg_advisory_lock\( pg_catalog\.hashtextextended\('commander\.kernel\.lifecycle\//i.test(sql),
    );
    const begin = normalized.indexOf('BEGIN');
    assert.ok(legacyLock > 0 && lifecycleLock > legacyLock && begin > lifecycleLock);
    assert.ok(client.queries.some(({ sql }) => sql === TASK1_LIFECYCLE_LOCK_STATE_SQL));
    assert.match(TASK1_LIFECYCLE_LOCK_STATE_SQL, /FOR UPDATE OF lifecycle_state/i);
    const commit = normalized.indexOf('COMMIT');
    const lifecycleUnlock = normalized.findIndex((sql) =>
      /pg_advisory_unlock\( pg_catalog\.hashtextextended\('commander\.kernel\.lifecycle\//i.test(
        sql,
      ),
    );
    const legacyUnlock = normalized.findIndex((sql) =>
      /pg_advisory_unlock\(pg_catalog\.hashtext\('commander\.kernel\.migrations'\)\)/i.test(sql),
    );
    assert.ok(commit > begin && lifecycleUnlock > commit && legacyUnlock > lifecycleUnlock);
    assert.equal(client.released, true);
  });

  it('rolls back and releases the owner client when proof or SQL writes fail', async () => {
    for (const failure of ['proof', 'write'] as const) {
      const client = new RecordingClient();
      client.failInsert = failure === 'write';
      const transactions = new PostgresTask1LifecycleOwnerTransactions(new RecordingPool(client));
      const service = new Task1LifecycleLedger(transactions, {
        createNonce: () => 'database-nonce',
      });

      await assert.rejects(
        () =>
          service.execute({
            command: 'install_enforce',
            platformBinding: composeBinding('enforce'),
            businessConfiguration: { allowlist: ['tenant-1'] },
            descriptorSet: ['lifecycle', 'expand', 'enforce'],
            applyTransition: async () => {
              if (failure === 'proof') throw new Error('proof failed');
            },
          }),
        new RegExp(`${failure} failed`),
      );

      assert.equal(
        client.queries.some(({ sql }) => sql === 'COMMIT'),
        false,
      );
      const normalized = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
      assert.ok(normalized.includes('ROLLBACK'));
      assert.match(
        normalized.at(-1)!,
        /pg_advisory_unlock\(pg_catalog\.hashtext\('commander\.kernel\.migrations'\)\)/i,
      );
      assert.equal(client.released, true);
    }
  });

  it('writes explicit evidence columns rather than an opaque operation_json placeholder', async () => {
    const client = new RecordingClient();
    const transactions = new PostgresTask1LifecycleOwnerTransactions(new RecordingPool(client));
    const service = new Task1LifecycleLedger(transactions, { createNonce: () => 'nonce' });
    await service.execute({
      command: 'install_enforce',
      platformBinding: composeBinding('enforce'),
      businessConfiguration: { allowlist: ['tenant-1'] },
      descriptorSet: ['lifecycle', 'expand', 'enforce'],
      applyTransition: async () => undefined,
    });
    const insert = client.queries.find(({ sql }) =>
      /INSERT INTO public\.commander_tenant_cutover_operations/i.test(sql),
    );
    assert.ok(insert);
    assert.match(insert.sql, /requested_configuration_jcs/i);
    assert.match(insert.sql, /requested_business_configuration_sha256/i);
    assert.doesNotMatch(insert.sql, /operation_json/i);
    const update = client.queries.find(({ sql }) =>
      /UPDATE public\.commander_tenant_cutover_state/i.test(sql),
    );
    assert.ok(update);
    assert.match(update.sql, /recorded_expand_operation_version\s*=/i);
    assert.match(update.sql, /platform_binding_sha256 IS NOT DISTINCT FROM/i);
    assert.match(update.sql, /origin_binding_sha256 =/i);
    assert.match(update.sql, /database_peer_binding_sha256 =/i);
    assert.match(update.sql, /pending_configuration_sha256 IS NOT DISTINCT FROM/i);
  });
});
