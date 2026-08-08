import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import type { SqlClient, SqlPool } from './postgres.js';
import type { Task1LifecycleOperation } from './task1LifecycleLedger.js';
import { isTask1RolloutProofForOperation } from './task1RolloutProof.js';
import type {
  Task1RolloutProofReceipt,
  Task1RolloutProofTransaction,
  Task1RolloutProofTransactions,
} from './task1RolloutProof.js';

type JsonRecord = Record<string, unknown>;

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_SESSION_LOCK_SQL =
  "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('commander.kernel.migrations'))";
const LEGACY_SESSION_UNLOCK_SQL =
  "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('commander.kernel.migrations'))";
const LIFECYCLE_SESSION_LOCK_SQL = `
SELECT pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('commander.kernel.lifecycle/' || database.oid::text, 0)
)
FROM pg_catalog.pg_database AS database
WHERE database.datname = pg_catalog.current_database()
`.trim();
const LIFECYCLE_SESSION_UNLOCK_SQL = LIFECYCLE_SESSION_LOCK_SQL.replace(
  'pg_catalog.pg_advisory_lock(',
  'pg_catalog.pg_advisory_unlock(',
);

interface LockedRow {
  operation: JsonRecord | null;
  next_proof_sequence: string;
}

interface ProofAttemptRow {
  operation: JsonRecord | null;
  proof_sequence: string;
  proof_attempt_id: string;
  rollout_proof_jcs: string;
  rollout_proof_sha256: string;
}

interface PendingProofCommit {
  operation: Task1LifecycleOperation;
  proofJcs: string;
  receipt: Task1RolloutProofReceipt;
}

function invalid(): never {
  throw new Error('TENANT_CUTOVER_PROOF_CURRENT_INVALID');
}

function text(row: JsonRecord, name: string): string {
  const value = row[name];
  if (typeof value !== 'string' && typeof value !== 'number') invalid();
  return String(value);
}

function nullableText(row: JsonRecord, name: string): string | null {
  return row[name] === null || row[name] === undefined ? null : text(row, name);
}

function operationFromRow(row: JsonRecord): Task1LifecycleOperation {
  const operationKind = text(row, 'operation_kind');
  const runtimePhase = text(row, 'runtime_phase');
  const platformKind = text(row, 'platform_kind');
  const predecessorState = text(row, 'predecessor_state');
  const resultingState = text(row, 'resulting_state');
  const descriptorSet = row.descriptor_set;
  if (
    ![
      'legacy_expand',
      'fresh_enforce',
      'enforce',
      'recover_runtime_after_enforce_failure',
      'rollback_to_recorded_expand',
    ].includes(operationKind) ||
    !['expand', 'enforce'].includes(runtimePhase) ||
    !['helm', 'compose'].includes(platformKind) ||
    !['fresh', 'fresh_pending', 'legacy', 'legacy_pending', 'expanded', 'enforced'].includes(
      predecessorState,
    ) ||
    !['fresh_pending', 'legacy_pending', 'expanded', 'enforced'].includes(resultingState) ||
    !Array.isArray(descriptorSet) ||
    !descriptorSet.every((value) => typeof value === 'string') ||
    text(row, 'result') !== 'committed'
  )
    invalid();
  return {
    installationUuid: text(row, 'installation_uuid'),
    operationVersion: text(row, 'operation_version'),
    predecessorStateVersion: text(row, 'predecessor_state_version'),
    resultingStateVersion: text(row, 'resulting_state_version'),
    predecessorState: predecessorState as Task1LifecycleOperation['predecessorState'],
    resultingState: resultingState as Task1LifecycleOperation['resultingState'],
    operationKind: operationKind as Task1LifecycleOperation['operationKind'],
    runtimePhase: runtimePhase as Task1LifecycleOperation['runtimePhase'],
    platformKind: platformKind as Task1LifecycleOperation['platformKind'],
    previousBindingJcs: nullableText(row, 'previous_binding_jcs'),
    previousBindingSha256: nullableText(row, 'previous_binding_sha256'),
    requestedBindingJcs: text(row, 'requested_binding_jcs'),
    requestedBindingSha256: text(row, 'requested_binding_sha256'),
    previousConfigurationJcs: nullableText(row, 'previous_configuration_jcs'),
    previousConfigurationSha256: nullableText(row, 'previous_configuration_sha256'),
    requestedConfigurationJcs: text(row, 'requested_configuration_jcs'),
    requestedConfigurationSha256: text(row, 'requested_configuration_sha256'),
    previousBusinessConfigurationSha256: nullableText(
      row,
      'previous_business_configuration_sha256',
    ),
    requestedBusinessConfigurationSha256: text(row, 'requested_business_configuration_sha256'),
    originBindingSha256: text(row, 'origin_binding_sha256'),
    databasePeerBindingSha256: text(row, 'database_peer_binding_sha256'),
    proofKeySha256: text(row, 'proof_key_sha256'),
    descriptorSet,
    predecessorEvidenceJcs: text(row, 'predecessor_evidence_jcs'),
    predecessorEvidenceSha256: text(row, 'predecessor_evidence_sha256'),
    predecessorProof: text(row, 'predecessor_evidence_sha256'),
    result: 'committed',
  };
}

