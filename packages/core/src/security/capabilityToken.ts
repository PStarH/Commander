/**
 * CapabilityToken — Short-lived, HMAC-signed authorization tokens for tool invocations.
 *
 * Phase 2.1. Closes the gap where {@link ToolApproval.requestApproval} auto-approves
 * every subsequent call after a single human approval. A capability token attests:
 * "this specific agent identity (sub) may invoke this specific tool subset (scope)
 *  for this specific TTL window (iat/exp) without re-prompting."
 *
 * Design overview
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ Wire format: <b64url(header)>.<b64url(payload)>.<b64url(signature)>     │
 * │ Header = {"alg":"HS256","typ":"CAP"} (fixed by protocol).              │
 * │ Payload = canonical-JSON of claims (sorted keys; see sign() helper).   │
 * │ Signature = HMAC-SHA-256(header.payload, masterKey) → hex → b64url.   │
 * │                                                                        │
 * │ Token claims (mandatory):                                              │
 * │   v         — protocol version (1); bumps invalidate the chain         │
 * │   jti       — 16 random bytes hex (uniqueness across all issuances)    │
 * │   sub       — agent id (or run id when no agent abstraction)           │
 * │   iss       — issuer (defaults to 'commander')                          │
 * │   iat/exp   — unix seconds; exp - iat ≤ maxTtlSeconds                   │
 * │   aud       — tenant id (or '*' for global)                             │
 * │   scope     — { tools: string[], argShapes: { tool: { param: [regex] }}}│
 * │   risk      — worst-case risk level this token approves (low…critical)  │
 * │   parent_jti— hex string OR null (delegation lineage)                  │
 * │   depth     — numeric chain depth (0 for root, parent.depth+1 for child)│
 * │   nonce     — 4 random bytes hex (replay window narrowing)              │
 * │                                                                        │
 * │ Tool membership uses wildcard semantics (e.g. `memory_*` matches       │
 * │ `memory_read`). Both verify() and the delegation subset check reconcile │
 * │ through the single file-private {@link toolMatches} helper to prevent  │
 * │ drift between issuance-time and runtime matching semantics.            │
 * │                                                                        │
 * │ Key handling:                                                          │
 * │   - Production requires env var COMMANDER_CAPABILITY_TOKEN_KEY ≥32    │
 * │     chars. Refuses to start without it.                                │
 * │   - Dev/test: deterministic dev key (sha256 of a fixed string) + warn. │
 * │                                                                        │
 * │ Revocation: in-memory RevocationSet singleton, process-local. Phase 2.2│
 * │ will trade this for an NDJSON-backed revocation ledger to span procs.  │
 * │                                                                        │
 * │ Audit:                                                                  │
 * │   Optional auditLogger callback at construction. Issuance emits        │
 * │   approval_granted; revocation emits approval_denied; verify is silent │
 * │   so high-volume middleware traffic does not flood the audit chain.   │
 * │   For tamper-evident hash-chained audits, see auditChain below.        │
 * │                                                                        │
 * │ Per-sink isolation (Phase 2.2): A throwing auditLogger MUST NEVER      │
 * │ disable the auditChain. Each sink is wrapped in {@link safelyFireAudit}│
 * │ so a broken in-process sink cannot bypass the tamper-evident trail.    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   const issuer = new CapabilityTokenIssuer({ masterKey });
 *   const verifier = new CapabilityTokenVerifier({ masterKey: issuer.masterKey });
 *   const tok = issuer.issue({ sub: 'agent-1', aud: 'tenant-A',
 *     tools: ['file_write'], ttlSeconds: 60 });
 *   const result = verifier.verify(tok, { tool: 'file_write',
 *     args: { path: '/workspace/x.ts' } });
 *   // result.ok === true, result.jti === <32 hex chars>
 */

import * as crypto from 'crypto';
import { SecurityEvent } from './securityAuditLogger';
import { getAuditChainLedger } from './auditChainLedger';
import { getMetricsCollector } from '../runtime/metricsCollector';

// ============================================================================
// Constants
// ============================================================================

/** Protocol version. Bumping intentionally invalidates all issued tokens. */
export const CAPABILITY_TOKEN_VERSION = 1;
/** Env var for the master HMAC key (≥ 32 chars in production). */
export const CAPABILITY_TOKEN_KEY_ENV = 'COMMANDER_CAPABILITY_TOKEN_KEY';
/** Default TTL window in seconds when caller doesn't specify. */
export const DEFAULT_MAX_TTL_SECONDS = 300;
/** Hard cap on delegation depth (root + N-1 descendants, where N ≤ max). */
export const MAX_DELEGATION_DEPTH = 3;
/** Issuer string baked into `iss` claim. */
export const DEFAULT_ISSUER = 'commander';
/** Allow ±N seconds of clock skew between issuer and verifier. */
export const CLOCK_SKEW_SECONDS = 5;

