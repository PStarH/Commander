import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createEvidenceSigner, verifyEvidenceSignature } from './evidenceSigner.js';
import {
  assertTerminalEvidence,
  buildEffectEvidenceBundle,
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  canonicalEvidenceJson,
  EVIDENCE_GENESIS_HASH,
  findDlpViolation,
  sanitizeForEvidence,
  verifyEvidenceBundle,
} from './evidenceBundle.js';

const baseEffect = {
  id: 'eff-1',
  runId: 'run-1',
  stepId: 'step-1',
  tenantId: 'tenant-a',
  type: 'llm.invoke',
  state: 'COMPLETED',
  policyDecisionId: 'pd-allow-1',
  requestHash: 'abc123',
  request: {
    contentHash: 'hash-prompt-bound',
    messages: [{ role: 'user', content: 'secret prompt text' }],
    chainOfThought: 'hidden reasoning',
  },
  response: {
    contentHash: 'hash-response-bound',
    completion: 'model output should not export',
    status: 'ok',
  },
  createdAt: '2026-07-17T06:00:00.000Z',
  completedAt: '2026-07-17T06:00:01.000Z',
  approvalInteractionId: 'int-approve-1',
};

describe('EB03 canonical evidence JSON persistence', () => {
  it('preserves canonical bytes and hashes for ordinary JSON objects', () => {
    const value = { z: [null, true, 1.5, { b: 'text', a: false }], '2': 2, '10': 10, a: {} };
    const expected = '{"10":10,"2":2,"a":{},"z":[null,true,1.5,{"a":false,"b":"text"}]}';
    const canonical = canonicalEvidenceJson(value);
    assert.equal(canonical, expected);
    assert.equal(
      createHash('sha256').update(canonical).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('omits nested undefined object members without mutating the input', () => {
    const value = {
      z: undefined,
      details: { optional: undefined, nested: { b: 2, a: undefined } },
    };
    const before = structuredClone(value);
    assert.equal(canonicalEvidenceJson(value), '{"details":{"nested":{"b":2}}}');
    assert.equal(
      canonicalEvidenceJson(value),
      canonicalEvidenceJson(JSON.parse(JSON.stringify(value))),
    );
    assert.deepEqual(value, before);
  });

  it('serializes undefined and sparse array holes as null at every depth', () => {
    const items = new Array<unknown>(4);
    items[1] = undefined;
    items[2] = { z: undefined, values: [undefined, 3] };
    assert.equal(canonicalEvidenceJson(items), '[null,null,{"values":[null,3]},null]');
    assert.equal(
      canonicalEvidenceJson(items),
      canonicalEvidenceJson(JSON.parse(JSON.stringify(items))),
    );
    assert.equal(0 in items, false);
    assert.equal(1 in items, true);
    assert.equal(3 in items, false);
  });

  for (const [name, value] of [
    ['function', () => 1],
    ['symbol', Symbol('not-json')],
  ] as const) {
    it(`rejects top-level ${name} instead of returning a non-string`, () => {
      assert.throws(() => canonicalEvidenceJson(value), TypeError);
    });
  }

  it('renders a top-level undefined as the JSON literal null', () => {
    // EB-01: the declared return type is `string`; returning `undefined` made an
    // unsigned record look signed because both sides compared equal.
    const canonical: unknown = canonicalEvidenceJson(undefined);
    assert.equal(typeof canonical, 'string');
    assert.equal(canonical, 'null');
  });

  it('uses native JSON persistence semantics for non-JSON members and toJSON', () => {
    const value = {
      date: new Date('2026-07-17T06:00:00.000Z'),
      numbers: [NaN, Infinity, -Infinity, -0],
      omittedFunction: () => 1,
      omittedSymbol: Symbol('omitted'),
      items: [() => 1, Symbol('null')],
    };
    assert.equal(
      canonicalEvidenceJson(value),
      '{"date":"2026-07-17T06:00:00.000Z","items":[null,null],"numbers":[null,null,null,0]}',
    );
    assert.equal(
      canonicalEvidenceJson(value),
      canonicalEvidenceJson(JSON.parse(JSON.stringify(value))),
    );
  });

  it('rejects BigInt and cycles but allows shared acyclic objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalEvidenceJson(cyclic), TypeError);
    assert.throws(() => canonicalEvidenceJson({ value: 1n }), TypeError);
    const shared = { b: 2, a: 1 };
    assert.equal(canonicalEvidenceJson([shared, shared]), '[{"a":1,"b":2},{"a":1,"b":2}]');
  });

  it('keeps nested audit hashes and a real Ed25519 signature valid after JSON round-trip', async () => {
    const details = {
      effectId: 'eff-1',
      optional: undefined,
      nested: { missing: undefined, status: 'ok' },
      items: [undefined, , { omitted: undefined, count: 2 }],
    };
    const input = {
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low' as const,
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details,
        },
      ],
      bundleId: 'bundle-eb03',
      exportedAt: '2026-07-17T06:00:02.000Z',
    };
    const bundle = buildRunEvidenceBundle(input);
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'eb03-test',
    });
    bundle.signature = await signer.sign(canonicalEvidenceBody(bundle));
    assert.equal(signer.verify(canonicalEvidenceBody(bundle), bundle.signature), true);
    assert.deepEqual(verifyEvidenceBundle(bundle), { ok: true });
    const roundTripped = JSON.parse(JSON.stringify(bundle));
    assert.deepEqual(verifyEvidenceBundle(roundTripped), { ok: true });
    assert.equal(canonicalEvidenceBody(roundTripped), canonicalEvidenceBody(bundle));
    assert.equal(
      verifyEvidenceSignature(
        canonicalEvidenceBody(roundTripped),
        roundTripped.signature,
        signer.jwks,
      ),
      true,
    );
    const persistedInputBundle = buildRunEvidenceBundle(JSON.parse(JSON.stringify(input)));
    assert.equal(persistedInputBundle.contentHash, bundle.contentHash);
    assert.equal(persistedInputBundle.auditEvents[0].entryHash, bundle.auditEvents[0].entryHash);
    assert.equal(Object.hasOwn(details.nested, 'missing'), true);
    assert.equal(1 in details.items, false);
  });

  it('rejects historical invalid-JSON audit hashes without rewriting the evidence', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: { effectId: 'eff-1' },
        },
      ],
    });
    const historicalBytes = `{"at":"2026-07-17T06:00:01.000Z","details":{"effectId":"eff-1","optional":undefined},"prevEntryHash":"${EVIDENCE_GENESIS_HASH}","severity":"low","stepId":"step-1","type":"effect.completed"}`;
    bundle.auditEvents[0].entryHash = createHash('sha256').update(historicalBytes).digest('hex');
    const before = structuredClone(bundle);
    assert.deepEqual(verifyEvidenceBundle(bundle), {
      ok: false,
      reason: 'audit entryHash mismatch',
      brokenAt: 'auditEvents',
      index: 0,
    });
    assert.deepEqual(bundle, before);
  });
});

