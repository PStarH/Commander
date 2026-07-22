import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CAPABILITY_AUTHORITY_REQUIRED,
  CAPABILITY_JWKS_JSON_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  createCapabilityAuthority,
} from '@commander/kernel';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import {
  assertEgressAllowlistBeforeDaemonStart,
  assertEgressUrlAllowed,
  cellTier,
  parseEgressAllowlist,
} from './egress.js';
import {
  assertAdapterOpsSchedulerModeForbidden,
  assertDurableCapabilityStores,
  assertNonOwnerDatabaseRole,
  assertNonOwnerDatabaseUrl,
  ADAPTER_OPS_COMPENSATION_WORKER_ID,
  ADAPTER_OPS_RECONCILE_WORKER_ID,
  type AdapterOpsWorkerRegistry,
  ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN,
  CAPABILITY_DURABLE_STORES_REQUIRED,
  COMMANDER_CELL_TENANT_ID_REQUIRED,
  compensationActionDigest,
  createAdapterOpsWiring,
  issueCompensationCapabilityToken,
  OWNER_DATABASE_ROLE_REJECTED,
  productionCapabilityBrokerOptions,
  registerAdapterOpsDaemonWorkers,
  WORKER_TENANT_SCOPE_REQUIRED,
} from './wiring.js';
import { canonicalRequestHash } from '@commander/effect-broker';

function ed25519Material(kid: string): {
  privateKeyPem: string;
  jwksJson: string;
  keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const jwksJson = JSON.stringify({
    keys: [{ kty: 'OKP', crv: 'Ed25519', kid, x: jwk.x, alg: 'EdDSA', use: 'sig' }],
  });
  return { privateKeyPem, jwksJson, keyId: kid };
}

const CAPABILITY_ENV_KEYS = [
  CAPABILITY_PRIVATE_KEY_PEM_ENV,
  CAPABILITY_KEY_ID_ENV,
  CAPABILITY_JWKS_JSON_ENV,
  'COMMANDER_REQUIRE_CAPABILITY_AUTHORITY',
] as const;

function snapshotCapabilityEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of CAPABILITY_ENV_KEYS) out[key] = process.env[key];
  return out;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearCapabilityEnv(): void {
  for (const key of CAPABILITY_ENV_KEYS) delete process.env[key];
}

class InMemoryAdapterOpsWorkerRegistry implements AdapterOpsWorkerRegistry {
  private readonly records = new Map<string, { id: string; generation: number; claimSecret: string }>();

  async initialize(): Promise<void> {}

  async register(definition: { id: string }): Promise<{ id: string; generation: number; claimSecret: string }> {
    const generation = (this.records.get(definition.id)?.generation ?? 0) + 1;
    const record = {
      id: definition.id,
      generation,
      claimSecret: `${definition.id}-claim-${generation}`,
    };
    this.records.set(definition.id, record);
    return record;
  }

  async get(workerId: string): Promise<{ id: string; generation: number; claimSecret: string } | null> {
    return this.records.get(workerId) ?? null;
  }
}