// ============================================================================
// Error types
// ============================================================================

/** Reasons a token may be rejected by `verify`. */
export type CapabilityRejectReason =
  | 'malformed_encoding'
  | 'malformed_payload'
  | 'unsupported_version'
  | 'invalid_algorithm'
  | 'signature_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'aud_mismatch'
  | 'jti_revoked'
  | 'parent_jti_revoked'
  | 'scope_mismatch'
  | 'empty_scope'
  | 'arg_shape_mismatch'
  | 'risk_mismatch'
  | 'ttl_overshoot'
  | 'delegation_depth_exceeded'
  | 'parent_exp_sooner_than_child'
  | 'duplicate_jti';

export class CapabilityTokenError extends Error {
  constructor(
    public readonly reason: CapabilityRejectReason,
    message: string,
  ) {
    super(`[capabilityToken] ${reason}: ${message}`);
    this.name = 'CapabilityTokenError';
  }
}

// ============================================================================
// Public types
// ============================================================================

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Tools authorised by this token. */
export interface CapabilityScope {
  tools: string[];
  /**
   * Per-tool, per-param regex strings that the runtime argument must match.
   * When absent or empty for a given tool+param, no constraint beyond tool
   * membership.
   */
  argShapes?: Record<string, Record<string, string[]>>;
}

/** Verbatim claim set encoded as the JSON payload. */
export interface CapabilityPayload {
  v: number;
  jti: string;
  sub: string;
  iss: string;
  iat: number;
  exp: number;
  aud: string;
  scope: CapabilityScope;
  risk: RiskLevel;
  parent_jti: string | null;
  /** Numeric depth in the delegation chain: 0 for root, parent.depth+1 for child. */
  depth: number;
  nonce: string;
}

export interface IssueOptions {
  sub: string;
  aud: string;
  tools: string[];
  argShapes?: CapabilityScope['argShapes'];
  risk?: RiskLevel;
  ttlSeconds?: number;
  /** When delegating, supply the parent token (parsed) here. */
  parent?: ParsedCapabilityToken;
  /** Allow caller to override the issuer string (mostly for tests). */
  iss?: string;
  /** Override jti (rare; tests may want deterministic jti). */
  jti?: string;
}

export interface VerifyRequest {
  tool: string;
  args: Record<string, unknown>;
  /** Optional caller-supplied audience; if absent, token's aud must equal '*'. */
  aud?: string;
}

export interface VerifyResultOk {
  ok: true;
  jti: string;
  parentJti: string | null;
  sub: string;
  scope: CapabilityScope;
  risk: RiskLevel;
  expiresAt: number;
}

export interface VerifyResultErr {
  ok: false;
  reason: CapabilityRejectReason;
  detail?: string;
}

export type VerifyResult = VerifyResultOk | VerifyResultErr;

export interface ParsedCapabilityToken {
  payload: CapabilityPayload;
  /** Encoded wire form, ready for transmission. */
  encoded: string;
  /** Hex HMAC-SHA-256(header.payload, key). */
  signature: string;
}

/** Optional hook into an audit logger (so verifier stays free of audit coupling). */
export type CapabilityAuditLogger = (event: SecurityEvent) => void;

// ============================================================================
// Encoding helpers
// ============================================================================

/**
 * Deterministic canonical-stringify for hash input. Sorts object keys
 * recursively so `{a:1,b:2}` and `{b:2,a:1}` produce identical output.
 * Arrays preserve order (semantics matter).
 */
function deterministicStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonical-encode non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(deterministicStringify).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') +
      '}'
    );
  }
  throw new TypeError(`Cannot canonical-encode value of type ${typeof value}`);
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf-8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(pad);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// ============================================================================
// Tool-membership helper (single source of truth for verify + delegation)
// ============================================================================

/**
 * Tool-pattern matcher shared by {@link CapabilityTokenVerifier.verify} (for
 * tool membership) and {@link CapabilityTokenIssuer.issue} (for the
 * wildcard-aware delegation subset check). Keeping these in one place prevents
 * drift between issuance-time and runtime matching semantics.
 */
function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  try {
    return new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    ).test(tool);
  } catch {
    return false;
  }
}