function exactReceipt(
  value: unknown,
  expected: Task1RolloutProofReceipt,
): value is Task1RolloutProofReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  return (
    keys.length === 4 &&
    keys.join(',') === 'operationVersion,proofAttemptId,proofSequence,rolloutProofSha256' &&
    receipt.operationVersion === expected.operationVersion &&
    receipt.proofSequence === expected.proofSequence &&
    receipt.proofAttemptId === expected.proofAttemptId &&
    receipt.rolloutProofSha256 === expected.rolloutProofSha256
  );
}

class PostgresTask1RolloutProofTransaction implements Task1RolloutProofTransaction {
  private locked: { operation: Task1LifecycleOperation; nextProofSequence: string } | undefined;
  private pendingCommit: PendingProofCommit | undefined;

  constructor(private readonly client: SqlClient) {}

  async lockCurrent(): Promise<{ operation: Task1LifecycleOperation; nextProofSequence: string }> {
    if (this.locked) return this.locked;
    const result = await this.client.query<LockedRow>(`
      SELECT pg_catalog.to_jsonb(operation) AS operation,
             (SELECT (COALESCE(MAX(proof.proof_sequence), 0) + 1)::text
                FROM public.commander_tenant_cutover_rollout_proofs AS proof
               WHERE proof.installation_uuid = operation.installation_uuid
                 AND proof.operation_version = operation.operation_version) AS next_proof_sequence
        FROM public.commander_tenant_cutover_state AS lifecycle_state
        JOIN public.commander_tenant_cutover_operations AS operation
          ON operation.installation_uuid = lifecycle_state.installation_uuid
         AND operation.operation_version = lifecycle_state.current_runtime_operation_version
       WHERE lifecycle_state.singleton = true
       FOR UPDATE OF lifecycle_state
    `);
    const row = result.rows[0];
    if (
      !row?.operation ||
      result.rowCount !== 1 ||
      !POSITIVE_DECIMAL.test(row.next_proof_sequence)
    ) {
      invalid();
    }
    this.locked = {
      operation: operationFromRow(row.operation),
      nextProofSequence: row.next_proof_sequence,
    };
    return this.locked;
  }