describe('adapter-ops run wiring', () => {
  it('starts reconciliation and compensation against sqlite kernel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-run-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    try {
      const wiring = await createAdapterOpsWiring();
      assert.equal(wiring.demoOpenHollowPep, false);
      wiring.reconciliation.start();
      wiring.compensation.start();
      assert.equal(typeof wiring.reconciliation.stop, 'function');
      await wiring.reconciliation.stop();
      await wiring.compensation.stop();
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('throws COMMANDER_CELL_TENANT_ID_REQUIRED when COMMANDER_CELL_TENANT_ID missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-no-tenant-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    delete process.env.COMMANDER_CELL_TENANT_ID;
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(COMMANDER_CELL_TENANT_ID_REQUIRED),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('refuses production authority without PEM/JWKS/key id before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-prod-auth-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    // Strict authority without NODE_ENV=production (sqlite refused in production).
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    delete process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV];
    delete process.env[CAPABILITY_KEY_ID_ENV];
    delete process.env[CAPABILITY_JWKS_JSON_ENV];
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('refuses COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 in production', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_CELL_TIER: process.env.COMMANDER_CELL_TIER,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
    };
    process.env.NODE_ENV = 'production';
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander:commander@127.0.0.1:5432/commander';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        /ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION/,
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('refuses COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 when COMMANDER_CELL_TIER=enterprise', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_CELL_TIER: process.env.COMMANDER_CELL_TIER,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    process.env.COMMANDER_CELL_TIER = 'enterprise';
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander:commander@127.0.0.1:5432/commander';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        /ADAPTER_OPS_DEMO_OPEN_FORBIDDEN_IN_PRODUCTION/,
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('switches to hollow PEP when COMMANDER_ADAPTER_OPS_DEMO_OPEN=1 outside production', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-demo-open-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN = '1';
    clearCapabilityEnv();
    try {
      const wiring = await createAdapterOpsWiring();
      assert.equal(wiring.demoOpenHollowPep, true);
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });
});

describe('adapter-ops authority startup gates', () => {
  it('rejects missing private key before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-miss-pem-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const mat = ed25519Material('kid-ops');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV];
    process.env[CAPABILITY_KEY_ID_ENV] = mat.keyId;
    process.env[CAPABILITY_JWKS_JSON_ENV] = mat.jwksJson;
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
          err.message.includes(CAPABILITY_PRIVATE_KEY_PEM_ENV),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('rejects missing JWKS before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-miss-jwks-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const mat = ed25519Material('kid-ops');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV] = mat.privateKeyPem;
    process.env[CAPABILITY_KEY_ID_ENV] = mat.keyId;
    delete process.env[CAPABILITY_JWKS_JSON_ENV];
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
          err.message.includes(CAPABILITY_JWKS_JSON_ENV),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('rejects missing key id before egress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-miss-kid-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const mat = ed25519Material('kid-ops');
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    process.env.COMMANDER_REQUIRE_CAPABILITY_AUTHORITY = '1';
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    process.env[CAPABILITY_PRIVATE_KEY_PEM_ENV] = mat.privateKeyPem;
    delete process.env[CAPABILITY_KEY_ID_ENV];
    process.env[CAPABILITY_JWKS_JSON_ENV] = mat.jwksJson;
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith(CAPABILITY_AUTHORITY_REQUIRED) &&
          err.message.includes(CAPABILITY_KEY_ID_ENV),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('rejects owner-role DSN userinfo before egress (no false-positive on worker-url)', () => {
    assert.throws(
      () =>
        assertNonOwnerDatabaseUrl(
          'postgres://commander_owner:commander_owner@postgres:5432/commander',
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.doesNotThrow(() =>
      assertNonOwnerDatabaseUrl(
        'postgres://commander_worker:commander_worker@postgres:5432/commander',
      ),
    );
  });

  it('rejects post-connect current_user matching owner or scheduler', () => {
    assert.throws(
      () => assertNonOwnerDatabaseRole('commander_owner'),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.throws(
      () => assertNonOwnerDatabaseRole('commander_scheduler'),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
    assert.doesNotThrow(() => assertNonOwnerDatabaseRole('commander_worker'));
  });

  it('rejects COMMANDER_KERNEL_SCHEDULER_MODE=1', () => {
    assert.throws(
      () => assertAdapterOpsSchedulerModeForbidden({ COMMANDER_KERNEL_SCHEDULER_MODE: '1' }),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(ADAPTER_OPS_SCHEDULER_MODE_FORBIDDEN),
    );
    assert.doesNotThrow(() =>
      assertAdapterOpsSchedulerModeForbidden({ COMMANDER_KERNEL_SCHEDULER_MODE: '0' }),
    );
  });

  it('rejects scheduler-role DSN userinfo', () => {
    assert.throws(
      () =>
        assertNonOwnerDatabaseUrl(
          'postgres://commander_scheduler:x@postgres:5432/commander',
        ),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
    );
  });

  it('rejects owner DSN via createAdapterOpsWiring before egress registry', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_PROFILE: process.env.COMMANDER_PROFILE,
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_DATABASE_URL: process.env.COMMANDER_KERNEL_DATABASE_URL,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_PROFILE;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    process.env.COMMANDER_KERNEL_BACKEND = 'postgres';
    process.env.COMMANDER_KERNEL_DATABASE_URL =
      'postgres://commander_owner:commander_owner@127.0.0.1:5432/commander';
    try {
      await assert.rejects(
        () => createAdapterOpsWiring(),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(OWNER_DATABASE_ROLE_REJECTED),
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it('rejects unavailable replay store before egress', () => {
    const mat = ed25519Material('kid-replay');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          isCapabilityRevoked: () => false,
          revokeCapability: async () => undefined,
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        err.message.includes('consumeCapabilityReplay'),
    );
  });

  it('rejects unavailable revocation store before egress', () => {
    const mat = ed25519Material('kid-rev');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(capability, {
          consumeCapabilityReplay: async () => false,
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        /isCapabilityRevoked|revokeCapability/.test(err.message),
    );
  });

  it('wires durable replay + revocations options from createCapabilityAuthority', () => {
    const mat = ed25519Material('kid-ok');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assertDurableCapabilityStores(capability, repo);
    const opts = productionCapabilityBrokerOptions(
      capability,
      ADAPTER_OPS_COMPENSATION_WORKER_ID,
      3,
    );
    assert.ok(opts.replay);
    assert.equal(typeof opts.replay, 'function');
    assert.ok(opts.revocations);
    assert.equal(opts.requireDurableCapabilityStores, true);
    assert.equal(opts.localWorkerId, ADAPTER_OPS_COMPENSATION_WORKER_ID);
    assert.equal(opts.localWorkerGeneration, 3);
    assert.equal(capability.generated, false);
  });

  it('rejects replayForTenant factory that returns a non-consume store', () => {
    const mat = ed25519Material('kid-shape');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    assert.throws(
      () =>
        assertDurableCapabilityStores(
          {
            ...capability,
            replayForTenant: () => ({}) as never,
          },
          repo,
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CAPABILITY_DURABLE_STORES_REQUIRED) &&
        err.message.includes('consume()'),
    );
  });
});

describe('adapter-ops P0 worker registry + compensation mint', () => {
  it('registers both daemon identities and pins compensation affinity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-reg-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_WORKER_TENANTS: process.env.COMMANDER_WORKER_TENANTS,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    process.env.COMMANDER_WORKER_TENANTS = 'tenant-a,tenant-b';
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();

    const workerRegistry = new InMemoryAdapterOpsWorkerRegistry();
    const registerCalls: string[] = [];
    const originalRegister = workerRegistry.register.bind(workerRegistry);
    workerRegistry.register = async (definition, identitySubject, tenantIds) => {
      registerCalls.push(definition.id);
      return originalRegister(definition, identitySubject, tenantIds);
    };

    try {
      const wiring = await createAdapterOpsWiring({ workerRegistry });
      assert.deepEqual(registerCalls.sort(), [
        ADAPTER_OPS_COMPENSATION_WORKER_ID,
        ADAPTER_OPS_RECONCILE_WORKER_ID,
      ].sort());
      assert.equal(wiring.compensationLocalWorkerId, ADAPTER_OPS_COMPENSATION_WORKER_ID);
      assert.equal(wiring.workers.compensation.id, ADAPTER_OPS_COMPENSATION_WORKER_ID);
      assert.equal(wiring.workers.reconcile.id, ADAPTER_OPS_RECONCILE_WORKER_ID);
      assert.ok(wiring.workers.reconcile.generation >= 1);
      assert.ok(wiring.workers.compensation.generation >= 1);
      assert.equal(
        (await workerRegistry.get(ADAPTER_OPS_RECONCILE_WORKER_ID))?.id,
        ADAPTER_OPS_RECONCILE_WORKER_ID,
      );
      assert.equal(
        (await workerRegistry.get(ADAPTER_OPS_COMPENSATION_WORKER_ID))?.id,
        ADAPTER_OPS_COMPENSATION_WORKER_ID,
      );
      await wiring.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('fail-closed when registry required but COMMANDER_WORKER_TENANTS missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-tenants-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const saved = {
      COMMANDER_KERNEL_BACKEND: process.env.COMMANDER_KERNEL_BACKEND,
      COMMANDER_KERNEL_SQLITE_PATH: process.env.COMMANDER_KERNEL_SQLITE_PATH,
      COMMANDER_CELL_TENANT_ID: process.env.COMMANDER_CELL_TENANT_ID,
      COMMANDER_WORKER_TENANTS: process.env.COMMANDER_WORKER_TENANTS,
      NODE_ENV: process.env.NODE_ENV,
      COMMANDER_ADAPTER_OPS_DEMO_OPEN: process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN,
      ...snapshotCapabilityEnv(),
    };
    process.env.COMMANDER_KERNEL_BACKEND = 'sqlite';
    process.env.COMMANDER_KERNEL_SQLITE_PATH = dbPath;
    process.env.COMMANDER_CELL_TENANT_ID = 'local';
    delete process.env.COMMANDER_WORKER_TENANTS;
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_ADAPTER_OPS_DEMO_OPEN;
    clearCapabilityEnv();
    try {
      await assert.rejects(
        () => createAdapterOpsWiring({ workerRegistry: new InMemoryAdapterOpsWorkerRegistry() }),
        (err: unknown) =>
          err instanceof Error && err.message.startsWith(WORKER_TENANT_SCOPE_REQUIRED),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('registerAdapterOpsDaemonWorkers writes both worker rows', async () => {
    const registry = new InMemoryAdapterOpsWorkerRegistry();
    const result = await registerAdapterOpsDaemonWorkers(registry, ['tenant-a']);
    assert.equal(result.reconcile.id, ADAPTER_OPS_RECONCILE_WORKER_ID);
    assert.equal(result.compensation.id, ADAPTER_OPS_COMPENSATION_WORKER_ID);
    assert.equal((await registry.get(ADAPTER_OPS_RECONCILE_WORKER_ID))?.generation, 1);
    assert.equal((await registry.get(ADAPTER_OPS_COMPENSATION_WORKER_ID))?.generation, 1);
    assert.ok(result.reconcile.claimSecret, 'reconcile register must return claimSecret');
    assert.ok(result.compensation.claimSecret, 'compensation register must return claimSecret');
    assert.notEqual(result.reconcile.claimSecret, result.compensation.claimSecret);
  });

  it('compensation mint includes Class A actionDigest of type+patch', async () => {
    const mat = ed25519Material('kid-cmp');
    const repo = new InMemoryKernelRepository();
    const capability = createCapabilityAuthority(
      {
        NODE_ENV: 'test',
        [CAPABILITY_PRIVATE_KEY_PEM_ENV]: mat.privateKeyPem,
        [CAPABILITY_KEY_ID_ENV]: mat.keyId,
        [CAPABILITY_JWKS_JSON_ENV]: mat.jwksJson,
      },
      repo,
    );
    const action = 'compensate.github.pull-request.create';
    const payload = { originalEffectId: 'e1', compensationPatch: { state: 'closed' } };
    const token = issueCompensationCapabilityToken({
      issuer: capability.issuer,
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      action,
      payload,
      workerId: ADAPTER_OPS_COMPENSATION_WORKER_ID,
      workerGeneration: 2,
    });
    const grant = await capability.verifier.verify(token);
    assert.equal(grant.requestHash, canonicalRequestHash(payload));
    assert.equal(grant.actionDigest, compensationActionDigest(action, payload));
    assert.notEqual(grant.actionDigest, grant.requestHash);
    assert.equal(grant.workloadId, ADAPTER_OPS_COMPENSATION_WORKER_ID);
    assert.equal(grant.workerId, ADAPTER_OPS_COMPENSATION_WORKER_ID);
    assert.equal(grant.workerGeneration, 2);
    // jti must be opaque UUID (not deterministic ops-+Date.now()).
    assert.match(grant.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe('adapter-ops egress fail-closed', () => {
  it('cellTier defaults to non-demo when COMMANDER_CELL_TIER is unset/empty', () => {
    assert.notEqual(cellTier({}), 'demo');
    assert.notEqual(cellTier({ COMMANDER_CELL_TIER: '' }), 'demo');
    assert.equal(cellTier({ COMMANDER_CELL_TIER: 'demo' }), 'demo');
    // Fail-closed default must trip the allowlist gate exactly like any other non-demo tier.
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart(cellTier({}), []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
  });

  it('parses allowlist CSV', () => {
    assert.deepEqual(
      parseEgressAllowlist({ COMMANDER_ADAPTER_EGRESS_ALLOWLIST: ' api.github.com, *.service-now.com ' }),
      ['api.github.com', '*.service-now.com'],
    );
  });

  it('blocks daemon start on non-demo without allowlist', () => {
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('enterprise', []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('standard', []),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_REQUIRED/,
    );
  });

  it('allows demo tier with empty allowlist', () => {
    assert.doesNotThrow(() => assertEgressAllowlistBeforeDaemonStart('demo', []));
  });

  it('allows non-demo when allowlist is non-empty', () => {
    assert.doesNotThrow(() =>
      assertEgressAllowlistBeforeDaemonStart('enterprise', ['api.github.com']),
    );
  });

  it('denies transport hosts outside hostname allowlist', () => {
    assert.throws(
      () => assertEgressUrlAllowed('https://evil.example/x', ['api.github.com']),
      /ADAPTER_OPS_EGRESS_DENIED/,
    );
    assert.doesNotThrow(() =>
      assertEgressUrlAllowed('https://api.github.com/repos/o/r', ['api.github.com']),
    );
  });
});