// ============================================================================
// Key resolution
// ============================================================================

export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const v = env[CAPABILITY_TOKEN_KEY_ENV];
  if (v && v.length >= 32) return Buffer.from(v, 'utf-8');
  if (env.NODE_ENV === 'production') {
    throw new Error(
      `[capabilityToken] ${CAPABILITY_TOKEN_KEY_ENV} must be set (>= 32 chars) in production. ` +
        'Refusing to issue capability tokens with a default key.',
    );
  }
  // eslint-disable-next-line no-console
  console.error(
    `[capabilityToken] WARNING: ${CAPABILITY_TOKEN_KEY_ENV} not set in non-production. ` +
      'Using insecure dev key derived from constants. Set the env var before shipping. ' +
      'Tokens issued with the dev key are NOT cryptographically valid.',
  );
  return crypto
    .createHash('sha256')
    .update('commander-capability-token-dev-key-DO-NOT-USE-IN-PROD-v1')
    .digest();
}

// ============================================================================
// Issuer
// ============================================================================

const HEADER_JSON = JSON.stringify({ alg: 'HS256', typ: 'CAP' });

export interface IssuerOptions {
  masterKey?: Buffer;
  maxTtlSeconds?: number;
  maxDelegationDepth?: number;
  /** Optional in-process audit sink (high-volume; not tamper-evident). */
  auditLogger?: CapabilityAuditLogger;
  /**
   * Optional tamper-evident hash-chained audit sink (Phase 1.1's
   * AuditChainLedger). When wired, every issuance + revocation lands
   * in the per-process chain so post-hoc tampering is detectable.
   * `getCapabilityTokenIssuer()` defaults this to {@link getAuditChainLedger}.
   */
  auditChain?: CapabilityAuditLogger;
  /** Optional override for default issuer string. */
  defaultIssuer?: string;
}

export class CapabilityTokenIssuer {
  readonly masterKey: Buffer;
  private readonly maxTtlSeconds: number;
  private readonly maxDelegationDepth: number;
  private readonly defaultIssuer: string;
  private readonly auditLogger?: CapabilityAuditLogger;
  private readonly auditChain?: CapabilityAuditLogger;
  /** Track every jti ever issued (in-process). Catches accidental duplicates. */
  private readonly seenJtis: Set<string> = new Set();

  constructor(opts: IssuerOptions = {}) {
    this.masterKey = opts.masterKey ?? resolveMasterKey();
    this.maxTtlSeconds = opts.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
    this.maxDelegationDepth = opts.maxDelegationDepth ?? MAX_DELEGATION_DEPTH;
    this.defaultIssuer = opts.defaultIssuer ?? DEFAULT_ISSUER;
    this.auditLogger = opts.auditLogger;
    this.auditChain = opts.auditChain;
  }

