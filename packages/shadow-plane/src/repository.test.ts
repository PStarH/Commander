import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@commander/contracts';
import { canonicalBytes } from './canonical.js';
import { parseShadowManifest, parseShadowObservation } from './contracts.js';
import { observationDigest } from './evaluator.js';
import { ShadowRepository, type ShadowSqlClient, type ShadowSqlPool } from './repository.js';
import { SHADOW_SCHEMA_SQL } from './schema.js';

type Response = { rows?: Record<string, unknown>[]; rowCount?: number };

class RecordingClient implements ShadowSqlClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  released = false;
  constructor(private readonly respond: (sql: string) => Response = () => ({})) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    const response = this.respond(sql);
    return { rows: response.rows ?? [], rowCount: response.rowCount ?? 0 };
  }
  release(): void {
    this.released = true;
  }
}

class RecordingPool implements ShadowSqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect(): Promise<ShadowSqlClient> {
    return this.client;
  }
  query(sql: string, values: unknown[] = []) {
    return this.client.query(sql, values);
  }
}

const snapshot = actionGatewayPolicySnapshot();
const keyPair = generateKeyPairSync('ed25519');

function observation() {
  return parseShadowObservation({
    schema: 'commander.shadow-observation/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    batchId: 'batch-1',
    index: 0,
    observationId: 'observation-1',
    occurredAt: '2026-09-01T00:00:00.000Z',
    workflow: 'kubernetes.deployment.rollback',
    effectType: 'connector.kubernetes.deployment.rollback',
    tool: 'kubernetes.deployment.rollback',
    destination: 'k8s://cluster-1/namespace-1/deployments/api',
    productionDecision: 'require_approval',
    productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
  });
}

function manifest() {
  const unsigned = {
    schema: 'commander.shadow-manifest/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    policyId: snapshot.policyId,
    policyDigest: snapshot.descriptorDigest,
    batchId: 'batch-1',
    closesAt: '2026-09-02T00:00:00.000Z',
    records: [
      { index: 0, observationId: 'observation-1', digest: observationDigest(observation()) },
    ],
    keyId: 'manifest-key-1',
  };
  return parseShadowManifest({
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), keyPair.privateKey).toString('base64url'),
  });
}

function repository(client: RecordingClient): ShadowRepository {
  return new ShadowRepository(new RecordingPool(client), {
    retentionDays: 14,
    trustedManifestPublicKeys: new Map([['manifest-key-1', keyPair.publicKey]]),
  });
}

