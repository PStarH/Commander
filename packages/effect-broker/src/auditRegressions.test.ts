import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  canonicalEvidenceJson,
  verifyEvidenceBundle,
} from './evidenceBundle.js';
import { createEvidenceSigner } from './evidenceSigner.js';
import { EvidenceSink, assertEvidenceRecord, type EvidenceRecord } from './evidenceSink.js';
import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  EffectBroker,
  canonicalRequestHash,
  deriveEffectIdempotencyKey,
  type AuditSink,
  type CapabilityGrant,
  type EffectKernelPort,
} from './index.js';

const signer = createEvidenceSigner({
  privateKeyPem: generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString(),
  keyId: 'audit-regression-cell',
});

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalEvidenceJson(value)).digest('hex');
}

/** Recompute every public hash so a crafted bundle is internally self-consistent. */
function reseal(bundle: EvidenceRecord['body']): void {
  for (const entry of bundle.effects) {
    const { entryHash: _hash, ...bare } = entry;
    entry.entryHash = sha256(bare);
  }
  for (const entry of bundle.auditEvents) {
    const { entryHash: _hash, ...bare } = entry;
    entry.entryHash = sha256(bare);
  }
  const { contentHash: _contentHash, signature: _signature, ...body } = bundle;
  bundle.contentHash = sha256(body);
}

async function signedRecord(): Promise<EvidenceRecord> {
  const body = buildRunEvidenceBundle({
    tenantId: 'tenant-a',
    runId: 'run-1',
    actionDigest: 'a'.repeat(64),
    policySnapshotId: 'ps-1',
    effects: [
      {
        id: 'eff-1',
        runId: 'run-1',
        stepId: 'step-1',
        tenantId: 'tenant-a',
        type: 'http.post',
        state: 'COMPLETED',
        policyDecisionId: 'pd-1',
        requestHash: 'rh-1',
        response: { status: 'ok' },
        createdAt: '2026-07-17T00:00:00.000Z',
        completedAt: '2026-07-17T00:00:01.000Z',
      },
    ],
    auditEvents: [
      {
        type: 'effect.admitted',
        severity: 'low',
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        at: '2026-07-17T00:00:00.000Z',
        details: { effectId: 'eff-1' },
      },
    ],
    bundleId: 'bundle-1',
    exportedAt: '2026-07-17T00:00:02.000Z',
  });
  const signature = await signer.sign(canonicalEvidenceBody(body));
  body.signature = signature;
  return {
    tenantId: 'tenant-a',
    runId: 'run-1',
    bundleId: body.bundleId,
    actionDigest: body.actionDigest,
    body,
    contentHash: body.contentHash,
    signature,
    createdAt: '2026-07-17T00:00:02.000Z',
    anchoredAt: '2026-07-17T00:00:02.000Z',
    retentionUntil: '2027-07-17T00:00:02.000Z',
  };
}

function makeRepository(): {
  writes: EvidenceRecord[];
  port: { appendEvidence(record: EvidenceRecord): Promise<{ inserted: boolean }> };
} {
  const writes: EvidenceRecord[] = [];
  return {
    writes,
    port: {
      appendEvidence: async (record) => {
        writes.push(record);
        return { inserted: true };
      },
    },
  };
}

describe('EB-01 an unsigned evidence record is rejected', () => {
  it('throws EVIDENCE_SIGNATURE_REQUIRED when neither signature is present', async () => {
    const record = await signedRecord();
    const unsigned = { ...record, signature: undefined, body: { ...record.body } };
    delete (unsigned.body as { signature?: unknown }).signature;
    assert.throws(
      () =>
        assertEvidenceRecord(unsigned as unknown as EvidenceRecord, {
          verifySignature: signer.verify,
        }),
      /EVIDENCE_SIGNATURE_REQUIRED/,
    );
  });

  it('keeps canonicalEvidenceJson a string for an absent value', () => {
    const canonical: unknown = canonicalEvidenceJson(undefined);
    assert.equal(typeof canonical, 'string');
    assert.equal(canonical, 'null');
    assert.throws(() => canonicalEvidenceJson(() => 1), TypeError);
  });
});