  /**
   * Issue a root or delegated token. Throws CapabilityTokenError on bad input.
   * Enforces (in order):
   *   1. ttlSeconds > 0 and ≤ maxTtlSeconds
   *   2. jti uniqueness in this process
   *   3. (delegation) child.depth ≤ maxDelegationDepth
   *   4. (delegation) child.exp < parent.exp
   *   5. (delegation) child.scope.tools ⊆ parent.scope.tools (wildcard-aware)
   *   6. (always) tools.length > 0 — refuse empty scope
   */
  issue(opts: IssueOptions): string {
    if (!opts.tools || opts.tools.length === 0)
      throw new CapabilityTokenError('empty_scope', 'tools array must contain at least one entry');

    const ttl = opts.ttlSeconds ?? this.maxTtlSeconds;
    if (ttl <= 0)
      throw new CapabilityTokenError('ttl_overshoot', `ttlSeconds must be > 0 (got ${ttl})`);
    if (ttl > this.maxTtlSeconds)
      throw new CapabilityTokenError(
        'ttl_overshoot',
        `ttlSeconds ${ttl} exceeds maxTtlSeconds ${this.maxTtlSeconds}`,
      );

    const jti = opts.jti ?? crypto.randomBytes(16).toString('hex');
    if (this.seenJtis.has(jti))
      throw new CapabilityTokenError('duplicate_jti', `jti ${jti} already issued in this process`);
    this.seenJtis.add(jti);

    const nonce = crypto.randomBytes(4).toString('hex');
    const nowSec = Math.floor(Date.now() / 1000);

    // Delegation invariants
    let parentJti: string | null = null;
    let depth = 0;
    if (opts.parent) {
      parentJti = opts.parent.payload.jti;
      depth = opts.parent.payload.depth + 1;
      if (depth >= this.maxDelegationDepth)
        throw new CapabilityTokenError(
          'delegation_depth_exceeded',
          `delegation chain would reach depth ${depth + 1} exceeding max ${this.maxDelegationDepth}`,
        );
      // Child must not outlive its parent.
      if (nowSec + ttl >= opts.parent.payload.exp)
        throw new CapabilityTokenError(
          'parent_exp_sooner_than_child',
          `child exp=${nowSec + ttl} must be < parent exp=${opts.parent.payload.exp}`,
        );
      // Wildcard-aware subset check: a parent scoping `memory_*` legitimately
      // covers a child naming `memory_read`. See {@link toolMatches}.
      for (const childTool of opts.tools) {
        const covered = opts.parent.payload.scope.tools.some((p) => toolMatches(p, childTool));
        if (!covered)
          throw new CapabilityTokenError(
            'scope_mismatch',
            `child scope tool=${childTool} not in parent scope ${opts.parent.payload.scope.tools.join(',')}`,
          );
      }
    }

    const payload: CapabilityPayload = {
      v: CAPABILITY_TOKEN_VERSION,
      jti,
      sub: opts.sub,
      iss: opts.iss ?? this.defaultIssuer,
      iat: nowSec,
      exp: nowSec + ttl,
      aud: opts.aud,
      scope: {
        tools: [...opts.tools].sort(),
        argShapes: opts.argShapes,
      },
      risk: opts.risk ?? 'low',
      parent_jti: parentJti,
      depth,
      nonce,
    };

    const encoded = sign(payload, this.masterKey);

    const event: SecurityEvent = {
      id: `ct_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'approval_granted',
      severity: opts.risk === 'critical' ? 'critical' : 'medium',
      source: 'CapabilityTokenIssuer',
      message: `capability token issued sub=${opts.sub} jti=${jti.slice(0, 12)}…`,
      details: {
        tools: opts.tools,
        ttlSeconds: ttl,
        risk: opts.risk ?? 'low',
        parentJti,
        depth,
      },
    };
    // Fire BOTH audit sinks with per-sink failure isolation. A throwing
    // in-process sink must NEVER disable the tamper-evident chained audit;
    // the chained trail is the one we cannot afford to lose.
    if (this.auditLogger) safelyFireAudit('auditLogger', this.auditLogger, event);
    if (this.auditChain) safelyFireAudit('auditChain', this.auditChain, event);
    return encoded;
  }

  /** Revoke a jti by adding it to the revocation ledger. Returns true if added. */
  revoke(jti: string, reason: string = 'manual_revoke'): boolean {
    const added = RevocationSet.shared.add(jti, reason);
    if (added) {
      const event: SecurityEvent = {
        id: `ct_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        type: 'approval_denied',
        severity: 'medium',
        source: 'CapabilityTokenIssuer',
        message: `capability token revoked jti=${jti.slice(0, 12)}…`,
        details: { jti, reason },
      };
      if (this.auditLogger) safelyFireAudit('auditLogger', this.auditLogger, event);
      // Fire auditChain so revocation joins the tamper-evident trail.
      if (this.auditChain) safelyFireAudit('auditChain', this.auditChain, event);
    }
    return added;
  }
}

// ============================================================================
// Verifier
// ============================================================================

export interface VerifierOptions {
  masterKey: Buffer;
  /** Audience string the verifier expects (token aud must equal this unless '*'). */
  expectedAud?: string;
  auditLogger?: CapabilityAuditLogger;
}

export class CapabilityTokenVerifier {
  private readonly masterKey: Buffer;
  private readonly expectedAud: string | undefined;
  private readonly auditLogger?: CapabilityAuditLogger;

  constructor(opts: VerifierOptions) {
    this.masterKey = opts.masterKey;
    this.expectedAud = opts.expectedAud;
    this.auditLogger = opts.auditLogger;
  }