describe('L3-11 evidence bundle v0', () => {
  it('binds the exact action digest and terminal disposition into the canonical body', () => {
    const build = (actionDigest: string) =>
      buildRunEvidenceBundle({
        tenantId: 'tenant-a',
        runId: 'run-1',
        actionDigest,
        policySnapshotId: 'ps-1',
        effects: [baseEffect],
        exportedAt: '2026-07-17T06:00:02.000Z',
        bundleId: 'bundle-terminal',
      });
    const first = build('a'.repeat(64));
    const second = build('b'.repeat(64));
    assert.equal(first.bodyVersion, 'commander.evidence-body/v1');
    assert.equal(first.actionDigest, 'a'.repeat(64));
    assert.equal(first.terminalDisposition, 'SUCCEEDED');
    assert.notEqual(first.contentHash, second.contentHash);
    assert.match(canonicalEvidenceBody(first), /"actionDigest":"a{64}"/);
    assert.doesNotThrow(() => assertTerminalEvidence(first));
  });

  it('rejects a terminal receipt with an unresolved consequential effect', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [{ ...baseEffect, state: 'COMPLETION_UNKNOWN', completedAt: undefined }],
    });
    assert.throws(() => assertTerminalEvidence(bundle), /TERMINAL_EVIDENCE_REQUIRED/);
  });

  it('accepts an unresolved effect only with an explicit escalation event', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [{ ...baseEffect, state: 'COMPLETION_UNKNOWN', completedAt: undefined }],
      auditEvents: [
        {
          type: 'effect.reconcile_escalated',
          severity: 'high',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:03.000Z',
          details: { effectId: 'eff-1', code: 'RECONCILE_DEADLINE_EXPIRED' },
        },
      ],
    });
    assert.equal(bundle.terminalDisposition, 'ESCALATED');
    assert.doesNotThrow(() => assertTerminalEvidence(bundle));
  });
  it('buildRunEvidenceBundle includes identity, policy, effect summary, versions', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      intentHash: 'intent-h',
      workGraphHash: 'graph-h',
      workGraphVersion: 'v1',
      policySnapshotId: 'ps-pin-1',
      kernelApiVersion: 'v2',
      capabilityGrant: {
        jti: 'cap-jti-1',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['llm.invoke'],
        expiresAt: '2026-07-18T00:00:00.000Z',
        issuer: 'gateway',
        audience: 'worker',
        requestHash: 'abc123',
        policySnapshotId: 'ps-pin-1',
      },
      effects: [baseEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: { effectId: 'eff-1', policyDecisionId: 'pd-allow-1' },
        },
      ],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-test-1',
    });

    assert.equal(bundle.schemaVersion, 'l3-11.v0');
    assert.equal(bundle.scope.tenantId, 'tenant-a');
    assert.equal(bundle.versions.policySnapshotId, 'ps-pin-1');
    assert.equal(bundle.identity.capabilityGrant?.jti, 'cap-jti-1');
    assert.equal(bundle.effects[0].policyDecisionId, 'pd-allow-1');
    assert.equal(bundle.effects[0].approvalInteractionId, 'int-approve-1');
    assert.equal(bundle.effects[0].responseSummary?.status, 'ok');
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('default sanitization strips CoT / prompt / gen_ai fields', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: {
            effectId: 'eff-1',
            'gen_ai.prompt': 'leak',
            'gen_ai.completion': 'leak',
          },
        },
      ],
    });

    assert.equal(findDlpViolation(bundle), undefined);
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
    assert.equal(bundle.effects[0].responseSummary?.completion, undefined);
    assert.equal(bundle.effects[0].responseSummary?.messages, undefined);
    assert.equal(bundle.effects[0].responseSummary?.contentHash, 'hash-response-bound');
    assert.deepEqual(sanitizeForEvidence({ messages: [1], status: 'ok' }), { status: 'ok' });
  });

  it('responseSummary is allowlisted and secret field names are stripped', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [
        {
          ...baseEffect,
          response: {
            contentHash: 'hash-response-bound',
            status: 'ok',
            body: 'raw payload must not export',
            Authorization: 'Bearer secret-token',
            httpStatus: 200,
            // Nested under allowlisted key must not smuggle raw payload.
            ok: { body: 'nested-leak', refresh_token: 'rt-1' },
          },
        },
      ],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: {
            effectId: 'eff-1',
            Authorization: 'Bearer audit-token',
            cookie: 'session=1',
            refresh_token: 'rt-leak',
            client_secret: 'cs-leak',
            access_token: 'at-leak',
          },
        },
      ],
    });

    assert.deepEqual(bundle.effects[0].responseSummary, {
      contentHash: 'hash-response-bound',
      status: 'ok',
      httpStatus: 200,
    });
    assert.equal('Authorization' in bundle.auditEvents[0].details, false);
    assert.equal('cookie' in bundle.auditEvents[0].details, false);
    assert.equal('refresh_token' in bundle.auditEvents[0].details, false);
    assert.equal('client_secret' in bundle.auditEvents[0].details, false);
    assert.equal('access_token' in bundle.auditEvents[0].details, false);
    assert.equal(bundle.auditEvents[0].details.effectId, 'eff-1');
    assert.deepEqual(
      sanitizeForEvidence({ Authorization: 'x', token: 'y', refresh_token: 'z', status: 'ok' }),
      { status: 'ok' },
    );
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('drops secret-like values smuggled through allowlisted response keys', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [
        {
          ...baseEffect,
          response: { status: 'Bearer sk-secret-value-that-must-not-be-retained' },
        },
      ],
    });
    assert.equal(bundle.effects[0].responseSummary?.status, undefined);

    const leaked = structuredClone(bundle);
    leaked.effects[0].responseSummary = {
      status: 'Bearer sk-secret-value-that-must-not-be-retained',
    };
    const result = verifyEvidenceBundle(leaked);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'dlp');
  });

  it('verifyEvidenceBundle rejects nested responseSummary values', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const nested = structuredClone(bundle);
    nested.effects[0].responseSummary = {
      status: { body: 'should-fail-verify' },
    };
    assert.equal(verifyEvidenceBundle(nested).ok, false);
    assert.equal(verifyEvidenceBundle(nested).brokenAt, 'dlp');
  });

  it('verifyEvidenceBundle detects tampered contentHash', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const tampered = { ...bundle, contentHash: 'f'.repeat(64) };
    const result = verifyEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'contentHash');
  });

  it('verifyEvidenceBundle detects broken effect entry chain', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const tampered = structuredClone(bundle);
    tampered.effects[0].entryHash = 'a'.repeat(64);
    const result = verifyEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'effects');
  });

  it('effect entry chain starts at GENESIS', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    assert.equal(bundle.effects[0].prevEntryHash, EVIDENCE_GENESIS_HASH);
  });

  it('buildEffectEvidenceBundle scopes to one effect', () => {
    const other = { ...baseEffect, id: 'eff-2', createdAt: '2026-07-17T06:00:05.000Z' };
    const bundle = buildEffectEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      effectId: 'eff-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect, other],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: { effectId: 'eff-1' },
        },
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:06.000Z',
          details: { effectId: 'eff-2' },
        },
        {
          type: 'effect.rejected',
          severity: 'high',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:00.500Z',
          details: { code: 'POLICY_DENIED' },
        },
      ],
    });
    assert.equal(bundle.scope.effectId, 'eff-1');
    assert.equal(bundle.effects.length, 1);
    assert.equal(bundle.effects[0].effectId, 'eff-1');
    assert.equal(bundle.auditEvents.length, 1);
    assert.equal(bundle.auditEvents[0].details.effectId, 'eff-1');
  });

  it('buildRunEvidenceBundle drops cross-tenant effects, audits, and grants', () => {
    const foreignEffect = {
      ...baseEffect,
      id: 'eff-foreign',
      tenantId: 'tenant-b',
      runId: 'run-1',
    };
    const wrongRunEffect = {
      ...baseEffect,
      id: 'eff-other-run',
      tenantId: 'tenant-a',
      runId: 'run-other',
    };
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      capabilityGrant: {
        jti: 'cap-foreign',
        tenantId: 'tenant-b',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['llm.invoke'],
        expiresAt: '2026-07-18T00:00:00.000Z',
      },
      effects: [baseEffect, foreignEffect, wrongRunEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: { effectId: 'eff-1' },
        },
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-b',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:02.000Z',
          details: { effectId: 'eff-foreign' },
        },
      ],
    });

    assert.equal(bundle.effects.length, 1);
    assert.equal(bundle.effects[0].effectId, 'eff-1');
    assert.equal(bundle.auditEvents.length, 1);
    assert.equal(bundle.auditEvents[0].details.effectId, 'eff-1');
    assert.equal(bundle.identity.capabilityGrant, undefined);
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('verifyEvidenceBundle rejects unredacted secret fields and non-allowlisted responseSummary', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });

    const secretLeak = structuredClone(bundle);
    secretLeak.auditEvents = [
      {
        type: 'effect.completed',
        at: '2026-07-17T06:00:01.000Z',
        severity: 'low',
        details: { Authorization: 'Bearer leaked' },
        entryHash: 'c'.repeat(64),
        prevEntryHash: EVIDENCE_GENESIS_HASH,
      },
    ];
    assert.equal(verifyEvidenceBundle(secretLeak).ok, false);
    assert.equal(verifyEvidenceBundle(secretLeak).brokenAt, 'dlp');

    const summaryLeak = structuredClone(bundle);
    summaryLeak.effects[0].responseSummary = {
      ...(summaryLeak.effects[0].responseSummary ?? {}),
      body: 'should-not-pass-verify',
    };
    assert.equal(verifyEvidenceBundle(summaryLeak).ok, false);
    assert.equal(verifyEvidenceBundle(summaryLeak).brokenAt, 'dlp');
  });

  it('verifyEvidenceBundle detects tampered effect field and deleted audit row', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: { effectId: 'eff-1' },
        },
      ],
    });

    const fieldTampered = structuredClone(bundle);
    fieldTampered.effects[0].policyDecisionId = 'pd-forged';
    const fieldResult = verifyEvidenceBundle(fieldTampered);
    assert.equal(fieldResult.ok, false);
    assert.equal(fieldResult.brokenAt, 'effects');

    const auditDeleted = structuredClone(bundle);
    auditDeleted.auditEvents = [];
    const deletedResult = verifyEvidenceBundle(auditDeleted);
    assert.equal(deletedResult.ok, false);
    assert.equal(deletedResult.brokenAt, 'contentHash');
  });

  it('verifyEvidenceBundle detects broken audit entry chain', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      auditEvents: [
        {
          type: 'effect.completed',
          severity: 'low',
          tenantId: 'tenant-a',
          runId: 'run-1',
          stepId: 'step-1',
          at: '2026-07-17T06:00:01.000Z',
          details: { effectId: 'eff-1' },
        },
      ],
    });
    const tampered = structuredClone(bundle);
    tampered.auditEvents[0].entryHash = 'b'.repeat(64);
    const result = verifyEvidenceBundle(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'auditEvents');
  });

  it('verifyEvidenceBundle rejects residual DLP keys', () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
    });
    const leaked = structuredClone(bundle);
    leaked.auditEvents = [
      {
        type: 'effect.completed',
        at: '2026-07-17T06:00:01.000Z',
        severity: 'low',
        details: { 'gen_ai.prompt': 'should-fail-verify' },
        entryHash: 'c'.repeat(64),
        prevEntryHash: EVIDENCE_GENESIS_HASH,
      },
    ];
    const result = verifyEvidenceBundle(leaked);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'dlp');
  });

  it('approvalInteractionId is optional', () => {
    const { approvalInteractionId: _omit, ...withoutApproval } = baseEffect;
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      effects: [withoutApproval],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-no-approval',
    });
    assert.equal('approvalInteractionId' in bundle.effects[0], false);
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
  });

  it('verifyEvidenceBundle survives JSON round-trip when optional fields are absent', () => {
    const sparse = {
      id: 'eff-1',
      runId: 'run-1',
      stepId: 'step-1',
      tenantId: 'tenant-a',
      type: 'http.write',
      state: 'ADMITTED',
      policyDecisionId: 'pd-1',
      requestHash: 'req-h',
      createdAt: '2026-07-17T06:00:00.000Z',
    };
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      policySnapshotId: 'ps-1',
      capabilityGrant: {
        jti: 'cap-jti-1',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        effectTypes: ['http.write'],
        expiresAt: '2026-07-18T00:00:00.000Z',
      },
      effects: [sparse],
      exportedAt: '2026-07-17T06:00:02.000Z',
      bundleId: 'bundle-roundtrip-1',
    });
    assert.equal(verifyEvidenceBundle(bundle).ok, true);
    assert.equal('completedAt' in bundle.effects[0], false);
    assert.equal('issuer' in (bundle.identity.capabilityGrant ?? {}), false);
    const roundTripped = JSON.parse(JSON.stringify(bundle));
    assert.equal(verifyEvidenceBundle(roundTripped).ok, true);
  });
});

