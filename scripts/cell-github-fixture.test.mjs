import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { once } from 'node:events';
import { createGitHubFixture } from './cell-github-fixture.mjs';

test('HTTPS GitHub peer shares remote state and counts actual creates and closes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cell-github-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'openssl.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=api.github.com\n[ext]\nsubjectAltName=DNS:api.github.com\nbasicConstraints=critical,CA:TRUE\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      join(dir, 'openssl.cnf'),
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(join(dir, 'cert.pem'));
  const server = createGitHubFixture({
    key: readFileSync(join(dir, 'key.pem')),
    cert,
    token: 'fixture-test-token',
    oracleToken: 'fixture-oracle-token',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const { port } = server.address();
  const call = (method, path, body, token = 'fixture-test-token') =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          servername: 'api.github.com',
          port,
          ca: cert,
          method,
          path,
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  assert.equal((await call('GET', '/__cell__/state', undefined, 'wrong')).status, 401);
  assert.equal((await call('GET', '/__cell__/state')).status, 401);
  assert.equal(
    (await call('GET', '/__cell__/state', undefined, 'fixture-oracle-token')).status,
    200,
  );
  assert.equal(
    (await call('GET', '/repos/cell/repo/pulls?state=all', undefined, 'fixture-oracle-token'))
      .status,
    401,
  );
  assert.deepEqual((await call('GET', '/repos/cell/repo/pulls?state=all')).body, []);
  assert.equal(
    (await call('POST', '/repos/cell/repo/pulls', { title: 'missing fields' })).status,
    422,
  );
  const payload = {
    title: 'Cell proof',
    body: '<!-- commander-action:proof -->',
    head: 'cell-proof',
    base: 'main',
  };
  const created = await call('POST', '/repos/cell/repo/pulls', payload);
  assert.equal(created.status, 201);
  assert.equal(created.body.number, 1);
  assert.equal(created.body.body, payload.body);
  assert.deepEqual(
    (await call('GET', '/repos/cell/repo/pulls?state=all&head=cell:cell-proof&base=main')).body,
    [created.body],
  );
  assert.deepEqual((await call('GET', '/repos/cell/repo/pulls?head=cell:other')).body, []);
  assert.deepEqual((await call('GET', '/repos/other/repo/pulls')).body, []);
  assert.equal((await call('GET', '/repos/cell/repo/pulls/1')).body.state, 'open');
  assert.equal(
    (await call('PATCH', '/repos/cell/repo/pulls/1', { state: 'closed' })).body.state,
    'closed',
  );
  assert.equal((await call('GET', '/repos/cell/repo/pulls/1')).body.state, 'closed');
  const evidence = (await call('GET', '/__cell__/state', undefined, 'fixture-oracle-token')).body;
  assert.equal(evidence.createCalls, 1);
  assert.equal(evidence.closeCalls, 1);
  assert.equal(evidence.pulls.length, 1);
  assert.equal(evidence.pulls[0].state, 'closed');
});

test('cuts the first valid create response after committing the pull request', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cell-github-cut-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'openssl.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=api.github.com\n[ext]\nsubjectAltName=DNS:api.github.com\nbasicConstraints=critical,CA:TRUE\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      join(dir, 'openssl.cnf'),
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(join(dir, 'cert.pem'));
  const server = createGitHubFixture({
    key: readFileSync(join(dir, 'key.pem')),
    cert,
    token: 'fixture-test-token',
    oracleToken: 'fixture-oracle-token',
    cutCreateResponse: true,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const { port } = server.address();
  const call = (method, path, body, token = 'fixture-test-token') =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          servername: 'api.github.com',
          port,
          ca: cert,
          method,
          path,
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : undefined, raw }),
          );
          res.on('aborted', () => resolve({ status: res.statusCode, raw, aborted: true }));
        },
      );
      req.on('error', (error) => resolve({ error }));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const payload = {
    title: 'Cell proof',
    body: '<!-- commander-action:proof -->',
    head: 'cell-proof',
    base: 'main',
  };
  assert.equal(
    (await call('POST', '/repos/cell/repo/pulls', { title: 'missing fields' })).status,
    422,
  );
  const cut = await call('POST', '/repos/cell/repo/pulls', payload);
  assert.equal(cut.status, 201);
  assert.equal(cut.aborted, true);
  assert.ok(cut.raw.length < JSON.stringify({ number: 1 }).length + 100);
  const second = await call('POST', '/repos/cell/repo/pulls', { ...payload, head: 'cell-proof-2' });
  assert.equal(second.status, 201);
  assert.equal(second.body.number, 2);
  const state = (await call('GET', '/__cell__/state', undefined, 'fixture-oracle-token')).body;
  assert.equal(state.createCalls, 2);
  assert.equal(state.responseCutInjected, true);
  assert.equal(state.committedCreateStatus, 201);
  assert.equal(state.pulls.length, 2);
  assert.equal((await call('GET', '/repos/cell/repo/pulls/1')).body.body, payload.body);
});
