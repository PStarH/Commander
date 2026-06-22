/**
 * Phase 2.1+2.2 — CapabilityToken tests.
 *
 * Coverage (40 subtests):
 *  - issue/verify round-trip and signature integrity
 *  - canonical JSON determinism across key reorderings
 *  - jti uniqueness, malformed/bad-base64 rejection
 *  - delegation: parent_jti + child scope non-broadening (wildcard-aware)
 *  - revocation by jti and by parent chain
 *  - arg-shape regex matching + missing/null fail-fast
 *  - tool membership + wildcard matching (parent & child)
 *  - TTL expiry, future-iat skew rejection
 *  - audience mismatch rejection
 *  - dev/prod key handling (env override)
 *  - max delegation depth cap
 *  - issuer/verifier state separation keys
 *  - ToolApproval integration: token short-circuits policy
 *  - ToolApproval integration: invalid token falls through
 *  - ToolApproval integration: token ignored when no verifier configured
 *  - audit event emission on issuance + revocation
 *  - auditChain wiring (default + explicit)
 *  - per-sink audit isolation (throwing in-process sink must NOT bypass chained)
 *  - tokenRejected observability (opt-in via ToolApproval.setTokenRejectedLogger)
 *  - opt-out: no tokenRejectedLogger wired stays silent on rejection
 *  - singleton reset isolation
 */
import { it, beforeAll, afterEach, describe } from 'vitest';
import assert from 'node:assert/strict';

// Force a deterministic key for every test BEFORE importing the module.
process.env.NODE_ENV = 'test';

let _savedKey: string | undefined;
const setKey = (v: string) => {
  _savedKey = process.env.COMMANDER_CAPABILITY_TOKEN_KEY;
  process.env.COMMANDER_CAPABILITY_TOKEN_KEY = v;
};
const restoreKey = () => {
  if (_savedKey !== undefined) process.env.COMMANDER_CAPABILITY_TOKEN_KEY = _savedKey;
  else delete process.env.COMMANDER_CAPABILITY_TOKEN_KEY;
};

// Set a default key (will be overwritten by individual tests when needed).
setKey('test-key-must-be-at-least-32-characters-long-AAAA');

import {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  CapabilityTokenError,
  decode,
  sign,
  getCapabilityTokenIssuer,
  resetCapabilityTokenState,
  resetRevocationLedger,
  resolveMasterKey,
  CAPABILITY_TOKEN_KEY_ENV,
  DEFAULT_MAX_TTL_SECONDS,
  MAX_DELEGATION_DEPTH,
  CLOCK_SKEW_SECONDS,
} from '../../src/security/capabilityToken';
import { getAuditChainLedger, resetAuditChainLedger } from '../../src/security/auditChainLedger';
import { getMetricsCollector, resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { TokenRejectedLogger } from '../../src/runtime/toolApproval';
import { ToolApproval } from '../../src/runtime/toolApproval';

// Provide an audit sink so auditLogger optional path can be tested.
function makeIssuer(
  opts: ConstructorParameters<typeof CapabilityTokenIssuer>[0] = {},
): CapabilityTokenIssuer {
  resetRevocationLedger();
  return new CapabilityTokenIssuer({ masterKey: Buffer.alloc(32, 7), ...opts });
}
function makeVerifier(masterKey = Buffer.alloc(32, 7), expectedAud?: string) {
  return new CapabilityTokenVerifier({ masterKey, expectedAud });
}

beforeAll(() => {
  resetCapabilityTokenState();
  resetAuditChainLedger();
  resetMetricsCollector();
});

afterEach(() => {
  resetRevocationLedger();
  resetAuditChainLedger();
  resetMetricsCollector();
  restoreKey();
});

it('Phase 2.1 — issue + verify round-trip succeeds', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const tok = issuer.issue({
    sub: 'agent-1',
    aud: 'tenant-A',
    tools: ['file_write', 'memory_read'],
    ttlSeconds: 10,
  });
  const r = verifier.verify(tok, { tool: 'file_write', args: { path: '/x.ts' } });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.sub, 'agent-1');
    assert.deepEqual(r.scope.tools, ['file_write', 'memory_read']);
    assert.equal(typeof r.jti, 'string');
  }
});

