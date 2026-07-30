import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Task1ReadinessProof } from '../src/task1ReadinessProof.js';
import {
  createTask1ProofHttpsServer,
  createTask1ReadinessDatabasePools,
  loadTask1ProofTlsMaterial,
  parseTask1ReadinessEnvironment,
  pollTask1RuntimeIdentity,
  readTask1DatabaseIdentity,
  runTask1TenantSelfCheck,
  type Task1QueryClient,
  type Task1QueryPool,
} from '../src/task1ReadinessRuntime.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);

class RecordingClient implements Task1QueryClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly releases: Array<Error | boolean | undefined> = [];
  constructor(private readonly answer: (text: string) => { rows: unknown[] }) {}
  async query(text: string, values?: readonly unknown[]): Promise<{ rows: never[] }> {
    this.calls.push({ text, values });
    return this.answer(text) as { rows: never[] };
  }
  release(error?: Error | boolean): void { this.releases.push(error); }
}

class Pool implements Task1QueryPool {
  constructor(readonly client: RecordingClient) {}
  connect(): Promise<Task1QueryClient> { return Promise.resolve(this.client); }
  query(text: string, values?: readonly unknown[]): Promise<{ rows: never[] }> {
    return this.client.query(text, values);
  }
}

function proof(now = 1_000): Task1ReadinessProof {
  return new Task1ReadinessProof({
    nowMonotonicMs: () => now,
    installationId: '11111111-1111-4111-8111-111111111111',
    databasePeerBindingSha256: digest('d'),
    expectedPhase: 'enforce',
    expectedImageDigest: `sha256:${digest('a')}`,
    expectedConfigurationSha256: digest('c'),
  });
}

function responseStatus(state: Task1ReadinessProof, challenge?: string): number {
  let statusCode = 200;
  state.handle(
    {
      method: 'GET',
      url: '/ready/tenant-authority/v1',
      rawHeaders: challenge ? ['X-Commander-Readiness-Challenge', challenge] : [],
    },
    {
      status(value) { statusCode = value; return this; },
      setHeader() {},
      end() {},
    },
  );
  return statusCode;
}

