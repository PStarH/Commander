import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertComposeRoles,
  dsnRole,
  EXPECTED_WORKER_TENANTS,
  normalizeEnvironment,
  SERVICE_ROLE_MAP,
  type ComposeConfig,
} from './compose-role-assert.js';

/** Minimal cell compose config JSON (docker compose config --format json shape). */
const CELL_FIXTURE: ComposeConfig = {
  services: {
    'kernel-migrate': {
      environment: {
        DATABASE_URL: 'postgres://commander_owner:commander_owner@postgres:5432/commander',
        COMMANDER_KERNEL_DATABASE_URL:
          'postgres://commander_owner:commander_owner@postgres:5432/commander',
      },
      profiles: ['cell'],
    },
    api: {
      environment: {
        API_STORE_BACKEND: 'memory',
        COMMANDER_MEMORY_STORE: 'in-memory',
        DATABASE_URL: 'postgres://commander_app:commander_app@postgres:5432/commander',
        COMMANDER_KERNEL_DATABASE_URL:
          'postgres://commander_app:commander_app@postgres:5432/commander',
      },
      profiles: ['cell'],
    },
    'kernel-ops': {
      environment: {
        DATABASE_URL:
          'postgres://commander_scheduler:commander_scheduler@postgres:5432/commander',
      },
      profiles: ['cell'],
    },
    worker: {
      environment: {
        DATABASE_URL: 'postgres://commander_worker:commander_worker@postgres:5432/commander',
        COMMANDER_WORKER_TENANTS: 'local',
      },
      profiles: ['cell'],
    },
    'adapter-ops': {
      environment: {
        DATABASE_URL: 'postgres://commander_worker:commander_worker@postgres:5432/commander',
        COMMANDER_WORKER_TENANTS: 'local',
      },
      profiles: ['cell'],
    },
  },
};

/** Minimal root docker-compose.v2.yml merge shape (api/app, ops/scheduler, worker). */
const V2_FIXTURE: ComposeConfig = {
  services: {
    'kernel-migrate': {
      environment: {
        DATABASE_URL: 'postgres://commander_owner:commander_owner@postgres:5432/commander',
        COMMANDER_KERNEL_DATABASE_URL:
          'postgres://commander_owner:commander_owner@postgres:5432/commander',
      },
      profiles: ['v2'],
    },
    api: {
      environment: {
        API_STORE_BACKEND: 'memory',
        COMMANDER_MEMORY_STORE: 'in-memory',
        DATABASE_URL: 'postgres://commander_app:commander_app@postgres:5432/commander',
        COMMANDER_KERNEL_DATABASE_URL:
          'postgres://commander_app:commander_app@postgres:5432/commander',
        COMMANDER_DEFAULT_TENANT_ID: 'tenant-local',
      },
      profiles: ['v2'],
    },
    'kernel-ops': {
      environment: {
        DATABASE_URL:
          'postgres://commander_scheduler:commander_scheduler@postgres:5432/commander',
      },
      profiles: ['v2'],
    },
    worker: {
      environment: {
        DATABASE_URL: 'postgres://commander_worker:commander_worker@postgres:5432/commander',
        COMMANDER_WORKER_TENANTS: 'tenant-local',
      },
      profiles: ['v2'],
    },
  },
};

const V2_BENCH_FIXTURE: ComposeConfig = {
  services: {
    migrate: {
      environment: {
        DATABASE_URL: 'postgres://commander_owner:commander_owner@postgres:5432/commander',
      },
    },
    'api-1': {
      environment: {
        API_STORE_BACKEND: 'memory',
        COMMANDER_MEMORY_STORE: 'in-memory',
        DATABASE_URL: 'postgres://commander_app:commander_app@postgres:5432/commander',
      },
    },
    'api-2': {
      environment: {
        API_STORE_BACKEND: 'memory',
        COMMANDER_MEMORY_STORE: 'in-memory',
        DATABASE_URL: 'postgres://commander_app:commander_app@postgres:5432/commander',
      },
    },
    worker: {
      environment: {
        DATABASE_URL: 'postgres://commander_worker:commander_worker@postgres:5432/commander',
        COMMANDER_WORKER_TENANTS: 'tenant-0,tenant-1,tenant-2,tenant-3,tenant-4',
      },
    },
    'kernel-ops': {
      environment: {
        DATABASE_URL:
          'postgres://commander_scheduler:commander_scheduler@postgres:5432/commander',
      },
    },
  },
};