it('Phase 2.1 — tampered payload fails signature verification', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 10 });
  const decoded = decode(tok);
  // Flip a payload claim without re-signing.
  decoded.payload.tools = ['shell_execute'];
  const parts = tok.split('.');
  const headerB64 = parts[0]!;
  const newPayloadB64 = Buffer.from(JSON.stringify(decoded.payload), 'utf-8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const stillOldSigB64 = parts[2]!;
  const forged = `${headerB64}.${newPayloadB64}.${stillOldSigB64}`;
  const r = verifier.verify(forged, { tool: 'shell_execute', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'signature_mismatch');
});

it('Phase 2.1 — malicious master key cannot verify token', () => {
  const issuer = makeIssuer();
  const attackerKey = Buffer.alloc(32, 99);
  const verifier = makeVerifier(attackerKey);
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 10 });
  const r = verifier.verify(tok, { tool: 'web_search', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'signature_mismatch');
});

it('Phase 2.1 — canonical JSON: key-order independence (sign is deterministic)', () => {
  const m = Buffer.alloc(32, 7);
  // Same content, DIFFERENT outer-object key order. Signatures MUST match.
  // (Arrays preserve order by design — sort tools at issuance time if reordering
  // is desired; the canonical engine itself only sorts object keys.)
  const tools = ['a_tool', 'b_tool'];
  const a = {
    v: 1,
    jti: 'a'.repeat(32),
    sub: 'agent-1',
    iss: 'commander',
    iat: 1000,
    exp: 2000,
    aud: 'tenant-A',
    scope: { tools, argShapes: { a_tool: { p: ['^a.*'] } } },
    risk: 'low',
    parent_jti: null,
    depth: 0,
    nonce: '1234abcd',
  };
  const b = {
    nonce: '1234abcd',
    parent_jti: null,
    depth: 0,
    risk: 'low',
    scope: { tools, argShapes: { a_tool: { p: ['^a.*'] } } },
    aud: 'tenant-A',
    exp: 2000,
    iat: 1000,
    iss: 'commander',
    sub: 'agent-1',
    v: 1,
    jti: 'a'.repeat(32),
  };
  assert.equal(sign(a, m), sign(b, m));
});

it('Phase 2.1 — jti uniqueness across N issuances', () => {
  const issuer = makeIssuer();
  const jtis = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['x'], ttlSeconds: 5 });
    jtis.add(decode(tok).payload.jti);
  }
  assert.equal(jtis.size, 100);
});

it('Phase 2.1 — malformed token: missing dots is rejected', () => {
  const verifier = makeVerifier(Buffer.alloc(32, 7));
  const r = verifier.verify('abc.def', { tool: 'x', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'malformed_encoding');
});

it('Phase 2.1 — malformed token: bad base64 signature rejected', () => {
  const issuer = makeIssuer();
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 10 });
  const parts = tok.split('.');
  parts[2] = '!!!not-base64!!!';
  const r = makeVerifier(issuer.masterKey).verify(parts.join('.'), {
    tool: 'web_search',
    args: {},
  });
  // Accept any of the three plausible reject paths so this test stays robust
  // to verifier-internal re-orderings (e.g., if sig-decode ever happens
  // before header/payload parse).
  assert.equal(r.ok, false);
  if (!r.ok)
    assert.ok(
      r.reason === 'malformed_encoding' ||
        r.reason === 'malformed_payload' ||
        r.reason === 'signature_mismatch',
      `expected one of malformed_encoding|malformed_payload|signature_mismatch, got ${r.reason}`,
    );
});

it('Phase 2.1 — token expired is rejected', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 1 });
  // Wait past expiry + skew.
  const deadline = Date.now() + CLOCK_SKEW_SECONDS * 1000 + 1500;
  while (Date.now() < deadline) {
    /* spin briefly */
  }
  const r = verifier.verify(tok, { tool: 'web_search', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
}, 10000);

it('Phase 2.1 — audience mismatch is rejected', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey, 'tenant-A');
  const tok = issuer.issue({ sub: 'a', aud: 'tenant-B', tools: ['web_search'], ttlSeconds: 10 });
  const r = verifier.verify(tok, { tool: 'web_search', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'aud_mismatch');
});

