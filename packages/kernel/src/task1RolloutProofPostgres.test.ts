import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import type { SqlClient, SqlPool, SqlQueryResult } from './postgres.js';
import type { Task1RolloutProofTransaction } from './task1RolloutProof.js';
import { PostgresTask1RolloutProofTransactions } from './task1RolloutProofPostgres.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);

function operationRow(): Record<string, unknown> {
  const binding = {
    kind: 'compose',
    projectName: 'commander',
    composeVariant: 'prod',
    composeCredentialInventory: 'runtime-v1',
    composeSourceSha256: digest('a'),
    composeCliVersion: '5.3.1',
    composeContentSha256: digest('b'),
    phase: 'enforce',
    apiImageDigest: `registry.example/commander@sha256:${digest('c')}`,
    apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
  };
  const configuration = { operationAuditNonce: 'n'.repeat(43) };
  return {
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
    predecessor_evidence_jcs: '{}',
    predecessor_evidence_sha256: digest('1'),
    result: 'committed',
  };
}

const proofAttemptId = '11111111-1111-4111-8111-111111111111';

function validProof(): Record<string, unknown> {
  const operation = operationRow();
  const challengedResponse = {
    challenge: Buffer.alloc(32, 1).toString('base64url'),
    operationVersion: '7',
    phase: 'enforce',
    installationId: operation.installation_uuid,
    databasePeerBindingSha256: operation.database_peer_binding_sha256,
    imageDigest: `sha256:${digest('c')}`,
    configurationSha256: operation.requested_configuration_sha256,
  };
  const platformArtifact = {
    format: 'compose-runtime-projection/v1',
    projectName: 'commander',
    imageDigest: `sha256:${digest('c')}`,
    containerId: 'a'.repeat(64),
  };
  return {
    format: 'rollout-proof/v1',
    installationId: operation.installation_uuid,
    operationVersion: '7',
    proofSequence: '4',
    proofAttemptId,
    lifecycleCommand: 'enforce',
    topology: 'compose',
    configurationSha256: operation.requested_configuration_sha256,
    platformBindingSha256: operation.requested_binding_sha256,
    requestedImageDigest: `sha256:${digest('c')}`,
    proofKeySha256: operation.proof_key_sha256,
    challengedResponse,
    challengedResponseSha256: canonicalBootstrapSha256(challengedResponse),
    platformArtifact,
    platformArtifactSha256: canonicalBootstrapSha256(platformArtifact),
    workload: {
      uid: 'a'.repeat(64),
      generation: '1',
      observedGeneration: '1',
      templateSha256: digest('4'),
      ready: ['api'],
    },
    startedAt: '2026-07-29T00:00:00.000Z',
    provenAt: '2026-07-29T00:00:01.000Z',
    pinned: { node: process.version, compose: '5.3.1', sourceSha256: digest('a') },
    metadata: {
      specRevision: 27,
      evidenceLevel: 'live',
      writeOwner: 'commander_owner',
      publicationPoint: 'commander_tenant_cutover_rollout_proofs',
    },
  };
}

function receiptFor(proof: Record<string, unknown>) {
  return {
    operationVersion: String(proof.operationVersion),
    proofSequence: String(proof.proofSequence),
    proofAttemptId: String(proof.proofAttemptId),
    rolloutProofSha256: canonicalBootstrapSha256(proof),
  };
}

interface RecordingClientOptions {
  commitError?: Error;
  rollbackError?: Error;
  lifecycleUnlockError?: Error;
  legacyUnlockError?: Error;
  attemptRow?: Record<string, unknown>;
  attemptLookupError?: Error;
  releaseError?: Error;
}

class RecordingClient implements SqlClient {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly releases: Array<Error | boolean | undefined> = [];
  constructor(private readonly options: RecordingClientOptions = {}) {}
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
            owns_proofs: true,
          } as T,
        ],
        rowCount: 1,
      };
    }
    if (normalized.includes('next_proof_sequence')) {
      return { rows: [{ operation: operationRow(), next_proof_sequence: '4' } as T], rowCount: 1 };
    }
    if (normalized.includes('proof.proof_attempt_id')) {
      if (this.options.attemptLookupError) throw this.options.attemptLookupError;
      const row = this.options.attemptRow;
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized === 'COMMIT' && this.options.commitError) throw this.options.commitError;
    if (normalized === 'ROLLBACK' && this.options.rollbackError) throw this.options.rollbackError;
    if (
      normalized.includes('pg_catalog.pg_advisory_unlock(') &&
      normalized.includes("hashtextextended('commander.kernel.lifecycle/'") &&
      this.options.lifecycleUnlockError
    )
      throw this.options.lifecycleUnlockError;
    if (
      normalized.includes('pg_catalog.pg_advisory_unlock(') &&
      normalized.includes("hashtext('commander.kernel.migrations')") &&
      this.options.legacyUnlockError
    )
      throw this.options.legacyUnlockError;
    return { rows: [], rowCount: normalized.startsWith('INSERT INTO') ? 1 : 0 };
  }
  release(error?: Error | boolean): void {
    this.releases.push(error);
    if (this.options.releaseError) throw this.options.releaseError;
  }
}

