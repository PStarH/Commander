const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, stopServer } = require('./_helpers/spawnServer');

let serverContext;

test.before(async () => {
  serverContext = await startServer(path.resolve(__dirname, '..'));
});

test.after(async () => {
  if (serverContext) {
    await stopServer(serverContext);
  }
});

// AUDIT F-B-5: this file used to `console.log` the status with no assertion, so
// an unhealthy 500 looked exactly like a healthy 200. It now pins the contract.
test('server answers /health with 200 and an ok payload', async () => {
  const res = await fetch(`${serverContext.baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body && typeof body === 'object', 'health body must be a JSON object');
  assert.equal(typeof body.status, 'string');
  assert.notEqual(body.status, 'error');
});

test('server serves the public OpenAPI spec with 200 (HTTP stack is live)', async () => {
  // NOTE: /ready is deliberately not asserted here — it is a hard-gate 503 in
  // this environment because no PostgreSQL DSN is configured, and that is a
  // missing external dependency, not a defect in this suite. An unknown path
  // is also not usable: the global auth middleware correctly answers 401.
  const res = await fetch(`${serverContext.baseUrl}/api/openapi.json`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.openapi, '3.1.0');
});