it('Phase 2.1 — wildcard tool scope matches', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['memory_*'], ttlSeconds: 10 });
  const r1 = verifier.verify(tok, { tool: 'memory_read', args: {} });
  const r2 = verifier.verify(tok, { tool: 'memory_write', args: { content: 'x' } });
  const r3 = verifier.verify(tok, { tool: 'shell_execute', args: {} });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.reason, 'scope_mismatch');
});

it('Phase 2.1 — arg-shape regex match approves, mismatch rejects', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const tok = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['file_write'],
    argShapes: { file_write: { path: ['^/workspace/', '^/tmp/'] } },
    ttlSeconds: 10,
  });
  const ok = verifier.verify(tok, { tool: 'file_write', args: { path: '/workspace/x.ts' } });
  assert.equal(ok.ok, true);
  const bad = verifier.verify(tok, { tool: 'file_write', args: { path: '/etc/passwd' } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'arg_shape_mismatch');
});

it('Phase 2.1 — arg-shape: missing/null param fails closed (no undefined coercion)', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const tok = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['file_write'],
    argShapes: { file_write: { path: ['^.*'] } }, // permissive regex, but missing arg must fail
    ttlSeconds: 10,
  });
  const missing = verifier.verify(tok, { tool: 'file_write', args: {} });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'arg_shape_mismatch');
  const explicitNull = verifier.verify(tok, { tool: 'file_write', args: { path: null } });
  assert.equal(explicitNull.ok, false);
  if (!explicitNull.ok) assert.equal(explicitNull.reason, 'arg_shape_mismatch');
});

it('Phase 2.1 — revocation: jti off the ledger rejects', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  assert.equal(issuer.revoke(decode(tok).payload.jti, 'incident_response'), true);
  const r = verifier.verify(tok, { tool: 'web_search', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'jti_revoked');
});

it('Phase 2.1 — revocation: revoking parent invalidates descendant', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const root = issuer.issue({ sub: 'a', aud: '*', tools: ['file_write'], ttlSeconds: 60 });
  const child = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['file_write'],
    ttlSeconds: 10,
    parent: decode(root),
  });
  assert.equal(
    verifier.verify(child, { tool: 'file_write', args: {} }).ok,
    true,
    'child must be accepted before parent revocation',
  );
  issuer.revoke(decode(root).payload.jti, 'parent_revoked');
  const r = verifier.verify(child, { tool: 'file_write', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'parent_jti_revoked');
});

it('Phase 2.1 — delegation: child exp must precede parent exp', () => {
  const issuer = makeIssuer();
  const root = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['file_write'],
    ttlSeconds: 10,
  });
  assert.throws(
    () =>
      issuer.issue({
        sub: 'a',
        aud: '*',
        tools: ['file_write'],
        ttlSeconds: 30,
        parent: decode(root),
      }),
    (e: unknown) =>
      e instanceof CapabilityTokenError && e.reason === 'parent_exp_sooner_than_child',
  );
});

it('Phase 2.1 — delegation depth capped at MAX_DELEGATION_DEPTH', () => {
  const issuer = makeIssuer();
  // Root with a generous TTL; each child halves (with a -1s margin) so the
  // parent_exp > child_exp invariant holds throughout the depth chain.
  let parent = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['file_write'],
    ttlSeconds: 120,
  });
  let lastError: CapabilityTokenError | null = null;
  let issuedAtDepth = 0;
  for (let i = 0; i < MAX_DELEGATION_DEPTH + 3; i++) {
    const ttl = Math.max(1, Math.floor(120 / Math.pow(2, i + 1)) - 1);
    try {
      parent = issuer.issue({
        sub: 'a',
        aud: '*',
        tools: ['file_write'],
        ttlSeconds: ttl,
        parent: decode(parent),
      });
      issuedAtDepth++;
    } catch (e) {
      if (e instanceof CapabilityTokenError) lastError = e;
      break;
    }
  }
  assert.ok(lastError !== null, 'expected delegation depth to be exceeded');
  assert.equal(lastError!.reason, 'delegation_depth_exceeded');
  assert.ok(issuedAtDepth >= 2, 'should issue at least root + 2 descendants before cap');
  assert.ok(issuedAtDepth < MAX_DELEGATION_DEPTH + 3, 'cap must terminate the chain');
});

