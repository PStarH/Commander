import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL } from './campaign2CriticalHardening.js';
import {
  KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
  KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
  KERNEL_SIGNED_EVIDENCE_ORDERING_SQL,
} from './evidenceSchema.js';
import { KERNEL_SIGNED_EVIDENCE_MIGRATIONS } from './migrations.js';
import {
  PostgresKernelRepository,
  type SqlClient,
  type SqlPool,
  type SqlQueryResult,
  type TenantContextAuthority,
} from './postgres.js';
import type { CompensationAuthorizationRecord } from './types.js';
import type { KernelEvidenceRecord } from './evidenceRepository.js';

function result<T>(rows: T[] = []): SqlQueryResult<T> {
  return { rows, rowCount: rows.length };
}

class RecordingClient implements SqlClient {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(private readonly loginRole: 'commander_app' | 'commander_adapter_ops') {}

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, values });
    if (/session_user::text AS login_role/i.test(sql)) {
      return result([{ login_role: this.loginRole } as T]);
    }
    if (/pg_current_xact_id\(\)::text AS xid/i.test(sql)) {
      return result([{ database_oid: 16_384, backend_pid: 42, xid: '91' } as T]);
    }
    if (/bind_app_tenant_context/i.test(sql)) {
      return result([{ tenant_id: 'tenant-a' } as T]);
    }
    if (/create_compensation_authorization/i.test(sql)) {
      return result([
        {
          result: { authorization: AUTHORIZATION, replayed: false },
        } as T,
      ]);
    }
    if (/request_compensation/i.test(sql)) {
      return result([
        {
          result: { accepted: false, requestId: 'request-a', reason: 'AUTHORIZATION_NOT_FOUND' },
        } as T,
      ]);
    }
    if (/complete_reconcile_effect/i.test(sql)) {
      return result([{ result: { applied: false, reason: 'NOT_FOUND' } } as T]);
    }
    if (/read_adapter_ops_evidence_context/i.test(sql)) {
      return result([
        {
          result: {
            effect: {
              id: 'effect-a',
              runId: 'run-a',
              stepId: 'step-a',
              tenantId: 'tenant-a',
              type: 'crm.write',
              state: 'COMPLETION_UNKNOWN',
              requestHash: 'request-a',
              policyDecisionId: 'decision-a',
              policySnapshotId: 'snapshot-a',
              actionDigest: 'b'.repeat(64),
              request: {},
              createdAt: '2026-07-30T00:00:00.000Z',
            },
            events: [],
            evidence: null,
          },
        } as T,
      ]);
    }
    return result<T>();
  }

  release(): void {}
}

class Pool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect(): Promise<SqlClient> {
    return this.client;
  }
}

class Authority implements TenantContextAuthority {
  async issue() {
    return {
      contextId: '00000000-0000-4000-8000-000000000001',
      expiresAt: new Date(Date.now() + 60_000),
    };
  }
}

