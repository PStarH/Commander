import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@commander/contracts';
import { canonicalBytes } from './canonical.js';
import { parseShadowManifest, parseShadowObservation } from './contracts.js';
import { observationDigest } from './evaluator.js';
import { ShadowRepository, type ShadowSqlClient, type ShadowSqlPool } from './repository.js';

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
    clock: () => new Date('2026-09-01T12:00:00.000Z'),
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
    assert.match(client.calls[1]!.sql, /tenant_id[\s\S]*FOR UPDATE/i);
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
    for (const call of client.calls) {
      assert.match(call.sql, /tenant_id/i);
      assert.equal(call.values.includes('tenant-1'), true);
    }
  });
});