  async appendProof(proof: JsonRecord): Promise<void> {
    if (!this.locked) throw new Error('TENANT_CUTOVER_PROOF_LOCK_REQUIRED');
    if (
      proof.format !== 'rollout-proof/v1' ||
      proof.installationId !== this.locked.operation.installationUuid ||
      proof.operationVersion !== this.locked.operation.operationVersion ||
      proof.proofSequence !== this.locked.nextProofSequence ||
      typeof proof.proofAttemptId !== 'string' ||
      !UUID.test(proof.proofAttemptId)
    ) {
      throw new Error('TENANT_CUTOVER_PROOF_APPEND_INVALID');
    }
    const jcs = canonicalBootstrapJson(proof);
    const sha256 = canonicalBootstrapSha256(proof);
    const result = await this.client.query(
      `INSERT INTO public.commander_tenant_cutover_rollout_proofs
       (installation_uuid, operation_version, proof_sequence, proof_attempt_id,
        rollout_proof_jcs, rollout_proof_sha256)
       VALUES ($1, $2, $3, $4::uuid, $5, $6)`,
      [
        this.locked.operation.installationUuid,
        this.locked.operation.operationVersion,
        this.locked.nextProofSequence,
        proof.proofAttemptId,
        jcs,
        sha256,
      ],
    );
    if (result.rowCount !== 1) throw new Error('TENANT_CUTOVER_PROOF_APPEND_FAILED');
    this.pendingCommit = {
      operation: this.locked.operation,
      proofJcs: jcs,
      receipt: {
        operationVersion: this.locked.operation.operationVersion,
        proofSequence: this.locked.nextProofSequence,
        proofAttemptId: proof.proofAttemptId,
        rolloutProofSha256: sha256,
      },
    };
  }

  recoveryFor(result: unknown): PendingProofCommit | undefined {
    return this.pendingCommit && exactReceipt(result, this.pendingCommit.receipt)
      ? this.pendingCommit
      : undefined;
  }
}

export class PostgresTask1RolloutProofTransactions implements Task1RolloutProofTransactions {
  constructor(private readonly pool: SqlPool) {}

  private async recoverCommittedProof(
    pending: PendingProofCommit,
  ): Promise<Task1RolloutProofReceipt | undefined> {
    let client: SqlClient;
    try {
      client = await this.pool.connect();
    } catch {
      return undefined;
    }

    let recovered: Task1RolloutProofReceipt | undefined;
    let lookupError: unknown;
    try {
      const result = await client.query<ProofAttemptRow>(
        `
        SELECT pg_catalog.to_jsonb(operation) AS operation,
               proof.proof_sequence::text AS proof_sequence,
               proof.proof_attempt_id::text AS proof_attempt_id,
               proof.rollout_proof_jcs,
               proof.rollout_proof_sha256
          FROM public.commander_tenant_cutover_rollout_proofs AS proof
          JOIN public.commander_tenant_cutover_state AS lifecycle_state
            ON lifecycle_state.singleton = true
           AND lifecycle_state.installation_uuid = proof.installation_uuid
           AND lifecycle_state.current_runtime_operation_version = proof.operation_version
          JOIN public.commander_tenant_cutover_operations AS operation
            ON operation.installation_uuid = proof.installation_uuid
           AND operation.operation_version = proof.operation_version
         WHERE proof.proof_attempt_id = $1::uuid
           AND proof.installation_uuid = $2::uuid
           AND proof.operation_version = $3
      `,
        [
          pending.receipt.proofAttemptId,
          pending.operation.installationUuid,
          pending.operation.operationVersion,
        ],
      );
      const row = result.rows[0];
      if (
        result.rowCount === 1 &&
        row?.operation &&
        row.proof_sequence === pending.receipt.proofSequence &&
        row.proof_attempt_id === pending.receipt.proofAttemptId &&
        row.rollout_proof_jcs === pending.proofJcs &&
        row.rollout_proof_sha256 === pending.receipt.rolloutProofSha256
      ) {
        const current = operationFromRow(row.operation);
        if (
          current.installationUuid === pending.operation.installationUuid &&
          current.operationVersion === pending.operation.operationVersion &&
          isTask1RolloutProofForOperation(current, row.rollout_proof_jcs, row.rollout_proof_sha256)
        ) {
          recovered = {
            operationVersion: current.operationVersion,
            proofSequence: row.proof_sequence,
            proofAttemptId: row.proof_attempt_id,
            rolloutProofSha256: row.rollout_proof_sha256,
          };
          if (!exactReceipt(recovered, pending.receipt)) recovered = undefined;
        }
      }
    } catch (error) {
      lookupError = error;
    }

    try {
      await client.release(
        lookupError instanceof Error ? lookupError : lookupError ? true : undefined,
      );
    } catch {
      return undefined;
    }
    return lookupError ? undefined : recovered;
  }