const AUTHORIZATION: CompensationAuthorizationRecord = {
  id: 'authorization-a',
  tenantId: 'tenant-a',
  originalRunId: 'run-a',
  originalEffectId: 'effect-a',
  compensationEffectType: 'compensate.demo.ticket.create',
  adapterVersion: 'v1',
  compensationPatch: {},
  forwardReceiptHash: 'a'.repeat(64),
  policyDecisionId: 'decision-a',
  policySnapshotId: 'snapshot-a',
  decision: 'allow',
  actionDigest: 'b'.repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const EVIDENCE: KernelEvidenceRecord = {
  tenantId: 'tenant-a',
  runId: 'run-a',
  bundleId: 'evidence_effect-a',
  actionDigest: 'b'.repeat(64),
  body: { scope: { tenantId: 'tenant-a', runId: 'run-a', effectId: 'effect-a' } },
  contentHash: 'c'.repeat(64),
  signature: {
    algorithm: 'Ed25519',
    keyId: 'test-key',
    signedAt: '2026-07-30T00:00:00.000Z',
    value: 'signature',
  },
  createdAt: '2026-07-30T00:00:00.000Z',
  anchoredAt: '2026-07-30T00:00:01.000Z',
  retentionUntil: '2027-07-30T00:00:00.000Z',
};

describe('Campaign 2 critical authority hardening', () => {
  it('pins the published signed-evidence authority closure checksum', () => {
    const historical = KERNEL_SIGNED_EVIDENCE_MIGRATIONS.find(
      ({ id }) => id === '2026-07-29.2.signed_evidence_authority_closure',
    );
    assert.equal(
      historical?.checksum,
      'd76d0dc499b7c2b69abe779252792cf3fd7dd1921e09cd9b8d77e42035f7149d',
    );
  });

  it('validates and locks reconciliation authority before receipt and terminal mutation', () => {
    assert.match(
      KERNEL_SIGNED_EVIDENCE_ORDERING_SQL,
      /validate_reconcile_effect_mutation_v1[\s\S]*FOR UPDATE[\s\S]*CREATE OR REPLACE FUNCTION public\.apply_reconcile_effect_with_evidence_v1/i,
    );
    const wrapper = KERNEL_SIGNED_EVIDENCE_ORDERING_SQL.match(
      /CREATE OR REPLACE FUNCTION public\.apply_reconcile_effect_with_evidence_v1[\s\S]*?\n\$fn\$;/i,
    )?.[0];
    assert.ok(wrapper);
    assert.ok(
      wrapper.indexOf('validate_reconcile_effect_mutation_v1') <
        wrapper.indexOf('commander_insert_reconcile_evidence_v1'),
    );
    assert.ok(
      wrapper.indexOf('commander_insert_reconcile_evidence_v1') <
        wrapper.indexOf('apply_reconcile_effect_mutation_v1'),
    );
    assert.match(
      KERNEL_SIGNED_EVIDENCE_ORDERING_SQL,
      /REVOKE ALL ON FUNCTION public\.validate_reconcile_effect_mutation_v1[\s\S]*commander_adapter_ops/i,
    );
  });

  it('exposes only an effect-scoped evidence context to durable adapter-ops workers', () => {
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /CREATE FUNCTION public\.read_adapter_ops_evidence_context\([\s\S]*SECURITY DEFINER/i,
    );
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /session_user\s*<>\s*'commander_adapter_ops'/i,
    );
    assert.match(KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL, /secret_hash\s*=\s*sha256/i);
    assert.match(KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL, /w\.tenant_ids\s*\?\s*p_tenant_id/i);
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /w\.capabilities\s+IN\s*\([\s\S]*effect\.reconcile[\s\S]*effect\.compensate/i,
    );
    assert.match(KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL, /effect\.id\s*=\s*p_effect_id/i);
    assert.match(KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL, /effect\.run_id\s*=\s*p_run_id/i);
    assert.match(KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL, /event\.aggregate_id\s*=\s*p_effect_id/i);
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /reconcile_claim_token IS DISTINCT FROM p_claim_token/i,
    );
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /reconcile_claim_expires_at\s*<=\s*clock_timestamp\(\)/i,
    );
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /request\.claim_token\s*=\s*p_claim_token/i,
    );
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /outbox\.claim_token\s*=\s*p_claim_token/i,
    );
    assert.match(KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL, /step\.lease_token\s*=\s*p_claim_token/i);
    assert.doesNotMatch(KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL, /GRANT\s+SELECT\s+ON\s+TABLE/i);
    assert.match(
      KERNEL_ADAPTER_OPS_EVIDENCE_CONTEXT_SQL,
      /GRANT EXECUTE ON FUNCTION public\.read_adapter_ops_evidence_context\([\s\S]*TO commander_adapter_ops/i,
    );
  });

  it('reads adapter-ops evidence context through worker-authenticated RPC arguments', async () => {
    const client = new RecordingClient('commander_adapter_ops');
    const repository = new PostgresKernelRepository(new Pool(client), { adapterOpsMode: true });

    const context = await repository.getAdapterOpsEvidenceContext({
      workerId: 'reconcile-worker',
      workerGeneration: 2,
      claimSecret: 'secret',
      tenantId: 'tenant-a',
      runId: 'run-a',
      effectId: 'effect-a',
      claimToken: 'claim-a',
    });

    const query = client.queries.find(({ sql }) => /read_adapter_ops_evidence_context/i.test(sql));
    assert.deepEqual(query?.values, [
      'reconcile-worker',
      2,
      'secret',
      'tenant-a',
      'run-a',
      'effect-a',
      'claim-a',
    ]);
    assert.equal(context.effect.id, 'effect-a');
    assert.equal(context.effect.runId, 'run-a');
    assert.deepEqual(context.events, []);
    assert.equal(context.evidence, null);
  });

  it('binds app compensation RPCs to the database-authenticated tenant', () => {
    assert.match(
      KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL,
      /create_compensation_authorization[\s\S]*commander_authenticated_app_tenant\(\)[\s\S]*tenantId[\s\S]*IS DISTINCT FROM v_tenant/i,
    );
    assert.match(
      KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL,
      /request_compensation[\s\S]*commander_authenticated_app_tenant\(\)[\s\S]*p_tenant_id IS DISTINCT FROM v_tenant/i,
    );
  });

  it('exposes claim RPCs without caller-controlled clocks or TTLs', () => {
    assert.match(
      KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL,
      /CREATE FUNCTION public\.claim_reconcile_effects\(\s*p_worker_id text,\s*p_worker_generation bigint,\s*p_limit integer,\s*p_claim_secret text\s*\)/i,
    );
    assert.match(
      KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL,
      /CREATE FUNCTION public\.claim_compensation_request\(\s*p_request_id text,\s*p_outbox_message_id text,\s*p_worker_id text,\s*p_worker_generation bigint,\s*p_claim_secret text\s*\)/i,
    );
    assert.match(
      KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL,
      /clock_timestamp\(\)[\s\S]*interval '60 seconds'/i,
    );
    assert.doesNotMatch(
      KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL,
      /CREATE FUNCTION public\.(?:claim_reconcile_effects|claim_compensation_request)\([\s\S]*?p_(?:now|claim_ttl_ms|lease_ttl_ms)/i,
    );
  });

  it('runs app compensation RPCs inside the authenticated tenant transaction', async () => {
    const client = new RecordingClient('commander_app');
    const repository = new PostgresKernelRepository(new Pool(client), {
      tenantContextAuthority: new Authority(),
      tenantContextPhase: 'enforce',
    });

    await repository.createCompensationAuthorization(AUTHORIZATION);
    await repository.requestCompensation({
      tenantId: 'tenant-a',
      authorizationId: AUTHORIZATION.id,
      actor: 'api-user',
    });

    const statements = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    assert.equal(statements.filter((sql) => /bind_app_tenant_context/i.test(sql)).length, 2);
    assert.equal(statements.filter((sql) => /close_app_tenant_context/i.test(sql)).length, 2);
    for (const rpc of ['create_compensation_authorization', 'request_compensation']) {
      const rpcIndex = statements.findIndex((sql) => sql.includes(rpc));
      const bindIndex = statements.findLastIndex(
        (sql, index) => index < rpcIndex && /bind_app_tenant_context/i.test(sql),
      );
      const closeIndex = statements.findIndex(
        (sql, index) => index > rpcIndex && /close_app_tenant_context/i.test(sql),
      );
      assert.ok(bindIndex >= 0 && bindIndex < rpcIndex);
      assert.ok(closeIndex > rpcIndex);
    }
  });

  it('repository claim calls match the narrowed production RPC signatures', async () => {
    const client = new RecordingClient('commander_adapter_ops');
    const repository = new PostgresKernelRepository(new Pool(client), { adapterOpsMode: true });

    await repository.claimReconcileEffects({
      limit: 3,
      workerId: 'reconcile-worker',
      workerGeneration: 2,
      claimSecret: 'secret',
      now: new Date('2099-01-01T00:00:00.000Z'),
      claimTtlMs: 1,
    });
    await repository.claimCompensationRequest({
      requestId: '',
      outboxMessageId: '',
      workerId: 'compensation-worker',
      workerGeneration: 3,
      claimSecret: 'secret',
      now: new Date('2099-01-01T00:00:00.000Z'),
      leaseTtlMs: 1,
    });

    const reconcile = client.queries.find(({ sql }) => /SELECT claim_reconcile_effects/i.test(sql));
    assert.deepEqual(reconcile?.values, ['reconcile-worker', 2, 3, 'secret']);
    const compensation = client.queries.find(({ sql }) =>
      /SELECT claim_compensation_request/i.test(sql),
    );
    assert.deepEqual(compensation?.values, ['', '', 'compensation-worker', 3, 'secret']);
  });

  it('closes reconciliation terminal mutations around signed evidence', () => {
    for (const rpc of [
      'complete_reconcile_effect',
      'confirm_effect_not_applied',
      'reschedule_reconcile_effect',
      'escalate_reconcile_effect',
    ]) {
      assert.match(
        KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
        new RegExp(
          `CREATE (?:OR REPLACE )?FUNCTION public\\.${rpc}\\([\\s\\S]*?p_evidence jsonb`,
          'i',
        ),
      );
      assert.match(
        KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${rpc}\\(text,text,text,bigint,text,text,jsonb\\)\\s+FROM commander_adapter_ops`,
          'i',
        ),
      );
      assert.match(
        KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(\\s*text,text,text,bigint,text,text,jsonb,jsonb\\s*\\)\\s+TO commander_adapter_ops`,
          'i',
        ),
      );
    }
    assert.match(KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL, /TERMINAL_EVIDENCE_REQUIRED/i);
    assert.match(KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL, /EVIDENCE_RECORD_BINDING_INVALID/i);
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /INSERT INTO public\.commander_evidence_receipts/i,
    );
    assert.match(
      KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
      /scope[\s\S]*terminalDisposition[\s\S]*effects/i,
    );
  });

  it('returns exhausted reconciliation work to the signer instead of escalating in claim SQL', () => {
    const claim = KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL.match(
      /CREATE OR REPLACE FUNCTION public\.claim_reconcile_effects\([\s\S]*?\n\$fn\$;/i,
    )?.[0];
    assert.ok(claim, 'evidence closure must replace the claim authority');
    assert.match(claim, /reconcile_max_attempts = 0[\s\S]*reconcile_deadline_at <= v_now/i);
    assert.match(claim, /reconcile_claim_token = v_token/i);
    assert.doesNotMatch(claim, /reconcile_disposition\s*=\s*'ESCALATED'/i);
    assert.doesNotMatch(claim, /'effect\.reconcile_escalated'/i);
  });

  it('passes evidence to PostgreSQL reconciliation mutations as the eighth argument', async () => {
    const client = new RecordingClient('commander_adapter_ops');
    const repository = new PostgresKernelRepository(new Pool(client), { adapterOpsMode: true });

    await repository.completeReconcileEffect({
      tenantId: 'tenant-a',
      effectId: 'effect-a',
      workerId: 'reconcile-worker',
      workerGeneration: 2,
      claimSecret: 'secret',
      claimToken: 'token',
      response: { remoteId: 'remote-a' },
      evidence: EVIDENCE,
    });

    const mutation = client.queries.find(({ sql }) =>
      /SELECT complete_reconcile_effect/i.test(sql),
    );
    assert.match(mutation?.sql ?? '', /\$8::jsonb/);
    assert.deepEqual(mutation?.values, [
      'tenant-a',
      'effect-a',
      'reconcile-worker',
      2,
      'secret',
      'token',
      JSON.stringify({ remoteId: 'remote-a' }),
      JSON.stringify(EVIDENCE),
    ]);
  });
});