/**
 * EB-02: `verifyEvidenceBundle` destructured `signature` away and never verified it, so a
 * bundle whose body had been rewritten — with every hash recomputed using the public
 * canonicalisation — and whose `signature` object was copied from an honest bundle passed
 * the only integrity gate on the evidence write path.
 */
describe('EB-02 evidence bundle signature verification', () => {
  function signerFor(keyId: string) {
    const { privateKey } = generateKeyPairSync('ed25519');
    return createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId,
    });
  }

  const signer = signerFor('eb02-key');
  const otherSigner = signerFor('eb02-other-key');

  async function signedBundle(bundleId = 'bundle-eb02') {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      bundleId,
      exportedAt: '2026-07-17T06:00:02.000Z',
    });
    bundle.signature = await signer.sign(canonicalEvidenceBody(bundle));
    return bundle;
  }

  function recomputeHashes(bundle: ReturnType<typeof buildRunEvidenceBundle>): void {
    for (const entry of bundle.effects) {
      const { entryHash: _entryHash, ...body } = entry;
      entry.entryHash = createHash('sha256').update(canonicalEvidenceJson(body)).digest('hex');
    }
    for (const entry of bundle.auditEvents) {
      const { entryHash: _entryHash, ...body } = entry;
      entry.entryHash = createHash('sha256').update(canonicalEvidenceJson(body)).digest('hex');
    }
    const { contentHash: _contentHash, signature: _signature, ...body } = bundle;
    bundle.contentHash = createHash('sha256').update(canonicalEvidenceJson(body)).digest('hex');
  }

  it('accepts a bundle whose signature verifies', async () => {
    const bundle = await signedBundle();
    assert.deepEqual(verifyEvidenceBundle(bundle, { jwks: signer.jwks }), { ok: true });
    assert.deepEqual(
      verifyEvidenceBundle(bundle, { verifySignature: (body, sig) => signer.verify(body, sig) }),
      { ok: true },
    );
  });

  it('rejects an unsigned bundle when a verifier is supplied', async () => {
    const bundle = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      bundleId: 'bundle-unsigned',
      exportedAt: '2026-07-17T06:00:02.000Z',
    });
    const result = verifyEvidenceBundle(bundle, { jwks: signer.jwks });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'signature');
    assert.equal(result.reason, 'evidence bundle is not signed');
  });

  it('rejects a forged body that reuses an honest signature', async () => {
    const honest = await signedBundle();
    const forged = structuredClone(honest);
    forged.effects[0].responseSummary = { status: 'FORGED' };
    recomputeHashes(forged);

    // The structural checks are self-referential: a forger can satisfy them.
    assert.equal(verifyEvidenceBundle(forged).ok, true);
    // The real verifier sees through it.
    assert.equal(
      verifyEvidenceSignature(canonicalEvidenceBody(forged), forged.signature!, signer.jwks),
      false,
    );
    const result = verifyEvidenceBundle(forged, { jwks: signer.jwks });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'signature');
    assert.equal(result.reason, 'evidence signature verification failed');
  });

  it('rejects a tampered signature value and a signature from another key', async () => {
    const bundle = await signedBundle();
    const tampered = structuredClone(bundle);
    tampered.signature!.value = 'A' + tampered.signature!.value.slice(1);
    assert.equal(verifyEvidenceBundle(tampered, { jwks: signer.jwks }).ok, false);

    assert.equal(verifyEvidenceBundle(bundle, { jwks: otherSigner.jwks }).ok, false);
  });

  it('fails closed when a signature is required but no verifier was supplied', async () => {
    const bundle = await signedBundle();
    const result = verifyEvidenceBundle(bundle, { requireSignature: true });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 'signature');
    assert.match(result.reason ?? '', /EVIDENCE_SIGNATURE_VERIFIER_REQUIRED/);
  });

  it('documents that structural-only verification proves no authenticity', async () => {
    // No verifier and no requireSignature: this is the legacy structural-only mode. It is
    // not an authenticity guarantee — acceptance paths must pass a verifier (see the
    // forged-body case above, which passes here and fails with a verifier).
    const unsigned = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [baseEffect],
      bundleId: 'bundle-structural-only',
      exportedAt: '2026-07-17T06:00:02.000Z',
    });
    assert.equal(verifyEvidenceBundle(unsigned).ok, true);
  });
});