describe('Task 1 readiness runtime', () => {
  it('runs issue, bind, canonical resolve, and close without product DML', async () => {
    const app = new RecordingClient((text) => {
      if (text.includes('pg_backend_pid')) {
        return { rows: [{ database_oid: 16_384, backend_pid: 91, xid: '9223372036854775808' }] };
      }
      if (text.includes('bind_app_tenant_context')) {
        return { rows: [{ tenant_id: 'commander/readiness/v1' }] };
      }
      if (text.includes('commander_authenticated_app_tenant')) {
        return { rows: [{ tenant_id: 'commander/readiness/v1' }] };
      }
      return { rows: [] };
    });
    const authority = new RecordingClient((text) =>
      text.includes('issue_app_tenant_context')
        ? { rows: [{ context_id: '11111111-1111-4111-8111-111111111111' }] }
        : { rows: [] },
    );
    const state = proof();

    await runTask1TenantSelfCheck(state, new Pool(app), new Pool(authority));

    assert.equal(responseStatus(state), 200);
    assert.equal(app.calls.length, 6);
    assert.equal(app.calls[0]!.text, 'BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.match(app.calls[1]!.text, /pg_current_xact_id\(\)::text/);
    assert.match(app.calls[2]!.text, /bind_app_tenant_context/);
    assert.match(app.calls[4]!.text, /close_app_tenant_context/);
    assert.equal(app.calls[5]!.text, 'COMMIT');
    assert.equal(authority.calls.length, 1);
    assert.match(authority.calls[0]!.text, /issue_app_tenant_context/);
    assert.deepEqual(authority.calls[0]!.values, [
      'commander/readiness/v1', 16_384, 91, '9223372036854775808',
    ]);
    assert.deepEqual(app.releases, [undefined]);
    assert.deepEqual(authority.releases, [undefined]);
    assert.doesNotMatch(app.calls.map(({ text }) => text).join('\n'), /INSERT|UPDATE|DELETE/i);
  });

  it('invalidates readiness and rolls back when any context step fails', async () => {
    const app = new RecordingClient((text) => {
      if (text.includes('pg_backend_pid')) {
        return { rows: [{ database_oid: 1, backend_pid: 2, xid: '3' }] };
      }
      if (text.includes('bind_app_tenant_context')) throw new Error('TENANT_CONTEXT_INVALID');
      return { rows: [] };
    });
    const authority = new RecordingClient(() => ({
      rows: [{ context_id: '11111111-1111-4111-8111-111111111111' }],
    }));
    const state = proof();
    state.recordTenantSelfCheck(true);

    await assert.rejects(
      runTask1TenantSelfCheck(state, new Pool(app), new Pool(authority)),
      /TENANT_CONTEXT_INVALID/,
    );
    assert.equal(responseStatus(state), 503);
    assert.equal(app.calls.at(-1)!.text, 'ROLLBACK');
    assert.equal(app.releases.length, 1);
    assert.ok(app.releases[0] instanceof Error);
    assert.equal(authority.releases.length, 1);
    assert.equal(authority.releases[0], undefined);
  });

  it('destroys an authority client after a query failure instead of returning it to the pool', async () => {
    const authority = new RecordingClient(() => {
      throw new Error('authority query timed out');
    });
    const state = proof();

    await assert.rejects(
      pollTask1RuntimeIdentity(state, new Pool(authority)),
      /authority query timed out/,
    );

    assert.equal(authority.releases.length, 1);
    assert.ok(authority.releases[0] instanceof Error);
  });

  it('polls only the bounded identity RPC and invalidates mismatched results', async () => {
    const challenge = Buffer.alloc(32, 4).toString('base64url');
    const state = proof();
    state.recordTenantSelfCheck(true);
    const matching = new Pool(new RecordingClient(() => ({ rows: [{
      operation_version_text: '19',
      runtime_phase: 'enforce',
      api_image_digest: `sha256:${digest('a')}`,
      configuration_sha256: digest('c'),
    }] })));

    await pollTask1RuntimeIdentity(state, matching);
    assert.equal(responseStatus(state, challenge), 200);
    assert.equal(matching.client.calls.length, 1);
    assert.match(matching.client.calls[0]!.text, /commander_runtime_configuration_identity\(\)/);

    await assert.rejects(
      pollTask1RuntimeIdentity(state, new Pool(new RecordingClient(() => ({ rows: [] })))),
      /TASK1_RUNTIME_IDENTITY_INVALID/,
    );
    assert.equal(responseStatus(state, challenge), 503);
  });

  it('keeps a still-fresh identity usable while the next poll is in flight', async () => {
    const challenge = Buffer.alloc(32, 7).toString('base64url');
    const state = proof();
    state.recordTenantSelfCheck(true);
    state.recordRuntimeIdentity({
      operationVersion: '18',
      phase: 'enforce',
      imageDigest: `sha256:${digest('a')}`,
      configurationSha256: digest('c'),
    });
    let resolveQuery!: (value: { rows: never[] }) => void;
    const pending = new Promise<{ rows: never[] }>((resolve) => { resolveQuery = resolve; });
    const pollingClient: Task1QueryClient = {
      query: () => pending,
      release: () => undefined,
    };
    const pollingPool: Task1QueryPool = {
      connect: () => Promise.resolve(pollingClient),
      query: () => Promise.reject(new Error('not used')),
    };

    const poll = pollTask1RuntimeIdentity(state, pollingPool);
    await Promise.resolve();
    assert.equal(responseStatus(state, challenge), 200);
    resolveQuery({ rows: [{
      operation_version_text: '19',
      runtime_phase: 'enforce',
      api_image_digest: `sha256:${digest('a')}`,
      configuration_sha256: digest('c'),
    }] as never[] });
    await poll;
  });

  it('enables only expand/enforce with distinct app and authority DSNs', () => {
    assert.equal(parseTask1ReadinessEnvironment({}), undefined);
    const env = {
      COMMANDER_TENANT_AUTHORITY_CUTOVER_PHASE: 'expand',
      COMMANDER_TENANT_AUTHORITY_PROOF_PORT: '9443',
      COMMANDER_TENANT_AUTHORITY_PROOF_CERT_FILE: '/run/proof/tls.crt',
      COMMANDER_TENANT_AUTHORITY_PROOF_KEY_FILE: '/run/proof/tls.key',
      COMMANDER_TENANT_AUTHORITY_PROOF_DNS_NAME: 'api.commander.svc.cluster.local',
      COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST: `sha256:${digest('a')}`,
      COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256: digest('c'),
      DATABASE_URL: 'postgres://commander_app:app@db/commander?sslmode=verify-full',
      COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
        'postgres://commander_tenant_authority:authority@db/commander?sslmode=verify-full',
    };
    assert.deepEqual(parseTask1ReadinessEnvironment(env), {
      phase: 'expand',
      port: 9443,
      certFile: '/run/proof/tls.crt',
      keyFile: '/run/proof/tls.key',
      proofDnsName: 'api.commander.svc.cluster.local',
      imageDigest: `sha256:${digest('a')}`,
      configurationSha256: digest('c'),
      appDatabaseUrl: env.DATABASE_URL,
      authorityDatabaseUrl: env.COMMANDER_TENANT_AUTHORITY_DATABASE_URL,
    });
    assert.throws(
      () => parseTask1ReadinessEnvironment({
        ...env,
        COMMANDER_TENANT_AUTHORITY_DATABASE_URL: env.DATABASE_URL,
      }),
      /DATABASE_URLS_MUST_BE_DISTINCT/,
    );
  });

  it('builds both verified pools with bounded acquisition/query timeouts and the supplied TLS env', () => {
    const calls: Array<{ input: Record<string, unknown>; env: NodeJS.ProcessEnv }> = [];
    const fakePool = { end: async () => undefined };
    const env = {
      COMMANDER_DATABASE_TLS_CA_FILE: '/run/database/ca.crt',
      COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256: digest('d'),
    };
    const pools = createTask1ReadinessDatabasePools({
      phase: 'enforce',
      port: 9443,
      certFile: '/run/proof/tls.crt',
      keyFile: '/run/proof/tls.key',
      proofDnsName: 'api.commander.svc.cluster.local',
      imageDigest: `sha256:${digest('a')}`,
      configurationSha256: digest('c'),
      appDatabaseUrl: 'postgres://commander_app:app@db/commander?sslmode=verify-full',
      authorityDatabaseUrl:
        'postgres://commander_tenant_authority:authority@db/commander?sslmode=verify-full',
    }, env, ((input: Record<string, unknown>, receivedEnv: NodeJS.ProcessEnv) => {
      calls.push({ input, env: receivedEnv });
      return fakePool;
    }) as never);

    assert.equal(pools.appPool, fakePool);
    assert.equal(pools.authorityPool, fakePool);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.env, env);
    assert.equal(calls[1]!.env, env);
    assert.equal(calls[0]!.input.connectionTimeoutMillis, 2_000);
    assert.equal(calls[0]!.input.query_timeout, 2_000);
    assert.equal(calls[0]!.input.statement_timeout, 1_500);
    assert.equal(calls[1]!.input.connectionTimeoutMillis, 2_000);
    assert.equal(calls[1]!.input.query_timeout, 900);
    assert.equal(calls[1]!.input.statement_timeout, 750);
  });

  it('reads the immutable database identity only through its bounded RPC', async () => {
    const pool = new Pool(new RecordingClient(() => ({ rows: [{
      installation_id: '11111111-1111-4111-8111-111111111111',
      database_peer_binding_sha256: digest('d'),
    }] })));
    assert.deepEqual(await readTask1DatabaseIdentity(pool), {
      installationId: '11111111-1111-4111-8111-111111111111',
      databasePeerBindingSha256: digest('d'),
    });
    assert.match(pool.client.calls[0]!.text, /commander_database_identity\(\)/);
  });

  it('requires non-symlink owner files with 0444 certificate and 0400 key modes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-task1-proof-'));
    const certFile = join(directory, 'tls.crt');
    const keyFile = join(directory, 'tls.key');
    execFileSync('openssl', [
      'req', '-x509', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'ignore' });
    chmodSync(certFile, 0o444);
    chmodSync(keyFile, 0o644);
    assert.throws(
      () => loadTask1ProofTlsMaterial({ certFile, keyFile, expectedDnsName: 'localhost' }),
      /KEY_FILE_MODE_INVALID/,
    );

    chmodSync(keyFile, 0o400);
    assert.doesNotThrow(() => loadTask1ProofTlsMaterial({
      certFile,
      keyFile,
      expectedDnsName: 'localhost',
    }));
    assert.throws(
      () => loadTask1ProofTlsMaterial({
        certFile,
        keyFile,
        expectedDnsName: 'api.commander.svc.cluster.local',
      }),
      /TLS_MATERIAL_INVALID/,
    );
    const linkedKey = join(directory, 'linked.key');
    symlinkSync(keyFile, linkedKey);
    assert.throws(
      () => loadTask1ProofTlsMaterial({
        certFile,
        keyFile: linkedKey,
        expectedDnsName: 'localhost',
      }),
      /KEY_FILE_INVALID/,
    );
  });

  it('serves the proof on a dedicated TLS 1.3-only listener', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-task1-proof-server-'));
    const certFile = join(directory, 'tls.crt');
    const keyFile = join(directory, 'tls.key');
    execFileSync('openssl', [
      'req', '-x509', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', keyFile, '-out', certFile,
    ], { stdio: 'ignore' });
    chmodSync(certFile, 0o444);
    chmodSync(keyFile, 0o400);
    const state = proof();
    state.recordTenantSelfCheck(true);
    const server = createTask1ProofHttpsServer(
      state,
      loadTask1ProofTlsMaterial({ certFile, keyFile, expectedDnsName: 'localhost' }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      const status = await new Promise<number>((resolveRequest, reject) => {
        const req = request({
          host: 'localhost', port: address.port, path: '/ready/tenant-authority/v1',
          ca: readFileSync(certFile), minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
        }, (res) => { res.resume(); res.on('end', () => resolveRequest(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 200);

      await assert.rejects(new Promise<void>((resolveRequest, reject) => {
        const req = request({
          host: 'localhost', port: address.port, path: '/ready/tenant-authority/v1',
          ca: readFileSync(certFile), minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
        }, (res) => { res.resume(); res.on('end', resolveRequest); });
        req.on('error', reject);
        req.end();
      }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