it('Phase 2.1 — TTL overshoot (greater than maxTtlSeconds) throws at issue', () => {
  const issuer = makeIssuer({ maxTtlSeconds: 30 });
  assert.throws(
    () => issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 600 }),
    (e: unknown) => e instanceof CapabilityTokenError && e.reason === 'ttl_overshoot',
  );
});

it('Phase 2.1 — empty tools array throws at issue (refuses empty scope)', () => {
  const issuer = makeIssuer();
  assert.throws(
    () => issuer.issue({ sub: 'a', aud: '*', tools: [], ttlSeconds: 5 }),
    (e: unknown) => e instanceof CapabilityTokenError && e.reason === 'empty_scope',
  );
});

it('Phase 2.1 — duplicate jti within same process is refused', () => {
  const issuer = makeIssuer();
  const jti = 'a'.repeat(32);
  issuer.issue({ sub: 'a', aud: '*', tools: ['x'], ttlSeconds: 5, jti });
  assert.throws(
    () => issuer.issue({ sub: 'a', aud: '*', tools: ['x'], ttlSeconds: 5, jti }),
    (e: unknown) => e instanceof CapabilityTokenError && e.reason === 'duplicate_jti',
  );
});

it('Phase 2.1 — production refuses to start without env var key', () => {
  setKey('test-key-must-be-at-least-32-characters-long-AAAA');
  delete process.env[CAPABILITY_TOKEN_KEY_ENV];
  const savedEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => resolveMasterKey(), /must be set/);
  } finally {
    process.env.NODE_ENV = savedEnv!;
  }
});

it('Phase 2.1 — env override key takes precedence over dev fallback', () => {
  const custom = 'env-override-key-thirty-two-characters!!!';
  setKey(custom);
  try {
    const k = resolveMasterKey();
    assert.equal(Buffer.from(custom).equals(k), true);
  } finally {
    /* restoreKey runs in afterEach */
  }
});

it('Phase 2.1 — issuer + verifier sharing a masterKey roundtrip; mismatched keys fail', () => {
  const shared = Buffer.alloc(32, 11);
  const iA = new CapabilityTokenIssuer({ masterKey: shared });
  const vA = new CapabilityTokenVerifier({ masterKey: shared });
  const tok = iA.issue({ sub: 'x', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  assert.equal(vA.verify(tok, { tool: 'web_search', args: {} }).ok, true);

  const otherKey = Buffer.alloc(32, 22);
  const vB = new CapabilityTokenVerifier({ masterKey: otherKey });
  assert.equal(vB.verify(tok, { tool: 'web_search', args: {} }).ok, false);
});

it('Phase 2.1 — clock-skew tolerance: future iat within skew window is accepted', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const payload = {
    v: 1,
    jti: 'b'.repeat(32),
    sub: 'a',
    iss: 'commander',
    iat: Math.floor(Date.now() / 1000) + 3,
    exp: Math.floor(Date.now() / 1000) + 60,
    aud: '*',
    scope: { tools: ['web_search'] },
    risk: 'low',
    parent_jti: null,
    depth: 0,
    nonce: 'abcd1234',
  };
  const tok = sign(payload, issuer.masterKey);
  const r = verifier.verify(tok, { tool: 'web_search', args: {} });
  assert.equal(r.ok, true);
});

it('Phase 2.1 — clock-skew tolerance: future iat beyond skew window is rejected', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const farFuture = Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS + 60;
  const payload = {
    v: 1,
    jti: 'c'.repeat(32),
    sub: 'a',
    iss: 'commander',
    iat: farFuture,
    exp: farFuture + 60,
    aud: '*',
    scope: { tools: ['web_search'] },
    risk: 'low',
    parent_jti: null,
    depth: 0,
    nonce: 'abcd1234',
  };
  const tok = sign(payload, issuer.masterKey);
  const r = verifier.verify(tok, { tool: 'web_search', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'not_yet_valid');
});

it('Phase 2.1 — ToolApproval integration: valid token short-circuits policy', async () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const approver: Parameters<typeof ToolApproval>[0] = () => ({
    approved: false,
    requestId: 'r',
    approvedAt: new Date().toISOString(),
    reason: 'should-not-be-called',
  });
  const ta = new ToolApproval(approver, undefined, verifier);
  const tok = issuer.issue({ sub: 'agent-X', aud: '*', tools: ['file_write'], ttlSeconds: 30 });
  const r = await ta.requestApproval(
    'file_write',
    { path: '/workspace/x.ts' },
    {
      agentId: 'agent-X',
      token: tok,
    },
  );
  assert.equal(r.approved, true);
  assert.match(r.reason ?? '', /^capability-token:/);
});

