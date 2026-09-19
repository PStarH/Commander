import { createHash, randomUUID } from 'node:crypto';
import { verifyEvidenceSignature, type EvidenceJwks } from './evidenceSigner.js';
import type { CapabilityGrant } from './index.js';

export const EVIDENCE_BUNDLE_SCHEMA = 'l3-11.v0' as const;
export const EVIDENCE_BODY_VERSION = 'commander.evidence-body/v1' as const;
export const EVIDENCE_GENESIS_HASH = '0'.repeat(64);

export type EvidenceTerminalDisposition = 'SUCCEEDED' | 'FAILED' | 'ESCALATED';

export interface EvidenceSignature {
  algorithm: 'Ed25519';
  keyId: string;
  signedAt: string;
  value: string;
}

export interface EvidenceSigner {
  sign(canonicalBody: string): Promise<EvidenceSignature>;
  verify(canonicalBody: string, signature: EvidenceSignature): boolean;
}

/** Keys stripped by default — CoT / raw LLM / OTel gen_ai prompt fields (DLP). */
export const EVIDENCE_DLP_EXCLUDED_KEYS = new Set([
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.tool.call.arguments',
  'prompt',
  'messages',
  'chainofthought',
  'chain_of_thought',
  'reasoning',
  'thinking',
  'completion',
  'rawprompt',
  'rawcompletion',
]);

/** Response summary is fail-closed: only non-sensitive metadata keys. */
export const EVIDENCE_RESPONSE_SUMMARY_KEYS = new Set([
  'contenthash',
  'status',
  'httpstatus',
  'bytes',
  'contenttype',
  'errorcode',
  'ok',
]);

/**
 * Field-name secrets always redacted in exported payloads.
 * Substring match on normalized keys (aligns with shadow scrubber) so
 * refresh_token / client_secret / access_token are not fail-open.
 */
const EVIDENCE_SECRET_FIELD_NAME =
  /password|passwd|passcode|secret|token|authorization|credential|privatekey|accesskey|apikey|otp|cookie|xapikey|xauthtoken/i;

const EVIDENCE_SECRET_VALUE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i;

function isSecretValue(value: unknown): boolean {
  return typeof value === 'string' && EVIDENCE_SECRET_VALUE.test(value);
}

export interface EvidenceBundleScope {
  tenantId: string;
  runId: string;
  effectId?: string;
}

export interface EvidenceBundleIdentity {
  intentHash?: string;
  workGraphHash?: string;
  capabilityGrant?: {
    jti: string;
    issuer?: string;
    audience?: string;
    requestHash?: string;
    policySnapshotId?: string;
  };
}

export interface EvidenceBundleVersions {
  policySnapshotId: string;
  workGraphVersion?: string;
  kernelApiVersion?: string;
}

export interface EvidenceBundleEffectEntry {
  effectId: string;
  stepId: string;
  type: string;
  state: string;
  policyDecisionId: string;
  requestHash: string;
  approvalInteractionId?: string;
  responseSummary?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
  entryHash: string;
  prevEntryHash: string;
}

export interface EvidenceBundleAuditEntry {
  type: string;
  at: string;
  severity: string;
  stepId?: string;
  details: Record<string, unknown>;
  entryHash: string;
  prevEntryHash: string;
}

export interface EvidenceBundle {
  schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA;
  bodyVersion: typeof EVIDENCE_BODY_VERSION;
  bundleId: string;
  exportedAt: string;
  actionDigest: string;
  terminalDisposition: EvidenceTerminalDisposition;
  scope: EvidenceBundleScope;
  identity: EvidenceBundleIdentity;
  versions: EvidenceBundleVersions;
  effects: EvidenceBundleEffectEntry[];
  auditEvents: EvidenceBundleAuditEntry[];
  contentHash: string;
  signature?: EvidenceSignature;
}

export interface EvidenceEffectSource {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  type: string;
  state: string;
  policyDecisionId: string;
  requestHash: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
  approvalInteractionId?: string;
}

export interface EvidenceAuditSource {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  tenantId: string;
  runId: string;
  stepId: string;
  at: string;
  details: Record<string, unknown>;
}

