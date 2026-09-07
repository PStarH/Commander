import { createHash, type KeyObject } from 'node:crypto';
import { actionGatewayPolicySnapshot } from '@commander/contracts';
import { canonicalBytes, sha256Hex, verifyEd25519 } from './canonical.js';
import {
  parseShadowObservation,
  parseShadowObservationBinding,
  ShadowContractError,
  type ShadowManifestV1,
  type ShadowObservationV1,
} from './contracts.js';
import { compareShadowDecision, type ShadowComparison } from './comparison.js';
import {
  evaluateShadowObservation,
  observationDigest,
  type ShadowEvaluation,
} from './evaluator.js';
import { SHADOW_SCHEMA_VERSION } from './schema.js';
import type { Pool, PoolClient } from 'pg';

export interface ShadowSqlResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface ShadowSqlClient {
  query(sql: string, values?: unknown[]): Promise<ShadowSqlResult>;
  release(): void;
}

export interface ShadowSqlPool {
  connect(): Promise<ShadowSqlClient>;
  query(sql: string, values?: unknown[]): Promise<ShadowSqlResult>;
}

function clientAdapter(client: PoolClient): ShadowSqlClient {
  return {
    async query(sql, values = []) {
      const result = await client.query(sql, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release() {
      client.release();
    },
  };
}

export function asShadowSqlPool(pool: Pool): ShadowSqlPool {
  return {
    async connect() {
      return clientAdapter(await pool.connect());
    },
    async query(sql, values = []) {
      const result = await pool.query(sql, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export interface ShadowRepositoryOptions {
  retentionDays: number;
  trustedManifestPublicKeys: ReadonlyMap<string, KeyObject>;
}

export interface ShadowImportResult {
  idempotent: boolean;
  evaluation: ShadowEvaluation;
  comparison: ShadowComparison;
}

export interface ShadowCampaignReportData {
  campaign: Record<string, unknown> | null;
  batches: Record<string, unknown>[];
  records: Record<string, unknown>[];
}

async function transaction<T>(
  pool: ShadowSqlPool,
  operation: (client: ShadowSqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (begun)
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'SHADOW_TRANSACTION_ROLLBACK_FAILED');
      }
    throw error;
  } finally {
    client.release();
  }
}

function requireTenant(tenantId: string, recordTenantId?: string): void {
  if (!tenantId || (recordTenantId !== undefined && tenantId !== recordTenantId)) {
    throw new Error('SHADOW_TENANT_MISMATCH');
  }
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error('SHADOW_DATABASE_ROW_INVALID');
  return value;
}

function campaignHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Shared advisory locks let the SELECT-only reader serialize with campaign writes.
// Every writer takes the same lock before row locks; hash collisions only add waiting.
async function lockCampaign(
  client: ShadowSqlClient,
  tenantId: string,
  campaignId: string,
  shared = false,
): Promise<void> {
  await client.query(
    `SELECT ${shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(
       hashtextextended(json_build_array($1::text, $2::text)::text, 0)) AS tenant_id`,
    [tenantId, campaignId],
  );
}

export class ShadowRepository {
  constructor(
    private readonly pool: ShadowSqlPool,
    private readonly options: ShadowRepositoryOptions,
  ) {}

  async registerManifest(
    tenantId: string,
    manifest: ShadowManifestV1,
  ): Promise<{ idempotent: boolean }> {
    requireTenant(tenantId, manifest.tenantId);
    const trustedKey = this.options.trustedManifestPublicKeys.get(manifest.keyId);
    if (!trustedKey) throw new Error('SHADOW_MANIFEST_KEY_UNTRUSTED');
    const { signature, ...signedBody } = manifest;
    if (!verifyEd25519(signedBody, signature, trustedKey)) {
      throw new Error('SHADOW_MANIFEST_SIGNATURE_INVALID');
    }
    const snapshot = actionGatewayPolicySnapshot();
    if (
      manifest.policyId !== snapshot.policyId ||
      manifest.policyDigest !== snapshot.descriptorDigest
    ) {
      throw new Error('SHADOW_POLICY_MISMATCH');
    }
    const manifestDigest = sha256Hex(canonicalBytes(manifest));
    const retentionUntil = new Date(
      Date.parse(manifest.closesAt) + this.options.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    return transaction(this.pool, async (client) => {
      await lockCampaign(client, tenantId, manifest.campaignId);
      await client.query(
        `INSERT INTO commander_shadow.campaigns
           (tenant_id, campaign_id, producer_id, policy_id, policy_digest, state, retention_until)
         VALUES ($1,$2,$3,$4,$5,'open',$6)
         ON CONFLICT (tenant_id, campaign_id) DO NOTHING`,
        [
          tenantId,
          manifest.campaignId,
          manifest.producerId,
          manifest.policyId,
          manifest.policyDigest,
          retentionUntil,
        ],
      );
      const campaign = await client.query(
        `SELECT producer_id, policy_id, policy_digest, state
           FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND campaign_id=$2
          FOR UPDATE`,
        [tenantId, manifest.campaignId],
      );
      const existingCampaign = campaign.rows[0];
      if (existingCampaign) {
        if (existingCampaign.state === 'withdrawn') throw new Error('SHADOW_CAMPAIGN_WITHDRAWN');
        if (
          existingCampaign.producer_id !== manifest.producerId ||
          existingCampaign.policy_id !== manifest.policyId ||
          existingCampaign.policy_digest !== manifest.policyDigest
        )
          throw new Error('SHADOW_CAMPAIGN_CONFLICT');
      }
      const inserted = await client.query(
        `INSERT INTO commander_shadow.batches
           (tenant_id, campaign_id, batch_id, manifest, manifest_digest, closes_at, state)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,'open')
         ON CONFLICT (tenant_id, campaign_id, batch_id) DO NOTHING
         RETURNING manifest_digest`,
        [
          tenantId,
          manifest.campaignId,
          manifest.batchId,
          JSON.stringify(manifest),
          manifestDigest,
          manifest.closesAt,
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query(
          `SELECT manifest_digest FROM commander_shadow.batches
            WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 FOR UPDATE`,
          [tenantId, manifest.campaignId, manifest.batchId],
        );
        if (existing.rows[0] && existing.rows[0].manifest_digest !== manifestDigest) {
          throw new Error('SHADOW_MANIFEST_CONFLICT');
        }
        if (existing.rows[0]) return { idempotent: true };
      }
      for (const record of manifest.records) {
        await client.query(
          `INSERT INTO commander_shadow.expected_records
             (tenant_id, campaign_id, batch_id, record_index, observation_id, digest, status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
          [
            tenantId,
            manifest.campaignId,
            manifest.batchId,
            record.index,
            record.observationId,
            record.digest,
          ],
        );
      }
      await client.query(
        `UPDATE commander_shadow.campaigns SET retention_until=GREATEST(retention_until,$3)
          WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, manifest.campaignId, retentionUntil],
      );
      return { idempotent: false };
    });
  }

  async importObservation(tenantId: string, rawObservation: unknown): Promise<ShadowImportResult> {
    const observation = parseShadowObservationBinding(rawObservation);
    requireTenant(tenantId, observation.tenantId);
    const result = await transaction<ShadowImportResult | { error: string }>(
      this.pool,
      async (client) => {
        await lockCampaign(client, tenantId, observation.campaignId);
        const campaignResult = await client.query(
          `SELECT producer_id, policy_id, policy_digest, state
           FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND campaign_id=$2
          FOR UPDATE`,
          [tenantId, observation.campaignId],
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw new Error('SHADOW_CAMPAIGN_NOT_FOUND');
        if (campaign.state !== 'open') throw new Error('SHADOW_CAMPAIGN_CLOSED');
        if (campaign.producer_id !== observation.producerId)
          throw new Error('SHADOW_PRODUCER_MISMATCH');

        const expectedResult = await client.query(
          `SELECT e.digest, e.observation_id, e.status, b.closes_at,
                b.closes_at <= clock_timestamp() AS is_due, b.state AS batch_state
           FROM commander_shadow.expected_records e
           JOIN commander_shadow.batches b USING (tenant_id, campaign_id, batch_id)
          WHERE e.tenant_id=$1 AND e.campaign_id=$2 AND e.batch_id=$3 AND e.record_index=$4
          FOR UPDATE OF e, b`,
          [tenantId, observation.campaignId, observation.batchId, observation.index],
        );
        const expected = expectedResult.rows[0];
        if (!expected) throw new Error('SHADOW_EXPECTED_RECORD_NOT_FOUND');
        if (expected.batch_state !== 'open' || expected.is_due !== false) {
          throw new Error('SHADOW_BATCH_CLOSED');
        }
        if (expected.observation_id !== observation.observationId)
          throw new Error('SHADOW_OBSERVATION_ID_MISMATCH');
        const digest = sha256Hex(canonicalBytes(rawObservation));

        const existing = await client.query(
          `SELECT digest, hypothetical_decision, hypothetical_decision_id,
                hypothetical_reason_code, comparison
           FROM commander_shadow.observations
          WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND record_index=$4`,
          [tenantId, observation.campaignId, observation.batchId, observation.index],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].digest !== digest) throw new Error('SHADOW_OBSERVATION_CONFLICT');
          return {
            idempotent: true,
            evaluation: {
              decision: rowString(
                existing.rows[0],
                'hypothetical_decision',
              ) as ShadowEvaluation['decision'],
              decisionId: rowString(existing.rows[0], 'hypothetical_decision_id'),
              reasonCode: rowString(existing.rows[0], 'hypothetical_reason_code'),
              policyId: actionGatewayPolicySnapshot().policyId,
              policyDigest: rowString(campaign, 'policy_digest'),
            },
            comparison: rowString(existing.rows[0], 'comparison') as ShadowComparison,
          };
        }
        const recordAttempt = async (status: 'rejected' | 'failed', code: string) => {
          await client.query(
            `UPDATE commander_shadow.expected_records
              SET status=$5, attempt_digest=$6, attempt_code=$7, attempted_at=clock_timestamp()
            WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND record_index=$4`,
            [
              tenantId,
              observation.campaignId,
              observation.batchId,
              observation.index,
              status,
              digest,
              code,
            ],
          );
          return { error: code };
        };
        if (expected.digest !== digest) return recordAttempt('rejected', 'SHADOW_DIGEST_MISMATCH');
        let evaluation: ShadowEvaluation;
        let parsed: ShadowObservationV1;
        try {
          parsed = parseShadowObservation(rawObservation);
          evaluation = evaluateShadowObservation(parsed, {
            policyId: rowString(campaign, 'policy_id'),
            policyDigest: rowString(campaign, 'policy_digest'),
            expectedDigest: rowString(expected, 'digest'),
          });
        } catch (error) {
          if (error instanceof ShadowContractError) return recordAttempt('rejected', error.code);
          if (error instanceof Error && error.message === 'SHADOW_UNSUPPORTED_ACTION')
            return recordAttempt('rejected', 'SHADOW_UNSUPPORTED_ACTION');
          return recordAttempt('failed', 'SHADOW_EVALUATION_FAILED');
        }
        const comparison = compareShadowDecision(parsed.productionDecision, evaluation.decision);
        const terminalStatus = comparison === 'uncomparable' ? 'uncomparable' : 'compared';
        await client.query(
          `INSERT INTO commander_shadow.observations
           (tenant_id, campaign_id, batch_id, record_index, observation_id, digest,
            canonical_observation, hypothetical_decision, hypothetical_reason_code,
            hypothetical_decision_id,
            production_decision, production_reason_code, comparison)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
          [
            tenantId,
            observation.campaignId,
            observation.batchId,
            observation.index,
            observation.observationId,
            digest,
            JSON.stringify(parsed),
            evaluation.decision,
            evaluation.reasonCode,
            evaluation.decisionId,
            parsed.productionDecision,
            parsed.productionReasonCode ?? null,
            comparison,
          ],
        );
        await client.query(
          `UPDATE commander_shadow.expected_records SET status=$5,
                attempt_digest=NULL, attempt_code=NULL, attempted_at=NULL
          WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND record_index=$4`,
          [
            tenantId,
            observation.campaignId,
            observation.batchId,
            observation.index,
            terminalStatus,
          ],
        );
        return { idempotent: false, evaluation, comparison };
      },
    );
    if ('error' in result) throw new Error(result.error);
    return result;
  }

  async closeDueBatch(tenantId: string, campaignId: string, batchId: string): Promise<void> {
    requireTenant(tenantId);
    await transaction(this.pool, async (client) => {
      await lockCampaign(client, tenantId, campaignId);
      const campaign = await client.query(
        `SELECT state FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`,
        [tenantId, campaignId],
      );
      if (!campaign.rows[0] || campaign.rows[0].state !== 'open')
        throw new Error('SHADOW_CAMPAIGN_NOT_OPEN');
      const batch = await client.query(
        `SELECT state, closes_at, closes_at <= clock_timestamp() AS is_due FROM commander_shadow.batches
          WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 FOR UPDATE`,
        [tenantId, campaignId, batchId],
      );
      if (!batch.rows[0]) throw new Error('SHADOW_BATCH_NOT_FOUND');
      if (batch.rows[0].is_due !== true) throw new Error('SHADOW_BATCH_NOT_DUE');
      if (batch.rows[0].state === 'closed') return;
      await client.query(
        `UPDATE commander_shadow.expected_records SET status='missing'
          WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND status='pending'`,
        [tenantId, campaignId, batchId],
      );
      await client.query(
        `UPDATE commander_shadow.batches SET state='closed', closed_at=clock_timestamp()
          WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3`,
        [tenantId, campaignId, batchId],
      );
    });
  }

  async readReport(tenantId: string, campaignId: string): Promise<ShadowCampaignReportData> {
    requireTenant(tenantId);
    return transaction(this.pool, async (client) => {
      await lockCampaign(client, tenantId, campaignId, true);
      const campaign = await client.query(
        `SELECT campaign_id, producer_id, policy_id, policy_digest, state, retention_until, created_at
         FROM commander_shadow.campaigns WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      const batches = await client.query(
        `SELECT batch_id, manifest, manifest_digest, closes_at, state, closed_at
         FROM commander_shadow.batches WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY batch_id`,
        [tenantId, campaignId],
      );
      const records = await client.query(
        `SELECT e.batch_id, e.record_index, e.observation_id, e.digest, e.status,
              e.attempt_digest, e.attempt_code, e.attempted_at,
              o.canonical_observation, o.hypothetical_decision, o.hypothetical_reason_code,
              o.hypothetical_decision_id,
              o.production_decision, o.production_reason_code, o.comparison
         FROM commander_shadow.expected_records e
         LEFT JOIN commander_shadow.observations o
           USING (tenant_id, campaign_id, batch_id, record_index)
        WHERE e.tenant_id=$1 AND e.campaign_id=$2 ORDER BY e.batch_id, e.record_index`,
        [tenantId, campaignId],
      );
      return { campaign: campaign.rows[0] ?? null, batches: batches.rows, records: records.rows };
    });
  }

  async withdrawCampaign(tenantId: string, campaignId: string): Promise<void> {
    requireTenant(tenantId);
    await transaction(this.pool, async (client) => {
      await lockCampaign(client, tenantId, campaignId);
      const campaign = await client.query(
        `SELECT state FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`,
        [tenantId, campaignId],
      );
      if (!campaign.rows[0]) throw new Error('SHADOW_CAMPAIGN_NOT_FOUND');
      if (campaign.rows[0].state === 'withdrawn') return;
      await client.query(
        `UPDATE commander_shadow.campaigns
            SET state='withdrawn', producer_id=NULL, policy_id=NULL, policy_digest=NULL,
                withdrawn_at=clock_timestamp()
          WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      await client.query(
        `DELETE FROM commander_shadow.observations WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      await client.query(
        `DELETE FROM commander_shadow.batches WHERE tenant_id=$1 AND campaign_id=$2`,
        [tenantId, campaignId],
      );
      await client.query(
        `INSERT INTO commander_shadow.deletion_audit
           (tenant_id_hash, campaign_id_hash, reason) VALUES ($1,$2,'withdrawal')`,
        [campaignHash(tenantId), campaignHash(campaignId)],
      );
    });
  }

  async runRetention(tenantId: string): Promise<number> {
    requireTenant(tenantId);
    return transaction(this.pool, async (client) => {
      const expired = await client.query(
        `SELECT campaign_id FROM commander_shadow.campaigns
          WHERE tenant_id=$1 AND retention_until <= clock_timestamp() ORDER BY campaign_id`,
        [tenantId],
      );
      for (const row of expired.rows) {
        const campaignId = rowString(row, 'campaign_id');
        await lockCampaign(client, tenantId, campaignId);
        const locked = await client.query(
          `SELECT campaign_id FROM commander_shadow.campaigns
            WHERE tenant_id=$1 AND campaign_id=$2 AND retention_until <= clock_timestamp() FOR UPDATE`,
          [tenantId, campaignId],
        );
        if (locked.rows.length === 0) continue;
        await client.query(
          `INSERT INTO commander_shadow.deletion_audit
             (tenant_id_hash, campaign_id_hash, reason) VALUES ($1,$2,'retention')`,
          [campaignHash(tenantId), campaignHash(campaignId)],
        );
        await client.query(
          `DELETE FROM commander_shadow.campaigns WHERE tenant_id=$1 AND campaign_id=$2`,
          [tenantId, campaignId],
        );
      }
      await client.query(
        `INSERT INTO commander_shadow.cleanup_state (tenant_id, last_completed_at)
         VALUES ($1, clock_timestamp()) ON CONFLICT (tenant_id)
         DO UPDATE SET last_completed_at=EXCLUDED.last_completed_at`,
        [tenantId],
      );
      return expired.rows.length;
    });
  }

  async readiness(
    tenantId: string,
    cleanupFreshnessMinutes: number,
  ): Promise<{ ready: boolean; code: string }> {
    requireTenant(tenantId);
    const privileges = await this.pool.query(
      `SELECT has_schema_privilege(current_user, 'commander_shadow', 'USAGE') AS schema_usage,
              has_schema_privilege(current_user, 'commander_shadow', 'CREATE') AS schema_create,
              has_table_privilege(current_user, 'commander_shadow.schema_version', 'SELECT') AS version_read
        WHERE $1::text IS NOT NULL`,
      [tenantId],
    );
    const privilegeRow = privileges.rows[0];
    if (
      !privilegeRow ||
      privilegeRow.schema_usage !== true ||
      privilegeRow.schema_create !== false ||
      privilegeRow.version_read !== true
    )
      return { ready: false, code: 'SHADOW_DATABASE_PRIVILEGES_INVALID' };
    const version = await this.pool.query(
      `SELECT version FROM commander_shadow.schema_version WHERE version=$1`,
      [SHADOW_SCHEMA_VERSION],
    );
    if (version.rows.length !== 1) return { ready: false, code: 'SHADOW_SCHEMA_NOT_READY' };
    const cleanup = await this.pool.query(
      `SELECT last_completed_at FROM commander_shadow.cleanup_state
        WHERE tenant_id=$1
          AND last_completed_at >= clock_timestamp() - ($2 * interval '1 minute')`,
      [tenantId, cleanupFreshnessMinutes],
    );
    if (cleanup.rows.length !== 1) return { ready: false, code: 'SHADOW_CLEANUP_OVERDUE' };
    return { ready: true, code: 'SHADOW_READY' };
  }
}