  async withLockedOwnerTransaction<T>(
    work: (transaction: Task1RolloutProofTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let legacyLocked = false;
    let lifecycleLocked = false;
    let transactionOpen = false;
    let released = false;
    let primaryErrorRaised = false;
    let cleanupFailed = false;
    let cleanupFailure: unknown;
    const recordCleanupFailure = (error: unknown): void => {
      if (!cleanupFailed) cleanupFailure = error;
      cleanupFailed = true;
    };
    try {
      const authority = await client.query<{
        current_user: string;
        session_user: string;
        owns_proofs: boolean;
      }>(`
        SELECT current_user::text AS current_user,
               session_user::text AS session_user,
               pg_catalog.pg_has_role(current_user, 'commander_owner', 'USAGE') AS owns_proofs
      `);
      const identity = authority.rows[0];
      if (
        authority.rowCount !== 1 ||
        identity?.current_user !== 'commander_owner' ||
        identity.session_user !== 'commander_owner' ||
        !identity.owns_proofs
      ) {
        throw new Error('TENANT_CUTOVER_OWNER_AUTHORITY_REQUIRED');
      }
      await client.query(LEGACY_SESSION_LOCK_SQL);
      legacyLocked = true;
      await client.query(LIFECYCLE_SESSION_LOCK_SQL);
      lifecycleLocked = true;
      await client.query('BEGIN');
      transactionOpen = true;
      const transaction = new PostgresTask1RolloutProofTransaction(client);
      const result = await work(transaction);
      const pending = transaction.recoveryFor(result);
      try {
        await client.query('COMMIT');
      } catch (error) {
        transactionOpen = false;
        legacyLocked = false;
        lifecycleLocked = false;
        let uncertainConnectionReleased = false;
        try {
          await client.release(error instanceof Error ? error : true);
          uncertainConnectionReleased = true;
        } catch {
          // The original commit failure remains the authoritative error.
        }
        released = true;
        if (!uncertainConnectionReleased) throw error;
        const recovered = pending ? await this.recoverCommittedProof(pending) : undefined;
        if (recovered) return recovered as T;
        throw error;
      }
      transactionOpen = false;
      return result;
    } catch (error) {
      primaryErrorRaised = true;
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          recordCleanupFailure(rollbackError);
        } finally {
          transactionOpen = false;
        }
      }
      throw error;
    } finally {
      if (!released) {
        try {
          if (lifecycleLocked) {
            try {
              await client.query(LIFECYCLE_SESSION_UNLOCK_SQL);
            } catch (unlockError) {
              recordCleanupFailure(unlockError);
            } finally {
              lifecycleLocked = false;
            }
          }
        } finally {
          try {
            if (legacyLocked) {
              try {
                await client.query(LEGACY_SESSION_UNLOCK_SQL);
              } catch (unlockError) {
                recordCleanupFailure(unlockError);
              } finally {
                legacyLocked = false;
              }
            }
          } finally {
            try {
              await client.release(
                cleanupFailed
                  ? cleanupFailure instanceof Error
                    ? cleanupFailure
                    : true
                  : undefined,
              );
            } catch (releaseError) {
              recordCleanupFailure(releaseError);
            } finally {
              released = true;
            }
          }
        }
        if (!primaryErrorRaised && cleanupFailed) throw cleanupFailure;
      }
    }
  }
}