it('Phase 2.1 — ToolApproval integration: invalid token falls through to approver (manual-level tool)', async () => {
  const verifier = makeVerifier(Buffer.alloc(32, 7));
  let approverCalled = false;
  const approver: Parameters<typeof ToolApproval>[0] = () => {
    approverCalled = true;
    return {
      approved: true,
      requestId: 'r',
      approvedAt: new Date().toISOString(),
      reason: 'fallthrough',
    };
  };
  const ta = new ToolApproval(approver, undefined, verifier);
  // Use `git_push` (manual-level policy) so the approver callback is the only
  // path to approval — ensures we observe fallback behavior, not autoApproveIf.
  const r = await ta.requestApproval(
    'git_push',
    { remote: 'origin' },
    {
      token: 'malformed.token.value',
    },
  );
  assert.equal(r.approved, true);
  assert.equal(approverCalled, true);
  assert.equal(r.reason, 'fallthrough');
});

it('Phase 2.1 — ToolApproval integration: token ignored when no verifier configured (manual-level tool)', async () => {
  const issuer = makeIssuer();
  let approverCalled = false;
  const approver: Parameters<typeof ToolApproval>[0] = () => {
    approverCalled = true;
    return {
      approved: true,
      requestId: 'r',
      approvedAt: new Date().toISOString(),
      reason: 'no-verifier',
    };
  };
  const ta = new ToolApproval(approver);
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['git_push'], ttlSeconds: 30 });
  // Use git_push (manual) so the approver must be called.
  const r = await ta.requestApproval('git_push', {}, { token: tok });
  assert.equal(r.approved, true);
  assert.equal(approverCalled, true);
  assert.equal(r.reason, 'no-verifier');
  assert.notEqual(r.reason ?? '', /^capability-token:/);
});

it('Phase 2.1 — issuance audit event is recorded when auditLogger is wired', () => {
  const events: Array<{ type: string; source: string }> = [];
  const issuer = makeIssuer({
    auditLogger: (e) => events.push({ type: e.type, source: e.source }),
  });
  issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'approval_granted');
  assert.equal(events[0]!.source, 'CapabilityTokenIssuer');
});

it('Phase 2.1 — issuance also writes to auditChain when wired', () => {
  const chainEvents: Array<{ type: string; source: string; tools: string[] }> = [];
  const inprocEvents: Array<{ type: string }> = [];
  const issuer = makeIssuer({
    auditLogger: (e) => inprocEvents.push({ type: e.type }),
    auditChain: (e) =>
      chainEvents.push({
        type: e.type,
        source: e.source,
        tools: (e.details?.tools as string[] | undefined) ?? [],
      }),
  });
  issuer.issue({ sub: 'a', aud: '*', tools: ['x', 'y'], ttlSeconds: 30 });
  assert.equal(inprocEvents.length, 1, 'in-process auditLogger fired');
  assert.equal(chainEvents.length, 1, 'auditChain fired');
  assert.equal(chainEvents[0]!.type, 'approval_granted');
  assert.equal(chainEvents[0]!.source, 'CapabilityTokenIssuer');
  assert.deepEqual(chainEvents[0]!.tools, ['x', 'y']);
  // Parity: both sinks observe the same event payload.
  assert.equal(inprocEvents[0]!.type, chainEvents[0]!.type);
});

it('Phase 2.1 — default-wired singleton feeds AuditChainLedger on issuance', () => {
  resetCapabilityTokenState();
  resetAuditChainLedger();
  const issuer = getCapabilityTokenIssuer();
  const beforeChained = getAuditChainLedger().getEntries().length;
  issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 60 });
  const afterChained = getAuditChainLedger().getEntries().length;
  assert.ok(
    afterChained === beforeChained + 1,
    `Expected exactly 1 new chained entry, got delta ${afterChained - beforeChained}`,
  );
  const lastEntry =
    getAuditChainLedger().getEntries()[getAuditChainLedger().getEntries().length - 1];
  assert.equal(lastEntry!.type, 'approval_granted');
  assert.equal(lastEntry!.source, 'CapabilityTokenIssuer');
});

