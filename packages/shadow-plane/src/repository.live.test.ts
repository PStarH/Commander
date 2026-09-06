import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { actionGatewayPolicySnapshot } from '@commander/contracts';
import { canonicalBytes } from './canonical.js';
import {
  parseShadowManifest,
  parseShadowObservation,
  type ShadowObservationV1,
} from './contracts.js';
import { observationDigest } from './evaluator.js';
import { asShadowSqlPool, ShadowRepository } from './repository.js';
import { SHADOW_SCHEMA_SQL } from './schema.js';

const adminUrl = process.env.COMMANDER_SHADOW_PG_ADMIN_URL;
if (process.env.CI && !adminUrl) throw new Error('COMMANDER_SHADOW_PG_ADMIN_URL_REQUIRED');

describe('shadow PostgreSQL authority', { skip: !adminUrl }, () => {
  const passwords = {
    installer: 'shadow_installer_test',
    ingestion: 'shadow_ingestion_test',
    reader: 'shadow_reader_test',
    retention: 'shadow_retention_test',
  };
  const keys = generateKeyPairSync('ed25519');
  const snapshot = actionGatewayPolicySnapshot();
  const now = Date.now();
  let admin: Pool;
  let installer: Pool;
  let ingestion: Pool;
  let reader: Pool;
  let retention: Pool;

  function roleUrl(role: keyof typeof passwords): string {
    const url = new URL(adminUrl!);
    url.username = `commander_shadow_${role}`;
    url.password = passwords[role];
    return url.toString();
  }

  function repo(pool: Pool, clock = () => new Date(now)): ShadowRepository {
    return new ShadowRepository(asShadowSqlPool(pool), {
      retentionDays: 1,
      trustedManifestPublicKeys: new Map([['manifest-key-1', keys.publicKey]]),
      clock,
    });
  }

  function observation(
    campaignId: string,
    batchId: string,
    index: number,
    overrides: Record<string, unknown> = {},
  ): ShadowObservationV1 {
    return parseShadowObservation({
      schema: 'commander.shadow-observation/v1',
      campaignId,
      tenantId: 'tenant-live',
      producerId: 'producer-live',
      batchId,
      index,
      observationId: `${campaignId}-observation-${index}`,
      occurredAt: new Date(now).toISOString(),
      workflow: 'kubernetes.deployment.rollback',
      effectType: 'connector.kubernetes.deployment.rollback',
      tool: 'kubernetes.deployment.rollback',
      destination: 'k8s://cluster/namespace/deployments/api',
      productionDecision: 'require_approval',
      productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
      ...overrides,
    });
  }

  function manifest(
    campaignId: string,
    batchId: string,
    observations: ShadowObservationV1[],
    closesAt: string,
  ) {
    const unsigned = {
      schema: 'commander.shadow-manifest/v1',
      campaignId,
      tenantId: 'tenant-live',
      producerId: 'producer-live',
      policyId: snapshot.policyId,
      policyDigest: snapshot.descriptorDigest,
      batchId,
      closesAt,
      records: observations.map((record) => ({
        index: record.index,
        observationId: record.observationId,
        digest: observationDigest(record),
      })),
      keyId: 'manifest-key-1',
    };
    return parseShadowManifest({
      ...unsigned,
      signature: sign(null, canonicalBytes(unsigned), keys.privateKey).toString('base64url'),
    });
  }

  before(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 2 });
    await admin.query(`
      CREATE ROLE commander_shadow_installer LOGIN PASSWORD '${passwords.installer}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE commander_shadow_ingestion LOGIN PASSWORD '${passwords.ingestion}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE commander_shadow_reader LOGIN PASSWORD '${passwords.reader}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE commander_shadow_retention LOGIN PASSWORD '${passwords.retention}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      GRANT CREATE ON DATABASE commander TO commander_shadow_installer;
      CREATE SCHEMA shadow_other;
      CREATE TABLE shadow_other.secret (value text);
      INSERT INTO shadow_other.secret VALUES ('not-visible');
    `);
    installer = new Pool({ connectionString: roleUrl('installer'), max: 1 });
    await installer.query(SHADOW_SCHEMA_SQL);
    ingestion = new Pool({ connectionString: roleUrl('ingestion'), max: 3 });
    reader = new Pool({ connectionString: roleUrl('reader'), max: 2 });
    retention = new Pool({ connectionString: roleUrl('retention'), max: 3 });
  });

  after(async () => {
    await Promise.all([ingestion?.end(), reader?.end(), retention?.end(), installer?.end()]);
    if (admin) {
      await admin.query(`
        DROP SCHEMA IF EXISTS commander_shadow CASCADE;
        DROP SCHEMA IF EXISTS shadow_other CASCADE;
        REVOKE CREATE ON DATABASE commander FROM commander_shadow_installer;
        DROP ROLE IF EXISTS commander_shadow_ingestion;
        DROP ROLE IF EXISTS commander_shadow_reader;
        DROP ROLE IF EXISTS commander_shadow_retention;
        DROP ROLE IF EXISTS commander_shadow_installer;
      `);
      await admin.end();
    }
  });

  it('denies runtime DDL, role management, cross-schema reads, and cross-role writes', async () => {
    await assert.rejects(
      ingestion.query('CREATE TABLE commander_shadow.forbidden (id integer)'),
      /permission denied/i,
    );
    await assert.rejects(ingestion.query('CREATE ROLE shadow_forbidden'), /permission denied/i);
    await assert.rejects(
      ingestion.query('SELECT * FROM shadow_other.secret'),
      /permission denied/i,
    );
    await assert.rejects(
      reader.query(
        "INSERT INTO commander_shadow.campaigns VALUES ('t','c','p','x','d','open',clock_timestamp(),clock_timestamp(),NULL)",
      ),
      /permission denied/i,
    );
    await assert.rejects(
      retention.query('CREATE TABLE commander_shadow.forbidden_retention (id integer)'),
      /permission denied/i,
    );
  });

  it('persists registration and import across a fresh pool, supports identical retry, and rejects conflict', async () => {
    const input = observation('campaign-persist', 'batch-persist', 0);
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-persist', 'batch-persist', [input], new Date(now + 60_000).toISOString()),
    );
    const first = await repo(ingestion).importObservation('tenant-live', input);
    assert.equal(first.idempotent, false);
    await ingestion.end();
    ingestion = new Pool({ connectionString: roleUrl('ingestion'), max: 3 });
    const retry = await repo(ingestion).importObservation('tenant-live', input);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.evaluation.decisionId, first.evaluation.decisionId);
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', { ...input, productionDecision: 'deny' }),
      /SHADOW_OBSERVATION_CONFLICT/,
    );
    assert.equal(
      (await repo(reader).readReport('tenant-live', 'campaign-persist')).records.length,
      1,
    );
  });

  it('closes declared batches with complete terminal count reconciliation, including wholly missing batches', async () => {
    const first = observation('campaign-close', 'batch-partial', 0);
    const second = observation('campaign-close', 'batch-partial', 1);
    const closesAt = new Date(now + 60_000).toISOString();
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-close', 'batch-partial', [first, second], closesAt),
    );
    await repo(ingestion).importObservation('tenant-live', first);
    await repo(ingestion, () => new Date(now + 120_000)).closeDueBatch(
      'tenant-live',
      'campaign-close',
      'batch-partial',
    );
    const partial = await repo(reader).readReport('tenant-live', 'campaign-close');
    assert.deepEqual(
      partial.records.map((row) => row.status),
      ['compared', 'missing'],
    );

    const missing = [
      observation('campaign-missing', 'batch-missing', 0),
      observation('campaign-missing', 'batch-missing', 1),
    ];
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-missing', 'batch-missing', missing, closesAt),
    );
    await repo(ingestion, () => new Date(now + 120_000)).closeDueBatch(
      'tenant-live',
      'campaign-missing',
      'batch-missing',
    );
    const absent = await repo(reader).readReport('tenant-live', 'campaign-missing');
    assert.deepEqual(
      absent.records.map((row) => row.status),
      ['missing', 'missing'],
    );
    assert.equal(absent.records.length, 2);
    await assert.rejects(
      repo(ingestion).importObservation('tenant-live', missing[0]!),
      /SHADOW_BATCH_CLOSED/,
    );
  });

  it('serializes concurrent withdrawal and import so no observation survives withdrawal', async () => {
    const input = observation('campaign-withdraw', 'batch-withdraw', 0);
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest(
        'campaign-withdraw',
        'batch-withdraw',
        [input],
        new Date(now + 60_000).toISOString(),
      ),
    );
    await Promise.allSettled([
      repo(ingestion).importObservation('tenant-live', input),
      repo(retention).withdrawCampaign('tenant-live', 'campaign-withdraw'),
    ]);
    const report = await repo(reader).readReport('tenant-live', 'campaign-withdraw');
    assert.equal(report.campaign?.state, 'withdrawn');
    assert.equal(report.records.length, 0);
  });

  it('deletes expired campaign data and advances cleanup readiness', async () => {
    const input = observation('campaign-expire', 'batch-expire', 0);
    await repo(ingestion).registerManifest(
      'tenant-live',
      manifest('campaign-expire', 'batch-expire', [input], new Date(now + 60_000).toISOString()),
    );
    await admin.query(
      "UPDATE commander_shadow.campaigns SET retention_until=clock_timestamp()-interval '1 minute' WHERE tenant_id='tenant-live' AND campaign_id='campaign-expire'",
    );
    assert.equal(await repo(retention).runRetention('tenant-live'), 1);
    assert.equal((await repo(reader).readReport('tenant-live', 'campaign-expire')).campaign, null);
    assert.equal((await repo(reader).readiness('tenant-live', 120)).ready, true);
  });
});