describe('EB-02 signature verification is a required acceptance dependency', () => {
  it('refuses a sink with no trusted verifier', () => {
    const { writes, port } = makeRepository();
    assert.throws(() => new EvidenceSink(port), /EVIDENCE_SIGNATURE_VERIFIER_REQUIRED/);
    assert.equal(writes.length, 0);
  });

  it('rejects rather than accepts a record when no verifier is supplied', async () => {
    const record = await signedRecord();
    await assert.rejects(
      async () => assertEvidenceRecord(record, {}),
      /EVIDENCE_SIGNATURE_VERIFIER_REQUIRED/,
    );
  });

  it('rejects a forged body that staples a stolen signature', async () => {
    const honest = await signedRecord();
    const forged = await signedRecord();
    forged.body.effects[0]!.responseSummary = { status: 'FORGED' };
    reseal(forged.body);
    forged.body.signature = honest.signature;
    forged.signature = honest.signature;
    forged.contentHash = forged.body.contentHash;

    // Structurally self-consistent (public hashes recomputed) yet not authentic.
    assert.equal(verifyEvidenceBundle(forged.body, { jwks: signer.jwks }).ok, false);
    const { writes, port } = makeRepository();
    const sink = new EvidenceSink(port, { verifySignature: signer.verify });
    await assert.rejects(sink.persist(forged), /EVIDENCE_INTEGRITY_INVALID/);
    assert.equal(writes.length, 0);
  });

  it('still accepts an honest signed record', async () => {
    const { writes, port } = makeRepository();
    const sink = new EvidenceSink(port, { verifySignature: signer.verify });
    await sink.persist(await signedRecord());
    assert.equal(writes.length, 1);
  });
});

describe('EB-07 DLP scanning ignores the signer-produced signature blob', () => {
  it('does not fail an otherwise valid bundle on a signature value that looks like a key', () => {
    const body = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [],
    });
    body.signature = {
      algorithm: 'Ed25519',
      keyId: 'cell-1',
      signedAt: '2026-07-17T00:00:00.000Z',
      value: `-sk_${'A'.repeat(80)}`,
    };
    assert.equal(verifyEvidenceBundle(body, { verifySignature: () => true }).ok, true);
  });

  it('still rejects a real secret leaked into the content domain', () => {
    const body = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [],
    });
    // Re-seal after planting a secret so only the DLP scan can reject it.
    body.auditEvents.push({
      type: 'effect.admitted',
      at: '2026-07-17T00:00:00.000Z',
      severity: 'low',
      stepId: 'step-1',
      details: { note: 'x' },
      entryHash: '',
      prevEntryHash: '0'.repeat(64),
    });
    const secrets = ['sk_' + 'C'.repeat(40), 'Bearer abcdefghijklmnop'];
    const results = secrets.map((secret) => {
      const planted = structuredClone(body);
      planted.auditEvents[0]!.details = { note: secret };
      reseal(planted);
      return verifyEvidenceBundle(planted, { verifySignature: () => true });
    });
    for (const [index, result] of results.entries()) {
      assert.equal(result.ok, false, `secret ${index} was not rejected`);
      assert.equal(result.brokenAt, 'dlp');
    }
  });
});

const REQUEST = { value: 1 };

function allowPolicy(): never {
  return {
    evaluate: async () => ({
      effect: 'allow',
      decisionId: 'd1',
      reason: 'ok',
      policySnapshotId: 'p1',
    }),
  } as never;
}

