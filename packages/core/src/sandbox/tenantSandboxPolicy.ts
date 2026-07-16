/**
 * WS7 §5 — Tenant / Workload sandbox policy layer.
 *
 * Per-workload sandbox policy module. Sits alongside `profiles.ts`:
 *   - `profiles.ts` describes *per-mode* sandbox profiles (read-only,
 *     workspace-write, hardened, …) that are independent of who is running.
 *   - `tenantSandboxPolicy.ts` describes the *per-workload-instance* policy:
 *     which identity tuple (tenantId/runId/stepId/workloadId) is executing,
 *     which profile is applied, and the server-generated container / volume /
 *     network / workdir names that isolate this workload from every other.
 *
 * Security invariants enforced here (WS7 §5.1 / §5.2):
 *
 * 1. **Identity validation** — all four identity fields must be non-empty and
 *    match a safe charset (`[A-Za-z0-9_-]`) before any container resource is
 *    created. Prevents container-name injection, label injection, and path
 *    traversal via workload identity.
 *
 * 2. **Server-generated names** — container, volume, network namespace and
 *    workdir paths are derived from the identity tuple via SHA-256. The user
 *    never supplies these names; they are opaque to the caller and unforgeable
 *    from outside.
 *
 * 3. **Tenant scope consistency** — the tenantId observed at the three
 *    enforcement points (worker claim, sandbox creation, execution audit) must
 *    be identical. Any mismatch is a tenant isolation violation and fails
 *    closed.
 *
 * 4. **Image digest locking** — production workloads pin images by digest
 *    (`sha256:...`), not just tag. A tag is mutable; a digest is
 *    content-addressed and immutable.
 *
 * This module is the Phase 1 policy surface. Phase 2 Build wires it into
 * `DockerSB.execute()` / `GVisorSB.execute()` so the server-generated
 * container name reaches the Docker API and the user-supplied workdir is
 * replaced by `policy.workdir`.
 */

import { createHash } from 'node:crypto';
import type { SandboxProfile, WorkloadIdentity } from './types';
import { SandboxInitializationError } from './manager';

/**
 * WS7 §5.1 — Safe charset for workload identity fields.
 *
 * Allows ASCII letters, digits, hyphens, underscores. Rejects anything else
 * to prevent container name injection, label injection, or path traversal.
 * Container labels and names in Docker are constrained to `[A-Za-z0-9_.-]`;
 * we drop `.` to keep the same charset across path components too.
 */
const IDENTITY_CHARSET = /^[A-Za-z0-9_-]+$/;

/**
 * WS7 §5.1 — Max length per identity field.
 *
 * Defensive cap. The four fields together feed into a 32-hex-char container
 * name suffix, so field length does not affect the container name length —
 * but unbounded fields would let a caller exhaust memory or push very long
 * strings into audit logs.
 */
const IDENTITY_MAX_LEN = 128;

/**
 * WS7 §5.1 — Container name DNS label limit.
 *
 * Docker container names must be <= 63 chars and match `[A-Za-z0-9][A-Za-z0-9_.-]*`.
 * `commander-sbx-` is 15 chars; a 32-hex digest keeps the total at 47 chars,
 * well under the limit and within the `[A-Za-z0-9-]` subset.
 */
const CONTAINER_NAME_PREFIX = 'commander-sbx-';
const CONTAINER_NAME_SUFFIX_LEN = 32;

/**
 * WS7 §5.2 — The three enforcement points where tenant scope must be
 * consistent. Used by `assertTenantScopeConsistency` to identify which check
 * failed in the audit trail.
 */
export type TenantScopeCheckPoint = 'claim' | 'sandbox-create' | 'audit';

/**
 * WS7 §5.1 — Validates a WorkloadIdentity before any container resource is
 * created.
 *
 * All four identity fields must be:
 *  - non-empty
 *  - <= `IDENTITY_MAX_LEN` characters
 *  - matching `IDENTITY_CHARSET` (ASCII letters, digits, hyphens, underscores)
 *
 * @throws SandboxInitializationError on any validation failure. The error
 *   message does NOT echo the offending value — only the field name — to
 *   avoid leaking partial identity material into logs that may be aggregated.
 */
export function validateWorkloadIdentity(identity: WorkloadIdentity): void {
  const fields: ReadonlyArray<keyof WorkloadIdentity> = [
    'tenantId',
    'runId',
    'stepId',
    'workloadId',
  ];
  for (const field of fields) {
    const value = identity[field];
    if (value === undefined || value === null || value.length === 0) {
      throw new SandboxInitializationError(`WS7 §5.1: WorkloadIdentity.${field} must be non-empty`);
    }
    if (value.length > IDENTITY_MAX_LEN) {
      throw new SandboxInitializationError(
        `WS7 §5.1: WorkloadIdentity.${field} exceeds ${IDENTITY_MAX_LEN} characters`,
      );
    }
    if (!IDENTITY_CHARSET.test(value)) {
      throw new SandboxInitializationError(
        `WS7 §5.1: WorkloadIdentity.${field} contains unsafe characters ` +
          '(allowed: ASCII letters, digits, hyphen, underscore)',
      );
    }
  }
}

