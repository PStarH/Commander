import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, request } from 'node:https';
import { test } from 'node:test';
import { createGitHubFixture } from './cell-github-fixture.mjs';
import { createLiveGitHubProxy } from './cell-github-live-proxy.mjs';

function selfSignedPair(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cell-github-live-proxy-test-'));
  t?.after(() => rmSync(dir, { recursive: true, force: true }));
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
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function caller(port, cert) {
  const agent = new Agent({ ca: cert });
  return (method, path, body, token = 'real-token') =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          servername: 'api.github.com',
          port,
          agent,
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
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

test('forwards only the approved repository writes and cuts the first committed create', async (t) => {
  const { key, cert } = selfSignedPair(t);
  const upstream = createGitHubFixture({
    key,
    cert,
    token: 'real-token',
    oracleToken: 'upstream-oracle',
  });
  const upstreamPort = await listen(upstream);
  const proxy = createLiveGitHubProxy({
    key,
    cert,
    oracleToken: 'proxy-oracle',
    allowedRepository: 'cell/repo',
    upstream: { host: '127.0.0.1', port: upstreamPort, agent: new Agent({ ca: cert }) },
    cutCreateResponse: true,
  });
  const proxyPort = await listen(proxy);
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const call = caller(proxyPort, cert);
  const payload = { title: 'Cell live', body: 'marker', head: 'live-head', base: 'main' };

  assert.equal((await call('GET', '/__cell__/state')).status, 401);
  assert.equal((await call('GET', '/__cell__/state', undefined, 'proxy-oracle')).status, 200);

  assert.equal((await call('POST', '/repos/other/repo/pulls', payload)).status, 403);
  assert.equal((await call('POST', '/repos/cell/repo/issues', payload)).status, 403);
  assert.equal((await call('DELETE', '/repos/cell/repo/pulls/1')).status, 403);
  assert.equal((await call('PATCH', '/repos/cell/repo/pulls/1', { title: 'x' })).status, 403);
  assert.equal((await call('GET', '/repos/other/repo/pulls')).status, 403);

  await assert.rejects(call('POST', '/repos/cell/repo/pulls', payload));
  const afterCut = (await call('GET', '/__cell__/state', undefined, 'proxy-oracle')).body;
  assert.equal(afterCut.createCalls, 1);
  assert.equal(afterCut.responseCutInjected, true);
  assert.equal(afterCut.committedCreateStatus, 201);

  const listed = await call('GET', '/repos/cell/repo/pulls?state=all&head=cell:live-head');
  assert.equal(listed.body.length, 1);
  const closed = await call('PATCH', `/repos/cell/repo/pulls/${listed.body[0].number}`, {
    state: 'closed',
  });
  assert.equal(closed.body.state, 'closed');

  const second = await call('POST', '/repos/cell/repo/pulls', { ...payload, head: 'other-head' });
  assert.equal(second.status, 201);
  const final = (await call('GET', '/__cell__/state', undefined, 'proxy-oracle')).body;
  assert.equal(final.createCalls, 2);
  assert.equal(final.closeCalls, 1);
});

test('refuses to start without one exact repository', (t) => {
  const { key, cert } = selfSignedPair(t);
  for (const allowedRepository of ['', 'owner', 'owner/*', 'a/b/c'])
    assert.throws(() =>
      createLiveGitHubProxy({
        key,
        cert,
        oracleToken: 'oracle',
        allowedRepository,
        upstream: { host: '127.0.0.1' },
      }),
    );
});

test('holds a committed create response open so the caller can be killed mid-call', async (t) => {
  const { key, cert } = selfSignedPair(t);
  const upstream = createGitHubFixture({
    key,
    cert,
    token: 'real-token',
    oracleToken: 'upstream-oracle',
  });
  const upstreamPort = await listen(upstream);
  const proxy = createLiveGitHubProxy({
    key,
    cert,
    oracleToken: 'proxy-oracle',
    allowedRepository: 'cell/repo',
    upstream: { host: '127.0.0.1', port: upstreamPort, agent: new Agent({ ca: cert }) },
    holdCreateResponse: true,
  });
  const proxyPort = await listen(proxy);
  const agent = new Agent({ ca: cert });
  t.after(() => {
    agent.destroy();
    proxy.close();
    upstream.close();
  });
  const payload = { title: 'Cell live', body: 'marker', head: 'live-head', base: 'main' };
  const held = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        servername: 'api.github.com',
        port: proxyPort,
        agent,
        method: 'POST',
        path: '/repos/cell/repo/pulls',
        headers: { Authorization: 'Bearer real-token' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        setTimeout(() => {
          const outcome = { status: res.statusCode, bodyBytes: body.length };
          req.destroy();
          resolve(outcome);
        }, 300);
      },
    );
    req.on('error', () => {});
    req.on('close', () => {});
    req.end(JSON.stringify(payload));
    setTimeout(() => reject(new Error('no headers')), 5000).unref();
  });
  assert.equal(held.status, 201);
  assert.equal(held.bodyBytes, 0);
  const state = await caller(proxyPort, cert)('GET', '/__cell__/state', undefined, 'proxy-oracle');
  assert.equal(state.body.createCalls, 1);
  assert.equal(state.body.responseHeld, true);
  assert.equal(state.body.responseCutInjected, false);
});