  /** Verify an encoded token against a tool/args request. Pure (no audit emit). */
  verify(encoded: string, req: VerifyRequest): VerifyResult {
    let parts: string[];
    try {
      parts = encoded.split('.');
    } catch {
      return reject('malformed_encoding', 'token is not a string');
    }
    if (parts.length !== 3) return reject('malformed_encoding', 'expected 3 dot-separated parts');

    let header: { alg?: string; typ?: string };
    let payload: CapabilityPayload;
    try {
      header = JSON.parse(b64urlDecode(parts[0]!));
      payload = JSON.parse(b64urlDecode(parts[1]!));
    } catch (e) {
      return reject('malformed_payload', `JSON parse failed: ${(e as Error).message}`);
    }
    if (header.alg !== 'HS256') return reject('invalid_algorithm', `alg=${header.alg}`);
    if (header.typ !== 'CAP') return reject('malformed_payload', `typ=${header.typ}`);
    if (payload.v !== CAPABILITY_TOKEN_VERSION)
      return reject('unsupported_version', `v=${payload.v}`);

    // Signature verification (constant-time).
    const expectedSig = crypto
      .createHmac('sha256', this.masterKey)
      .update(parts[0] + '.' + parts[1])
      .digest('hex');
    let providedSig: string;
    try {
      providedSig = b64urlDecode(parts[2]!);
    } catch {
      return reject('malformed_encoding', 'signature is not valid base64url');
    }
    if (
      providedSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(providedSig, 'utf-8'), Buffer.from(expectedSig, 'utf-8'))
    ) {
      return reject('signature_mismatch', 'recomputed HMAC does not match stored signature');
    }

    // Time bounds
    const now = Math.floor(Date.now() / 1000);
    if (payload.iat - CLOCK_SKEW_SECONDS > now)
      return reject(
        'not_yet_valid',
        `iat=${payload.iat} is more than ${CLOCK_SKEW_SECONDS}s in the future`,
      );
    if (payload.exp + CLOCK_SKEW_SECONDS <= now)
      return reject('expired', `exp=${payload.exp} has passed (now=${now})`);

    // Revocation (own jti + parent chain)
    if (RevocationSet.shared.isRevoked(payload.jti))
      return reject('jti_revoked', `jti=${payload.jti.slice(0, 12)}…`);
    if (payload.parent_jti && RevocationSet.shared.isRevoked(payload.parent_jti))
      return reject(
        'parent_jti_revoked',
        `parent jti=${payload.parent_jti.slice(0, 12)}… was revoked`,
      );

    // Audience
    if (this.expectedAud !== undefined && payload.aud !== this.expectedAud && payload.aud !== '*')
      return reject('aud_mismatch', `token aud=${payload.aud} expected=${this.expectedAud}`);

    // Scope: tool membership (wildcard-aware via shared toolMatches()).
    const toolCovered = payload.scope.tools.some((p) => toolMatches(p, req.tool));
    if (!toolCovered) return reject('scope_mismatch', `tool=${req.tool} not in scope`);

    // Arg-shape constraints. Fail-fast on undefined/null so a token scoped
    // to e.g. {path: [/^\/workspace\//]} cannot accidentally satisfy a
    // permissive wildcard regex when the caller omits the parameter entirely.
    const shapesForTool = payload.scope.argShapes?.[req.tool];
    if (shapesForTool) {
      for (const [param, regexes] of Object.entries(shapesForTool)) {
        const v = req.args[param];
        if (v === undefined || v === null)
          return reject(
            'arg_shape_mismatch',
            `param=${param} is ${v === null ? 'null' : 'absent'} but token requires a constrained value`,
          );
        const str = typeof v === 'string' ? v : JSON.stringify(v);
        const matched = regexes.some((rx) => {
          try {
            return new RegExp(rx).test(str);
          } catch {
            return false;
          }
        });
        if (!matched)
          return reject(
            'arg_shape_mismatch',
            `param=${param} value does not match any allowed regex`,
          );
      }
    }

    return ok(payload);
  }

  /** Re-trust a revoked jti (rare; e.g. recovering from a false-positive). */
  trustParent(jti: string): boolean {
    return RevocationSet.shared.remove(jti);
  }
}

// ============================================================================
// Revocation set (process-local; Phase 2.2 = NDJSON-backed)
// ============================================================================

class RevocationSet {
  private readonly set: Map<string, { reason: string; revokedAt: number }> = new Map();

  add(jti: string, reason: string): boolean {
    if (this.set.has(jti)) return false;
    this.set.set(jti, { reason, revokedAt: Date.now() });
    return true;
  }

  isRevoked(jti: string): boolean {
    return this.set.has(jti);
  }

  remove(jti: string): boolean {
    return this.set.delete(jti);
  }

  reset(): void {
    this.set.clear();
  }

  static shared: RevocationSet = new RevocationSet();
}

/** Reset the revocation ledger. Test isolation only. */
export function resetRevocationLedger(): void {
  RevocationSet.shared.reset();
}

// ============================================================================
// Stateless signing helpers (used by Issuer + tests + external consumers)
// ============================================================================

