// Test-only TLS proxy in front of the real GitHub API for the live Gateway proof.
// Reads are forwarded for one approved repository. The only writes forwarded are a pull-request
// create and a close of that repository's pull requests; everything else is refused. The first
// accepted create is answered with a cut response, and the next one with headers that never finish,
// so the client cannot see the committed result.
import { createServer, request } from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOP_HEADERS = new Set(['connection', 'content-length', 'host', 'transfer-encoding']);

export function createLiveGitHubProxy({
  key,
  cert,
  oracleToken,
  allowedRepository,
  upstream,
  cutCreateResponse = false,
  holdCreateResponse = false,
}) {
  if (!oracleToken) throw new Error('CELL_GITHUB_ORACLE_TOKEN is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(allowedRepository ?? ''))
    throw new Error('CELL_GITHUB_ALLOWED_REPO must be one exact owner/repository');
  if (!upstream?.host) throw new Error('CELL_GITHUB_UPSTREAM_IP is required');
  const pullsPath = `/repos/${allowedRepository}/pulls`;
  const closePath = new RegExp(`^${pullsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[1-9]\\d*$`);
  let createCalls = 0;
  let closeCalls = 0;
  let responseCutInjected = false;
  let responseHeld = false;
  let committedCreateStatus = null;
  return createServer({ key, cert }, async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'https://api.github.com');
    if (url.pathname === '/__cell__/state') {
      if (req.headers.authorization !== `Bearer ${oracleToken}`) {
        send(401, { message: 'Bad credentials' });
        return;
      }
      send(200, {
        createCalls,
        closeCalls,
        responseCutInjected,
        responseHeld,
        committedCreateStatus,
      });
      return;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 65536) {
        send(413, { message: 'Body too large' });
        return;
      }
    }
    const isCreate = req.method === 'POST' && url.pathname === pullsPath;
    let isClose = false;
    if (req.method === 'PATCH' && closePath.test(url.pathname)) {
      try {
        const body = JSON.parse(raw);
        isClose = Boolean(body) && typeof body === 'object' && body.state === 'closed';
      } catch {
        isClose = false;
      }
    }
    const isRead =
      req.method === 'GET' &&
      (url.pathname === pullsPath || url.pathname.startsWith(`${pullsPath}/`));
    if (!isCreate && !isClose && !isRead) {
      send(403, { message: 'Blocked by the live proxy' });
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name)),
    );
    headers.host = 'api.github.com';
    headers['accept-encoding'] = 'identity';
    if (raw) headers['content-length'] = String(Buffer.byteLength(raw));
    const forwarded = await new Promise((resolve) => {
      const outbound = request(
        {
          host: upstream.host,
          port: upstream.port ?? 443,
          servername: 'api.github.com',
          agent: upstream.agent,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
          response.on('error', () => resolve(null));
        },
      );
      outbound.setTimeout(30_000, () => outbound.destroy());
      outbound.on('error', () => resolve(null));
      outbound.end(raw || undefined);
    });
    if (!forwarded) {
      send(502, { message: 'Upstream unavailable' });
      return;
    }
    if (isCreate) {
      committedCreateStatus = forwarded.status;
      if (forwarded.status === 201) createCalls += 1;
    }
    if (isClose && forwarded.status === 200) closeCalls += 1;
    const responseHeaders = Object.fromEntries(
      Object.entries(forwarded.headers).filter(([name]) => !HOP_HEADERS.has(name)),
    );
    responseHeaders['content-length'] = String(forwarded.body.length);
    if (isCreate && forwarded.status === 201 && cutCreateResponse && !responseCutInjected) {
      responseCutInjected = true;
      res.writeHead(201, responseHeaders);
      res.write(forwarded.body.subarray(0, 1), () => res.destroy());
      return;
    }
    if (isCreate && forwarded.status === 201 && holdCreateResponse && !responseHeld) {
      responseHeld = true;
      res.writeHead(201, responseHeaders);
      res.flushHeaders();
      return;
    }
    res.writeHead(forwarded.status, responseHeaders);
    res.end(forwarded.body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createLiveGitHubProxy({
    key: readFileSync('/fixture/tls/key.pem'),
    cert: readFileSync('/fixture/tls/cert.pem'),
    oracleToken: process.env.CELL_GITHUB_ORACLE_TOKEN,
    allowedRepository: process.env.CELL_GITHUB_ALLOWED_REPO,
    upstream: { host: process.env.CELL_GITHUB_UPSTREAM_IP },
    cutCreateResponse: process.env.CELL_GITHUB_CUT_CREATE_RESPONSE === '1',
    holdCreateResponse: process.env.CELL_GITHUB_HOLD_CREATE_RESPONSE === '1',
  });
  server.listen(443, '0.0.0.0');
}
