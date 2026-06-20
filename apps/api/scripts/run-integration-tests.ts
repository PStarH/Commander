#!/usr/bin/env node
/**
 * API integration test runner.
 *
 * Builds the API, starts the server on a free port, runs the TypeScript
 * integration tests in apps/api/tests, then shuts the server down.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as path from 'node:path';

const PORT = process.env.PORT ?? '4000';
const TEST_API_URL = `http://localhost:${PORT}`;
const API_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(API_ROOT, 'dist', 'index.js');
const TEST_GLOB = path.join(API_ROOT, 'tests', '*.test.ts');

function run(cmd: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function waitForHealth(url: string, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // server not ready yet
    }
    await sleep(250);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

async function main() {
  // 1. Build core and api
  console.log('Building @commander/core...');
  let code = await run('pnpm', ['--filter', '@commander/core', 'build']);
  if (code !== 0) {
    console.error('Core build failed');
    process.exit(code);
  }

  console.log('Building @commander/api...');
  code = await run('pnpm', ['--filter', '@commander/api', 'build']);
  if (code !== 0) {
    console.error('API build failed');
    process.exit(code);
  }

  // 2. Start the API server in the background
  console.log(`Starting API server on port ${PORT}...`);
  const server = spawn('node', [SERVER_ENTRY], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT) },
  });

  let exitCode = 1;
  try {
    await waitForHealth(TEST_API_URL);
    console.log('Server healthy, running integration tests...');

    // 3. Run the TypeScript integration tests serially to avoid shared-server races.
    exitCode = await run('npx', ['-p', 'tsx', 'tsx', '--test', '--test-concurrency=1', TEST_GLOB], {
      env: { ...process.env, TEST_API_URL },
    });
  } catch (err) {
    console.error(err);
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    if (!server.killed) server.kill('SIGKILL');
  }

  process.exit(exitCode);
}

main();
