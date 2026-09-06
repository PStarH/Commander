import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdDoctor } from '../../src/cli/commands/manage';
import { ENV_MAP } from '../../src/config/commanderConfig';
import { isSupportedNodeVersion } from '../../src/cli/nodeSupport';

const cliEntryPath = fileURLToPath(new URL('../../src/cliEntry.ts', import.meta.url));
const tsxCliPath = fileURLToPath(
  new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const originalPath = process.env.PATH;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.env.PATH = originalPath;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('first-user CLI readiness', () => {
  it('runs quickstart --check without creating setup files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'commander-quickstart-'));
    await writeFile(join(workspace, '.env.example'), 'EXAMPLE=true\n');
    const env = { ...process.env, NO_COLOR: '1' };
    for (const providerEnv of Object.values(ENV_MAP)) {
      delete env[providerEnv.key];
      delete env[providerEnv.url];
      delete env[providerEnv.model];
    }
    for (const fallbackEnv of [
      'COHERE_API_KEY',
      'REPLICATE_API_KEY',
      'PPLX_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_PROFILE',
    ]) {
      delete env[fallbackEnv];
    }

    try {
      const result = spawnSync(
        process.execPath,
        [tsxCliPath, cliEntryPath, 'quickstart', '--check'],
        {
          cwd: workspace,
          env,
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(isSupportedNodeVersion(process.version) ? 0 : 1);
      expect(result.stdout).toContain('Commander Quickstart');
      expect(result.stdout).toContain('Optional for simulated demo');
      expect(result.stdout).not.toContain('Commander Init');
      expect(result.stdout).not.toContain('No API key found');
      expect(existsSync(join(workspace, '.env'))).toBe(false);
      expect(existsSync(join(workspace, '.commander.json'))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('runs doctor offline without contacting a configured provider', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(repositoryRoot);
    for (const env of Object.values(ENV_MAP)) {
      vi.stubEnv(env.key, '');
      vi.stubEnv(env.url, '');
      vi.stubEnv(env.model, '');
    }
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    const fetchMock = vi.fn(() => {
      throw new Error('network must not be called in offline mode');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await cmdDoctor(['--offline']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(isSupportedNodeVersion(process.version) ? 0 : 1);
  });

  it('returns a non-zero status when mandatory doctor checks fail', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'commander-doctor-'));
    await writeFile(join(workspace, 'package-lock.json'), '{}');
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    process.env.PATH = '';
    for (const env of Object.values(ENV_MAP)) vi.stubEnv(env.key, '');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await cmdDoctor(['--offline']);
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