describe('compose-role-assert helpers', () => {
  it('parses DSN usernames', () => {
    assert.equal(
      dsnRole('postgres://commander_app:secret@postgres:5432/commander'),
      'commander_app',
    );
    assert.equal(dsnRole('postgresql://commander_owner@localhost/db'), 'commander_owner');
    assert.equal(dsnRole('not-a-dsn'), null);
  });

  it('normalizes array and object environments', () => {
    assert.deepEqual(normalizeEnvironment(['FOO=bar', 'BAZ=1']), { FOO: 'bar', BAZ: '1' });
    assert.deepEqual(normalizeEnvironment({ FOO: 'bar', N: 1 }), { FOO: 'bar', N: '1' });
  });

  it('maps services to expected roles', () => {
    assert.equal(SERVICE_ROLE_MAP['kernel-migrate'], 'commander_owner');
    assert.equal(SERVICE_ROLE_MAP.api, 'commander_app');
    assert.equal(SERVICE_ROLE_MAP['kernel-ops'], 'commander_scheduler');
    assert.equal(SERVICE_ROLE_MAP.worker, 'commander_worker');
    assert.equal(SERVICE_ROLE_MAP['adapter-ops'], 'commander_worker');
    assert.equal(EXPECTED_WORKER_TENANTS.cell, 'local');
    assert.equal(EXPECTED_WORKER_TENANTS.base, 'tenant-local');
    assert.equal(EXPECTED_WORKER_TENANTS.v2, 'tenant-local');
    assert.equal(
      EXPECTED_WORKER_TENANTS['v2-bench'],
      'tenant-0,tenant-1,tenant-2,tenant-3,tenant-4',
    );
  });
});

describe('assertComposeRoles', () => {
  it('passes cell fixture', () => {
    assert.doesNotThrow(() => assertComposeRoles(CELL_FIXTURE, 'cell'));
  });

  it('passes v2 fixture', () => {
    assert.doesNotThrow(() => assertComposeRoles(V2_FIXTURE, 'v2'));
  });

  it('rejects v2 shared commander login on api', () => {
    const bad: ComposeConfig = structuredClone(V2_FIXTURE);
    bad.services!.api!.environment = {
      DATABASE_URL: 'postgres://commander:commander@postgres:5432/commander',
    };
    assert.throws(() => assertComposeRoles(bad, 'v2'), /commander_app/);
  });

  it('passes v2-bench fixture', () => {
    assert.doesNotThrow(() => assertComposeRoles(V2_BENCH_FIXTURE, 'v2-bench'));
  });

  it('rejects an app-role API without isolated legacy stores', () => {
    const bad: ComposeConfig = structuredClone(CELL_FIXTURE);
    const env = bad.services!.api!.environment as Record<string, string>;
    delete env.COMMANDER_MEMORY_STORE;
    assert.throws(
      () => assertComposeRoles(bad, 'cell'),
      /API_STORE_BACKEND=memory|COMMANDER_MEMORY_STORE=in-memory/,
    );
  });

  it('rejects a v2-bench API replica using PostgreSQL legacy stores', () => {
    const bad: ComposeConfig = structuredClone(V2_BENCH_FIXTURE);
    bad.services!['api-1']!.environment = {
      ...(bad.services!['api-1']!.environment as Record<string, string>),
      API_STORE_BACKEND: 'postgres',
      COMMANDER_MEMORY_STORE: 'postgres',
    };
    assert.throws(
      () => assertComposeRoles(bad, 'v2-bench'),
      /API_STORE_BACKEND=memory|COMMANDER_MEMORY_STORE=in-memory/,
    );
  });

  it('accepts a cell tenant override when worker and adapter agree', () => {
    const override: ComposeConfig = structuredClone(CELL_FIXTURE);
    for (const name of ['worker', 'adapter-ops']) {
      override.services![name]!.environment = {
        ...(override.services![name]!.environment as Record<string, string>),
        COMMANDER_WORKER_TENANTS: 'cell-smoke-tenant',
        COMMANDER_CELL_TENANT_ID: 'cell-smoke-tenant',
      };
    }
    assert.doesNotThrow(() => assertComposeRoles(override, 'cell'));
  });

  it('rejects worker COMMANDER_WORKER_TENANTS=*', () => {
    const bad: ComposeConfig = structuredClone(CELL_FIXTURE);
    bad.services!.worker!.environment = {
      ...(bad.services!.worker!.environment as Record<string, string>),
      COMMANDER_WORKER_TENANTS: '*',
    };
    assert.throws(() => assertComposeRoles(bad, 'cell'), /\*/);
  });

  it('rejects api authenticated as owner', () => {
    const bad: ComposeConfig = structuredClone(CELL_FIXTURE);
    bad.services!.api!.environment = {
      DATABASE_URL: 'postgres://commander_owner:commander_owner@postgres:5432/commander',
    };
    assert.throws(() => assertComposeRoles(bad, 'cell'), /commander_app|owner/i);
  });

  it('rejects wrong cell worker tenant default', () => {
    const bad: ComposeConfig = structuredClone(CELL_FIXTURE);
    bad.services!.worker!.environment = {
      ...(bad.services!.worker!.environment as Record<string, string>),
      COMMANDER_WORKER_TENANTS: 'tenant-local',
    };
    assert.throws(() => assertComposeRoles(bad, 'cell'), /local/);
  });

  it('rejects missing worker tenants', () => {
    const bad: ComposeConfig = structuredClone(CELL_FIXTURE);
    const env = {
      ...(bad.services!.worker!.environment as Record<string, string>),
    };
    delete env.COMMANDER_WORKER_TENANTS;
    bad.services!.worker!.environment = env;
    assert.throws(() => assertComposeRoles(bad, 'cell'), /COMMANDER_WORKER_TENANTS/);
  });

  it('rejects missing adapter-ops tenants', () => {
    const bad: ComposeConfig = structuredClone(CELL_FIXTURE);
    const env = {
      ...(bad.services!['adapter-ops']!.environment as Record<string, string>),
    };
    delete env.COMMANDER_WORKER_TENANTS;
    bad.services!['adapter-ops']!.environment = env;
    assert.throws(() => assertComposeRoles(bad, 'cell'), /adapter-ops.*COMMANDER_WORKER_TENANTS/);
  });

  it('rejects adapter-ops COMMANDER_WORKER_TENANTS=*', () => {
    const bad: ComposeConfig = structuredClone(CELL_FIXTURE);
    bad.services!['adapter-ops']!.environment = {
      ...(bad.services!['adapter-ops']!.environment as Record<string, string>),
      COMMANDER_WORKER_TENANTS: '*',
    };
    assert.throws(() => assertComposeRoles(bad, 'cell'), /\*/);
  });

  it('accepts array-form environment from compose config', () => {
    const withArrays: ComposeConfig = {
      services: {
        'kernel-migrate': {
          environment: [
            'DATABASE_URL=postgres://commander_owner:commander_owner@postgres:5432/commander',
          ],
        },
        api: {
          environment: [
            'API_STORE_BACKEND=memory',
            'COMMANDER_MEMORY_STORE=in-memory',
            'DATABASE_URL=postgres://commander_app:commander_app@postgres:5432/commander',
          ],
        },
        'kernel-ops': {
          environment: [
            'DATABASE_URL=postgres://commander_scheduler:commander_scheduler@postgres:5432/commander',
          ],
        },
        worker: {
          environment: [
            'DATABASE_URL=postgres://commander_worker:commander_worker@postgres:5432/commander',
            'COMMANDER_WORKER_TENANTS=local',
          ],
        },
        'adapter-ops': {
          environment: [
            'DATABASE_URL=postgres://commander_worker:commander_worker@postgres:5432/commander',
            'COMMANDER_WORKER_TENANTS=local',
          ],
        },
      },
    };
    assert.doesNotThrow(() => assertComposeRoles(withArrays, 'cell'));
  });
});

