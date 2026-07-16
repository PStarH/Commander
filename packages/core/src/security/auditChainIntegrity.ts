/**
 * auditChainIntegrity — WS9 §6 KC-5 closure layer.
 *
 * The existing {@link AuditChainLedger} provides a per-process HMAC hash chain
 * but the 2026-07-13 enterprise trust audit (KC-5) identified six gaps:
 *
 *   KC-5a. Whole-chain deletion passes `verify()` (no chain registry).
 *   KC-5b. Tail-truncation passes `verify()` (no external anchor on head).
 *   KC-5c. HMAC key co-located with logs (symmetric, app-held).
 *   KC-5d. Async fire-and-forget persistence (fail-open).
 *   KC-5e. `verify()` never called on a timer.
 *   KC-5f. Compliance reports hardcode `tamperProof:true` from a public const.
 *
 * This module closes those gaps WITHOUT rewriting the working ledger (minimal
 * edits per project convention). It adds:
 *
 *   - {@link ChainManifest}: an HMAC-signed registry of chain heads, stored in
 *     a directory SEPARATE from the audit log. Detects whole-chain deletion,
 *     tail-truncation, and foreign (unregistered) chains.
 *   - {@link AsymmetricChainSigner} + {@link KeyProvider}: L2 RSA-PSS signing
 *     of chain heads. In production the private key is injected via Vault/KMS
 *     (not co-located with logs); {@link InMemoryKeyProvider} is CI-only and
 *     self-declares `evidenceLevel=ci-worm-sim` so it can never fill a live/SOC
 *     evidence slot (WS9 §9 honesty rule).
 *   - {@link verifyWithManifest}: combines ledger.verify() with manifest
 *     cross-check and DERIVES `tamperProof` from the live result — never
 *     hardcoded.
 *   - {@link startVerifyTimer}: runs verifyWithManifest on an interval and
 *     alerts on failure (closes KC-5e).
 *   - {@link FailClosedPersistor}: synchronous, throwing persistence — audit
 *     write failure blocks the calling effect (closes KC-5d).
 *
 * Evidence level: this module's unit tests are `ci-worm-sim`. Live WORM/KMS
 * evidence is produced by the WS9 live-fire TAMPER-* cases against real S3
 * Object-Lock + KMS (see spec/ws9-tenant-livefire-compliance.md §6.5).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AuditChainLedger, VerifyResult } from './auditChainLedger';
import { collectPersistedEntries } from './auditChainLedger';

// ============================================================================
// Types
// ============================================================================

/** A chain head snapshot eligible for external anchoring. */
export interface ChainHead {
  chainId: string;
  tenantId?: string;
  maxSeq: number;
  headHmac: string;
}

/** A manifest entry: a chain head plus its L2 asymmetric signature. */
export interface ManifestEntry extends ChainHead {
  /** L2 asymmetric signature over the canonical head (RSA-PSS, base64). */
  kmsSig: string;
  registeredAt: string;
}

export type ManifestGapReason =
  | 'chain_missing_from_log' // manifest knows chain, disk does not (whole-chain deletion)
  | 'tail_truncated' // manifest maxSeq > disk maxSeq (tail-truncation)
  | 'chain_unregistered'; // disk has chain, manifest does not (foreign insertion)

export interface ManifestGap {
  chainId: string;
  tenantId?: string;
  reason: ManifestGapReason;
  detail: string;
}

export interface VerifyWithManifestResult extends VerifyResult {
  /** Derived from the live verify result + manifest cross-check. Never hardcoded. */
  tamperProof: boolean;
  /** Gaps between manifest and on-disk chains. Empty when consistent. */
  manifestGaps: ManifestGap[];
}

// ============================================================================
// KeyProvider — pluggable asymmetric signing (KMS/HSM in prod, in-memory in CI)
// ============================================================================

export interface KeyProvider {
  /** Evidence level of the backing key material. */
  readonly evidenceLevel: 'live' | 'ci-worm-sim';
  /** Sign data with the private key. Returns base64 signature. */
  sign(data: Buffer): string;
  /** Verify a signature against data with the public key. */
  verify(data: Buffer, signature: string): boolean;
  /** Key identifier for audit (e.g. KMS key ARN); never the private key. */
  readonly keyId: string;
}

/**
 * CI-only RSA-PSS key provider. Generated in-process — NOT backed by KMS/HSM.
 * Self-declares `evidenceLevel=ci-worm-sim` so the honesty gate prevents it
 * from filling a live/SOC evidence slot.
 */
