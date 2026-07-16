/**
 * WS7 fail-closed behavior tests.
 *
 * Covers the Phase 1 audit resolutions:
 *  - Resolution 1: COMMANDER_SANDBOX_ISOLATION parsing, gvisor no-silent-fallback,
 *    production Noop refuse.
 *  - Resolution 4 (tenant policy layer) is covered in
 *    `tenantSandboxPolicy.test.ts`.
 *
 * Spec references:
 *  - §2 isolation levels & defaults
 *  - §3 production prohibited bypasses
 *  - §4.1 worker boot fail-closed
 *  - §6 Phase 2 Build: "至少覆盖：无沙箱启动拒绝、旁路配置拒绝、禁止 host exec、
 *    每租户容器不复用、容器创建失败不执行"
 *
 * The production-mode tests manipulate `process.env.NODE_ENV` under a save /
 * restore guard so they cannot leak into sibling tests in the same suite.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  SandboxManager,
  SandboxInitializationError,
  parseSandboxIsolation,
} from '../src/sandbox/manager';
import { NoopSB } from '../src/sandbox/platforms';

// ─── Env save/restore helpers ────────────────────────────────────────────────
// NODE_ENV and COMMANDER_* vars are process-global. We save them before each
// production-mode test and restore after, so the test suite is hermetic.

const ENV_KEYS = [
  'NODE_ENV',
  'COMMANDER_SANDBOX_ISOLATION',
  'COMMANDER_ALLOW_NO_SANDBOX',
  'COMMANDER_ALLOW_UNCHECKED_EXEC',
] as const;

type EnvSnapshot = Record<(typeof ENV_KEYS)[number], string | undefined>;

function snapshotEnv(): EnvSnapshot {
  const snap = {} as EnvSnapshot;
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function setProductionEnv(overrides: Record<string, string> = {}): void {
  process.env.NODE_ENV = 'production';
  // Clean slate — production tests must not inherit dev bypasses or isolation
  // selections from sibling tests or CI env.
  delete process.env.COMMANDER_ALLOW_NO_SANDBOX;
  delete process.env.COMMANDER_ALLOW_UNCHECKED_EXEC;
  delete process.env.COMMANDER_SANDBOX_ISOLATION;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
}

// ─── parseSandboxIsolation ───────────────────────────────────────────────────

describe('WS7 §2 parseSandboxIsolation', () => {
  it('returns undefined when unset in non-production', () => {
    const result = parseSandboxIsolation({ NODE_ENV: 'development' });
    assert.strictEqual(result, undefined);
  });

  it('returns the explicit value when set to a valid level in non-production', () => {
    assert.strictEqual(
      parseSandboxIsolation({ NODE_ENV: 'development', COMMANDER_SANDBOX_ISOLATION: 'docker' }),
      'docker',
    );
    assert.strictEqual(
      parseSandboxIsolation({ NODE_ENV: 'development', COMMANDER_SANDBOX_ISOLATION: 'gvisor' }),
      'gvisor',
    );
    assert.strictEqual(
      parseSandboxIsolation({ NODE_ENV: 'development', COMMANDER_SANDBOX_ISOLATION: 'process' }),
      'process',
    );
  });

  it('normalizes case and trims whitespace', () => {
    assert.strictEqual(
      parseSandboxIsolation({ NODE_ENV: 'development', COMMANDER_SANDBOX_ISOLATION: '  DOCKER  ' }),
      'docker',
    );
    assert.strictEqual(
      parseSandboxIsolation({ NODE_ENV: 'development', COMMANDER_SANDBOX_ISOLATION: 'GVisor' }),
      'gvisor',
    );
  });

  it('defaults to docker in production when unset', () => {
    assert.strictEqual(parseSandboxIsolation({ NODE_ENV: 'production' }), 'docker');
  });

  it('accepts gvisor in production (explicit selection, no degrade)', () => {
    assert.strictEqual(
      parseSandboxIsolation({ NODE_ENV: 'production', COMMANDER_SANDBOX_ISOLATION: 'gvisor' }),
      'gvisor',
    );
  });

  it('rejects process isolation in production', () => {
    assert.throws(
      () =>
        parseSandboxIsolation({
          NODE_ENV: 'production',
          COMMANDER_SANDBOX_ISOLATION: 'process',
        }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError, 'should be SandboxInitializationError');
        assert.match((err as Error).message, /process.*rejected/i);
        return true;
      },
    );
  });

  it('returns undefined for an unknown isolation string in non-production', () => {
    // Unknown values are not normalized to a default — they fall through.
    assert.strictEqual(
      parseSandboxIsolation({
        NODE_ENV: 'development',
        COMMANDER_SANDBOX_ISOLATION: 'kube',
      }),
      undefined,
    );
  });

  it('falls back to docker in production for an unknown isolation string', () => {
    assert.strictEqual(
      parseSandboxIsolation({
        NODE_ENV: 'production',
        COMMANDER_SANDBOX_ISOLATION: 'kube',
      }),
      'docker',
    );
  });
});

// ─── SandboxManager production fail-closed ───────────────────────────────────

describe('WS7 §3/§4.1 SandboxManager production fail-closed', () => {
  let snap: EnvSnapshot;

  before(() => {
    snap = snapshotEnv();
  });

  after(() => {
    restoreEnv(snap);
  });

  it('production: refuses to construct when no sandbox backend is available', () => {
    setProductionEnv();
    assert.throws(
      () => new SandboxManager({ sandboxes: [], allowNoSandbox: false }),
      SandboxInitializationError,
    );
  });

  it('production: ignores COMMANDER_ALLOW_NO_SANDBOX and still refuses', () => {
    setProductionEnv({ COMMANDER_ALLOW_NO_SANDBOX: 'true' });
    // Constructor reads the env flag via allowNoSandboxFallback() when deps
    // don't override it. In production the flag must be ignored.
    assert.throws(
      () => new SandboxManager({ sandboxes: [] }),
      SandboxInitializationError,
    );
  });

  it('production: does not fall back to NoopSB even when allowNoSandbox is passed true', () => {
    setProductionEnv();
    // The constructor forces allowNoSandbox=false in production, so the
    // NoopSB fallback in getSandbox() must be unreachable.
    assert.throws(
      () => new SandboxManager({ sandboxes: [], allowNoSandbox: true }),
      SandboxInitializationError,
    );
  });

  it('production: gvisor isolation does not degrade to docker when runsc is absent', () => {
    setProductionEnv({ COMMANDER_SANDBOX_ISOLATION: 'gvisor' });
    // The constructor does NOT validate isolation-match — that happens at
    // getSandbox(). We inject a NoopSB-as-docker placeholder to prove the
    // isolation filter in getSandbox() rejects it: gvisor must NOT silently
    // fall back to the available docker backend.
    const fakeDocker = new NoopSB() as unknown as { name: 'docker' };
    const manager = new SandboxManager({
      sandboxes: [fakeDocker],
      isolation: 'gvisor',
      allowNoSandbox: false,
    });
    assert.throws(
      () => manager.getSandbox(),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /gvisor/i);
        return true;
      },
    );
  });

  it('production: gvisor isolation throws at getSandbox when runsc backend is missing', () => {
    setProductionEnv();
    // Construct with at least one sandbox so construction succeeds, then
    // ask for gvisor — must throw rather than fall back to the available
    // docker/noop backend.
    const fakeDocker = new NoopSB() as unknown as { name: 'docker' };
    const manager = new SandboxManager({
      sandboxes: [fakeDocker],
      isolation: 'gvisor',
      allowNoSandbox: false,
    });
    assert.throws(
      () => manager.getSandbox(),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.match((err as Error).message, /gvisor/i);
        return true;
      },
    );
  });

  it('non-production: respects COMMANDER_ALLOW_NO_SANDBOX for dev escape hatch', () => {
    setProductionEnv({ NODE_ENV: 'development', COMMANDER_ALLOW_NO_SANDBOX: 'true' });
    const manager = new SandboxManager({ sandboxes: [], allowNoSandbox: true });
    assert.strictEqual(manager.hasSandbox(), false);
    // NoopSB is reachable in dev when the bypass is explicit.
    const sb = manager.getSandbox();
    assert.strictEqual(sb.name, 'none');
  });
});

// ─── §6 "禁止 host exec" — NoopSB is not a host-exec path ────────────────────
//
// The WS7 audit R-4 calls out NoopSB as the production Noop fallback. NoopSB
// itself is NOT a host exec primitive — it runs commands via spawn() with
// shell: false, which is the safe argv form. But in production, NoopSB must
// never be reachable at all because it does not enforce the sandbox profile.
// That is covered above. Here we verify NoopSB still refuses non-full-access
// profiles, so even if it were reached it would not silently execute a
// network-blocked command unsandboxed.

describe('WS7 §6 NoopSB refuses to mask profile violations', () => {
  // The SandboxManager.execute() path loads a sandbox-escape detector via
  // require(). Under tsx/ESM that require() throws, which triggers the
  // fail-closed branch. We set COMMANDER_ALLOW_UNCHECKED_EXEC=1 to bypass
  // the detector so these tests exercise NoopSB's own profile enforcement
  // (the WS7 §6 invariant) rather than the detector's fail-closed path.
  // The detector's fail-closed behaviour is covered separately by the
  // ws7-boot-refuse.yml CI workflow which runs under real Node ESM.

  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    process.env.COMMANDER_ALLOW_UNCHECKED_EXEC = '1';
  });
  after(() => {
    restoreEnv(snap);
  });

  it('NoopSB refuses workspace-write (blocked network) profile', async () => {
    const manager = new SandboxManager({ sandboxes: [], allowNoSandbox: true });
    const result = await manager.execute('echo should-be-blocked');
    assert.strictEqual(result.exitCode, 126);
    assert.ok(
      result.violated?.includes('network_policy_not_enforceable'),
      `expected violated to include network_policy_not_enforceable, got: ${JSON.stringify(result.violated)}`,
    );
  });

  it('NoopSB only executes when the profile is explicitly full-access', async () => {
    const manager = new SandboxManager({ sandboxes: [], allowNoSandbox: true });
    const result = await manager.execute('echo hello-ws7-noop', 'full-access');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello-ws7-noop'));
  });
});

// ─── §6 "每租户容器不复用" — different identities yield different names ──────
//
// This is the high-level invariant. The detailed per-field validation and
// name-generation tests live in `tenantSandboxPolicy.test.ts`. Here we verify
// the cross-cutting property: two distinct workload identities never share a
// container name, volume name, or workdir.

describe('WS7 §6 per-tenant container non-reuse (cross-cutting)', () => {
  it('different workload identities produce different container/volume/workdir names', async () => {
    const { buildTenantSandboxPolicy } = await import('../src/sandbox/tenantSandboxPolicy');
    const { HARDENED } = await import('../src/sandbox/profiles');

    const identityA = {
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-2',
      workloadId: 'wl-001',
    };
    const identityB = {
      tenantId: 'tenant-b',
      runId: 'run-1',
      stepId: 'step-2',
      workloadId: 'wl-001',
    };

    const policyA = buildTenantSandboxPolicy(identityA, HARDENED, {
      now: () => '2026-07-16T00:00:00.000Z',
    });
    const policyB = buildTenantSandboxPolicy(identityB, HARDENED, {
      now: () => '2026-07-16T00:00:00.000Z',
    });

    assert.notStrictEqual(policyA.containerName, policyB.containerName);
    assert.notStrictEqual(policyA.volumeName, policyB.volumeName);
    assert.notStrictEqual(policyA.networkNamespace, policyB.networkNamespace);
    assert.notStrictEqual(policyA.workdir, policyB.workdir);

    // Same identity must yield the same names (deterministic).
    const policyA2 = buildTenantSandboxPolicy(identityA, HARDENED, {
      now: () => '2026-07-16T00:00:00.000Z',
    });
    assert.strictEqual(policyA.containerName, policyA2.containerName);
    assert.strictEqual(policyA.volumeName, policyA2.volumeName);
  });
});
