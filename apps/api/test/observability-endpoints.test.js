const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const apiDir = path.resolve(__dirname, '..');
const port = 4322;
const baseUrl = `http://127.0.0.1:${port}`;
const obsBase = `${baseUrl}/api/v1/observability`;

let serverProcess;

async function waitForServer(url, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('API server did not become healthy in time');
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['dist/index.js'], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', () => {});

  await waitForServer(baseUrl);
});

test.after(() => {
  if (serverProcess && !serverProcess.pid) {
    try {
      process.kill(-serverProcess.pid, 'SIGTERM');
    } catch {}
  }
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
  }
});

test('GET /api/v1/observability/runs returns 200 with empty count in fresh server', async () => {
  const response = await fetch(`${obsBase}/runs`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.count, 'number');
  assert.ok(Array.isArray(body.runs));
});

test('GET /api/v1/observability/runs/:runId returns 404 for unknown run', async () => {
  const response = await fetch(`${obsBase}/runs/run_does_not_exist_12345`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.ok(body.error);
});

test('GET /api/v1/observability/runs/:runId/timeline returns 404 for unknown run', async () => {
  const response = await fetch(`${obsBase}/runs/run_unknown_xyz/timeline`);
  assert.equal(response.status, 404);
});

test('GET /api/v1/observability/runs/:runId/cost returns 404 for unknown run', async () => {
  const response = await fetch(`${obsBase}/runs/run_unknown_xyz/cost`);
  assert.equal(response.status, 404);
});

test('GET /api/v1/observability/runs/:runId/decisions returns 404 for unknown run', async () => {
  const response = await fetch(`${obsBase}/runs/run_unknown_xyz/decisions`);
  assert.equal(response.status, 404);
});

test('POST /api/v1/observability/runs/:runId/replay returns 404 for unknown run', async () => {
  const response = await fetch(`${obsBase}/runs/run_unknown_xyz/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: 'run_unknown_xyz', substitutions: [], reExecuteLlm: false }),
  });
  assert.equal(response.status, 404);
});

test('GET /api/v1/observability/runs/:runId/tree returns 404 for unknown run', async () => {
  const response = await fetch(`${obsBase}/runs/run_unknown_xyz/tree`);
  assert.equal(response.status, 404);
});

test('GET /api/v1/observability/agents/:agentId returns 200 with empty runs', async () => {
  const response = await fetch(`${obsBase}/agents/agent-test-1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agentId, 'agent-test-1');
  assert.equal(typeof body.count, 'number');
  assert.ok(Array.isArray(body.runs));
});

test('GET /api/v1/observability/search returns 200 with count', async () => {
  const response = await fetch(`${obsBase}/search?limit=10`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.count, 'number');
  assert.ok(Array.isArray(body.runs));
});

test('GET /api/v1/observability/search honors since parameter', async () => {
  const response = await fetch(`${obsBase}/search?since=2020-01-01T00:00:00Z&limit=5`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.count >= 0);
  assert.ok(body.runs.length <= 5);
});

test('Invalid runId with traversal characters returns 400', async () => {
  const response = await fetch(`${obsBase}/runs/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(response.status, 400);
});

test('Invalid runId with semicolons returns 400', async () => {
  const response = await fetch(`${obsBase}/runs/foo%3Bbar`);
  assert.equal(response.status, 400);
});

test('Non-existent route returns 404', async () => {
  const response = await fetch(`${obsBase}/nonexistent/whatever`);
  assert.equal(response.status, 404);
});