export class InMemoryKeyProvider implements KeyProvider {
  readonly evidenceLevel = 'ci-worm-sim' as const;
  readonly keyId: string;
  private readonly publicKey: crypto.KeyObject;
  private readonly privateKey: crypto.KeyObject;

  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 3072,
    });
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.keyId = `in-memory:${crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)}`;
  }

  sign(data: Buffer): string {
    const sig = crypto.sign('sha256', data, {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    });
    return sig.toString('base64');
  }

  verify(data: Buffer, signature: string): boolean {
    try {
      return crypto.verify('sha256', data, {
        key: this.publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      }, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }
}

/**
 * Asymmetric chain-head signer. Wraps a {@link KeyProvider} to produce L2
 * signatures over canonical chain heads. In production, inject a KMS/HSM-backed
 * KeyProvider so the private key never resides on the log host (KC-5c).
 */
export class AsymmetricChainSigner {
  constructor(private readonly keyProvider: KeyProvider) {}

  get evidenceLevel(): 'live' | 'ci-worm-sim' {
    return this.keyProvider.evidenceLevel;
  }

  signHead(head: ChainHead): string {
    return this.keyProvider.sign(Buffer.from(canonicalHead(head), 'utf-8'));
  }

  verifyHead(head: ChainHead, signature: string): boolean {
    return this.keyProvider.verify(Buffer.from(canonicalHead(head), 'utf-8'), signature);
  }
}

// ============================================================================
// ChainManifest — HMAC-signed registry of chain heads (closes KC-5a, KC-5b)
// ============================================================================

const MANIFEST_VERSION = 1;

interface ManifestFile {
  version: number;
  entries: ManifestEntry[];
  /** HMAC-SHA256 over canonical {version, entries}, using the manifest key. */
  hmac: string;
}

export class ChainManifest {
  private entries: Map<string, ManifestEntry> = new Map();
  private readonly manifestDir: string;
  private readonly manifestFile: string;
  private readonly manifestKey: Buffer;
  private readonly signer: AsymmetricChainSigner;
  private dirty: boolean = false;

  constructor(options: {
    manifestDir: string;
    /** Manifest HMAC key. Must be distinct from the audit-chain master key. */
    manifestKey?: string;
    /** Asymmetric signer for L2 head signatures. Defaults to in-memory (CI-only). */
    signer?: AsymmetricChainSigner;
  }) {
    this.manifestDir = options.manifestDir;
    this.manifestFile = path.join(this.manifestDir, 'chain-manifest.json');
    const rawKey = options.manifestKey ?? process.env.COMMANDER_MANIFEST_KEY;
    if (!rawKey) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'COMMANDER_MANIFEST_KEY is required in production (no default manifest HMAC key)',
        );
      }
      // Dev/CI only — never use in production.
      this.manifestKey = crypto
        .createHash('sha256')
        .update('commander-manifest-dev-key-DO-NOT-USE-IN-PROD-v1')
        .digest();
    } else {
      this.manifestKey = crypto.createHash('sha256').update(rawKey).digest();
    }
    this.signer = options.signer ?? new AsymmetricChainSigner(new InMemoryKeyProvider());
    if (fs.existsSync(this.manifestFile)) {
      this.reload();
    }
  }

  /** Register or update a chain head. Signs the head with L2 and marks dirty. */
  registerHead(head: ChainHead): ManifestEntry {
    const kmsSig = this.signer.signHead(head);
    const entry: ManifestEntry = {
      ...head,
      kmsSig,
      registeredAt: new Date().toISOString(),
    };
    this.entries.set(head.chainId, entry);
    this.dirty = true;
    return entry;
  }

  /** All registered entries (read-only snapshot). */
  getEntries(): ManifestEntry[] {
    return [...this.entries.values()];
  }

  /** Verify an entry's L2 signature against a head (detects head tampering). */
  verifyEntry(head: ChainHead): boolean {
    const entry = this.entries.get(head.chainId);
    if (!entry) return false;
    return this.signer.verifyHead(head, entry.kmsSig);
  }

  get evidenceLevel(): 'live' | 'ci-worm-sim' {
    return this.signer.evidenceLevel;
  }

  /** Persist the manifest to disk with an HMAC signature. */
  flush(): void {
    this.ensureDir();
    const file = this.serialize();
    fs.writeFileSync(this.manifestFile, JSON.stringify(file, null, 2), 'utf-8');
    this.dirty = false;
  }

  /** Reload from disk, verifying the HMAC signature. Throws on tamper. */
  reload(): void {
    const raw = fs.readFileSync(this.manifestFile, 'utf-8');
    const parsed = JSON.parse(raw) as ManifestFile;
    if (!this.verifyManifestHmac(parsed)) {
      throw new Error(
        'INTEGRITY_VIOLATION: chain manifest HMAC signature mismatch — tamper detected',
      );
    }
    this.entries = new Map(parsed.entries.map((e) => [e.chainId, e]));
    this.dirty = false;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  // ── internal ─────────────────────────────────────────────────────────

  private serialize(): ManifestFile {
    const entries = this.getEntries();
    const hmac = computeManifestHmac(this.manifestKey, { version: MANIFEST_VERSION, entries });
    return { version: MANIFEST_VERSION, entries, hmac };
  }

  private verifyManifestHmac(file: ManifestFile): boolean {
    const expected = computeManifestHmac(this.manifestKey, {
      version: file.version,
      entries: file.entries,
    });
    if (expected.length !== file.hmac.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(file.hmac, 'hex'));
    } catch {
      return false;
    }
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.manifestDir)) {
      fs.mkdirSync(this.manifestDir, { recursive: true });
    }
  }
}

