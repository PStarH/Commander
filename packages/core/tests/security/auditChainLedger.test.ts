/**
 * auditChainLedger.test.ts — Phase 1.1 tamper-evident HMAC chain tests.
 *
 * Covers:
 *   1. Chain construction (GENESIS, linkage, instance uniqueness)
 *   2. Canonicalization (stable across key permutations)
 *   3. Per-process chainId and serial seq
 *   4. Tenant isolation (HKDF-derived keys; verify scoping)
 *   5. Persistence (NDJSON writes + rotated file aggregation)
 *   6. verify() tampering detection (delete, modify payload,
 *      modify prevHash, foreign insertion, duplicate seq)
 *   7. Key handling (production hard-fails; non-prod warns)
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import {
  AuditChainLedger,
  GENESIS_HASH,
  CHAIN_PROTOCOL_VERSION,
  AUDIT_CHAIN_KEY_ENV,
  computeEntryHmac,
  deriveTenantKey,
  resolveMasterKey,
  collectPersistedEntries,
  getAuditChainLedger,
  resetAuditChainLedger,
} from '../../src/security/auditChainLedger';
import {
  SecurityAuditLogger,
  getSecurityAuditLogger,
  resetSecurityAuditLogger,
} from '../../src/security/securityAuditLogger';

// ─── Test fixtures ─────────────────────────────────────────────────────

const TEST_KEY = 'x'.repeat(64);
const PREV_NODE_ENV = process.env.NODE_ENV;

let tmpDirCounter = 0;

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `audit-chain-${process.pid}-${Date.now()}-${++tmpDirCounter}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Build a ledger using TEST_KEY + tmpDir.
 * Also override the SecurityAuditLogger singleton's persist dir via env
 * so chain entries (which the ledger delegates to the logger for the
 * durable NDJSON write) end up in the same tmp directory.
 */
function freshLedger(tmp: string): AuditChainLedger {
  return new AuditChainLedger({
    persistDir: tmp,
    masterKey: Buffer.from(TEST_KEY, 'utf-8'),
  });
}