export interface BuildEvidenceBundleInput {
  tenantId: string;
  runId: string;
  actionDigest?: string;
  effectId?: string;
  intentHash?: string;
  workGraphHash?: string;
  workGraphVersion?: string;
  policySnapshotId: string;
  kernelApiVersion?: string;
  capabilityGrant?: CapabilityGrant;
  effects: EvidenceEffectSource[];
  auditEvents?: EvidenceAuditSource[];
  exportedAt?: string;
  bundleId?: string;
}

export interface VerifyEvidenceBundleResult {
  ok: boolean;
  reason?: string;
  brokenAt?: 'effects' | 'auditEvents' | 'contentHash' | 'dlp' | 'signature';
  index?: number;
}

export interface VerifyEvidenceBundleOptions {
  /**
   * Injected verifier for `bundle.signature`. Key material stays at the call site —
   * this module never holds keys.
   */
  verifySignature?: (canonicalBody: string, signature: EvidenceSignature) => boolean;
  /** Public keys for the built-in Ed25519 verifier (alternative to `verifySignature`). */
  jwks?: EvidenceJwks;
  /**
   * Require a cryptographically verified signature. Defaults to `true` as soon as a
   * verifier is supplied; passing `true` without a verifier fails closed.
   */
  requireSignature?: boolean;
}