// ============================================================================
// verifyWithManifest — cross-check ledger + manifest, derive tamperProof
// ============================================================================

/**
 * Run the ledger's chain verify AND cross-check the manifest against on-disk
 * chains. `tamperProof` is TRUE only when both pass — derived, never hardcoded.
 */
export function verifyWithManifest(
  ledger: AuditChainLedger,
  manifest: ChainManifest,
): VerifyWithManifestResult {
  const base = ledger.verify();
  const gaps = crossCheckManifest(ledger, manifest);
  const ok = base.ok && gaps.length === 0;
  return {
    ...base,
    ok,
    tamperProof: ok,
    manifestGaps: gaps,
  };
}

/** Compute gaps between the manifest registry and on-disk chains. */
function crossCheckManifest(
  ledger: AuditChainLedger,
  manifest: ChainManifest,
): ManifestGap[] {
  const gaps: ManifestGap[] = [];
  const disk = collectPersistedEntries(ledger.persistDirectory);

  // maxSeq per chainId on disk.
  const diskByChain = new Map<string, { maxSeq: number; tenantId?: string }>();
  for (const e of disk) {
    const cur = diskByChain.get(e.chainId);
    if (!cur || e.seq > cur.maxSeq) {
      diskByChain.set(e.chainId, { maxSeq: e.seq, tenantId: e.tenantId });
    }
  }

  // Manifest entries: each must exist on disk with maxSeq >= manifest maxSeq.
  for (const m of manifest.getEntries()) {
    const onDisk = diskByChain.get(m.chainId);
    if (!onDisk) {
      gaps.push({
        chainId: m.chainId,
        tenantId: m.tenantId,
        reason: 'chain_missing_from_log',
        detail: `manifest has chain ${m.chainId} (maxSeq=${m.maxSeq}) but no entries exist on disk`,
      });
    } else if (onDisk.maxSeq < m.maxSeq) {
      gaps.push({
        chainId: m.chainId,
        tenantId: m.tenantId,
        reason: 'tail_truncated',
        detail: `manifest maxSeq=${m.maxSeq} but disk maxSeq=${onDisk.maxSeq} — tail truncated`,
      });
    }
  }

  // Disk chains: each must be registered in the manifest (foreign detection).
  for (const [chainId, onDisk] of diskByChain) {
    if (!manifest.getEntries().some((m) => m.chainId === chainId)) {
      gaps.push({
        chainId,
        tenantId: onDisk.tenantId,
        reason: 'chain_unregistered',
        detail: `chain ${chainId} on disk but not registered in manifest (foreign insertion)`,
      });
    }
  }

  return gaps;
}

// ============================================================================
// startVerifyTimer — periodic verify + alert (closes KC-5e)
// ============================================================================

export interface VerifyTimerOptions {
  intervalMs?: number;
  /** Called when verification fails. Use a sanitized SLA channel (WS9 §6.4). */
  onFailure?: (result: VerifyWithManifestResult) => void;
  /** Called when verification passes (optional, for metrics). */
  onSuccess?: (result: VerifyWithManifestResult) => void;
}

/**
 * Run {@link verifyWithManifest} on an interval. Returns a stop function.
 * On failure, invokes onFailure (alert). Never marks tamperProof:true on a
 * failing result — the result object carries tamperProof=false.
 */
export function startVerifyTimer(
  ledger: AuditChainLedger,
  manifest: ChainManifest,
  options: VerifyTimerOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    try {
      const result = verifyWithManifest(ledger, manifest);
      if (result.ok) {
        options.onSuccess?.(result);
      } else {
        options.onFailure?.(result);
      }
    } catch (err) {
      // Verifier crash is itself a tamper signal.
      options.onFailure?.({
        ok: false,
        tamperProof: false,
        manifestGaps: [],
        totalEntries: 0,
        chainsInspected: 0,
        brokenChain: {
          chainId: 'unknown',
          seq: 0,
          reason: 'invalid_hmac',
          detail: `verifier threw: ${(err as Error)?.message ?? String(err)}`,
        },
      });
    }
  }, intervalMs);
  // Don't keep the Node process alive solely for the verify timer.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