it('Phase 2.1 — default-wired singleton feeds AuditChainLedger on revoke', () => {
  resetCapabilityTokenState();
  resetAuditChainLedger();
  const issuer = getCapabilityTokenIssuer();
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 60 });
  const initialCount = getAuditChainLedger().getEntries().length;
  issuer.revoke(decode(tok).payload.jti, 'test_revoke');
  const finalCount = getAuditChainLedger().getEntries().length;
  assert.equal(finalCount, initialCount + 1, 'revoke emitted one more chained entry');
  const entries = getAuditChainLedger().getEntries();
  assert.equal(entries[entries.length - 1]!.type, 'approval_denied');
});

it('Phase 2.1 — revocation audit event recorded; reset state clears the ledger', () => {
  const events: Array<{ type: string }> = [];
  const issuer = makeIssuer({
    auditLogger: (e) => events.push({ type: e.type }),
  });
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  issuer.revoke(decode(tok).payload.jti, 'manual');
  assert.equal(events[events.length - 1]!.type, 'approval_denied');
  resetRevocationLedger();
  // After reset, the verifier should now accept the token again.
  const verifier = makeVerifier(issuer.masterKey);
  assert.equal(verifier.verify(tok, { tool: 'web_search', args: {} }).ok, true);
});

it('Phase 2.1 — getCapabilityTokenIssuer singleton + resetCapabilityTokenState isolation', () => {
  resetCapabilityTokenState();
  const a = getCapabilityTokenIssuer();
  const b = getCapabilityTokenIssuer();
  assert.ok(a === b, 'singleton returns same instance until reset');
  resetCapabilityTokenState();
  const c = getCapabilityTokenIssuer();
  assert.ok(a !== c, 'reset forces a fresh issuer');
});

it('Phase 2.1 — Resolution short-circuit: wrong typ header', () => {
  const issuer = makeIssuer();
  const m = issuer.masterKey;
  const payload = {
    v: 1,
    jti: 'd'.repeat(32),
    sub: 'a',
    iss: 'commander',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    aud: '*',
    scope: { tools: ['web_search'] },
    risk: 'low',
    parent_jti: null,
    depth: 0,
    nonce: 'abcd1234',
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'NOT-CAP' }), 'utf-8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const nodeCrypto = require('node:crypto');
  const sigB64 = nodeCrypto.createHmac('sha256', m).update(`${header}.${payloadB64}`).digest('hex');
  const sig = Buffer.from(sigB64, 'utf-8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const tok = `${header}.${payloadB64}.${sig}`;
  const r = makeVerifier(issuer.masterKey).verify(tok, { tool: 'web_search', args: {} });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'malformed_payload');
});

it('Phase 2.1 — delegation rejects child scope that broadens parent scope', () => {
  const issuer = makeIssuer();
  const root = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['memory_read', 'memory_write'],
    ttlSeconds: 60,
  });
  assert.throws(
    () =>
      issuer.issue({
        sub: 'a',
        aud: '*',
        tools: ['shell_execute'], // not in parent scope
        ttlSeconds: 10,
        parent: decode(root),
      }),
    (e: unknown) => e instanceof CapabilityTokenError && e.reason === 'scope_mismatch',
  );
});

it('Phase 2.1 — delegation accepts child scope that is a strict subset of parent', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  const root = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['memory_read', 'memory_write', 'file_read'],
    ttlSeconds: 60,
  });
  const child = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['memory_read'], // subset
    ttlSeconds: 10,
    parent: decode(root),
  });
  assert.equal(
    verifier.verify(child, { tool: 'memory_read', args: {} }).ok,
    true,
    'narrower-scope child must be accepted',
  );
  assert.equal(
    verifier.verify(child, { tool: 'file_read', args: {} }).ok,
    false,
    'child token cannot enact a tool outside its narrowed scope',
  );
});