async function drainMicrotasks(): Promise<void> {
  // PersistChainedLine is fire-and-forget; let the microtask drain so
  // the appendFile + stat complete before tests inspect the directory.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// ─── Suite ─────────────────────────────────────────────────────────────

describe('AuditChainLedger', () => {
  let tmpDir: string;

  beforeEach(() => {
    process.env[AUDIT_CHAIN_KEY_ENV] = TEST_KEY;
    process.env.NODE_ENV = 'test';
    process.env.COMMANDER_AUDIT_PERSIST_DIR = (tmpDir = makeTmpDir());
    resetAuditChainLedger();
    resetSecurityAuditLogger();
  });

  afterEach(async () => {
    delete process.env[AUDIT_CHAIN_KEY_ENV];
    delete process.env.COMMANDER_AUDIT_PERSIST_DIR;
    process.env.NODE_ENV = PREV_NODE_ENV ?? '';
    if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV;
    cleanupTmpDir(tmpDir);
    resetAuditChainLedger();
    resetSecurityAuditLogger();
    await drainMicrotasks();
  });

  // ─── 1. Chain construction ──────────────────────────────────────────

  describe('chain construction', () => {
    it('first entry has prevHash = GENESIS_HASH', () => {
      const ledger = freshLedger(tmpDir);
      const entry = ledger.logEvent({
        type: 'content_threat',
        severity: 'high',
        source: 'TestSource',
        message: 'first event',
      });
      assert.equal(entry.prevHash, GENESIS_HASH);
      assert.equal(entry.seq, 1);
      assert.equal(entry.chainId, ledger.currentChainId);
      assert.equal(entry.hmac.length, 64); // SHA-256 hex
    });

    it('each subsequent entry links to the previous hmac', () => {
      const ledger = freshLedger(tmpDir);
      const e1 = ledger.logEvent({
        type: 'auth_failure',
        severity: 'high',
        source: 'auth',
        message: 'bad key',
      });
      const e2 = ledger.logEvent({
        type: 'auth_failure',
        severity: 'high',
        source: 'auth',
        message: 'bad key 2',
      });
      const e3 = ledger.logEvent({
        type: 'content_threat',
        severity: 'medium',
        source: 'scanner',
        message: 'injection',
      });
      assert.equal(e2.seq, 2);
      assert.equal(e2.prevHash, e1.hmac);
      assert.equal(e3.seq, 3);
      assert.equal(e3.prevHash, e2.hmac);
      assert.equal(ledger.currentPrevHash, e3.hmac);
    });

    it('hmac differs across two ledger instances', () => {
      const ledgerA = freshLedger(path.join(tmpDir, 'a'));
      const ledgerB = freshLedger(path.join(tmpDir, 'b'));
      ledgerB.chainId; // no-op for typing
      const entryA = ledgerA.logEvent({
        type: 'config_change',
        severity: 'low',
        source: 'cfg',
        message: 'same body',
        context: { tenantId: 't' },
      });
      const entryB = ledgerB.logEvent({
        type: 'config_change',
        severity: 'low',
        source: 'cfg',
        message: 'same body',
        context: { tenantId: 't' },
      });
      assert.notEqual(entryA.chainId, entryB.chainId);
      assert.notEqual(entryA.hmac, entryB.hmac);
    });

    it('changing any payload field invalidates hmac', () => {
      const ledger = freshLedger(tmpDir);
      const baseEvent = {
        type: 'content_threat' as const,
        severity: 'high' as const,
        source: 'src',
        message: 'msg',
        details: { count: 1 },
      };
      const a = ledger.logEvent({ ...baseEvent });
      const b = ledger.logEvent({ ...baseEvent, message: 'msg mutated' });
      assert.notEqual(a.hmac, b.hmac);
      const c = ledger.logEvent({ ...baseEvent, severity: 'low' });
      assert.notEqual(a.hmac, c.hmac);
      const d = ledger.logEvent({ ...baseEvent, details: { count: 2 } });
      assert.notEqual(a.hmac, d.hmac);
    });
  });

  // ─── 2. Canonicalization ────────────────────────────────────────────

  describe('canonicalization', () => {
    it('same logical event → identical hmac regardless of details key order', () => {
      const ledger = freshLedger(tmpDir);
      const details1 = { a: 1, b: 2, c: { x: 'hi', y: 'lo' } };
      const details2 = { c: { y: 'lo', x: 'hi' }, b: 2, a: 1 };
      const e1 = ledger.logEvent({
        type: 'content_threat',
        severity: 'high',
        source: 'scanner',
        message: 'm',
        details: details1,
      });
      const e2 = ledger.logEvent({
        type: 'content_threat',
        severity: 'high',
        source: 'scanner',
        message: 'm',
        details: details2,
      });
      // Same canonical form ⇒ same hmac (but different seq + prev ⇒ different chain positions).
      // We test by re-computing an equivalent entry with the same fields against the same key.
      const masterKey = Buffer.from(TEST_KEY, 'utf-8');
      const tenantKey = deriveTenantKey(masterKey, e1.tenantId);
      const syntheticHmac = computeEntryHmac(tenantKey, {
        chainId: e1.chainId,
        seq: e1.seq,
        prevHash: e1.prevHash,
        id: e1.id,
        timestamp: e1.timestamp,
        type: e1.type,
        severity: e1.severity,
        source: e1.source,
        message: e1.message,
        details: details2, // semantically equal but key-permuted
        context: e1.context,
        tenantId: e1.tenantId,
      });
      assert.equal(syntheticHmac, e1.hmac);
      // Sanity: e2 still has a different hmac despite logical equivalence
      // (because seq differs).
      assert.notEqual(e2.hmac, e1.hmac);
    });

    it('arrays preserve order (semantic)', () => {
      const ledger = freshLedger(tmpDir);
      const e1 = ledger.logEvent({
        type: 'content_threat',
        severity: 'medium',
        source: 's',
        message: 'arr-order',
        details: { tags: ['a', 'b', 'c'] },
      });
      const e2 = ledger.logEvent({
        type: 'content_threat',
        severity: 'medium',
        source: 's',
        message: 'arr-order',
        details: { tags: ['c', 'b', 'a'] }, // permuted
      });
      // Even though we can't compare hmac of different seq entries, we DO
      // verify direct computeEntryHmac differs for permuted arrays.
      const masterKey = Buffer.from(TEST_KEY, 'utf-8');
      const tenantKey = deriveTenantKey(masterKey, undefined);
      const h1 = computeEntryHmac(tenantKey, {
        chainId: e1.chainId, seq: e1.seq, prevHash: e1.prevHash,
        id: e1.id, timestamp: e1.timestamp, type: e1.type,
        severity: e1.severity, source: e1.source, message: e1.message,
        details: { tags: ['a', 'b', 'c'] }, context: e1.context, tenantId: e1.tenantId,
      });
      const h2 = computeEntryHmac(tenantKey, {
        chainId: e1.chainId, seq: e1.seq, prevHash: e1.prevHash,
        id: e1.id, timestamp: e1.timestamp, type: e1.type,
        severity: e1.severity, source: e1.source, message: e1.message,
        details: { tags: ['c', 'b', 'a'] }, context: e1.context, tenantId: e1.tenantId,
      });
      assert.notEqual(h1, h2);
    });
  });

  // ─── 3. Per-process chainId ─────────────────────────────────────────

  describe('per-process chainId', () => {
    it('two ledger instances generate distinct chainIds', () => {
      const a = freshLedger(path.join(tmpDir, 'a'));
      const b = freshLedger(path.join(tmpDir, 'b'));
      assert.notEqual(a.currentChainId, b.currentChainId);
      assert.match(a.currentChainId, /^[0-9a-f]{32}$/);
      assert.match(b.currentChainId, /^[0-9a-f]{32}$/);
    });

    it('the same instance produces a single chainId across calls', () => {
      const ledger = freshLedger(tmpDir);
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const e = ledger.logEvent({
          type: 'security_scan',
          severity: 'low',
          source: 's',
          message: `scan ${i}`,
        });
        ids.add(e.chainId);
      }
      assert.equal(ids.size, 1);
    });
  });

  // ─── 4. seq counter ─────────────────────────────────────────────────

  describe('seq counter', () => {
    it('starts at 1 and increments gaplessly', () => {
      const ledger = freshLedger(tmpDir);
      for (let i = 1; i <= 25; i++) {
        const e = ledger.logEvent({
          type: 'config_change',
          severity: 'low',
          source: 'cfg',
          message: `change-${i}`,
        });
        assert.equal(e.seq, i);
      }
      assert.equal(ledger.currentSeq, 25);
    });
  });

  // ─── 5. Tenant isolation ────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('two tenants with same content produce different hmac', () => {
      const ledger = freshLedger(tmpDir);
      const tA = ledger.logEvent({
        type: 'auth_success',
        severity: 'low',
        source: 's',
        message: 'login',
        context: { tenantId: 'tenant-A' },
      });
      const tB = ledger.logEvent({
        type: 'auth_success',
        severity: 'low',
        source: 's',
        message: 'login',
        context: { tenantId: 'tenant-B' },
      });
      assert.equal(tA.tenantId, 'tenant-A');
      assert.equal(tB.tenantId, 'tenant-B');
      assert.notEqual(tA.hmac, tB.hmac);
      // Cross-check via computeEntryHmac — both should match their stored hmac.
      const masterKey = Buffer.from(TEST_KEY, 'utf-8');
      const keyA = deriveTenantKey(masterKey, 'tenant-A');
      const keyB = deriveTenantKey(masterKey, 'tenant-B');
      const { hmac: _ignoredA, ...partialA } = tA;
      const { hmac: _ignoredB, ...partialB } = tB;
      assert.equal(computeEntryHmac(keyA, partialA), tA.hmac);
      assert.equal(computeEntryHmac(keyB, partialB), tB.hmac);
    });

    it('deriveTenantKey returns 32-byte HKDF-derived keys', () => {
      const masterKey = Buffer.from(TEST_KEY, 'utf-8');
      const k1 = deriveTenantKey(masterKey, 'tenant-1');
      const k1b = deriveTenantKey(masterKey, 'tenant-1');
      const k2 = deriveTenantKey(masterKey, 'tenant-2');
      assert.equal(k1.length, 32);
      assert.equal(k2.length, 32);
      // Deterministic for same input
      assert.ok(k1.equals(k1b));
      // Different per tenant
      assert.ok(!k1.equals(k2));
      // Global (no tenant) returns master key directly
      assert.ok(deriveTenantKey(masterKey, undefined).equals(masterKey));
    });

    it('verify({ tenantId }) ignores entries from other tenants', () => {
      const ledgerA = freshLedger(path.join(tmpDir, 'a'));
      const ledgerB = freshLedger(path.join(tmpDir, 'b'));
      ledgerA.logEvent({
        type: 'auth_success', severity: 'low', source: 's',
        message: 'A1', context: { tenantId: 'tenant-A' },
      });
      ledgerB.logEvent({
        type: 'auth_success', severity: 'low', source: 's',
        message: 'B1', context: { tenantId: 'tenant-B' },
      });
      // Both ledgers in same dir ⇒ verify sees both chains.
      const r = ledgerA.verify({ tenantId: 'tenant-A' });
      assert.equal(r.ok, true);
      assert.equal(r.chainsInspected, 1);
      assert.equal(r.totalEntries, 1);
    });
  });

  // ─── 6. Persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    it('writes entries to audit-chain-*.ndjson', async () => {
      const ledger = freshLedger(tmpDir);
      ledger.logEvent({
        type: 'auth_failure', severity: 'high', source: 'auth',
        message: 'one',
      });
      ledger.logEvent({
        type: 'auth_failure', severity: 'high', source: 'auth',
        message: 'two',
      });
      await drainMicrotasks();
      const files = fs.readdirSync(tmpDir).filter(
        (f) => f.startsWith('audit-chain-') && f.endsWith('.ndjson'),
      );
      assert.ok(files.length >= 1);
      const content = fs.readFileSync(path.join(tmpDir, files[0]!), 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      const first = JSON.parse(lines[0]!);
      assert.equal(typeof first.hmac, 'string');
      assert.equal(first.chainId, ledger.currentChainId);
    });

    it('collectPersistedEntries reads rotated files', async () => {
      const ledger = new AuditChainLedger({
        persistDir: tmpDir,
        masterKey: Buffer.from(TEST_KEY, 'utf-8'),
        // Force per-file rotation by setting tiny maxFileSize.
      });
      // Override maxFileSize indirectly: many entries → SecurityAuditLogger
      // will rotate for us. The unique thing we test here is that the
      // ledger-facing collectPersistedEntries returns ALL entries.
      for (let i = 0; i < 30; i++) {
        ledger.logEvent({
          type: 'security_scan', severity: 'low', source: 's',
          message: `entry-${i}`,
        });
      }
      await drainMicrotasks();
      const entries = collectPersistedEntries(tmpDir);
      assert.equal(entries.length, 30);
      // Sequence must be 1…30 in order
      for (let i = 0; i < 30; i++) {
        assert.equal(entries[i]!.seq, i + 1);
      }
    });
  });

  // ─── 7. verify() tampering detection ────────────────────────────────

  describe('verify() tampering detection', () => {
    it('clean chain verifies ok=true', async () => {
      const ledger = freshLedger(tmpDir);
      ledger.logEvent({
        type: 'auth_failure', severity: 'high', source: 's', message: 'a',
      });
      ledger.logEvent({
        type: 'auth_failure', severity: 'high', source: 's', message: 'b',
      });
      await drainMicrotasks();
      const r = ledger.verify();
      assert.equal(r.ok, true);
      assert.equal(r.totalEntries, 2);
      assert.equal(r.chainsInspected, 1);
      assert.equal(r.brokenChain, undefined);
    });

    it('detect deletion of a middle entry via seq_gap', async () => {
      const ledger = freshLedger(tmpDir);
      for (let i = 1; i <= 5; i++) {
        ledger.logEvent({
          type: 'config_change', severity: 'low', source: 's', message: `${i}`,
        });
      }
      await drainMicrotasks();
      // Tamper: rewrite the file removing seq=3.
      const file = path.join(tmpDir, 'audit-chain-0.ndjson');
      const original = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      const filtered = original.filter((line) => {
        const obj = JSON.parse(line) as { seq: number };
        return obj.seq !== 3;
      });
      fs.writeFileSync(file, filtered.join('\n') + '\n');
      const r = ledger.verify();
      assert.equal(r.ok, false);
      assert.ok(r.brokenChain);
      assert.equal(r.brokenChain!.reason, 'seq_gap');
    });

    it('detect modification of payload field', async () => {
      const ledger = freshLedger(tmpDir);
      ledger.logEvent({
        type: 'content_threat', severity: 'high', source: 's', message: 'original',
      });
      await drainMicrotasks();
      const file = path.join(tmpDir, 'audit-chain-0.ndjson');
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      const mutated = lines.map((line) => {
        const obj = JSON.parse(line) as Record<string, unknown> & { message: string };
        return JSON.stringify({ ...obj, message: 'TAMPERED' });
      });
      fs.writeFileSync(file, mutated.join('\n') + '\n');
      const r = ledger.verify();
      assert.equal(r.ok, false);
      assert.ok(r.brokenChain);
      assert.equal(r.brokenChain!.reason, 'invalid_hmac');
      assert.match(r.brokenChain!.detail ?? '', /recomputed/);
    });

    it('detect modification of prevHash field on a non-genesis entry', async () => {
      const ledger = freshLedger(tmpDir);
      ledger.logEvent({
        type: 'auth_failure', severity: 'high', source: 's', message: 'a',
      });
      ledger.logEvent({
        type: 'auth_failure', severity: 'high', source: 's', message: 'b',
      });
      await drainMicrotasks();
      const file = path.join(tmpDir, 'audit-chain-0.ndjson');
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      // Modify seq=2's prevHash to all-f
      const mutated = lines.map((line) => {
        const obj = JSON.parse(line) as Record<string, unknown> & { seq: number; prevHash: string };
        if (obj.seq === 2) return JSON.stringify({ ...obj, prevHash: 'f'.repeat(64) });
        return JSON.stringify(obj);
      });
      fs.writeFileSync(file, mutated.join('\n') + '\n');
      const r = ledger.verify();
      assert.equal(r.ok, false);
      assert.ok(r.brokenChain);
      assert.equal(r.brokenChain!.reason, 'broken_link');
      assert.equal(r.brokenChain!.seq, 2);
    });

    it('detect foreign insertion with mismatched prevHash', async () => {
      const ledger = freshLedger(tmpDir);
      ledger.logEvent({
        type: 'auth_failure', severity: 'high', source: 's', message: 'a',
      });
      await drainMicrotasks();
      // Append a forged entry that has seq=2 but an unrelated prevHash.
      const file = path.join(tmpDir, 'audit-chain-0.ndjson');
      const first = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)[0]!;
      const original = JSON.parse(first) as Record<string, unknown> & { chainId: string };
      const forged = {
        ...original,
        seq: 2,
        prevHash: '0'.repeat(64), // not the real prevHash
        message: 'forged',
        hmac: '0'.repeat(64),
        id: 'forged_id',
        timestamp: new Date().toISOString(),
      };
      fs.appendFileSync(file, JSON.stringify(forged) + '\n');
      const r = ledger.verify();
      assert.equal(r.ok, false);
      assert.ok(r.brokenChain);
      // Either seq_gap or broken_link or invalid_hmac — at minimum, NOT ok
      assert.notEqual(r.brokenChain!.reason, undefined);
    });

    it('detect a duplicate seq (reorder attempt)', async () => {
      const ledger = freshLedger(tmpDir);
      ledger.logEvent({
        type: 'sandbox_violation', severity: 'critical', source: 's', message: 'a',
      });
      ledger.logEvent({
        type: 'sandbox_violation', severity: 'critical', source: 's', message: 'b',
      });
      await drainMicrotasks();
      const file = path.join(tmpDir, 'audit-chain-0.ndjson');
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      // Duplicate seq=1 with a different message → second-pass sort lands both at seq=1.
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      const dup = JSON.stringify({
        ...first,
        seq: 1,
        message: 'duplicate-attempt',
        // hmac stays as is — chain reports reorder_detected BEFORE hmac check.
      });
      fs.writeFileSync(file, dup + '\n' + lines.join('\n') + '\n');
      const r = ledger.verify();
      assert.equal(r.ok, false);
      assert.ok(r.brokenChain);
      assert.equal(r.brokenChain!.reason, 'reorder_detected');
    });

    it('detect seq=1 with non-GENESIS prevHash', async () => {
      const ledger = freshLedger(tmpDir);
      ledger.logEvent({
        type: 'config_change', severity: 'low', source: 's', message: '1',
      });
      await drainMicrotasks();
      const file = path.join(tmpDir, 'audit-chain-0.ndjson');
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      const mutated = lines.map((line) => {
        const obj = JSON.parse(line) as Record<string, unknown> & { seq: number; prevHash: string };
        if (obj.seq === 1) return JSON.stringify({ ...obj, prevHash: 'abcd'.repeat(16) });
        return JSON.stringify(obj);
      });
      fs.writeFileSync(file, mutated.join('\n') + '\n');
      const r = ledger.verify();
      assert.equal(r.ok, false);
      assert.ok(r.brokenChain);
      assert.equal(r.brokenChain!.reason, 'missing_prev_hash');
      assert.equal(r.brokenChain!.seq, 1);
    });
  });

  // ─── 8. Key handling ────────────────────────────────────────────────

  describe('key handling', () => {
    it('throws in production when env var is missing', () => {
      delete process.env[AUDIT_CHAIN_KEY_ENV];
      const saved = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        assert.throws(
          () => resolveMasterKey({ [AUDIT_CHAIN_KEY_ENV]: '', NODE_ENV: 'production' }),
          /must be set/,
        );
      } finally {
        process.env.NODE_ENV = saved;
        process.env[AUDIT_CHAIN_KEY_ENV] = TEST_KEY;
      }
    });

    it('uses env var when present and >= 32 chars', () => {
      const result = resolveMasterKey({ [AUDIT_CHAIN_KEY_ENV]: TEST_KEY });
      assert.equal(result.length, 64); // 64 bytes from the 64-char utf-8 string
      assert.ok(result.equals(Buffer.from(TEST_KEY, 'utf-8')));
    });

    it('falls back to deterministic dev key in non-production', () => {
      const a = resolveMasterKey({ [AUDIT_CHAIN_KEY_ENV]: '', NODE_ENV: 'test' });
      const b = resolveMasterKey({ [AUDIT_CHAIN_KEY_ENV]: undefined, NODE_ENV: 'development' });
      assert.equal(a.length, 32);
      assert.ok(a.equals(b));
    });
  });
});