/**
 * Internal — derive a deterministic opaque suffix from the identity tuple.
 *
 * The suffix is a truncated SHA-256 over a domain-separated material string.
 * Domain separation (`prefix|`) ensures the same tuple hashed under different
 * namespaces (container vs volume vs network vs workdir) yields different
 * suffixes, so a volume name cannot be confused with a container name.
 *
 * The caller is responsible for validating the identity first.
 */
function opaqueSuffix(identity: WorkloadIdentity, domain: string, length: number): string {
  const material = `${domain}|${identity.tenantId}|${identity.runId}|${identity.stepId}|${identity.workloadId}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, length);
}

/**
 * WS7 §5.1 — Server-generate the container name for a workload.
 *
 * Format: `commander-sbx-<32-hex>` where the hex is a truncated SHA-256 over
 * the identity tuple. The hash makes the container name:
 *  - **unforgeable** from outside — an attacker cannot predict or collide with
 *    another workload's container name without knowing all four identity fields
 *  - **deterministic** — the same workload always gets the same name, so audit
 *    trails and Docker logs can be correlated back to a workload identity
 *  - **opaque** — the name does not leak tenantId/runId/stepId/workloadId to
 *    anyone reading `docker ps`
 *
 * The caller never provides the container name — only the identity tuple.
 *
 * @throws SandboxInitializationError if the identity is invalid.
 */
export function generateContainerName(identity: WorkloadIdentity): string {
  validateWorkloadIdentity(identity);
  return `${CONTAINER_NAME_PREFIX}${opaqueSuffix(identity, 'container', CONTAINER_NAME_SUFFIX_LEN)}`;
}

/**
 * WS7 §5.1 — Server-generate a per-workload volume name.
 *
 * Different tenants must never share writable volumes. Each workload gets its
 * own ephemeral volume named `commander-vol-<32-hex>`. The hex digest is
 * domain-separated from the container name so the two cannot collide.
 *
 * @throws SandboxInitializationError if the identity is invalid.
 */
export function generateWorkloadVolumeName(identity: WorkloadIdentity): string {
  validateWorkloadIdentity(identity);
  return `commander-vol-${opaqueSuffix(identity, 'volume', CONTAINER_NAME_SUFFIX_LEN)}`;
}

/**
 * WS7 §5.1 — Server-generate a per-workload network namespace name.
 *
 * Different tenants must never share a network namespace. Each workload gets
 * `commander-net-<32-hex>`. Domain-separated from container/volume names.
 *
 * @throws SandboxInitializationError if the identity is invalid.
 */
export function generateNetworkNamespaceName(identity: WorkloadIdentity): string {
  validateWorkloadIdentity(identity);
  return `commander-net-${opaqueSuffix(identity, 'network', CONTAINER_NAME_SUFFIX_LEN)}`;
}

/**
 * WS7 §5.1 — Server-generate a per-workload working-directory path inside
 * the sandbox.
 *
 * Returns a deterministic, tenant-isolated absolute path that the sandbox
 * supervisor mounts as the container's working directory. The path is opaque
 * to the user and never accepted as input — the user-supplied workdir that
 * `DockerSB.execute()` currently accepts is replaced by this value when the
 * policy is in effect (Phase 2 Build wiring).
 *
 * @throws SandboxInitializationError if the identity is invalid.
 */
export function generateWorkloadWorkdir(identity: WorkloadIdentity): string {
  validateWorkloadIdentity(identity);
  return `/workspace/commander-${opaqueSuffix(identity, 'workdir', 16)}`;
}

/**
 * WS7 §5.2 — Tenant scope consistency check.
 *
 * The tenantId observed at the three enforcement points must be identical:
 *   1. `claim` — when the worker claims the work from the kernel
 *   2. `sandbox-create` — when the sandbox container is created
 *   3. `audit` — when the execution audit event is recorded
 *
 * Any mismatch is a tenant isolation violation and must fail closed. The
 * error message records the check point and the two values so the operator
 * can investigate which leg of the pipeline dropped or swapped the tenant
 * scope.
 *
 * @throws SandboxInitializationError if the tenant scopes do not match.
 */
export function assertTenantScopeConsistency(
  expected: string,
  observed: string,
  point: TenantScopeCheckPoint,
): void {
  if (expected !== observed) {
    throw new SandboxInitializationError(
      `WS7 §5.2: tenant scope mismatch at ${point} — ` +
        `expected tenantId="${expected}" but observed "${observed}". ` +
        'Tenant isolation violation — refusing to proceed.',
    );
  }
}

/**
 * WS7 §5.2 — Locked image descriptor.
 *
 * Production workloads must pin images by digest, not just tag. A tag like
 * `node:22-slim` is mutable; the digest `sha256:abc...` is content-addressed
 * and immutable. The sandbox supervisor resolves the tag to a digest at
 * admission time and rejects execution if the runtime digest differs.
 */
export interface LockedImage {
  /** Original tag (for display / debugging only — never used to pull). */
  readonly tag: string;
  /** Resolved digest in `sha256:<64 hex>` form. */
  readonly digest: string;
  /** Fully-qualified image reference, e.g. `node:22-slim@sha256:abc...`. */
  readonly ref: string;
}

/** WS7 §5.2 — Digest format: `sha256:` followed by exactly 64 lowercase hex chars. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * WS7 §5.2 — Resolve a tag to a digest-locked image reference.
 *
 * This is a pure formatter — the actual digest resolution happens in the
 * sandbox supervisor by calling `docker image inspect --format '{{.Id}}' <tag>`
 * (Phase 2 Build). This function validates the digest shape and produces the
 * immutable `tag@digest` reference that gets pinned to the policy.
 *
 * @throws SandboxInitializationError if the tag is empty or the digest is
 *   not in `sha256:<64 hex>` form.
 */
export function lockImageByDigest(tag: string, digest: string): LockedImage {
  if (!tag || tag.length === 0) {
    throw new SandboxInitializationError('WS7 §5.2: image tag must be non-empty');
  }
  if (!DIGEST_RE.test(digest)) {
    throw new SandboxInitializationError(
      `WS7 §5.2: image digest must be in sha256:<64 hex> form, got "${digest}"`,
    );
  }
  return {
    tag,
    digest,
    ref: `${tag}@${digest}`,
  };
}

/**
 * WS7 §5.1 — Tenant sandbox policy record.
 *
 * Captures the resolved policy for a single workload execution: identity,
 * selected profile, optional image lock, and the server-generated resource
 * names. Stored alongside `profiles.ts` as the per-workload policy layer.
 *
 * The record is frozen at construction. The sandbox supervisor (Phase 2
 * Build) treats every field as immutable after `buildTenantSandboxPolicy`
 * returns — runtime mutations would defeat tenant isolation.
 */
export interface TenantSandboxPolicy {
  /** The workload identity tuple — validated at construction. */
  readonly identity: WorkloadIdentity;
  /** The sandbox profile to apply (one of PROFILES from profiles.ts). */
  readonly profile: SandboxProfile;
  /** Digest-locked image reference. Required in production; optional in dev. */
  readonly image?: LockedImage;
  /** Server-generated container name (never user-supplied). */
  readonly containerName: string;
  /** Server-generated per-workload volume name. */
  readonly volumeName: string;
  /** Server-generated per-workload network namespace name. */
  readonly networkNamespace: string;
  /** Server-generated per-workload working directory inside the sandbox. */
  readonly workdir: string;
  /** When the policy was frozen (ISO 8601). */
  readonly frozenAt: string;
}

/**
 * Options for `buildTenantSandboxPolicy`.
 */
export interface BuildTenantSandboxPolicyOptions {
  /** Digest-locked image reference (required for production workloads). */
  readonly image?: LockedImage;
  /** Override the `frozenAt` timestamp — testing only. */
  readonly now?: () => string;
}

/**
 * WS7 §5.1 — Build a fully-resolved TenantSandboxPolicy for a workload.
 *
 * This is the single entry point that turns a WorkloadIdentity + SandboxProfile
 * into a concrete, server-generated policy record. All container / volume /
 * network / workdir names are derived from the identity tuple — the caller
 * never provides them.
 *
 * The policy is frozen at construction time (the `frozenAt` timestamp).
 * Subsequent mutations are rejected by the sandbox supervisor (Phase 2 Build).
 *
 * @throws SandboxInitializationError if the identity is invalid.
 */
export function buildTenantSandboxPolicy(
  identity: WorkloadIdentity,
  profile: SandboxProfile,
  options?: BuildTenantSandboxPolicyOptions,
): TenantSandboxPolicy {
  validateWorkloadIdentity(identity);
  const now = options?.now ?? (() => new Date().toISOString());
  return {
    identity,
    profile,
    image: options?.image,
    containerName: generateContainerName(identity),
    volumeName: generateWorkloadVolumeName(identity),
    networkNamespace: generateNetworkNamespaceName(identity),
    workdir: generateWorkloadWorkdir(identity),
    frozenAt: now(),
  };
}