it('Phase 2.1 — delegation: parent wildcard covers child explicit tool name', () => {
  const issuer = makeIssuer();
  const verifier = makeVerifier(issuer.masterKey);
  // Parent grants `memory_*`; child should be issued for `memory_read`
  // without being flagged as scope broadening.
  const root = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['memory_*'],
    ttlSeconds: 60,
  });
  const child = issuer.issue({
    sub: 'a',
    aud: '*',
    tools: ['memory_read'],
    ttlSeconds: 10,
    parent: decode(root),
  });
  assert.equal(
    verifier.verify(child, { tool: 'memory_read', args: {} }).ok,
    true,
    'wildcard-propagated child must be accepted',
  );
  assert.equal(
    verifier.verify(child, { tool: 'memory_write', args: {} }).ok,
    false,
    'child token still cannot enact a tool it did not name',
  );
});

it('Phase 2.2 — throwing auditLogger does NOT skip auditChain (per-sink isolation)', () => {
  let chainEventCount = 0;
  const issuer = makeIssuer({
    auditLogger: () => {
      // Simulate a broken in-process sink. Issuance must still succeed
      // and the chained audit must still observe the event.
      throw new Error('simulated auditLogger crash');
    },
    auditChain: () => {
      chainEventCount++;
    },
  });
  // Issuance must still succeed despite the broken auditLogger.
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  assert.equal(typeof tok, 'string', 'issuance returned a token despite broken sink');
  assert.ok(tok.split('.').length === 3, 'returned value is a properly-formed token');
  assert.equal(
    chainEventCount,
    1,
    'auditChain STILL fired despite the auditLogger exception — tamper-evident trail unbypassable by broken in-process sink',
  );
});

it('Phase 2.2 — ToolApproval: rejected token emits observable tokenRejected event (opt-in)', async () => {
  const verifier = makeVerifier(Buffer.alloc(32, 7));
  const events: Array<{
    type: string;
    toolName: string;
    reason: string;
    agentId?: string;
    runId?: string;
  }> = [];
  const approver: Parameters<typeof ToolApproval>[0] = () => ({
    approved: true,
    requestId: 'r',
    approvedAt: new Date().toISOString(),
    reason: 'fallthrough',
  });
  const ta = new ToolApproval(approver, undefined, verifier);
  const rejectedLogger: TokenRejectedLogger = (e) =>
    events.push({
      type: e.type,
      toolName: e.toolName,
      reason: e.reason,
      agentId: e.agentId,
      runId: e.runId,
    });
  ta.setTokenRejectedLogger(rejectedLogger);
  // Use git_push (manual-level policy) so the approver MUST be reached -
  // proves the observability emit does NOT short-circuit the request when
  // the token is rejected, only fires the audit hook for visibility.
  const r = await ta.requestApproval(
    'git_push',
    { remote: 'origin' },
    { agentId: 'agent-Z', runId: 'run-42', token: 'not.a.valid.token' },
  );
  // Approval still falls through; observability side-channel fires.
  assert.equal(r.approved, true);
  assert.equal(r.reason, 'fallthrough');
  assert.equal(events.length, 1, 'opt-in logger fires exactly once on rejection');
  assert.equal(events[0]!.type, 'token_rejected');
  assert.equal(events[0]!.toolName, 'git_push');
  assert.equal(events[0]!.agentId, 'agent-Z');
  assert.equal(events[0]!.runId, 'run-42');
  assert.ok(
    ['malformed_encoding', 'malformed_payload', 'signature_mismatch'].includes(events[0]!.reason),
    `expected malformed_*|signature_mismatch, got ${events[0]!.reason}`,
  );
});

it('Phase 2.2 — ToolApproval: opt-out (no tokenRejectedLogger wired) stays silent on rejection', async () => {
  const verifier = makeVerifier(Buffer.alloc(32, 7));
  let approverCallCount = 0;
  const approver: Parameters<typeof ToolApproval>[0] = () => {
    approverCallCount++;
    return {
      approved: true,
      requestId: 'r',
      approvedAt: new Date().toISOString(),
      reason: 'silent-fallthrough',
    };
  };
  const ta = new ToolApproval(approver, undefined, verifier);
  // Deliberately do NOT call setTokenRejectedLogger — the rejection path
  // must remain completely silent (matches verify()'s intentional silence).
  const r = await ta.requestApproval('git_push', {}, { token: 'not.a.valid.token' });
  assert.equal(r.approved, true);
  assert.equal(r.reason, 'silent-fallthrough');
  assert.equal(approverCallCount, 1, 'approver still called once for fallback approval');
});

