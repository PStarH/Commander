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
import { executeReview, formatReviewOutput } from '../../src/reviewAgent';

const cliEntryPath = fileURLToPath(new URL('../../src/cliEntry.ts', import.meta.url));
const tsxCliPath = fileURLToPath(
  new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const reviewAgentUrl = new URL('../../src/reviewAgent.ts', import.meta.url).href;
const originalPath = process.env.PATH;
const originalExitCode = process.exitCode;

afterEach(() => {
  vi.useRealTimers();
  process.env.PATH = originalPath;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('first-user CLI readiness', () => {
  function withoutProviderCredentials(): NodeJS.ProcessEnv {
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
    return env;
  }

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

  it('fails a requested real review when the selected provider is not configured', () => {
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, cliEntryPath, 'review', '--commit', 'HEAD', '--real', '--provider=openai'],
      {
        cwd: repositoryRoot,
        env: withoutProviderCredentials(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('OPENAI_API_KEY');
    expect(result.stdout).not.toContain('Review PASSED');
  });

  it('treats --commit without a SHA as HEAD when followed by another flag', () => {
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, cliEntryPath, 'review', '--commit', '--real', '--provider=openai'],
      {
        cwd: repositoryRoot,
        env: withoutProviderCredentials(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('OPENAI_API_KEY');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('ambiguous argument');
  });

  it('fails a requested real review when there are no changes to submit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'commander-empty-review-'));
    const env = withoutProviderCredentials();
    env.OPENAI_API_KEY = 'test-key-not-a-credential';
    env.OPENAI_BASE_URL = 'https://provider.invalid/v1';

    try {
      expect(spawnSync('git', ['init'], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync(
          'git',
          [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--allow-empty',
            '-m',
            'base',
          ],
          { cwd: workspace },
        ).status,
      ).toBe(0);
      const result = spawnSync(
        process.execPath,
        [tsxCliPath, cliEntryPath, 'review', '--real', '--provider=openai'],
        { cwd: workspace, env, encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'no changes to review; provider was not called',
      );
      expect(result.stdout).not.toContain('Review PASSED');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed when a requested real provider review cannot reach the provider', () => {
    const env = withoutProviderCredentials();
    env.OPENAI_API_KEY = 'test-key-not-a-credential';
    env.OPENAI_BASE_URL = 'http://127.0.0.1:1';
    env.OPENAI_MODEL = 'test-model';

    const result = spawnSync(
      process.execPath,
      [tsxCliPath, cliEntryPath, 'review', '--commit', 'HEAD', '--real', '--provider=openai'],
      {
        cwd: repositoryRoot,
        env,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}\n${result.stderr}`).toContain('Real provider review failed');
    expect(result.stdout).not.toContain('Review PASSED');
  });

  it('runs a real review without exposing execution tools and reports provider provenance', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1');
    vi.stubEnv('OPENAI_MODEL', 'first-user-test-model');
    vi.stubEnv('ANTHROPIC_API_KEY', 'another-test-key');

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestBody.model).toBe('first-user-test-model');
      expect(requestBody.max_tokens).toBe(4000);
      expect(requestBody.stream).toBe(false);
      expect(requestBody).not.toHaveProperty('tools');
      expect((requestBody.messages as Array<{ content: string }>)[0].content).toContain(
        'untrusted data',
      );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '[]' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await executeReview({
      scope: 'commit',
      commitSha: 'HEAD',
      requireProvider: true,
      provider: 'openai',
      guidelines: ['x'.repeat(50_000)],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://provider.invalid/v1/chat/completions');
    expect(report.source).toBe('real');
    expect(report.provider).toBe('openai');
    expect(report.model).toBe('first-user-test-model');
    expect(report.endpointHost).toBe('provider.invalid');
    expect(report.outputTokenLimit).toBe(4000);
    expect(report.inputBytes).toBeGreaterThan(0);
    expect(report.guidelinesTruncated).toBe(true);
    expect(report.guidelinesUsed.join('\n')).toHaveLength(1_000);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(requestBody.messages[1].content.length).toBeLessThan(20_000);
  });

  it('runs an Anthropic review without exposing execution tools', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-test-key-not-a-credential');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://anthropic.invalid/v1');
    vi.stubEnv('ANTHROPIC_MODEL', 'first-user-anthropic-model');

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(headers.get('x-api-key')).toBe('anthropic-test-key-not-a-credential');
      expect(requestBody.model).toBe('first-user-anthropic-model');
      expect(requestBody.max_tokens).toBe(4000);
      expect(requestBody.stream).toBeUndefined();
      expect(requestBody).not.toHaveProperty('tools');
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '[]' }],
          usage: { input_tokens: 100, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await executeReview({
      scope: 'commit',
      commitSha: 'HEAD',
      requireProvider: true,
      provider: 'anthropic',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://anthropic.invalid/v1/messages');
    expect(report.source).toBe('real');
    expect(report.provider).toBe('anthropic');
    expect(report.model).toBe('first-user-anthropic-model');
    expect(report.endpointHost).toBe('anthropic.invalid');
  });

  it('fails when the provider response is truncated by its token limit', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '[]' }, finish_reason: 'length' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await expect(
      executeReview({
        scope: 'commit',
        commitSha: 'HEAD',
        requireProvider: true,
        provider: 'openai',
      }),
    ).rejects.toThrow('provider response was truncated');
  });

  it('fails the review gate when the provider returns a P1 finding', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify([
                      {
                        severity: 'P1',
                        title: 'High impact defect',
                        message: 'This must be fixed before showing the change.',
                        confidence: 0.9,
                      },
                    ]),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const report = await executeReview({
      scope: 'commit',
      commitSha: 'HEAD',
      requireProvider: true,
      provider: 'openai',
    });

    expect(report.passed).toBe(false);
    expect(formatReviewOutput(report)).toContain('Review FAILED');
  });

  it('rejects malformed output from a requested real provider review', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'This is not structured review JSON.' } }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await expect(
      executeReview({
        scope: 'commit',
        commitSha: 'HEAD',
        requireProvider: true,
        provider: 'openai',
      }),
    ).rejects.toThrow('Real provider review failed: provider returned invalid structured output');
  });

  it('rejects schema-invalid array items from a requested real provider review', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '[{}]' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(
      executeReview({
        scope: 'commit',
        commitSha: 'HEAD',
        requireProvider: true,
        provider: 'openai',
      }),
    ).rejects.toThrow('Real provider review failed: provider returned invalid structured output');
  });

  it('times out a requested real provider review', async () => {
    vi.useFakeTimers();
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const assertion = expect(
      executeReview({
        scope: 'commit',
        commitSha: 'HEAD',
        requireProvider: true,
        provider: 'openai',
      }),
    ).rejects.toThrow('TIMEOUT after 120000ms');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it('rejects an oversized provider response', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-credential');
    vi.stubEnv('OPENAI_BASE_URL', 'https://provider.invalid/v1');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'x'.repeat(8 * 1024 * 1024) } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await expect(
      executeReview({
        scope: 'commit',
        commitSha: 'HEAD',
        requireProvider: true,
        provider: 'openai',
      }),
    ).rejects.toThrow('PAYLOAD_TOO_LARGE');
  });

  it('reports only the bounded diff coverage submitted to the provider', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'commander-bounded-review-'));

    try {
      expect(spawnSync('git', ['init'], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync(
          'git',
          [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--allow-empty',
            '-m',
            'base',
          ],
          { cwd: workspace },
        ).status,
      ).toBe(0);
      for (let index = 0; index < 20; index += 1) {
        await writeFile(
          join(workspace, `file-${String(index).padStart(2, '0')}.txt`),
          Array.from({ length: 100 }, (_, line) => `${index}-${line}-${'x'.repeat(80)}`).join('\n'),
        );
      }
      expect(spawnSync('git', ['add', '.'], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync(
          'git',
          [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-m',
            'large change',
          ],
          { cwd: workspace },
        ).status,
      ).toBe(0);

      const script = `(async () => {
        process.env.OPENAI_API_KEY = 'test-key-not-a-credential';
        process.env.OPENAI_BASE_URL = 'https://provider.invalid/v1';
        globalThis.fetch = async () => new Response(
          JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
        const { executeReview, formatReviewOutput } = await import(${JSON.stringify(reviewAgentUrl)});
        const report = await executeReview({
          scope: 'commit', commitSha: 'HEAD', requireProvider: true, provider: 'openai'
        });
        console.log('REPORT:' + JSON.stringify({ report, output: formatReviewOutput(report) }));
      })().catch((error) => { console.error(error); process.exit(1); });`;
      const result = spawnSync(process.execPath, [tsxCliPath, '-e', script], {
        cwd: workspace,
        env: withoutProviderCredentials(),
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const resultLine = result.stdout.split('\n').find((line) => line.startsWith('REPORT:'));
      expect(resultLine).toBeDefined();
      const { report, output } = JSON.parse(resultLine!.slice('REPORT:'.length)) as {
        report: Awaited<ReturnType<typeof executeReview>>;
        output: string;
      };

      expect(report.truncated).toBe(true);
      expect(report.passed).toBe(false);
      expect(report.summary).toContain('Review incomplete');
      expect(report.totalFilesInScope).toBe(20);
      expect(report.filesReviewed).toBeLessThan(report.totalFilesInScope);
      expect(report.submittedDiffChars).toBe(15_000);
      expect(report.totalDiffChars).toBeGreaterThan(report.submittedDiffChars);
      expect(output).toContain(
        `${report.filesReviewed}/${report.totalFilesInScope} file(s) represented`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('resolves --commit HEAD for a repository root commit before provider validation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'commander-root-review-'));
    try {
      expect(spawnSync('git', ['init'], { cwd: workspace }).status).toBe(0);
      await writeFile(join(workspace, 'root.txt'), 'root commit\n');
      expect(spawnSync('git', ['add', '.'], { cwd: workspace }).status).toBe(0);
      expect(
        spawnSync(
          'git',
          ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'root'],
          { cwd: workspace },
        ).status,
      ).toBe(0);
      const result = spawnSync(
        process.execPath,
        [tsxCliPath, cliEntryPath, 'review', '--commit', 'HEAD', '--real', '--provider=openai'],
        { cwd: workspace, env: withoutProviderCredentials(), encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('OPENAI_API_KEY');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('unknown revision');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