// ============================================================================
// FailClosedPersistor — synchronous, throwing persistence (closes KC-5d)
// ============================================================================

export interface PersistResult {
  id: string;
  bytesWritten: number;
}

/**
 * Synchronous, fail-closed audit persistence. Unlike the ledger's
 * fire-and-forget async queue, this throws on write failure so the calling
 * effect is blocked (KC-5d "async fail-open" remediation).
 */
export class FailClosedPersistor {
  private readonly persistDir: string;
  private readonly file: string;
  private currentSize: number = 0;
  private readonly maxFileSize: number;

  constructor(options: { persistDir: string; maxFileSize?: number; fileName?: string }) {
    this.persistDir = options.persistDir;
    this.file = path.join(this.persistDir, options.fileName ?? 'audit-events.ndjson');
    this.maxFileSize = options.maxFileSize ?? 50 * 1024 * 1024;
  }

  /** Append a line. Throws AUDIT_PERSIST_FAILED on any write error. */
  async append(event: { id: string; line: string }): Promise<PersistResult> {
    const line = event.line.endsWith('\n') ? event.line : event.line + '\n';
    const buf = Buffer.from(line, 'utf-8');
    try {
      this.ensureDir();
      fs.appendFileSync(this.file, buf);
      this.currentSize += buf.length;
      return { id: event.id, bytesWritten: buf.length };
    } catch (err) {
      throw new Error(
        `AUDIT_PERSIST_FAILED (fail-closed): ${this.file} — ${(err as Error)?.message ?? String(err)}. ` +
          'Effect blocked because audit write could not be durably persisted.',
      );
    }
  }

  /** Synchronous variant for call sites that cannot await. */
  appendSync(event: { id: string; line: string }): PersistResult {
    const line = event.line.endsWith('\n') ? event.line : event.line + '\n';
    const buf = Buffer.from(line, 'utf-8');
    try {
      this.ensureDir();
      fs.appendFileSync(this.file, buf);
      this.currentSize += buf.length;
      return { id: event.id, bytesWritten: buf.length };
    } catch (err) {
      throw new Error(
        `AUDIT_PERSIST_FAILED (fail-closed): ${this.file} — ${(err as Error)?.message ?? String(err)}.`,
      );
    }
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.persistDir)) {
      fs.mkdirSync(this.persistDir, { recursive: true });
    }
  }
}

// ============================================================================
// Canonical serialization for chain heads
// ============================================================================

function canonicalHead(head: ChainHead): string {
  return JSON.stringify({
    chainId: head.chainId,
    tenantId: head.tenantId ?? null,
    maxSeq: head.maxSeq,
    headHmac: head.headHmac,
  }, Object.keys({
    chainId: 0,
    tenantId: 0,
    maxSeq: 0,
    headHmac: 0,
  }).sort());
}

/**
 * Compute HMAC-SHA256 over the canonical form of a manifest payload.
 * Canonical = JSON with sorted keys at every level so re-parsed JSON from
 * disk produces the same HMAC regardless of property insertion order.
 *
 * NOTE: We cannot use JSON.stringify(obj, arrayOfKeys) as a replacer because
 * the array acts as a property whitelist at ALL nesting levels — it would
 * strip fields from nested entry objects. Instead we recursively canonicalize.
 */
function computeManifestHmac(
  key: Buffer,
  payload: { version: number; entries: ManifestEntry[] },
): string {
  const canonicalEntries = payload.entries.map((e) =>
    canonicalEntry(e),
  );
  // Build canonical string with sorted top-level keys.
  const parts: string[] = [];
  parts.push('"entries":' + '[' + canonicalEntries.join(',') + ']');
  parts.push('"version":' + JSON.stringify(payload.version));
  const canonical = '{' + parts.sort().join(',') + '}';
  return crypto.createHmac('sha256', key).update(canonical).digest('hex');
}

/** Canonical (sorted-key, stable) JSON for a single manifest entry. */
function canonicalEntry(e: ManifestEntry): string {
  const fields: Record<string, unknown> = {
    chainId: e.chainId,
    tenantId: e.tenantId ?? null,
    maxSeq: e.maxSeq,
    headHmac: e.headHmac,
    kmsSig: e.kmsSig,
    registeredAt: e.registeredAt,
  };
  const parts: string[] = [];
  for (const k of Object.keys(fields).sort()) {
    parts.push(JSON.stringify(k) + ':' + JSON.stringify(fields[k]));
  }
  return '{' + parts.join(',') + '}';
}
