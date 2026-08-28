import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { TASK1_DATABASE_ROLES } from './canonicalBootstrap.js';
import { observeTask1DatabasePeers } from './task1DatabasePeer.js';

const LOGINS = {
  'adapter-ops': 'commander_adapter_ops',
  app: 'commander_app',
  owner: 'commander_owner',
  scheduler: 'commander_scheduler',
  'tenant-authority': 'commander_tenant_authority',
  worker: 'commander_worker',
} as const;

function certificate(): X509Certificate {
  const directory = mkdtempSync(join(tmpdir(), 'commander-peer-cert-'));
  const key = join(directory, 'tls.key');
  const cert = join(directory, 'tls.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-new',
      '-nodes',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-days',
      '2',
      '-subj',
      '/CN=db.example.test',
      '-addext',
      'subjectAltName=DNS:db.example.test',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  return new X509Certificate(readFileSync(cert));
}

class FakePool {
  constructor(
    private readonly login: string,
    private readonly cert: X509Certificate,
  ) {}
  async connect(): Promise<PoolClient> {
    return {
      connection: {
        stream: {
          encrypted: true,
          getPeerCertificate: () => ({ raw: this.cert.raw }),
        },
      },
      query: async () => ({
        rows: [
          {
            current_user: this.login,
            session_user: this.login,
            database_oid: '42',
            database_name: 'commander',
          },
        ],
        rowCount: 1,
      }),
      release: () => undefined,
    } as unknown as PoolClient;
  }
  async end(): Promise<void> {}
  on(): this {
    return this;
  }
}

describe('Task 1 six-role database peer observation', () => {
  it('binds every exact Commander login to one verified socket identity', async () => {
    const cert = certificate();
    const expectedSpki = createHash('sha256')
      .update(cert.publicKey.export({ format: 'der', type: 'spki' }))
      .digest('hex');
    const env: NodeJS.ProcessEnv = {
      COMMANDER_DATABASE_TLS_CA_FILE: '/run/ca.crt',
      COMMANDER_DATABASE_TLS_CA_MOUNT_IDENTITY: 'database-public-ca/v1',
      COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: expectedSpki,
    };
    for (const role of TASK1_DATABASE_ROLES) {
      env[`COMMANDER_${role.toUpperCase().replace('-', '_')}_DATABASE_URL`] =
        `postgres://${LOGINS[role]}:secret@db.example.test/commander?sslmode=verify-full`;
    }
    const observation = await observeTask1DatabasePeers(env, {
      readFile: (() => Buffer.from('ca')) as unknown as typeof import('node:fs').readFileSync,
      createPool: ((input) => {
        const login = decodeURIComponent(new URL(String(input.connectionString)).username);
        return new FakePool(login, cert) as unknown as Pool;
      }) as typeof import('@commander/postgres-runtime').createVerifiedPostgresPool,
    });
    assert.deepEqual(
      observation.input.roles.map(({ role }) => role),
      [...TASK1_DATABASE_ROLES],
    );
    assert.deepEqual(
      observation.binding.roles.map(({ role }) => role),
      [...TASK1_DATABASE_ROLES],
    );
    assert.equal(new Set(observation.binding.roles.map(({ databaseOid }) => databaseOid)).size, 1);
  });
});
