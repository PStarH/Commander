/**
 * WP-05: the worker entrypoint reported readiness as soon as `service.start()` returned.
 * start() only authenticates and registers the worker — the claim path against the kernel
 * authority has not been exercised, so a worker that can never claim work still advertised
 * itself ready (and stayed in the load balancer).
 *
 * These cases spawn the real `main.ts` with a bootstrap module whose claim path is
 * controlled by WS6_POLL_MODE, and read the real /ready endpoint.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MAIN = join(ROOT, 'packages/worker-plane/src/main.ts');

const BOOTSTRAP_SOURCE = `
const mode = process.env.WS6_POLL_MODE;
const never = () => new Promise(() => {});
export function createWorkerService() {
  return {
    async start() {
      return { id: 'ws6-worker' };
    },
    async pollOnce() {
      if (mode === 'hang') return never();
      if (mode === 'reject') throw new Error('claim authority unavailable');
      return false;
    },
    async run() {
      return never();
    },
  };
}
`;

const dir = mkdtempSync(join(tmpdir(), 'ws6-readiness-'));
const bootstrapPath = join(dir, 'ws6-bootstrap.mjs');
writeFileSync(bootstrapPath, BOOTSTRAP_SOURCE, 'utf8');
const children: ChildProcess[] = [];

after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function startWorker(mode: string, port: number): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      COMMANDER_WORKER_BOOTSTRAP: bootstrapPath,
      COMMANDER_WORKER_HEALTH_PORT: String(port),
      WS6_POLL_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll /ready until it reports `expected`; returns the matching status. */
async function waitForReadyStatus(
  port: number,
  expected: number,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last: number | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      await res.text();
      last = res.status;
      if (last === expected) return last;
    } catch {
      // The health server is not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`/ready never returned ${expected} within ${timeoutMs}ms (last: ${last})`);
}

describe('worker main readiness semantics (WP-05)', () => {
  it('does not report ready while the first claim has not completed', async () => {
    const port = await freePort();
    const child = startWorker('hang', port);
    assert.equal(await waitForReadyStatus(port, 503), 503);
    // Stable, not a startup race: it must stay not-ready for as long as the claim hangs.
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      assert.equal(await waitForReadyStatus(port, 503, 5_000), 503);
    }
    assert.equal(child.exitCode, null);
  });

  it('reports ready once the first claim has succeeded', async () => {
    const port = await freePort();
    startWorker('claim-ok', port);
    assert.equal(await waitForReadyStatus(port, 200), 200);
  });

  it('exits non-zero without ever reporting ready when the claim path fails', async () => {
    const port = await freePort();
    const child = startWorker('reject', port);
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('worker did not exit after a failed first claim')),
          20_000,
        ),
      ),
    ]);
    assert.equal(exitCode, 1);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/ready`));
  });
});
