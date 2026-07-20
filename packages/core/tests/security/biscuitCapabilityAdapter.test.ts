import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BiscuitCapabilityAdapter,
  BiscuitCapabilityVerifier,
  getGlobalBiscuitCapabilityAdapter,
} from '../../src/security/biscuitCapabilityAdapter';
import { BiscuitTokenVerifier, BiscuitCapabilityToken } from '../../src/security/biscuitToken';
import { ToolExecutionService } from '../../src/runtime/toolExecutionService';
import {
  getCapabilityTokenIssuer,
  resetCapabilityTokenState,
} from '../../src/security/capabilityToken';

/**
 * Biscuit capability token — signature-trust regression tests.
 *
 * The critical property: verification trust must be anchored in the issuer's
 * public key held by the verifier, NOT in a key embedded in the token. A token
 * signed by a different (attacker) issuer must be rejected.
 */
describe('BiscuitCapabilityAdapter — issuer trust', () => {
  function verifierFor(adapter: BiscuitCapabilityAdapter, aud: string): BiscuitCapabilityVerifier {
    return new BiscuitCapabilityVerifier(
      new BiscuitTokenVerifier(adapter.getIssuerPublicKey()),
      aud,
    );
  }

  it('accepts a token from the trusted issuer for an in-scope tool', () => {
    const adapter = new BiscuitCapabilityAdapter();
    const token = adapter.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_read'] });
    const verifier = verifierFor(adapter, 'acme');
    const result = verifier.verify(token, { tool: 'file_read', args: {} });
    expect(result.ok).toBe(true);
  });

  it('rejects an out-of-scope tool (least privilege)', () => {
    const adapter = new BiscuitCapabilityAdapter();
    const token = adapter.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_read'] });
    const verifier = verifierFor(adapter, 'acme');
    const result = verifier.verify(token, { tool: 'file_write', args: {} });
    expect(result.ok).toBe(false);
  });

  it('rejects a token forged by a different issuer (no embedded-key trust)', () => {
    const trusted = new BiscuitCapabilityAdapter();
    const attacker = new BiscuitCapabilityAdapter(); // different Ed25519 keypair
    // Attacker mints a self-signed token embedding THEIR public key.
    const forged = attacker.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_write'] });
    // Verified against the TRUSTED issuer's key — must fail on the signature.
    const verifier = verifierFor(trusted, 'acme');
    const result = verifier.verify(forged, { tool: 'file_write', args: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('token.verify() with no trusted key fails closed', () => {
    // Directly exercise the token: without an external issuer key, root trust
    // must fail closed rather than trust the embedded key.
    const adapter = new BiscuitCapabilityAdapter();
    const encoded = adapter.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_read'] });
    const bytes = new Uint8Array(Buffer.from(encoded.replace(/^bsc_/, ''), 'base64'));
    const token = BiscuitCapabilityToken.deserialize(bytes);
    expect(token.verify()).toBe(false); // no key → fail closed
    expect(token.verify(adapter.getIssuerPublicKey())).toBe(true); // trusted key → ok
  });
});

/**
 * CAP-02 — Biscuit must not fail-open when expectedAud is '*' or ''.
 * Reproduce: tenant-a scoped bsc_ + createVerifier('*') must be ok:false.
 * Semantics mirror HMAC CapabilityTokenVerifier (CAP-02).
 */
describe('BiscuitCapabilityAdapter — CAP-02 tenant audience', () => {
  it("CAP-02 hard: tenant-a scoped bsc_ + createVerifier('*') is rejected (not fail-open)", () => {
    const adapter = new BiscuitCapabilityAdapter();
    const scoped = adapter.issue({
      sub: 'agent-1',
      aud: 'tenant-a',
      tools: ['web_search'],
    });
    const result = adapter.createVerifier('*').verify(scoped, {
      tool: 'web_search',
      args: {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('aud_mismatch');
  });

  it("CAP-02 hard: createVerifier('') rejects (empty expectedAud misuse)", () => {
    const adapter = new BiscuitCapabilityAdapter();
    const scoped = adapter.issue({
      sub: 'agent-1',
      aud: 'tenant-a',
      tools: ['web_search'],
    });
    const result = adapter.createVerifier('').verify(scoped, {
      tool: 'web_search',
      args: {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('aud_mismatch');
    expect(result.detail ?? '').toMatch(/empty expected audience/i);
  });

  it("CAP-02: expectedAud='*' accepts wildcard token; rejects wrong/concrete tenants", () => {
    const adapter = new BiscuitCapabilityAdapter();
    const wild = adapter.issue({ sub: 'a', aud: '*', tools: ['web_search'] });
    const tenantA = adapter.issue({ sub: 'a', aud: 'tenant-a', tools: ['web_search'] });
    const verifier = adapter.createVerifier('*');

    expect(verifier.verify(wild, { tool: 'web_search', args: {} }).ok).toBe(true);

    const rejectScoped = verifier.verify(tenantA, { tool: 'web_search', args: {} });
    expect(rejectScoped.ok).toBe(false);
    expect(rejectScoped.reason).toBe('aud_mismatch');
  });

  it("CAP-02: concrete expectedAud rejects token aud='*' and wrong tenant; accepts same", () => {
    const adapter = new BiscuitCapabilityAdapter();
    const wild = adapter.issue({ sub: 'a', aud: '*', tools: ['web_search'] });
    const tenantA = adapter.issue({ sub: 'a', aud: 'tenant-a', tools: ['web_search'] });
    const tenantB = adapter.issue({ sub: 'a', aud: 'tenant-b', tools: ['web_search'] });
    const verifier = adapter.createVerifier('tenant-b');

    const rejectWild = verifier.verify(wild, { tool: 'web_search', args: {} });
    expect(rejectWild.ok).toBe(false);
    expect(rejectWild.reason).toBe('aud_mismatch');
    expect(rejectWild.detail ?? '').toMatch(/aud=\*|tenant-scoped verify/i);

    const rejectWrong = verifier.verify(tenantA, { tool: 'web_search', args: {} });
    expect(rejectWrong.ok).toBe(false);
    expect(rejectWrong.reason).toBe('aud_mismatch');

    expect(verifier.verify(tenantB, { tool: 'web_search', args: {} }).ok).toBe(true);
  });
});

describe('ToolExecutionService — CAP-02 biscuit/HMAC audience binding parity', () => {
  it('both createVerifier call sites use empty-safe expectedAud (same as HMAC)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tesPath = path.resolve(here, '../../src/runtime/toolExecutionService.ts');
    const src = fs.readFileSync(tesPath, 'utf8');
    // Must not regress to tenantId ?? '*' (empty string fail-open into createVerifier).
    expect(src).not.toMatch(/createVerifier\(\s*tenantId\s*\?\?\s*['"]\*['"]\s*\)/);
    const binding = /const expectedAud = tenantId && tenantId\.length > 0 \? tenantId : '\*';/g;
    const matches = src.match(binding) ?? [];
    expect(matches.length).toBe(2);
    // Both biscuit createVerifier sites consume the shared expectedAud.
    const biscuitCreate = src.match(/createVerifier\(\s*expectedAud\s*\)/g) ?? [];
    expect(biscuitCreate.length).toBe(2);
  });
});

describe('ToolExecutionService.execute — CAP-02 hard audience (behavioral)', () => {
  function makeSvc() {
    return new ToolExecutionService({
      tools: new Map(),
      compensationService: {
        getRegistry: () => ({ assessReversibility: () => 'reversible' }),
      } as never,
      cacheManager: { getToolCache: () => ({ get: () => null, set: () => {} }) } as never,
      // accept 路径会落到 TOOL_NOT_FOUND → dlq.record；stub 避免 as never 空对象抛错
      dlq: { record: () => {} } as never,
      getRunHandle: () => null,
      config: {} as never,
      reflexionGenerator: {} as never,
      stepTimeout: {} as never,
      getPromotedTools: () => new Set(),
      generateActionId: () => 'test-action',
      getBreakerRegistry: () => ({ get: () => null }) as never,
    });
  }

  function toolCall(name = 'web_search') {
    return {
      id: 'tc-1',
      name,
      arguments: {},
    };
  }

  /** CAP 门控通过后无注册工具 → TOOL_NOT_FOUND（证明非 CAPABILITY_TOKEN_REJECTED） */
  function expectCapAccepted(result: { error?: string }) {
    const err = result.error ?? '';
    expect(err).not.toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(err).not.toMatch(/CAPABILITY_TOKEN_ERROR/);
    expect(err).toMatch(/TOOL_NOT_FOUND/);
  }

  it('HMAC: wrong tenant token rejected on execute', async () => {
    resetCapabilityTokenState();
    const issuer = getCapabilityTokenIssuer();
    const tok = issuer.issue({
      sub: 'agent-1',
      aud: 'tenant-a',
      tools: ['web_search'],
      ttlSeconds: 30,
    });
    const result = await makeSvc().execute(
      'run-1',
      toolCall(),
      'agent-1',
      'tenant-b',
      undefined,
      undefined,
      undefined,
      tok,
    );
    expect(result.error ?? '').toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(result.error ?? '').toMatch(/aud_mismatch/);
  });

  it("HMAC: wildcard aud='*' rejected when execute has concrete tenant", async () => {
    resetCapabilityTokenState();
    const issuer = getCapabilityTokenIssuer();
    const tok = issuer.issue({
      sub: 'agent-1',
      aud: '*',
      tools: ['web_search'],
      ttlSeconds: 30,
    });
    const result = await makeSvc().execute(
      'run-1',
      toolCall(),
      'agent-1',
      'tenant-b',
      undefined,
      undefined,
      undefined,
      tok,
    );
    expect(result.error ?? '').toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(result.error ?? '').toMatch(/aud_mismatch/);
  });

  it('HMAC: missing/empty tenantId uses aud=* — rejects stolen tenant-scoped token', async () => {
    resetCapabilityTokenState();
    const issuer = getCapabilityTokenIssuer();
    const scoped = issuer.issue({
      sub: 'agent-1',
      aud: 'tenant-a',
      tools: ['web_search'],
      ttlSeconds: 30,
    });
    const svc = makeSvc();
    const missing = await svc.execute(
      'run-1',
      toolCall(),
      'agent-1',
      undefined,
      undefined,
      undefined,
      undefined,
      scoped,
    );
    expect(missing.error ?? '').toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(missing.error ?? '').toMatch(/aud_mismatch/);

    const empty = await svc.execute(
      'run-1',
      toolCall(),
      'agent-1',
      '',
      undefined,
      undefined,
      undefined,
      scoped,
    );
    expect(empty.error ?? '').toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(empty.error ?? '').toMatch(/aud_mismatch/);
  });

  it('Biscuit: wrong tenant / wild / missing tenantId rejected on execute', async () => {
    const adapter = getGlobalBiscuitCapabilityAdapter();
    const scopedA = adapter.issue({
      sub: 'agent-1',
      aud: 'tenant-a',
      tools: ['web_search'],
    });
    const wild = adapter.issue({ sub: 'agent-1', aud: '*', tools: ['web_search'] });
    const svc = makeSvc();

    const wrong = await svc.execute(
      'run-1',
      toolCall(),
      'agent-1',
      'tenant-b',
      undefined,
      undefined,
      undefined,
      scopedA,
    );
    expect(wrong.error ?? '').toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(wrong.error ?? '').toMatch(/aud_mismatch/);

    const wildReject = await svc.execute(
      'run-1',
      toolCall(),
      'agent-1',
      'tenant-b',
      undefined,
      undefined,
      undefined,
      wild,
    );
    expect(wildReject.error ?? '').toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(wildReject.error ?? '').toMatch(/aud_mismatch/);

    const missing = await svc.execute(
      'run-1',
      toolCall(),
      'agent-1',
      undefined,
      undefined,
      undefined,
      undefined,
      scopedA,
    );
    expect(missing.error ?? '').toMatch(/CAPABILITY_TOKEN_REJECTED/);
    expect(missing.error ?? '').toMatch(/aud_mismatch/);
  });

  // CAP-02 正向：正确 aud 在 execute 层必须越过 capability 门控（非仅 deny 早退）
  it('HMAC: matching tenant aud accepted on execute (CAP gate passes)', async () => {
    resetCapabilityTokenState();
    const issuer = getCapabilityTokenIssuer();
    const tok = issuer.issue({
      sub: 'agent-1',
      aud: 'tenant-a',
      tools: ['web_search'],
      ttlSeconds: 30,
    });
    const result = await makeSvc().execute(
      'run-1',
      toolCall(),
      'agent-1',
      'tenant-a',
      undefined,
      undefined,
      undefined,
      tok,
    );
    expectCapAccepted(result);
  });

  it("HMAC: missing tenantId + token aud='*' accepted on execute", async () => {
    resetCapabilityTokenState();
    const issuer = getCapabilityTokenIssuer();
    const wild = issuer.issue({
      sub: 'agent-1',
      aud: '*',
      tools: ['web_search'],
      ttlSeconds: 30,
    });
    const result = await makeSvc().execute(
      'run-1',
      toolCall(),
      'agent-1',
      undefined,
      undefined,
      undefined,
      undefined,
      wild,
    );
    expectCapAccepted(result);
  });

  it('Biscuit: matching tenant aud accepted on execute (CAP gate passes)', async () => {
    const adapter = getGlobalBiscuitCapabilityAdapter();
    const tok = adapter.issue({
      sub: 'agent-1',
      aud: 'tenant-a',
      tools: ['web_search'],
    });
    const result = await makeSvc().execute(
      'run-1',
      toolCall(),
      'agent-1',
      'tenant-a',
      undefined,
      undefined,
      undefined,
      tok,
    );
    expectCapAccepted(result);
  });

  it("Biscuit: missing tenantId + token aud='*' accepted on execute", async () => {
    const adapter = getGlobalBiscuitCapabilityAdapter();
    const wild = adapter.issue({ sub: 'agent-1', aud: '*', tools: ['web_search'] });
    const result = await makeSvc().execute(
      'run-1',
      toolCall(),
      'agent-1',
      undefined,
      undefined,
      undefined,
      undefined,
      wild,
    );
    expectCapAccepted(result);
  });
});
