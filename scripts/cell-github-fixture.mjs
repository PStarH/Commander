// Test-only GitHub HTTPS peer for the real Cell worker and adapter-ops processes.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function createGitHubFixture({ key, cert, token }) {
  if (!token) throw new Error('CELL_GITHUB_TOKEN is required');
  const pulls = [];
  let createCalls = 0;
  let closeCalls = 0;
  return createServer({ key, cert }, async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'https://api.github.com');
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(401, { message: 'Bad credentials' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__cell__/state') {
      send(200, { createCalls, closeCalls, pulls });
      return;
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?$/.exec(url.pathname);
    if (!match) {
      send(404, { message: 'Not found' });
      return;
    }
    const [, owner, repo, number] = match;
    const repoPulls = pulls.filter((pull) => pull.repository === `${owner}/${repo}`);
    const pull = repoPulls.find((item) => item.number === Number(number));
    if (req.method === 'GET') {
      if (number) {
        send(pull ? 200 : 404, pull ?? { message: 'Not found' });
      } else {
        const head = url.searchParams.get('head');
        const base = url.searchParams.get('base');
        const state = url.searchParams.get('state');
        send(
          200,
          repoPulls.filter(
            (item) =>
              (!head || `${owner}:${item.head.ref}` === head) &&
              (!base || item.base.ref === base) &&
              (!state || state === 'all' || item.state === state),
          ),
        );
      }
      return;
    }
    let body;
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 65536) {
          send(413, { message: 'Body too large' });
          return;
        }
      }
      body = JSON.parse(raw);
    } catch {
      send(400, { message: 'Invalid JSON' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(422, { message: 'Invalid body' });
      return;
    }
    if (req.method === 'POST' && !number) {
      if (!['title', 'body', 'head', 'base'].every((field) => typeof body[field] === 'string')) {
        send(422, { message: 'Missing pull request fields' });
        return;
      }
      createCalls += 1;
      const created = {
        repository: `${owner}/${repo}`,
        number: repoPulls.length + 1,
        html_url: `https://github.com/${owner}/${repo}/pull/${repoPulls.length + 1}`,
        state: 'open',
        title: body.title,
        body: body.body,
        head: { ref: body.head },
        base: { ref: body.base },
      };
      pulls.push(created);
      send(201, created);
    } else if (req.method === 'PATCH' && number && pull && body.state === 'closed') {
      closeCalls += 1;
      pull.state = 'closed';
      send(200, pull);
    } else {
      send(422, { message: 'Unsupported mutation' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGitHubFixture({
    key: readFileSync('/fixture/tls/key.pem'),
    cert: readFileSync('/fixture/tls/cert.pem'),
    token: process.env.CELL_GITHUB_TOKEN,
  });
  server.listen(443, '0.0.0.0');
}