describe('compose source files (static drift guard)', () => {
  it('cell/v2 compose YAML keep worker DSN role and explicit tenants', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const cell = await readFile(resolve(root, 'docker-compose.cell.yml'), 'utf8');
    const v2 = await readFile(resolve(root, 'docker-compose.v2.yml'), 'utf8');
    const v2Bench = await readFile(resolve(root, 'deploy/docker/v2-compose.yml'), 'utf8');

    for (const [name, text] of [
      ['docker-compose.cell.yml', cell],
      ['docker-compose.v2.yml', v2],
    ] as const) {
      assert.match(text, /commander_worker/, `${name} must reference commander_worker DSN`);
      assert.match(
        text,
        /COMMANDER_WORKER_TENANTS/,
        `${name} must set COMMANDER_WORKER_TENANTS`,
      );
      assert.doesNotMatch(
        text,
        /COMMANDER_WORKER_TENANTS\s*[:=]\s*['"]?\*/,
        `${name} must not set COMMANDER_WORKER_TENANTS=*`,
      );
      assert.match(
        text,
        /API_STORE_BACKEND=memory/,
        `${name} must keep the non-authoritative legacy API store in memory`,
      );
      assert.match(
        text,
        /COMMANDER_MEMORY_STORE=in-memory/,
        `${name} must keep the non-authoritative legacy memory store in memory`,
      );
    }

    assert.equal(
      v2Bench.match(/API_STORE_BACKEND:\s*memory/g)?.length,
      2,
      'deploy/docker/v2-compose.yml must isolate both API legacy stores',
    );
    assert.equal(
      v2Bench.match(/COMMANDER_MEMORY_STORE:\s*in-memory/g)?.length,
      2,
      'deploy/docker/v2-compose.yml must isolate both API memory stores',
    );

    const adapterBlock = cell.match(/^\s*adapter-ops:\s*\n(?:^\s{2,}.*\n)*/m)?.[0] ?? '';
    assert.ok(adapterBlock.length > 0, 'docker-compose.cell.yml must define adapter-ops');
    assert.match(adapterBlock, /commander_worker/, 'cell adapter-ops must use worker DSN');
    assert.doesNotMatch(adapterBlock, /commander_owner/, 'cell adapter-ops must not use owner DSN');
  });
});
