/**
 * Test Environment Isolation — TempDir-based isolation for tests.
 *
 * Inspired by Codex CLI's pattern: every test gets fresh temp directories
 * for state files, config, and working directories. Cleanup is automatic
 * via the dispose pattern.
 *
 * Usage:
 *   import { createTestEnv } from './helpers/testEnv';
 *
 *   describe('my tests', () => {
 *     it('isolated test', async () => {
 *       using env = await createTestEnv();
 *       // env.stateFile, env.configDir, env.workDir are all unique temp paths
 *       // cleanup happens automatically when `env` goes out of scope
 *     });
 *   });
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TestEnv {
  /** Unique temp directory for this test */
  tempDir: string;
  /** Path to a state file inside tempDir */
  stateFile: string;
  /** Path to a config directory inside tempDir */
  configDir: string;
  /** Path to a working directory inside tempDir */
  workDir: string;
  /** Path to an approval cache directory inside tempDir */
  approvalDir: string;
  /** Clean up all temp files */
  cleanup(): void;
  /** Symbol.dispose support for `using` keyword */
  [Symbol.dispose](): void;
}

/**
 * Create an isolated test environment with unique temp directories.
 * All paths are guaranteed to not exist yet (created fresh).
 */
export async function createTestEnv(name = 'test'): Promise<TestEnv> {
  const tmpRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `commander-${name}-`)
  );

  const tempDir = tmpRoot;
  const stateFile = path.join(tmpRoot, 'state.json');
  const configDir = path.join(tmpRoot, 'config');
  const workDir = path.join(tmpRoot, 'workdir');
  const approvalDir = path.join(tmpRoot, 'approvals');

  // Create subdirectories
  await fs.promises.mkdir(configDir, { recursive: true });
  await fs.promises.mkdir(workDir, { recursive: true });
  await fs.promises.mkdir(approvalDir, { recursive: true });

  function cleanup(): void {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  return {
    tempDir,
    stateFile,
    configDir,
    workDir,
    approvalDir,
    cleanup,
    [Symbol.dispose]: cleanup,
  };
}

/**
 * Synchronous version for tests that don't use async.
 */
export function createTestEnvSync(name = 'test'): TestEnv {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `commander-${name}-`)
  );

  const tempDir = tmpRoot;
  const stateFile = path.join(tmpRoot, 'state.json');
  const configDir = path.join(tmpRoot, 'config');
  const workDir = path.join(tmpRoot, 'workdir');
  const approvalDir = path.join(tmpRoot, 'approvals');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(approvalDir, { recursive: true });

  function cleanup(): void {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  return {
    tempDir,
    stateFile,
    configDir,
    workDir,
    approvalDir,
    cleanup,
    [Symbol.dispose]: cleanup,
  };
}

/**
 * Run a test function with automatic environment cleanup.
 * Works with both sync and async test functions.
 */
export async function withTestEnv<T>(
  name: string,
  fn: (env: TestEnv) => T | Promise<T>
): Promise<T> {
  const env = await createTestEnv(name);
  try {
    return await fn(env);
  } finally {
    env.cleanup();
  }
}
