/**
 * WS7 §5 TenantSandboxPolicy unit tests.
 *
 * Covers Phase 1 Resolution 4 — the per-workload sandbox policy layer:
 *  - identity validation (non-empty + safe charset)
 *  - server-generated container/volume/network/workdir names
 *  - tenant scope consistency check
 *  - image digest locking
 *  - buildTenantSandboxPolicy composition
 *
 * Spec references:
 *  - §5.1 identity & lifecycle (server-generated names, no user input)
 *  - §5.2 forced policy (tenant scope consistency at 3 enforcement points)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  validateWorkloadIdentity,
  generateContainerName,
  generateWorkloadVolumeName,
  generateNetworkNamespaceName,
  generateWorkloadWorkdir,
  assertTenantScopeConsistency,
  lockImageByDigest,
  buildTenantSandboxPolicy,
} from '../src/sandbox/tenantSandboxPolicy';
import { SandboxInitializationError } from '../src/sandbox/manager';
import { HARDENED, READ_ONLY } from '../src/sandbox/profiles';
import type { WorkloadIdentity } from '../src/sandbox/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_IDENTITY: WorkloadIdentity = {
  tenantId: 'tenant-alpha',
  runId: 'run-42',
  stepId: 'step-3',
  workloadId: 'wl-001',
};

// ─── validateWorkloadIdentity ────────────────────────────────────────────────

describe('WS7 §5.1 validateWorkloadIdentity', () => {
  it('accepts a valid identity with letters, digits, hyphens, underscores', () => {
    assert.doesNotThrow(() => validateWorkloadIdentity(VALID_IDENTITY));
  });

  it('accepts identity fields with underscores and digits', () => {
    assert.doesNotThrow(() =>
      validateWorkloadIdentity({
        tenantId: 't_1',
        runId: 'r_2',
        stepId: 's_3',
        workloadId: 'w_4',
      }),
    );
  });

  it('rejects an empty tenantId', () => {
    assert.throws(
      () => validateWorkloadIdentity({ ...VALID_IDENTITY, tenantId: '' }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /tenantId must be non-empty/);
        return true;
      },
    );
  });

  it('rejects an empty runId', () => {
    assert.throws(
      () => validateWorkloadIdentity({ ...VALID_IDENTITY, runId: '' }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /runId must be non-empty/);
        return true;
      },
    );
  });

  it('rejects an empty stepId', () => {
    assert.throws(
      () => validateWorkloadIdentity({ ...VALID_IDENTITY, stepId: '' }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /stepId must be non-empty/);
        return true;
      },
    );
  });

  it('rejects an empty workloadId', () => {
    assert.throws(
      () => validateWorkloadIdentity({ ...VALID_IDENTITY, workloadId: '' }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /workloadId must be non-empty/);
        return true;
      },
    );
  });

  it('rejects unsafe characters — spaces, slashes, dots, shell metachars', () => {
    const unsafe = [' ', '/', '.', ';', '|', '$', '`', '"', "'", '\n', '\t', '\\'];
    for (const ch of unsafe) {
      assert.throws(
        () =>
          validateWorkloadIdentity({ ...VALID_IDENTITY, workloadId: `bad${ch}id` }),
        SandboxInitializationError,
        `expected charset to reject "${ch}"`,
      );
    }
  });

  it('rejects fields exceeding the max length', () => {
    const tooLong = 'a'.repeat(129);
    assert.throws(
      () => validateWorkloadIdentity({ ...VALID_IDENTITY, tenantId: tooLong }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /exceeds 128 characters/);
        return true;
      },
    );
  });

  it('accepts a field of exactly the max length (128 chars)', () => {
    const exactlyMax = 'a'.repeat(128);
    assert.doesNotThrow(() =>
      validateWorkloadIdentity({ ...VALID_IDENTITY, runId: exactlyMax }),
    );
  });
});

// ─── generateContainerName ───────────────────────────────────────────────────

describe('WS7 §5.1 generateContainerName', () => {
  it('produces the commander-sbx-<32-hex> format', () => {
    const name = generateContainerName(VALID_IDENTITY);
    assert.match(name, /^commander-sbx-[0-9a-f]{32}$/);
    // 15 (prefix) + 32 (hex) = 47 chars — within Docker's 63-char DNS label.
    assert.ok(name.length <= 63, `container name too long: ${name.length}`);
  });

  it('is deterministic — same identity yields the same name', () => {
    const a = generateContainerName(VALID_IDENTITY);
    const b = generateContainerName(VALID_IDENTITY);
    assert.strictEqual(a, b);
  });

  it('changes when any identity field changes', () => {
    const base = generateContainerName(VALID_IDENTITY);
    const variants: WorkloadIdentity[] = [
      { ...VALID_IDENTITY, tenantId: 'tenant-beta' },
      { ...VALID_IDENTITY, runId: 'run-43' },
      { ...VALID_IDENTITY, stepId: 'step-4' },
      { ...VALID_IDENTITY, workloadId: 'wl-002' },
    ];
    for (const v of variants) {
      assert.notStrictEqual(generateContainerName(v), base);
    }
  });

  it('does not leak identity fields into the name — only the hash is visible', () => {
    const name = generateContainerName(VALID_IDENTITY);
    assert.ok(!name.includes(VALID_IDENTITY.tenantId));
    assert.ok(!name.includes(VALID_IDENTITY.runId));
    assert.ok(!name.includes(VALID_IDENTITY.stepId));
    assert.ok(!name.includes(VALID_IDENTITY.workloadId));
  });

  it('throws on invalid identity (fail-closed before any resource is created)', () => {
    assert.throws(
      () => generateContainerName({ ...VALID_IDENTITY, tenantId: '' }),
      SandboxInitializationError,
    );
  });
});

// ─── domain separation between name generators ───────────────────────────────

describe('WS7 §5.1 name generators are domain-separated', () => {
  it('container, volume, network, workdir names are all distinct for one identity', () => {
    const container = generateContainerName(VALID_IDENTITY);
    const volume = generateWorkloadVolumeName(VALID_IDENTITY);
    const network = generateNetworkNamespaceName(VALID_IDENTITY);
    const workdir = generateWorkloadWorkdir(VALID_IDENTITY);

    assert.notStrictEqual(container, volume);
    assert.notStrictEqual(container, network);
    assert.notStrictEqual(volume, network);
    // workdir is a path, not a name — distinct shape, but also distinct content
    assert.notStrictEqual(container, workdir);
  });

  it('volume name uses commander-vol- prefix and 32-hex suffix', () => {
    assert.match(
      generateWorkloadVolumeName(VALID_IDENTITY),
      /^commander-vol-[0-9a-f]{32}$/,
    );
  });

  it('network namespace uses commander-net- prefix and 32-hex suffix', () => {
    assert.match(
      generateNetworkNamespaceName(VALID_IDENTITY),
      /^commander-net-[0-9a-f]{32}$/,
    );
  });

  it('workdir is an absolute /workspace/commander-<16-hex> path', () => {
    assert.match(
      generateWorkloadWorkdir(VALID_IDENTITY),
      /^\/workspace\/commander-[0-9a-f]{16}$/,
    );
  });
});

// ─── assertTenantScopeConsistency ────────────────────────────────────────────

describe('WS7 §5.2 assertTenantScopeConsistency', () => {
  it('passes silently when expected === observed', () => {
    assert.doesNotThrow(() =>
      assertTenantScopeConsistency('tenant-a', 'tenant-a', 'claim'),
    );
    assert.doesNotThrow(() =>
      assertTenantScopeConsistency('tenant-a', 'tenant-a', 'sandbox-create'),
    );
    assert.doesNotThrow(() =>
      assertTenantScopeConsistency('tenant-a', 'tenant-a', 'audit'),
    );
  });

  it('throws at the claim check point on mismatch', () => {
    assert.throws(
      () => assertTenantScopeConsistency('tenant-a', 'tenant-b', 'claim'),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /mismatch at claim/);
        assert.match((err as Error).message, /tenant isolation violation/i);
        return true;
      },
    );
  });

  it('throws at the sandbox-create check point on mismatch', () => {
    assert.throws(
      () => assertTenantScopeConsistency('tenant-a', 'tenant-b', 'sandbox-create'),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /mismatch at sandbox-create/);
        return true;
      },
    );
  });

  it('throws at the audit check point on mismatch', () => {
    assert.throws(
      () => assertTenantScopeConsistency('tenant-a', 'tenant-b', 'audit'),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /mismatch at audit/);
        return true;
      },
    );
  });

  it('includes both expected and observed values in the error for forensics', () => {
    assert.throws(
      () => assertTenantScopeConsistency('expected-tenant', 'observed-tenant', 'claim'),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.ok(msg.includes('expected-tenant'), 'missing expected value');
        assert.ok(msg.includes('observed-tenant'), 'missing observed value');
        return true;
      },
    );
  });
});

// ─── lockImageByDigest ───────────────────────────────────────────────────────

describe('WS7 §5.2 lockImageByDigest', () => {
  const VALID_DIGEST = `sha256:${'a'.repeat(64)}`;

  it('produces a tag@digest ref for a valid tag and digest', () => {
    const locked = lockImageByDigest('node:22-slim', VALID_DIGEST);
    assert.strictEqual(locked.tag, 'node:22-slim');
    assert.strictEqual(locked.digest, VALID_DIGEST);
    assert.strictEqual(locked.ref, `node:22-slim@${VALID_DIGEST}`);
  });

  it('rejects an empty tag', () => {
    assert.throws(
      () => lockImageByDigest('', VALID_DIGEST),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /tag must be non-empty/);
        return true;
      },
    );
  });

  it('rejects a digest without the sha256: prefix', () => {
    assert.throws(
      () => lockImageByDigest('node:22-slim', 'a'.repeat(64)),
      SandboxInitializationError,
    );
  });

  it('rejects a digest with the wrong hash length', () => {
    assert.throws(
      () => lockImageByDigest('node:22-slim', 'sha256:abc'),
      SandboxInitializationError,
    );
  });

  it('rejects a digest with uppercase hex', () => {
    assert.throws(
      () => lockImageByDigest('node:22-slim', `sha256:${'A'.repeat(64)}`),
      SandboxInitializationError,
    );
  });

  it('rejects a digest with non-hex characters', () => {
    assert.throws(
      () => lockImageByDigest('node:22-slim', `sha256:${'g'.repeat(64)}`),
      SandboxInitializationError,
    );
  });

  it('accepts the SHA-256 of an empty string (real digest shape)', () => {
    const realDigest = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const locked = lockImageByDigest('ubuntu:22.04', realDigest);
    assert.strictEqual(locked.ref, `ubuntu:22.04@${realDigest}`);
  });
});

// ─── buildTenantSandboxPolicy ────────────────────────────────────────────────

describe('WS7 §5.1 buildTenantSandboxPolicy', () => {
  it('composes identity, profile, and server-generated names', () => {
    const frozenAt = '2026-07-16T00:00:00.000Z';
    const policy = buildTenantSandboxPolicy(VALID_IDENTITY, HARDENED, {
      now: () => frozenAt,
    });

    assert.deepStrictEqual(policy.identity, VALID_IDENTITY);
    assert.strictEqual(policy.profile, HARDENED);
    assert.strictEqual(policy.frozenAt, frozenAt);

    // All server-generated names are present and well-formed.
    assert.match(policy.containerName, /^commander-sbx-[0-9a-f]{32}$/);
    assert.match(policy.volumeName, /^commander-vol-[0-9a-f]{32}$/);
    assert.match(policy.networkNamespace, /^commander-net-[0-9a-f]{32}$/);
    assert.match(policy.workdir, /^\/workspace\/commander-[0-9a-f]{16}$/);
  });

  it('does NOT accept user-supplied container/volume/network/workdir names', () => {
    // The builder takes only identity + profile + image + now. There is no
    // parameter for containerName / volumeName / networkNamespace / workdir —
    // they are derived from the identity. This is the spec invariant:
    // "容器名和标签由服务端生成，不能由用户直接提供".
    const policy = buildTenantSandboxPolicy(VALID_IDENTITY, READ_ONLY);
    // Re-deriving from the same identity yields the same names — proving the
    // caller cannot inject a different name.
    const policy2 = buildTenantSandboxPolicy(VALID_IDENTITY, READ_ONLY);
    assert.strictEqual(policy.containerName, policy2.containerName);
    assert.strictEqual(policy.volumeName, policy2.volumeName);
    assert.strictEqual(policy.networkNamespace, policy2.networkNamespace);
    assert.strictEqual(policy.workdir, policy2.workdir);
  });

  it('attaches a digest-locked image when provided', () => {
    const digest = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const locked = lockImageByDigest('node:22-slim', digest);
    const policy = buildTenantSandboxPolicy(VALID_IDENTITY, HARDENED, {
      image: locked,
    });
    assert.strictEqual(policy.image, locked);
    assert.strictEqual(policy.image?.ref, `node:22-slim@${digest}`);
  });

  it('omits the image lock when not provided (dev path)', () => {
    const policy = buildTenantSandboxPolicy(VALID_IDENTITY, HARDENED);
    assert.strictEqual(policy.image, undefined);
  });

  it('throws on invalid identity before constructing any name', () => {
    assert.throws(
      () =>
        buildTenantSandboxPolicy({ ...VALID_IDENTITY, tenantId: '' }, HARDENED),
      SandboxInitializationError,
    );
  });

  it('freezes the policy with an ISO 8601 timestamp', () => {
    const ts = '2026-07-16T12:34:56.789Z';
    const policy = buildTenantSandboxPolicy(VALID_IDENTITY, HARDENED, {
      now: () => ts,
    });
    assert.strictEqual(policy.frozenAt, ts);
    // ISO 8601 shape — has the T separator and Z suffix.
    assert.match(policy.frozenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('uses the real clock by default for frozenAt', () => {
    const before = new Date().toISOString();
    const policy = buildTenantSandboxPolicy(VALID_IDENTITY, HARDENED);
    const after = new Date().toISOString();
    assert.ok(policy.frozenAt >= before, `frozenAt ${policy.frozenAt} < before ${before}`);
    assert.ok(policy.frozenAt <= after, `frozenAt ${policy.frozenAt} > after ${after}`);
  });

  it('different profiles do not change the server-generated names', () => {
    // Names are derived from identity only — the profile affects how the
    // sandbox runs, not what the resources are named.
    const hardened = buildTenantSandboxPolicy(VALID_IDENTITY, HARDENED);
    const readOnly = buildTenantSandboxPolicy(VALID_IDENTITY, READ_ONLY);
    assert.strictEqual(hardened.containerName, readOnly.containerName);
    assert.strictEqual(hardened.volumeName, readOnly.volumeName);
  });
});