it('Phase 2.3 — audit_sink_failures_total{sink="auditLogger"} increments when auditLogger throws', () => {
  const beforeCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditLogger' },
  ]);
  const issuer = makeIssuer({
    auditLogger: () => {
      throw new Error('simulated in-process sink crash');
    },
  });
  // Issue fires one auditLogger call; revoke fires another.
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  issuer.revoke(decode(tok).payload.jti, 'sink_failure_test');
  const afterCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditLogger' },
  ]);
  assert.equal(
    afterCount,
    beforeCount + 2,
    `auditLogger sink threw on both issue+revoke; expected counter +2, got ${afterCount - beforeCount}`,
  );
  // Cross-check: the chained-audit counter must remain at the baseline (no
  // chain sink was wired, so no chain failures possible).
  const chainCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditChain' },
  ]);
  assert.equal(
    chainCount,
    0,
    'auditChain counter must remain 0 when only auditLogger is wired+throws',
  );
});

it('Phase 2.3 — audit_sink_failures_total{sink="auditChain"} increments when auditChain throws', () => {
  const beforeCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditChain' },
  ]);
  const issuer = makeIssuer({
    auditChain: () => {
      throw new Error('simulated chained-sink crash');
    },
  });
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  issuer.revoke(decode(tok).payload.jti, 'chain_sink_failure_test');
  const afterCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditChain' },
  ]);
  assert.equal(
    afterCount,
    beforeCount + 2,
    `auditChain sink threw on both issue+revoke; expected counter +2, got ${afterCount - beforeCount}`,
  );
  // Cross-check: in-process counter must remain at baseline (succeeded).
  const inprocCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditLogger' },
  ]);
  assert.equal(
    inprocCount,
    0,
    'auditLogger counter must remain 0 when only auditChain is wired+throws',
  );
});

it('Phase 2.3 — audit_sink_failures_total{sink="tokenRejectedLogger"} increments when user logger throws', async () => {
  const verifier = makeVerifier(Buffer.alloc(32, 7));
  const beforeCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'tokenRejectedLogger' },
  ]);
  const approver: Parameters<typeof ToolApproval>[0] = () => ({
    approved: true,
    requestId: 'r',
    approvedAt: new Date().toISOString(),
    reason: 'fallthrough',
  });
  const ta = new ToolApproval(approver, undefined, verifier);
  ta.setTokenRejectedLogger(() => {
    // Simulate a user-tenant logger that crashes (e.g. on a remote sink).
    throw new Error('simulated tenant logger crash');
  });
  // Verify rejects the malformed token → tokenRejectedLogger fires → throws
  // → recordSinkFailure('tokenRejectedLogger') increments the counter.
  await ta.requestApproval(
    'git_push',
    { remote: 'origin' },
    {
      token: 'definitely.not.a.token',
    },
  );
  const afterCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'tokenRejectedLogger' },
  ]);
  assert.equal(
    afterCount,
    beforeCount + 1,
    `tokenRejectedLogger threw; expected counter +1, got ${afterCount - beforeCount}`,
  );
  // Cross-check: capability-token side sinks unrelated to this path stay at 0.
  const loggerCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditLogger' },
  ]);
  const chainCount = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditChain' },
  ]);
  assert.equal(loggerCount, 0, 'auditLogger counter not affected by tokenRejectedLogger crash');
  assert.equal(chainCount, 0, 'auditChain counter not affected by tokenRejectedLogger crash');
});

it('Phase 2.3 — audit_sink_failures_total is unaffected when both sinks succeed', () => {
  const beforeLogger = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditLogger' },
  ]);
  const beforeChain = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditChain' },
  ]);
  const issuer = makeIssuer({
    auditLogger: () => {
      /* success */
    },
    auditChain: () => {
      /* success */
    },
  });
  const tok = issuer.issue({ sub: 'a', aud: '*', tools: ['web_search'], ttlSeconds: 30 });
  issuer.revoke(decode(tok).payload.jti, 'no_throw_test');
  const afterLogger = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditLogger' },
  ]);
  const afterChain = getMetricsCollector().getCounter('audit_sink_failures_total', [
    { name: 'sink', value: 'auditChain' },
  ]);
  assert.equal(afterLogger, beforeLogger, 'auditLogger counter unchanged when sink succeeds');
  assert.equal(afterChain, beforeChain, 'auditChain counter unchanged when sink succeeds');
});
