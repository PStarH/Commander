/**
 * auditChainIntegrity.test.ts — WS9 §6 KC-5 closure tests.
 *
 * Closes trust-audit KC-5 gaps that the existing AuditChainLedger does not cover:
 *   1. Whole-chain deletion passes verify()      → ChainManifest detects missing chains
 *   2. Tail-truncation passes verify()            → manifest maxSeq > disk maxSeq detected
 *   3. HMAC key co-located with logs              → L2 asymmetric anchoring (key injectable)
 *   4. Async fail-open persistence                 → FailClosedPersistor blocks effect on write error
 *   5. verify() never called                       → startVerifyTimer() runs on interval + alerts
 *   6. compliance reports hardcode tamperProof      → verifyResult.tamperProof derived from live verify
 *
 * Evidence level: these are unit tests on the integrity layer (ci-worm-sim for the
 * asymmetric signer which uses an in-memory keypair). Live WORM/KMS evidence is
 * produced by the WS9 live-fire TAMPER-* cases against real S3 Object-Lock / KMS.
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'os';

import {
  AuditChainLedger,
  computeEntryHmac,
  deriveTenantKey,
} from '../../src/security/auditChainLedger';
import {
  ChainManifest,
  AsymmetricChainSigner,
  InMemoryKeyProvider,
  verifyWithManifest,
  startVerifyTimer,
  FailClosedPersistor,
  type KeyProvider,
} from '../../src/security/auditChainIntegrity';

const TEST_KEY = 'x'.repeat(64);

let tmpCounter = 0;
function makeTmp(): { dir: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `ws9-integrity-${process.pid}-${Date.now()}-${++tmpCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

function freshLedger(dir: string): AuditChainLedger {
  return new AuditChainLedger({ persistDir: dir, masterKey: Buffer.from(TEST_KEY, 'utf-8') });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('ChainManifest', () => {
  let env: { dir: string; cleanup: () => void };

  beforeEach(() => { env = makeTmp(); });
  afterEach(() => env.cleanup());

  it('registers a chain head and detects whole-chain deletion', async () => {
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'a' });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'b' });
    await drain();

    const entries = ledger.getEntries();
    const head = entries[entries.length - 1]!;
    manifest.registerHead({ chainId: ledger.chainId, tenantId: undefined, maxSeq: head.seq, headHmac: head.hmac });

    // Whole-chain deletion: remove the audit-chain files but leave manifest.
    for (const f of fs.readdirSync(env.dir).filter((f) => f.startsWith('audit-chain-'))) {
      fs.unlinkSync(path.join(env.dir, f));
    }

    const res = verifyWithManifest(ledger, manifest);
    assert.equal(res.ok, false);
    assert.equal(res.manifestGaps.length, 1);
    assert.equal(res.manifestGaps[0]!.chainId, ledger.chainId);
    assert.equal(res.manifestGaps[0]!.reason, 'chain_missing_from_log');
  });

  it('detects tail-truncation (manifest maxSeq > disk maxSeq)', async () => {
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'a' });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'b' });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'c' });
    await drain();

    const entries = ledger.getEntries();
    const head = entries[entries.length - 1]!;
    manifest.registerHead({ chainId: ledger.chainId, tenantId: undefined, maxSeq: head.seq, headHmac: head.hmac });

    // Truncate: rewrite the chain file keeping only seq=1 (drop 2 and 3).
    const chainFile = path.join(env.dir, 'audit-chain-0.ndjson');
    const lines = fs.readFileSync(chainFile, 'utf-8').trim().split('\n');
    fs.writeFileSync(chainFile, lines[0]! + '\n');

    const res = verifyWithManifest(ledger, manifest);
    assert.equal(res.ok, false);
    const gap = res.manifestGaps.find((g) => g.reason === 'tail_truncated');
    assert.ok(gap, 'expected tail_truncated gap');
    assert.equal(gap!.chainId, ledger.chainId);
  });

  it('is itself HMAC-signed and rejects a tampered manifest', async () => {
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    manifest.registerHead({ chainId: 'c1', tenantId: 't1', maxSeq: 5, headHmac: 'abc'.repeat(22) });
    manifest.flush();

    const file = path.join(env.dir, 'manifest', 'chain-manifest.json');
    const tampered = JSON.parse(fs.readFileSync(file, 'utf-8'));
    tampered.entries[0].maxSeq = 999;
    fs.writeFileSync(file, JSON.stringify(tampered));

    assert.throws(() => manifest.reload(), /INTEGRITY_VIOLATION|tamper|signature/i);
  });

  it('detects a foreign chain in the log not present in the manifest', async () => {
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'a' });
    await drain();

    // Manifest empty — chain on disk is foreign (unregistered).
    const res = verifyWithManifest(ledger, manifest);
    assert.equal(res.ok, false);
    assert.ok(res.manifestGaps.some((g) => g.reason === 'chain_unregistered'));
  });
});

describe('AsymmetricChainSigner', () => {
  let env: { dir: string; cleanup: () => void };
  beforeEach(() => { env = makeTmp(); });
  afterEach(() => env.cleanup());

  it('signs and verifies a chain head with an injected keypair', () => {
    const kp = new InMemoryKeyProvider();
    const signer = new AsymmetricChainSigner(kp);
    const head = { chainId: 'c1', tenantId: 't1', maxSeq: 42, headHmac: 'deadbeef'.repeat(8) };
    const sig = signer.signHead(head);
    assert.equal(signer.verifyHead(head, sig), true);
  });

  it('rejects a head modified after signing', () => {
    const kp = new InMemoryKeyProvider();
    const signer = new AsymmetricChainSigner(kp);
    const head = { chainId: 'c1', tenantId: 't1', maxSeq: 42, headHmac: 'deadbeef'.repeat(8) };
    const sig = signer.signHead(head);
    const tampered = { ...head, maxSeq: 999 };
    assert.equal(signer.verifyHead(tampered, sig), false);
  });

  it('reports evidenceLevel=ci-worm-sim for in-memory keys (not live/SOC)', () => {
    const kp = new InMemoryKeyProvider();
    assert.equal(kp.evidenceLevel, 'ci-worm-sim');
  });
});

describe('verifyWithManifest + tamperProof derivation', () => {
  let env: { dir: string; cleanup: () => void };
  beforeEach(() => { env = makeTmp(); });
  afterEach(() => env.cleanup());

  it('tamperProof is derived from live verify, never hardcoded true', async () => {
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'a' });
    await drain();
    const head = ledger.getEntries()[ledger.getEntries().length - 1]!;
    manifest.registerHead({ chainId: ledger.chainId, tenantId: undefined, maxSeq: head.seq, headHmac: head.hmac });

    const ok = verifyWithManifest(ledger, manifest);
    assert.equal(ok.tamperProof, true);

    // Tamper: modify a persisted entry.
    const chainFile = path.join(env.dir, 'audit-chain-0.ndjson');
    const lines = fs.readFileSync(chainFile, 'utf-8').trim().split('\n');
    const tamperedEntry = JSON.parse(lines[0]!);
    tamperedEntry.message = 'CHANGED';
    fs.writeFileSync(chainFile, JSON.stringify(tamperedEntry) + '\n');

    const bad = verifyWithManifest(ledger, manifest);
    assert.equal(bad.tamperProof, false);
  });

  it('detects unregistered tail append (disk maxSeq > manifest maxSeq)', async () => {
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'a' });
    await drain();
    const head = ledger.getEntries()[ledger.getEntries().length - 1]!;
    manifest.registerHead({
      chainId: ledger.chainId,
      tenantId: undefined,
      maxSeq: head.seq,
      headHmac: head.hmac,
    });

    // Attacker appends a valid-looking entry without updating the manifest anchor.
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'b' });
    await drain();

    const res = verifyWithManifest(ledger, manifest);
    assert.equal(res.ok, false);
    assert.equal(res.tamperProof, false);
    assert.ok(
      res.manifestGaps.some((g) => g.reason === 'disk_ahead_of_manifest'),
      `expected disk_ahead_of_manifest, got ${JSON.stringify(res.manifestGaps)}`,
    );
  });

  it('detects same-seq content rewrite even when chain HMAC is re-signed', async () => {
    // Attacker with COMMANDER_AUDIT_CHAIN_KEY can recompute a valid entry HMAC so
    // ledger.verify() alone may pass. Manifest headHmac + L2 must still fail closed.
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'original' });
    await drain();
    const head = ledger.getEntries()[ledger.getEntries().length - 1]!;
    manifest.registerHead({
      chainId: ledger.chainId,
      tenantId: undefined,
      maxSeq: head.seq,
      headHmac: head.hmac,
    });

    const chainFile = path.join(env.dir, 'audit-chain-0.ndjson');
    const entry = JSON.parse(fs.readFileSync(chainFile, 'utf-8').trim());
    const { hmac: _old, ...partial } = entry;
    partial.message = 'FORGED';
    const tenantKey = deriveTenantKey(Buffer.from(TEST_KEY, 'utf-8'), entry.tenantId);
    entry.message = 'FORGED';
    entry.hmac = computeEntryHmac(tenantKey, partial);
    fs.writeFileSync(chainFile, JSON.stringify(entry) + '\n');

    // Chain HMAC verifies (key-holder forgery); manifest cross-check must not.
    assert.equal(ledger.verify().ok, true);
    const res = verifyWithManifest(ledger, manifest);
    assert.equal(res.ok, false);
    assert.equal(res.tamperProof, false);
    assert.ok(
      res.manifestGaps.some((g) => g.reason === 'head_hmac_mismatch'),
      `expected head_hmac_mismatch, got ${JSON.stringify(res.manifestGaps)}`,
    );
  });

  it('detects kms_sig_invalid when L2 signature is corrupted but headHmac still matches', async () => {
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'a' });
    await drain();
    const head = ledger.getEntries()[ledger.getEntries().length - 1]!;
    manifest.registerHead({
      chainId: ledger.chainId,
      tenantId: undefined,
      maxSeq: head.seq,
      headHmac: head.hmac,
    });

    // Corrupt L2 sig while leaving headHmac aligned with disk — isolates kms_sig_invalid.
    const entry = manifest.getEntries()[0]!;
    (entry as { kmsSig: string }).kmsSig = Buffer.alloc(384, 0xab).toString('base64');

    const res = verifyWithManifest(ledger, manifest);
    assert.equal(res.ok, false);
    assert.equal(res.tamperProof, false);
    assert.ok(
      res.manifestGaps.some((g) => g.reason === 'kms_sig_invalid'),
      `expected kms_sig_invalid, got ${JSON.stringify(res.manifestGaps)}`,
    );
  });
});

describe('startVerifyTimer', () => {
  let env: { dir: string; cleanup: () => void };
  beforeEach(() => { env = makeTmp(); });
  afterEach(() => env.cleanup());

  it('invokes the alert callback when verification fails', async () => {
    const ledger = freshLedger(env.dir);
    const manifest = new ChainManifest({ manifestDir: path.join(env.dir, 'manifest') });
    ledger.logEvent({ type: 'content_threat', severity: 'high', source: 't', message: 'a' });
    await drain();
    const head = ledger.getEntries()[ledger.getEntries().length - 1]!;
    manifest.registerHead({ chainId: ledger.chainId, tenantId: undefined, maxSeq: head.seq, headHmac: head.hmac });

    // Tamper so verify will fail.
    const chainFile = path.join(env.dir, 'audit-chain-0.ndjson');
    fs.writeFileSync(chainFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(chainFile, 'utf-8').trim()), message: 'X' }) + '\n');

    let alerted = false;
    const stop = startVerifyTimer(ledger, manifest, {
      intervalMs: 10,
      onFailure: () => { alerted = true; },
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    assert.equal(alerted, true);
  });
});

describe('FailClosedPersistor', () => {
  it('throws on write failure in fail-closed mode (does not swallow)', async () => {
    const persistor = new FailClosedPersistor({
      persistDir: '/this/path/does/not/exist/and/cannot/be/created/xyz',
    });
    await assert.rejects(
      () => persistor.append({ id: 'x', line: '{"seq":1}' }),
      /AUDIT_PERSIST_FAILED|fail-closed/i,
    );
  });

  it('appends successfully when the directory is writable', async () => {
    const env = makeTmp();
    try {
      const persistor = new FailClosedPersistor({ persistDir: env.dir });
      await persistor.append({ id: 'x', line: '{"seq":1}\n' });
      const content = fs.readFileSync(path.join(env.dir, 'audit-events.ndjson'), 'utf-8');
      assert.ok(content.includes('"seq":1'));
    } finally {
      env.cleanup();
    }
  });
});