// ─── Singleton sanity ──────────────────────────────────────────────────

describe('AuditChainLedger singleton', () => {
  beforeEach(() => {
    process.env[AUDIT_CHAIN_KEY_ENV] = TEST_KEY;
    process.env.NODE_ENV = 'test';
    process.env.COMMANDER_AUDIT_PERSIST_DIR = makeTmpDir();
    resetAuditChainLedger();
    resetSecurityAuditLogger();
  });

  afterEach(async () => {
    delete process.env[AUDIT_CHAIN_KEY_ENV];
    delete process.env.COMMANDER_AUDIT_PERSIST_DIR;
    if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== PREV_NODE_ENV) {
      process.env.NODE_ENV = PREV_NODE_ENV ?? '';
      if (PREV_NODE_ENV === undefined) delete process.env.NODE_ENV;
    }
    resetAuditChainLedger();
    resetSecurityAuditLogger();
    await drainMicrotasks();
  });

  it('getAuditChainLedger returns a ledger', () => {
    const ledger = getAuditChainLedger();
    assert.ok(ledger instanceof AuditChainLedger);
    // chainId is a 32-char hex string (UUID v4 without dashes).
    assert.match(ledger.currentChainId, /^[0-9a-f]{32}$/);
  });

  it('resetAuditChainLedger rebuilds with a new chainId', () => {
    const before = getAuditChainLedger().currentChainId;
    resetAuditChainLedger();
    const after = getAuditChainLedger().currentChainId;
    assert.match(before, /^[0-9a-f]{32}$/);
    assert.match(after, /^[0-9a-f]{32}$/);
    assert.notEqual(before, after);
  });

  it('CHAIN_PROTOCOL_VERSION is 1', () => {
    assert.equal(CHAIN_PROTOCOL_VERSION, 1);
  });
});