function issueToken(issuer: CapabilityTokenIssuer): string {
  const grant: CapabilityGrant = {
    jti: 'jti-1',
    tenantId: 'tenant-a',
    runId: 'run-1',
    stepId: 'step-1',
    workloadId: 'wl-1',
    workerId: 'w1',
    workerGeneration: 1,
    effectTypes: ['llm.openai'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    policySnapshotId: 'p1',
    requestHash: canonicalRequestHash(REQUEST),
  };
  return issuer.issue(grant);
}

interface HarnessOptions {
  execute: () => Promise<Record<string, unknown>>;
  parked: string[];
  kernelOverrides?: Partial<EffectKernelPort>;
  auditAppend?: AuditSink['append'];
  idempotencyKeyPolicy?: 'derive' | 'caller';
}

function makeBroker(options: HarnessOptions): {
  broker: EffectBroker;
  issuer: CapabilityTokenIssuer;
} {
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-issuer',
    audience: 'commander.effect-broker',
    keyId: 'k1',
  });
  const verifier = new CapabilityTokenVerifier({
    issuer: 'commander-issuer',
    audience: 'commander.effect-broker',
    publicKeys: { k1: issuer.publicKey },
  });
  const ledger: Record<string, unknown> = {};
  const kernel = {
    admitEffect: async (input: Parameters<EffectKernelPort['admitEffect']>[0]) => {
      Object.assign(ledger, {
        id: input.id,
        runId: input.runId,
        stepId: input.stepId,
        tenantId: input.tenantId,
        type: input.type,
        state: 'ADMITTED',
        policyDecisionId: input.policyDecisionId,
        policySnapshotId: input.policySnapshotId,
        actionDigest: input.actionDigest,
        requestHash: canonicalRequestHash(REQUEST),
        createdAt: '2026-07-29T00:00:00.000Z',
      });
      return { admitted: true, effect: { id: input.id, state: 'ADMITTED' } };
    },
    completeEffect: async () => ({}),
    completeEffectWithEvidence: async () => ({ id: 'effect-1', state: 'COMPLETED' }),
    markEffectCompletionUnknown: async (input: { reason: string }) => {
      options.parked.push(input.reason);
      ledger.state = 'COMPLETION_UNKNOWN';
      return { id: 'effect-1', state: 'COMPLETION_UNKNOWN' };
    },
    getTerminalEvidenceContext: async () => ({ effect: { ...ledger } as never, events: [] }),
    ...options.kernelOverrides,
  } as unknown as EffectKernelPort;
  const broker = new EffectBroker(
    verifier,
    allowPolicy(),
    kernel,
    { execute: options.execute } as never,
    { append: options.auditAppend ?? (async () => {}) } as never,
    {
      evidenceSigner: signer,
      requireEvidencePersistence: true,
      replay: { consume: () => false },
      revocations: { revoke: () => undefined, isRevoked: () => false },
      ...(options.idempotencyKeyPolicy
        ? { idempotencyKeyPolicy: options.idempotencyKeyPolicy }
        : {}),
    },
  );
  return { broker, issuer };
}

function admitInput(
  issuer: CapabilityTokenIssuer,
  overrides: Record<string, unknown> = {},
): Parameters<EffectBroker['admit']>[0] {
  return {
    effectId: 'effect-1',
    token: issueToken(issuer),
    type: 'llm.openai',
    request: REQUEST,
    idempotencyKey: 'caller-chosen-key',
    lease: { workerId: 'w1', workerGeneration: 1, token: 'lease-1', fencingEpoch: 3 },
    actor: 'w1',
    ...overrides,
  } as Parameters<EffectBroker['admit']>[0];
}

function executeInput(): Parameters<EffectBroker['execute']>[0] {
  return {
    effectId: 'effect-1',
    token: 'unused',
    type: 'llm.openai',
    request: REQUEST,
    idempotencyKey: 'idem-1',
    lease: { workerId: 'w1', workerGeneration: 1, token: 'lease-1', fencingEpoch: 3 },
    actor: 'w1',
  };
}