/**
 * Encode header + payload via canonical JSON, sign with HMAC-SHA-256, return
 * the wire form `<b64url(header)>.<b64url(payload)>.<b64url(signature)>`.
 */
export function sign(payload: CapabilityPayload, masterKey: Buffer): string {
  const headerB64 = b64urlEncode(HEADER_JSON);
  const payloadB64 = b64urlEncode(deterministicStringify(payload));
  const sig = crypto
    .createHmac('sha256', masterKey)
    .update(`${headerB64}.${payloadB64}`)
    .digest('hex');
  return `${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Decode an encoded token into its parsed form. Useful for delegating and
 * introspecting (does NOT verify signature — pair with {@link
 * CapabilityTokenVerifier.verify}).
 */
export function decode(encoded: string): ParsedCapabilityToken {
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new CapabilityTokenError('malformed_encoding', 'expected 3 parts');
  const payload = JSON.parse(b64urlDecode(parts[1]!)) as CapabilityPayload;
  return { payload, encoded, signature: b64urlDecode(parts[2]!) };
}

function reject(reason: CapabilityRejectReason, detail: string): VerifyResultErr {
  return { ok: false, reason, detail };
}

/**
 * Increment a monotonic failure counter on the {@link MetricsCollector} for
 * audit/observability sinks whose throw was swallowed. Operators see a
 * visible dashboard alert on `audit_sink_failures_total{sink="…"}` instead
 * of an orphaned stderr line per call. Wrapped in defensive try/catch so a
 * metrics-collector failure can NEVER break the underlying token flow.
 */
function recordSinkFailure(sink: string): void {
  try {
    getMetricsCollector().incrementCounter(
      'audit_sink_failures_total',
      'Audit/observability sink failures (silent swallows)',
      1,
      [{ name: 'sink', value: sink }],
    );
  } catch {
    /* metrics collector unavailable — last-resort swallow */
  }
}

/**
 * Fire one audit sink with defensive error isolation. A throwing sink must
 * never break issuance or skip the OTHER audit sink (chained audit is
 * tamper-evident and must not be bypassed by an in-process sink failure).
 * `sinkName` is the label recorded on the `audit_sink_failures_total`
 * counter when this sink throws.
 */
function safelyFireAudit(
  sinkName: string,
  sink: CapabilityAuditLogger,
  event: SecurityEvent,
): void {
  try {
    sink(event);
  } catch (err) {
    recordSinkFailure(sinkName);
    try {
      // eslint-disable-next-line no-console
      console.error(
        `[capabilityToken] audit sink (${sinkName}) threw: ${(err as Error)?.message ?? String(err)}`,
      );
    } catch {
      /* stderr inaccessible, swallow */
    }
  }
}

function ok(payload: CapabilityPayload): VerifyResultOk {
  return {
    ok: true,
    jti: payload.jti,
    parentJti: payload.parent_jti,
    sub: payload.sub,
    scope: payload.scope,
    risk: payload.risk,
    expiresAt: payload.exp,
  };
}

// ============================================================================
// Singleton wiring (simple process-local; multi-tenant is Phase 2.2)
// ============================================================================

let _sharedIssuer: CapabilityTokenIssuer | null = null;

/**
 * Get the active issuer (lazily constructed process singleton).
 *
 * Default-wires `auditChain` to {@link getAuditChainLedger} so token
 * operations automatically join the hash-chained audit trail from Phase 1.1.
 * Callers may pass an explicit `auditChain` in `IssuerOptions` to override
 * this default (e.g., for tests with a custom sink).
 */
export function getCapabilityTokenIssuer(): CapabilityTokenIssuer {
  if (!_sharedIssuer) {
    _sharedIssuer = new CapabilityTokenIssuer({
      auditChain: (event) => {
        try {
          getAuditChainLedger().logEvent(event);
        } catch (err) {
          recordSinkFailure('auditChain');
          // Don't let chain failures break issuance; the in-process
          // auditLogger (if wired) is the fallback.
          try {
            // eslint-disable-next-line no-console
            console.error(
              `[capabilityToken] auditChain ledger unavailable: ${(err as Error)?.message ?? String(err)}`,
            );
          } catch {
            /* stderr inaccessible, swallow */
          }
        }
      },
    });
  }
  return _sharedIssuer;
}

/** Reset all issuers + revocation state. Test isolation only. */
export function resetCapabilityTokenState(): void {
  _sharedIssuer = null;
  resetRevocationLedger();
}