export function canonicalEvidenceJson(value: unknown): string {
  // EB-01: `JSON.stringify(undefined)` returns `undefined`, so the old
  // implementation returned a non-string despite declaring `string` — and
  // `canonicalEvidenceJson(undefined) === canonicalEvidenceJson(undefined)`
  // made an unsigned evidence record look signed. Render an absent value as the
  // JSON literal `null` and keep the declared `string` return honest.
  if (value === undefined) return 'null';
  // Hash the persisted JSON representation, retaining the existing lexicographic key order.
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('EVIDENCE_JSON_VALUE_REQUIRED');
  const canonical = (input: unknown): string => {
    if (input === undefined) return 'null';
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    const obj = input as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
      .join(',')}}`;
  };
  return canonical(JSON.parse(serialized));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalEvidenceJson(value)).digest('hex');
}

/** Drop undefined so hashes match JSON.parse(JSON.stringify(...)) round-trips. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out as T;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function isDlpExcludedKey(key: string): boolean {
  const normalized = normalizeKey(key);
  for (const excluded of EVIDENCE_DLP_EXCLUDED_KEYS) {
    if (normalizeKey(excluded) === normalized) return true;
  }
  return false;
}

function isSecretFieldKey(key: string): boolean {
  return EVIDENCE_SECRET_FIELD_NAME.test(normalizeKey(key));
}

/**
 * EB-07: the only field-name-based DLP heuristic that must not see the
 * attacker-influenced-but-signer-produced signature blob. `signature.value` is
 * Ed25519 output (base64url of random-looking bytes), so the `sk_…`/`AKIA…`
 * value patterns match it by chance — a real signature would be reported as a
 * DLP leak and the effect parked as COMPLETION_UNKNOWN. The verifier, not a
 * substring scan, decides whether a signature is authentic.
 */
function isSignatureArtifactKey(path: string): boolean {
  return path === 'signature.value';
}

function isAllowedResponseSummaryKey(key: string): boolean {
  return EVIDENCE_RESPONSE_SUMMARY_KEYS.has(normalizeKey(key));
}

/** responseSummary values are metadata scalars only — nested objects are a DLP bypass. */
function isResponseSummaryScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** Recursively remove DLP keys and secret field names; does not mutate input. */
export function sanitizeForEvidence(value: unknown): unknown {
  if (isSecretValue(value)) return '[REDACTED]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeForEvidence);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isDlpExcludedKey(key) || isSecretFieldKey(key)) continue;
    result[key] = sanitizeForEvidence(child);
  }
  return result;
}

export function findDlpViolation(value: unknown, path = ''): string | undefined {
  if (isSignatureArtifactKey(path)) return undefined;
  if (isSecretValue(value)) return path || '(value)';
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findDlpViolation(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (isDlpExcludedKey(key) || isSecretFieldKey(key)) return next;
    const hit = findDlpViolation(child, next);
    if (hit) return hit;
  }
  return undefined;
}

function summarizeResponse(
  response?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!response) return undefined;
  const sanitized = sanitizeForEvidence(response) as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(sanitized)) {
    if (!isAllowedResponseSummaryKey(key)) continue;
    if (!isResponseSummaryScalar(child)) continue;
    if (child === '[REDACTED]') continue;
    summary[key] = child;
  }
  if (Object.keys(summary).length === 0) return undefined;
  return summary;
}

function capabilityGrantRef(
  grant: CapabilityGrant | undefined,
  tenantId: string,
  runId: string,
): EvidenceBundleIdentity['capabilityGrant'] {
  if (!grant) return undefined;
  // Fail-closed: never bind another tenant/run's grant into this package.
  if (grant.tenantId !== tenantId || grant.runId !== runId) return undefined;
  return compact({
    jti: grant.jti,
    issuer: grant.issuer,
    audience: grant.audience,
    requestHash: grant.requestHash,
    policySnapshotId: grant.policySnapshotId,
  });
}

function scopeEffects(input: BuildEvidenceBundleInput): EvidenceEffectSource[] {
  return input.effects.filter((e) => e.tenantId === input.tenantId && e.runId === input.runId);
}

function scopeAuditEvents(input: BuildEvidenceBundleInput): EvidenceAuditSource[] {
  return (input.auditEvents ?? []).filter(
    (e) => e.tenantId === input.tenantId && e.runId === input.runId,
  );
}

function hashChainedEntries<T extends { entryHash: string; prevEntryHash: string }>(
  items: Array<Omit<T, 'entryHash' | 'prevEntryHash'>>,
): T[] {
  let prev = EVIDENCE_GENESIS_HASH;
  return items.map((item) => {
    const body = { ...item, prevEntryHash: prev };
    const entryHash = sha256(body);
    const entry = { ...body, entryHash } as T;
    prev = entryHash;
    return entry;
  });
}

function buildEffectEntries(effects: EvidenceEffectSource[]): EvidenceBundleEffectEntry[] {
  const sorted = [...effects].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const bare = sorted.map((effect) =>
    compact({
      effectId: effect.id,
      stepId: effect.stepId,
      type: effect.type,
      state: effect.state,
      policyDecisionId: effect.policyDecisionId,
      requestHash: effect.requestHash,
      approvalInteractionId: effect.approvalInteractionId,
      responseSummary: summarizeResponse(effect.response),
      createdAt: effect.createdAt,
      completedAt: effect.completedAt,
    }),
  );
  return hashChainedEntries<EvidenceBundleEffectEntry>(bare);
}

function buildAuditEntries(events: EvidenceAuditSource[]): EvidenceBundleAuditEntry[] {
  const sorted = [...events].sort(
    (a, b) => a.at.localeCompare(b.at) || a.type.localeCompare(b.type),
  );
  const bare = sorted.map((event) =>
    compact({
      type: event.type,
      at: event.at,
      severity: event.severity,
      stepId: event.stepId,
      details: sanitizeForEvidence(event.details) as Record<string, unknown>,
    }),
  );
  return hashChainedEntries<EvidenceBundleAuditEntry>(bare);
}

function attachContentHash(body: Omit<EvidenceBundle, 'contentHash'>): EvidenceBundle {
  const contentHash = sha256(body);
  return { ...body, contentHash };
}

function terminalDisposition(
  effects: EvidenceEffectSource[],
  auditEvents: EvidenceAuditSource[],
): EvidenceTerminalDisposition {
  const terminalStates = new Set(['COMPLETED', 'FAILED', 'CONFIRMED_NOT_APPLIED']);
  const unresolved = effects.some((effect) => !terminalStates.has(effect.state));
  const escalated = auditEvents.some((event) => event.type === 'effect.reconcile_escalated');
  if (unresolved && escalated) return 'ESCALATED';
  if (
    effects.some((effect) => effect.state === 'FAILED' || effect.state === 'CONFIRMED_NOT_APPLIED')
  ) {
    return 'FAILED';
  }
  return 'SUCCEEDED';
}

export function buildRunEvidenceBundle(input: BuildEvidenceBundleInput): EvidenceBundle {
  const effects = scopeEffects(input);
  const auditEvents = scopeAuditEvents(input);
  const body: Omit<EvidenceBundle, 'contentHash'> = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA,
    bodyVersion: EVIDENCE_BODY_VERSION,
    bundleId: input.bundleId ?? randomUUID(),
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    actionDigest:
      input.actionDigest ??
      sha256({
        tenantId: input.tenantId,
        runId: input.runId,
        effectRequestHashes: effects.map((effect) => effect.requestHash).sort(),
      }),
    terminalDisposition: terminalDisposition(effects, auditEvents),
    scope: compact({ tenantId: input.tenantId, runId: input.runId, effectId: input.effectId }),
    identity: compact({
      intentHash: input.intentHash,
      workGraphHash: input.workGraphHash,
      capabilityGrant: capabilityGrantRef(input.capabilityGrant, input.tenantId, input.runId),
    }),
    versions: compact({
      policySnapshotId: input.policySnapshotId,
      workGraphVersion: input.workGraphVersion,
      kernelApiVersion: input.kernelApiVersion,
    }),
    effects: buildEffectEntries(effects),
    auditEvents: buildAuditEntries(auditEvents),
  };
  return attachContentHash(body);
}

export function canonicalEvidenceBody(bundle: EvidenceBundle): string {
  const { signature: _signature, ...body } = bundle;
  return canonicalEvidenceJson(body);
}

export function assertTerminalEvidence(bundle: EvidenceBundle): void {
  const terminalStates = new Set(['COMPLETED', 'FAILED', 'CONFIRMED_NOT_APPLIED']);
  const unresolved = bundle.effects.filter((effect) => !terminalStates.has(effect.state));
  const hasEscalation = bundle.auditEvents.some(
    (event) => event.type === 'effect.reconcile_escalated',
  );
  if (
    unresolved.length > 0 &&
    (!unresolved.every((effect) => effect.state === 'COMPLETION_UNKNOWN') ||
      !hasEscalation ||
      bundle.terminalDisposition !== 'ESCALATED')
  ) {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED');
  }
  if (unresolved.length === 0 && bundle.terminalDisposition === 'ESCALATED') {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED');
  }
  const expected = bundle.effects.some(
    (effect) => effect.state === 'FAILED' || effect.state === 'CONFIRMED_NOT_APPLIED',
  )
    ? 'FAILED'
    : 'SUCCEEDED';
  if (unresolved.length === 0 && bundle.terminalDisposition !== expected) {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED');
  }
  if (!/^[a-f0-9]{64}$/.test(bundle.actionDigest)) {
    throw new Error('TERMINAL_EVIDENCE_REQUIRED: ACTION_DIGEST_INVALID');
  }
}

export function buildEffectEvidenceBundle(
  input: BuildEvidenceBundleInput & { effectId: string },
): EvidenceBundle {
  const match = input.effects.filter((e) => e.id === input.effectId);
  // Only keep audit rows explicitly bound to this effectId (fail-closed scope).
  const audit = (input.auditEvents ?? []).filter((e) => e.details.effectId === input.effectId);
  return buildRunEvidenceBundle({
    ...input,
    effects: match,
    auditEvents: audit,
    effectId: input.effectId,
  });
}

function recomputeEffectEntry(entry: EvidenceBundleEffectEntry): string {
  const { entryHash: _e, ...body } = entry;
  return sha256(body);
}

function recomputeAuditEntry(entry: EvidenceBundleAuditEntry): string {
  const { entryHash: _e, ...body } = entry;
  return sha256(body);
}

/**
 * Verify an evidence bundle.
 *
 * Structural checks (DLP, both hash chains, contentHash) prove only self-consistency —
 * the hash algorithm is public, so anyone who rewrites the body can recompute them. The
 * signature is the only thing that binds the body to a trusted issuer, and this function
 * used to destructure it away without ever verifying it (EB-02).
 *
 * Signature contract (fail closed):
 * - a verifier (`verifySignature` or `jwks`) supplied → the bundle MUST carry a signature
 *   and it MUST verify; an unsigned or invalidly-signed bundle returns `ok: false`.
 * - `requireSignature: true` without a verifier → `ok: false`
 *   (`EVIDENCE_SIGNATURE_VERIFIER_REQUIRED`): asking for proof without keys is not a pass.
 * - no verifier and no `requireSignature` → structural-only verification. Callers on an
 *   acceptance path must pass a verifier; the structural result is not an authenticity
 *   guarantee.
 */
export function verifyEvidenceBundle(
  bundle: EvidenceBundle,
  options: VerifyEvidenceBundleOptions = {},
): VerifyEvidenceBundleResult {
  const dlpHit = findDlpViolation(bundle);
  if (dlpHit) return { ok: false, reason: `DLP field present: ${dlpHit}`, brokenAt: 'dlp' };

  for (let i = 0; i < bundle.effects.length; i++) {
    const summary = bundle.effects[i].responseSummary;
    if (!summary) continue;
    for (const [key, child] of Object.entries(summary)) {
      if (!isAllowedResponseSummaryKey(key) || !isResponseSummaryScalar(child)) {
        return {
          ok: false,
          reason: `responseSummary contains non-allowlisted or non-scalar key: ${key}`,
          brokenAt: 'dlp',
          index: i,
        };
      }
    }
  }

  let prev = EVIDENCE_GENESIS_HASH;
  for (let i = 0; i < bundle.effects.length; i++) {
    const entry = bundle.effects[i];
    if (entry.prevEntryHash !== prev) {
      return { ok: false, reason: 'effect chain link broken', brokenAt: 'effects', index: i };
    }
    if (recomputeEffectEntry(entry) !== entry.entryHash) {
      return { ok: false, reason: 'effect entryHash mismatch', brokenAt: 'effects', index: i };
    }
    prev = entry.entryHash;
  }

  prev = EVIDENCE_GENESIS_HASH;
  for (let i = 0; i < bundle.auditEvents.length; i++) {
    const entry = bundle.auditEvents[i];
    if (entry.prevEntryHash !== prev) {
      return { ok: false, reason: 'audit chain link broken', brokenAt: 'auditEvents', index: i };
    }
    if (recomputeAuditEntry(entry) !== entry.entryHash) {
      return { ok: false, reason: 'audit entryHash mismatch', brokenAt: 'auditEvents', index: i };
    }
    prev = entry.entryHash;
  }

  const { contentHash, signature: _signature, ...body } = bundle;
  if (sha256(body) !== contentHash) {
    return { ok: false, reason: 'contentHash mismatch', brokenAt: 'contentHash' };
  }

  return verifyBundleSignature(bundle, options);
}

function resolveSignatureVerifier(
  options: VerifyEvidenceBundleOptions,
): ((canonicalBody: string, signature: EvidenceSignature) => boolean) | undefined {
  if (options.verifySignature) return options.verifySignature;
  const jwks = options.jwks;
  if (!jwks) return undefined;
  return (canonicalBody, signature) => verifyEvidenceSignature(canonicalBody, signature, jwks);
}

function verifyBundleSignature(
  bundle: EvidenceBundle,
  options: VerifyEvidenceBundleOptions,
): VerifyEvidenceBundleResult {
  const verifier = resolveSignatureVerifier(options);
  const requireSignature = options.requireSignature ?? verifier !== undefined;
  if (!verifier) {
    if (requireSignature) {
      return {
        ok: false,
        reason: 'EVIDENCE_SIGNATURE_VERIFIER_REQUIRED: no signature verifier was supplied',
        brokenAt: 'signature',
      };
    }
    return { ok: true };
  }
  if (!bundle.signature) {
    return { ok: false, reason: 'evidence bundle is not signed', brokenAt: 'signature' };
  }
  if (!verifier(canonicalEvidenceBody(bundle), bundle.signature)) {
    return {
      ok: false,
      reason: 'evidence signature verification failed',
      brokenAt: 'signature',
    };
  }
  return { ok: true };
}