describe('EB-09 a non-cooperative executor cannot suspend the caller forever', () => {
  it('hard-exits and parks as COMPLETION_UNKNOWN after the timeout', async () => {
    const parked: string[] = [];
    const { broker, issuer } = makeBroker({
      execute: () => new Promise<Record<string, unknown>>(() => {}),
      parked,
    });
    await assert.rejects(
      broker.execute({ ...executeInput(), token: issueToken(issuer), timeoutMs: 20 }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'COMPLETION_UNKNOWN',
    );
    assert.equal(parked.length, 1);
  });
});

describe('EB-10 park authority is mandatory and its failure stays visible', () => {
  it('refuses to construct an evidence-authoritative broker without park authority', () => {
    const issuer = CapabilityTokenIssuer.generate({
      issuer: 'commander-issuer',
      audience: 'commander.effect-broker',
      keyId: 'k1',
    });
    const verifier = new CapabilityTokenVerifier({
      issuer: 'commander-issuer',
      audience: 'commander.effect-broker',
      publicKeys: { k1: issuer.publicKey },
    });
    assert.throws(
      () =>
        new EffectBroker(
          verifier,
          allowPolicy(),
          {
            admitEffect: async () => ({ admitted: false }),
            completeEffect: async () => null,
            completeEffectWithEvidence: async () => ({}),
          } as unknown as EffectKernelPort,
          { execute: async () => ({}) } as never,
          { append: async () => {} } as never,
          {
            evidenceSigner: signer,
            requireEvidencePersistence: true,
            replay: { consume: () => false },
            revocations: { revoke: () => undefined, isRevoked: () => false },
          },
        ),
      /EVIDENCE_PARK_AUTHORITY_REQUIRED/,
    );
  });

  it('records a failed park and keeps the original error instead of pretending it parked', async () => {
    const parked: string[] = [];
    const audits: Array<{ type: string; details?: Record<string, unknown> }> = [];
    const { broker, issuer } = makeBroker({
      execute: async () => {
        throw new Error('executor exploded');
      },
      parked,
      kernelOverrides: {
        markEffectCompletionUnknown: async () => {
          throw new Error('park unavailable');
        },
      },
      auditAppend: async (event) => {
        audits.push(event as { type: string });
      },
    });
    await assert.rejects(
      broker.execute({ ...executeInput(), token: issueToken(issuer) }),
      (error: unknown) => error instanceof Error && error.message === 'executor exploded',
    );
    assert.equal(audits.filter((event) => event.type === 'effect.park_failed').length, 1);
    assert.equal(parked.length, 0);
  });
});

describe('EB-08 admit enforces the effect envelope contract', () => {
  it('rejects an effect id outside the identity pattern instead of passing it to the kernel', async () => {
    const { broker, issuer } = makeBroker({
      execute: async () => ({}),
      parked: [],
    });
    const rejected = await broker.admit(admitInput(issuer, { effectId: 'has space' }));
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.reason, 'INVALID_EFFECT_IDENTITY');
  });

  it('rejects a malformed caller idempotency key in the default caller policy', async () => {
    const { broker, issuer } = makeBroker({ execute: async () => ({}), parked: [] });
    for (const key of ['', 'has space', 'x'.repeat(257)]) {
      const rejected = await broker.admit(admitInput(issuer, { idempotencyKey: key }));
      assert.equal(rejected.admitted, false, `key ${JSON.stringify(key)} was admitted`);
      assert.equal(rejected.reason, 'INVALID_IDEMPOTENCY_KEY');
    }
  });

  it('still admits a well-formed caller key under the default caller policy', async () => {
    const { broker, issuer } = makeBroker({ execute: async () => ({}), parked: [] });
    const admitted = await broker.admit(admitInput(issuer));
    assert.equal(admitted.admitted, true);
  });

  it('recomputes and compares the key in derive policy', async () => {
    const { broker, issuer } = makeBroker({
      execute: async () => ({}),
      parked: [],
      idempotencyKeyPolicy: 'derive',
    });
    const mismatched = await broker.admit(admitInput(issuer, { idempotencyKey: 'not-derived' }));
    assert.equal(mismatched.admitted, false);
    assert.equal(mismatched.reason, 'IDEMPOTENCY_KEY_MISMATCH');

    const derived = deriveEffectIdempotencyKey({
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      effectId: 'effect-1',
      request: REQUEST,
    });
    const admitted = await broker.admit(admitInput(issuer, { idempotencyKey: derived }));
    assert.equal(admitted.admitted, true);
  });
});