class RecordingPool implements SqlPool {
  private index = 0;
  constructor(readonly clients: readonly RecordingClient[]) {}
  async connect(): Promise<SqlClient> {
    const client = this.clients[this.index++];
    if (!client) throw new Error('unexpected pool connection');
    return client;
  }
}

async function appendValidProof(transaction: Task1RolloutProofTransaction) {
  const locked = await transaction.lockCurrent();
  const proof = validProof();
  await transaction.appendProof(proof);
  assert.equal(locked.nextProofSequence, proof.proofSequence);
  return receiptFor(proof);
}

function attemptRow(proof = validProof()): Record<string, unknown> {
  return {
    operation: operationRow(),
    proof_sequence: proof.proofSequence,
    proof_attempt_id: proof.proofAttemptId,
    rollout_proof_jcs: canonicalBootstrapJson(proof),
    rollout_proof_sha256: canonicalBootstrapSha256(proof),
  };
}

describe('PostgreSQL Task 1 rollout proof transaction', () => {
  it('locks the current pointer and appends canonical proof before commit', async () => {
    const client = new RecordingClient();
    const transactions = new PostgresTask1RolloutProofTransactions(new RecordingPool([client]));
    await transactions.withLockedOwnerTransaction(async (transaction) => {
      const locked = await transaction.lockCurrent();
      assert.equal(locked.operation.operationVersion, '7');
      assert.equal(locked.nextProofSequence, '4');
      await transaction.appendProof({
        format: 'rollout-proof/v1',
        installationId: locked.operation.installationUuid,
        operationVersion: '7',
        proofSequence: '4',
        proofAttemptId: '11111111-1111-4111-8111-111111111111',
      });
    });
    const normalized = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    const begin = normalized.indexOf('BEGIN');
    const lock = normalized.findIndex((sql) => sql.includes('next_proof_sequence'));
    const insert = normalized.findIndex((sql) =>
      sql.startsWith('INSERT INTO public.commander_tenant_cutover_rollout_proofs'),
    );
    const commit = normalized.indexOf('COMMIT');
    assert.ok(begin >= 0 && lock > begin && insert > lock && commit > insert);
    assert.match(normalized[lock]!, /FOR UPDATE OF lifecycle_state/i);
    assert.equal(client.queries[insert]!.values[2], '4');
  });

  it('returns the exact receipt when commit acknowledgement is lost but the attempt row is valid', async () => {
    const commitError = new Error('commit acknowledgement lost');
    const transactionClient = new RecordingClient({ commitError });
    const lookupClient = new RecordingClient({ attemptRow: attemptRow() });
    const transactions = new PostgresTask1RolloutProofTransactions(
      new RecordingPool([transactionClient, lookupClient]),
    );

    const receipt = await transactions.withLockedOwnerTransaction(appendValidProof);

    assert.deepEqual(receipt, receiptFor(validProof()));
    assert.equal(
      lookupClient.queries.some(({ values }) => values[0] === proofAttemptId),
      true,
    );
    assert.equal(transactionClient.releases[0], commitError);
  });

  it('rethrows the original commit error when the attempt row is absent', async () => {
    const commitError = new Error('commit acknowledgement lost');
    const transactions = new PostgresTask1RolloutProofTransactions(
      new RecordingPool([new RecordingClient({ commitError }), new RecordingClient()]),
    );

    await assert.rejects(
      () => transactions.withLockedOwnerTransaction(appendValidProof),
      (error) => error === commitError,
    );
  });

  it('rethrows the original commit error when the attempt row mismatches the immutable proof', async () => {
    const commitError = new Error('commit acknowledgement lost');
    const mismatchedRow = attemptRow();
    mismatchedRow.operation = { ...operationRow(), operation_version: '8' };
    const transactions = new PostgresTask1RolloutProofTransactions(
      new RecordingPool([
        new RecordingClient({ commitError }),
        new RecordingClient({ attemptRow: mismatchedRow }),
      ]),
    );

    await assert.rejects(
      () => transactions.withLockedOwnerTransaction(appendValidProof),
      (error) => error === commitError,
    );
  });

  it('rethrows the original commit error when the attempt lookup fails', async () => {
    const commitError = new Error('commit acknowledgement lost');
    const lookupError = new Error('lookup connection lost');
    const transactions = new PostgresTask1RolloutProofTransactions(
      new RecordingPool([
        new RecordingClient({ commitError }),
        new RecordingClient({ attemptLookupError: lookupError }),
      ]),
    );

    await assert.rejects(
      () => transactions.withLockedOwnerTransaction(appendValidProof),
      (error) => error === commitError,
    );
  });

  it('rethrows the original commit error when the uncertain connection cannot be destroyed', async () => {
    const commitError = new Error('commit acknowledgement lost');
    const releaseError = new Error('connection destroy failed');
    const lookupClient = new RecordingClient({ attemptRow: attemptRow() });
    const transactions = new PostgresTask1RolloutProofTransactions(
      new RecordingPool([new RecordingClient({ commitError, releaseError }), lookupClient]),
    );

    await assert.rejects(
      () => transactions.withLockedOwnerTransaction(appendValidProof),
      (error) => error === commitError,
    );
    assert.equal(lookupClient.queries.length, 0);
  });

  for (const [name, mutate] of [
    [
      'proof sequence',
      (row: Record<string, unknown>) => {
        row.proof_sequence = '5';
      },
    ],
    [
      'attempt ID',
      (row: Record<string, unknown>) => {
        row.proof_attempt_id = '22222222-2222-4222-8222-222222222222';
      },
    ],
    [
      'proof JCS',
      (row: Record<string, unknown>) => {
        row.rollout_proof_jcs = '{}';
      },
    ],
    [
      'proof hash',
      (row: Record<string, unknown>) => {
        row.rollout_proof_sha256 = digest('9');
      },
    ],
  ] as const) {
    it(`rethrows the original commit error when the recovered ${name} differs`, async () => {
      const commitError = new Error('commit acknowledgement lost');
      const row = attemptRow();
      mutate(row);
      const transactions = new PostgresTask1RolloutProofTransactions(
        new RecordingPool([
          new RecordingClient({ commitError }),
          new RecordingClient({ attemptRow: row }),
        ]),
      );

      await assert.rejects(
        () => transactions.withLockedOwnerTransaction(appendValidProof),
        (error) => error === commitError,
      );
    });
  }

  it('rolls back a non-ambiguous work failure without looking up the attempt row', async () => {
    const workError = new Error('proof validation failed');
    const client = new RecordingClient();
    const pool = new RecordingPool([client]);
    const transactions = new PostgresTask1RolloutProofTransactions(pool);

    await assert.rejects(
      () =>
        transactions.withLockedOwnerTransaction(async () => {
          throw workError;
        }),
      (error) => error === workError,
    );

    assert.equal(
      client.queries.some(({ sql }) => sql.trim() === 'ROLLBACK'),
      true,
    );
  });

  it('preserves the work error and destroys the connection when rollback fails', async () => {
    const workError = new Error('proof validation failed');
    const rollbackError = new Error('rollback connection lost');
    const client = new RecordingClient({ rollbackError });
    const transactions = new PostgresTask1RolloutProofTransactions(new RecordingPool([client]));

    await assert.rejects(
      () =>
        transactions.withLockedOwnerTransaction(async () => {
          throw workError;
        }),
      (error) => error === workError,
    );

    const normalized = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    assert.equal(
      normalized.some(
        (sql) =>
          sql.includes('pg_advisory_unlock') &&
          sql.includes("hashtextextended('commander.kernel.lifecycle/'"),
      ),
      true,
    );
    assert.equal(
      normalized.some(
        (sql) =>
          sql.includes('pg_advisory_unlock') &&
          sql.includes("hashtext('commander.kernel.migrations')"),
      ),
      true,
    );
    assert.deepEqual(client.releases, [rollbackError]);
  });

  it('preserves the work error, attempts the legacy unlock, and destroys the connection when the lifecycle unlock fails', async () => {
    const workError = new Error('proof validation failed');
    const lifecycleUnlockError = new Error('lifecycle unlock connection lost');
    const client = new RecordingClient({ lifecycleUnlockError });
    const transactions = new PostgresTask1RolloutProofTransactions(new RecordingPool([client]));

    await assert.rejects(
      () =>
        transactions.withLockedOwnerTransaction(async () => {
          throw workError;
        }),
      (error) => error === workError,
    );

    const normalized = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    assert.equal(
      normalized.some(
        (sql) =>
          sql.includes('pg_advisory_unlock') &&
          sql.includes("hashtext('commander.kernel.migrations')"),
      ),
      true,
    );
    assert.deepEqual(client.releases, [lifecycleUnlockError]);
  });

  it('preserves the work error and destroys the connection when the legacy unlock fails', async () => {
    const workError = new Error('proof validation failed');
    const legacyUnlockError = new Error('legacy unlock connection lost');
    const client = new RecordingClient({ legacyUnlockError });
    const transactions = new PostgresTask1RolloutProofTransactions(new RecordingPool([client]));

    await assert.rejects(
      () =>
        transactions.withLockedOwnerTransaction(async () => {
          throw workError;
        }),
      (error) => error === workError,
    );

    assert.deepEqual(client.releases, [legacyUnlockError]);
  });
});