describe('shadow PostgreSQL repository contract', () => {
  it('verifies manifest authority and policy before opening a transaction', async () => {
    const client = new RecordingClient();
    const invalid = { ...manifest(), signature: Buffer.alloc(64, 2).toString('base64url') };
    await assert.rejects(
      repository(client).registerManifest('tenant-1', invalid),
      /SHADOW_MANIFEST_SIGNATURE_INVALID/,
    );
    assert.deepEqual(client.calls, []);
  });

  it('registers expected records in one tenant-bound transaction', async () => {
    const client = new RecordingClient();
    await repository(client).registerManifest('tenant-1', manifest());
    assert.equal(client.calls[0]?.sql, 'BEGIN');
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(client.released, true);
    const mutations = client.calls.filter((call) => /INSERT|UPDATE|DELETE/i.test(call.sql));
    assert.ok(mutations.length >= 3);
    for (const call of mutations) {
      assert.match(call.sql, /tenant_id/i);
      assert.equal(call.values.includes('tenant-1'), true);
    }
  });

  it('locks the tenant campaign before observation admission and withdrawal', async () => {
    const campaignRow = {
      state: 'open',
      producer_id: 'producer-1',
      policy_id: snapshot.policyId,
      policy_digest: snapshot.descriptorDigest,
    };
    const expectedRow = {
      digest: observationDigest(observation()),
      observation_id: 'observation-1',
      status: 'pending',
      closes_at: '2026-09-02T00:00:00.000Z',
      batch_state: 'open',
      is_due: false,
    };
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow\.campaigns/i.test(sql))
        return { rows: [campaignRow], rowCount: 1 };
      if (/FROM commander_shadow\.expected_records/i.test(sql))
        return { rows: [expectedRow], rowCount: 1 };
      return {};
    });
    const repo = repository(client);
    await repo.importObservation('tenant-1', observation());
    const lock = client.calls.findIndex((call) => /campaigns[\s\S]*FOR UPDATE/i.test(call.sql));
    const insert = client.calls.findIndex((call) =>
      /INSERT INTO commander_shadow\.observations/i.test(call.sql),
    );
    assert.ok(lock > 0 && insert > lock);

    client.calls.length = 0;
    await repo.withdrawCampaign('tenant-1', 'campaign-1');
    assert.ok(client.calls.some((call) => /tenant_id[\s\S]*FOR UPDATE/i.test(call.sql)));
    assert.ok(
      client.calls.some((call) =>
        /DELETE FROM commander_shadow\.(observations|batches)/i.test(call.sql),
      ),
    );
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
  });

  it('returns the persisted decision on identical retry and identifies changed content as conflict', async () => {
    const storedDigest = observationDigest(observation());
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow\.campaigns/i.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: snapshot.descriptorDigest,
            },
          ],
          rowCount: 1,
        };
      if (/FROM commander_shadow\.expected_records/i.test(sql))
        return {
          rows: [
            {
              digest: storedDigest,
              observation_id: 'observation-1',
              status: 'compared',
              closes_at: '2026-09-02T00:00:00.000Z',
              batch_state: 'open',
              is_due: false,
            },
          ],
          rowCount: 1,
        };
      if (/FROM commander_shadow\.observations/i.test(sql))
        return {
          rows: [
            {
              digest: storedDigest,
              hypothetical_decision: 'require_approval',
              hypothetical_decision_id: 'action-gateway-manifest-require_approval',
              hypothetical_reason_code: 'REGISTERED_ADAPTER_POLICY',
              comparison: 'match',
            },
          ],
          rowCount: 1,
        };
      return {};
    });
    const retry = await repository(client).importObservation('tenant-1', observation());
    assert.equal(retry.idempotent, true);
    assert.equal(retry.evaluation.decisionId, 'action-gateway-manifest-require_approval');

    await assert.rejects(
      repository(client).importObservation('tenant-1', {
        ...observation(),
        productionDecision: 'deny',
      }),
      /SHADOW_OBSERVATION_CONFLICT/,
    );
  });

  it('rolls back and propagates database failures without fallback', async () => {
    const failure = new Error('database unavailable');
    const client = new RecordingClient((sql) => {
      if (/INSERT INTO commander_shadow\.campaigns/i.test(sql)) throw failure;
      return {};
    });
    await assert.rejects(repository(client).registerManifest('tenant-1', manifest()), failure);
    assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(client.released, true);
  });

  it('places tenant predicates on every report and readiness data query', async () => {
    const client = new RecordingClient();
    const repo = repository(client);
    await repo.readReport('tenant-1', 'campaign-1');
    for (const call of client.calls.filter((call) => /SELECT/.test(call.sql))) {
      assert.match(call.sql, /tenant_id/i);
      assert.equal(call.values.includes('tenant-1'), true);
    }
  });

  it('releases a connection when BEGIN fails without issuing ROLLBACK', async () => {
    const client = new RecordingClient((sql) => {
      if (sql === 'BEGIN') throw new Error('begin failed');
      return {};
    });
    await assert.rejects(repository(client).runRetention('tenant-1'), /begin failed/);
    assert.equal(client.released, true);
    assert.deepEqual(
      client.calls.map((call) => call.sql),
      ['BEGIN'],
    );
  });

  it('only successful retention initializes cleanup readiness', async () => {
    const client = new RecordingClient();
    await repository(client).registerManifest('tenant-1', manifest());
    assert.equal(
      client.calls.some((call) => /cleanup_state/.test(call.sql)),
      false,
    );
    client.calls.length = 0;
    await repository(client).runRetention('tenant-1');
    assert.ok(
      client.calls.some((call) =>
        /INSERT INTO commander_shadow.cleanup_state[\s\S]*ON CONFLICT/.test(call.sql),
      ),
    );
    assert.doesNotMatch(
      SHADOW_SCHEMA_SQL,
      /GRANT SELECT, INSERT, UPDATE[^;]*cleanup_state[^;]*TO commander_shadow_ingestion/,
    );
    assert.match(
      SHADOW_SCHEMA_SQL,
      /GRANT SELECT, INSERT, UPDATE ON commander_shadow.cleanup_state TO commander_shadow_retention/,
    );
  });

  it('reads report data on one transaction and holds a campaign lock', async () => {
    const client = new RecordingClient();
    await repository(client).readReport('tenant-1', 'campaign-1');
    assert.equal(client.calls[0]?.sql, 'BEGIN');
    assert.ok(client.calls.some((call) => /pg_advisory_xact_lock_shared/.test(call.sql)));
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(client.released, true);
  });

  it('uses the database deadline for close and admission', async () => {
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return { rows: [{ state: 'open', producer_id: 'producer-1' }] };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [{ batch_state: 'open', is_due: true, closes_at: '2999-01-01T00:00:00.000Z' }],
        };
      if (/FROM commander_shadow.batches/.test(sql))
        return { rows: [{ state: 'open', is_due: false, closes_at: '2000-01-01T00:00:00.000Z' }] };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', observation()),
      /SHADOW_BATCH_CLOSED/,
    );
    await assert.rejects(
      repository(client).closeDueBatch('tenant-1', 'campaign-1', 'batch-1'),
      /SHADOW_BATCH_NOT_DUE/,
    );
  });

  it('commits a bound rejection with only a digest and stable code', async () => {
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: snapshot.descriptorDigest,
            },
          ],
        };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [
            {
              batch_state: 'open',
              is_due: false,
              observation_id: 'observation-1',
              digest: observationDigest(observation()),
            },
          ],
        };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', {
        ...observation(),
        destination: 'k8s://different/ns/deployments/api',
      }),
      /SHADOW_DIGEST_MISMATCH/,
    );
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    const rejected = client.calls.find(
      (call) => /attempt_code/.test(call.sql) && /UPDATE/.test(call.sql),
    );
    assert.ok(rejected);
    assert.ok(rejected.values.includes('rejected'));
    assert.ok(rejected.values.includes('SHADOW_DIGEST_MISMATCH'));
    assert.equal(JSON.stringify(rejected.values).includes('k8s://different'), false);
  });

  it('records schema-invalid arrived content when its manifest binding is known', async () => {
    const raw = { ...observation(), productionDecision: 'invalid', secret: 'must-not-store' };
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: snapshot.descriptorDigest,
            },
          ],
        };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [
            {
              batch_state: 'open',
              is_due: false,
              observation_id: 'observation-1',
              digest: observationDigest(observation()),
            },
          ],
        };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', raw),
      /SHADOW_DIGEST_MISMATCH/,
    );
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(JSON.stringify(client.calls).includes('must-not-store'), false);
  });

  it('refuses unbound or malformed identities before accessing PostgreSQL', async () => {
    const client = new RecordingClient();
    for (const raw of [
      null,
      { ...observation(), index: -1 },
      { ...observation(), campaignId: 'invalid campaign' },
    ]) {
      await assert.rejects(repository(client).importObservation('tenant-1', raw), /SHADOW_INVALID/);
    }
    assert.equal(client.calls.length, 0);
  });

  it('persists evaluation failures separately and lets a later valid retry replace an attempt', async () => {
    let failed = true;
    const client = new RecordingClient((sql) => {
      if (/FROM commander_shadow.campaigns/.test(sql))
        return {
          rows: [
            {
              state: 'open',
              producer_id: 'producer-1',
              policy_id: snapshot.policyId,
              policy_digest: failed ? 'bad-pin' : snapshot.descriptorDigest,
            },
          ],
        };
      if (/FROM commander_shadow.expected_records/.test(sql))
        return {
          rows: [
            {
              status: 'failed',
              batch_state: 'open',
              is_due: false,
              observation_id: 'observation-1',
              digest: observationDigest(observation()),
            },
          ],
        };
      return {};
    });
    await assert.rejects(
      repository(client).importObservation('tenant-1', observation()),
      /SHADOW_EVALUATION_FAILED/,
    );
    assert.ok(client.calls.some((call) => call.values.includes('failed')));
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    failed = false;
    assert.equal(
      (await repository(client).importObservation('tenant-1', observation())).comparison,
      'match',
    );
    assert.ok(client.calls.some((call) => /attempt_code=NULL/.test(call.sql)));
  });
});
