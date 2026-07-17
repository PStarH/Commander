import { createHash, randomUUID } from 'node:crypto';
import type { CapabilityGrant } from './index.js';

export const EVIDENCE_BUNDLE_SCHEMA = 'l3-11.v0' as const;
export const EVIDENCE_GENESIS_HASH = '0'.repeat(64);

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
  bundleId: string;
  exportedAt: string;
  scope: EvidenceBundleScope;
  identity: EvidenceBundleIdentity;
  versions: EvidenceBundleVersions;
  effects: EvidenceBundleEffectEntry[];
  auditEvents: EvidenceBundleAuditEntry[];
  contentHash: string;
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
  brokenAt?: 'effects' | 'auditEvents' | 'contentHash' | 'dlp';
  index?: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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

function isAllowedResponseSummaryKey(key: string): boolean {
  return EVIDENCE_RESPONSE_SUMMARY_KEYS.has(normalizeKey(key));
}

/** responseSummary values are metadata scalars only — nested objects are a DLP bypass. */
function isResponseSummaryScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Recursively remove DLP keys and secret field names; does not mutate input. */
export function sanitizeForEvidence(value: unknown): unknown {
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

function summarizeResponse(response?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!response) return undefined;
  const sanitized = sanitizeForEvidence(response) as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(sanitized)) {
    if (!isAllowedResponseSummaryKey(key)) continue;
    if (!isResponseSummaryScalar(child)) continue;
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
  return (input.auditEvents ?? []).filter((e) => e.tenantId === input.tenantId && e.runId === input.runId);
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
  const sorted = [...effects].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const bare = sorted.map((effect) => compact({
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
  }));
  return hashChainedEntries<EvidenceBundleEffectEntry>(bare);
}

function buildAuditEntries(events: EvidenceAuditSource[]): EvidenceBundleAuditEntry[] {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.type.localeCompare(b.type));
  const bare = sorted.map((event) => compact({
    type: event.type,
    at: event.at,
    severity: event.severity,
    stepId: event.stepId,
    details: sanitizeForEvidence(event.details) as Record<string, unknown>,
  }));
  return hashChainedEntries<EvidenceBundleAuditEntry>(bare);
}

function attachContentHash(body: Omit<EvidenceBundle, 'contentHash'>): EvidenceBundle {
  const contentHash = sha256(body);
  return { ...body, contentHash };
}

export function buildRunEvidenceBundle(input: BuildEvidenceBundleInput): EvidenceBundle {
  const body: Omit<EvidenceBundle, 'contentHash'> = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA,
    bundleId: input.bundleId ?? randomUUID(),
    exportedAt: input.exportedAt ?? new Date().toISOString(),
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
    effects: buildEffectEntries(scopeEffects(input)),
    auditEvents: buildAuditEntries(scopeAuditEvents(input)),
  };
  return attachContentHash(body);
}

export function buildEffectEvidenceBundle(
  input: BuildEvidenceBundleInput & { effectId: string },
): EvidenceBundle {
  const match = input.effects.filter((e) => e.id === input.effectId);
  // Only keep audit rows explicitly bound to this effectId (fail-closed scope).
  const audit = (input.auditEvents ?? []).filter((e) => e.details.effectId === input.effectId);
  return buildRunEvidenceBundle({ ...input, effects: match, auditEvents: audit, effectId: input.effectId });
}

function recomputeEffectEntry(entry: EvidenceBundleEffectEntry): string {
  const { entryHash: _e, ...body } = entry;
  return sha256(body);
}

function recomputeAuditEntry(entry: EvidenceBundleAuditEntry): string {
  const { entryHash: _e, ...body } = entry;
  return sha256(body);
}

export function verifyEvidenceBundle(bundle: EvidenceBundle): VerifyEvidenceBundleResult {
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

  const { contentHash, ...body } = bundle;
  if (sha256(body) !== contentHash) {
    return { ok: false, reason: 'contentHash mismatch', brokenAt: 'contentHash' };
  }

  return { ok: true };
}
