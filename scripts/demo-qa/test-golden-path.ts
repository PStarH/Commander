#!/usr/bin/env node
/**
 * Golden Path E2E Test — Buyer-visible demo assertions.
 *
 * Runs the production demo end-to-end while the API server is alive,
 * captures stdout/stderr/SSE, and enforces the invariants a CFO/CTO would
 * actually care about:
 *   - No unhandled promise rejections
 *   - Exit code 0
 *   - Recovery / fallback / completion markers appear in output
 */

import { reportSilentFailure } from '../../packages/core/src/silentFailureReporter';
import { spawn, ChildProcess } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const API_LOG = path.join(ROOT, '.commander', 'qa-api.log');
const DEMO_LOG = path.join(ROOT, '.commander', 'qa-demo.log');
const UNHANDLED_RE = /UnhandledPromiseRejection|unhandled.*rejection|Unhandled exception/i;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

function runCommand(
  cmd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; logFile?: string } = {},
): Promise<{ child: ChildProcess; result: Promise<RunResult> }> {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    if (options.logFile) {
      fs.appendFileSync(options.logFile, chunk);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    if (options.logFile) {
      fs.appendFileSync(options.logFile, chunk);
    }
  });

  const result = new Promise<RunResult>((resolve) => {
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      resolve({
        code,
        stdout,
        stderr,
        combined: stdout + '\n' + stderr,
      });
    });
  });

  return Promise.resolve({ child, result });
}

async function waitForApiReady(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      reportSilentFailure(err, 'test-golden-path:80');
      /* not ready yet */
    }
    await sleep(200);
  }
  throw new Error(`API did not become ready within ${timeoutMs}ms`);
}

async function fetchSse(url: string, durationMs: number): Promise<string> {
  const chunks: string[] = [];
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), durationMs);

  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.body) return '';
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timeout);
  }

  return chunks.join('');
}

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Assertion failed [${label}]: expected output to contain "${needle}"`);
  }
}

function assertNoUnhandled(text: string, label: string): void {
  if (UNHANDLED_RE.test(text)) {
    throw new Error(`Assertion failed [${label}]: unhandled rejection/exception detected`);
  }
}

async function main() {
  // Clean logs from previous runs.
  fs.mkdirSync(path.dirname(API_LOG), { recursive: true });
  fs.writeFileSync(API_LOG, '');
  fs.writeFileSync(DEMO_LOG, '');

  // 1. Start the API server.
  const api = await runCommand('npx', ['tsx', 'apps/api/src/index.ts'], {
    env: { PORT: '4000', WEB_PORT: '5173' },
    logFile: API_LOG,
  });

  try {
    await waitForApiReady('http://localhost:4000/health');

    // 2. Start an SSE listener on the public events stream.
    const ssePromise = fetchSse('http://localhost:4000/events?heartbeatMs=5000', 30000);

    // 3. Run the self-contained viral demo that exercises recovery/fallback.
    const demo = await runCommand('npx', ['tsx', 'demos/viral-demo.ts'], {
      env: { FAST_DEMO: '1' },
      logFile: DEMO_LOG,
    });
    const demoRun = await demo.result;

    // 4. Collect SSE output.
    const sseText = await ssePromise;

    // 5. Kill the API after the demo finishes.
    api.child.kill('SIGTERM');
    const apiRun = await api.result;

    // 6. Assertions — these are the "buyer-visible" outcomes.
    assertNoUnhandled(apiRun.combined, 'API stdout/stderr');
    assertNoUnhandled(demoRun.combined, 'Demo stdout/stderr');
    assertNoUnhandled(sseText, 'SSE stream');

    assertContains(demoRun.combined, 'OpenAI → Anthropic', 'Provider fallback visible');
    assertContains(demoRun.combined, 'SAGA', 'Saga recovery visible');
    assertContains(demoRun.combined, 'ROLLBACK', 'Compensation rollback visible');
    assertContains(demoRun.combined, 'FLEET COMPLETE', 'Demo completion visible');

    if (demoRun.code !== 0) {
      throw new Error(`Demo exited with code ${demoRun.code}`);
    }

    console.log('✅ Golden-path E2E test passed');
    console.log(`   Demo exit code: ${demoRun.code}`);
    console.log(`   API exit code:  ${apiRun.code}`);
    console.log(`   Logs written to:`);
    console.log(`     ${API_LOG}`);
    console.log(`     ${DEMO_LOG}`);
    process.exit(0);
  } catch (err) {
    api.child.kill('SIGKILL');
    throw err;
  }
}

main().catch((err) => {
  console.error(
    '❌ Golden-path E2E test failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
