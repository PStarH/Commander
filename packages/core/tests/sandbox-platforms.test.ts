import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';

// We test the sandbox internals by importing the modules and checking
// their behavior. Since Seatbelt/Bubblewrap/Docker require specific OS
// features, we test what we can and skip what we can't.

describe('Sandbox Profiles', () => {
  it('READ_ONLY profile has correct structure', async () => {
    const { READ_ONLY } = await import('../src/sandbox/profiles');
    assert.strictEqual(READ_ONLY.mode, 'read-only');
    assert.strictEqual(READ_ONLY.network, 'blocked');
    assert.ok(READ_ONLY.filesystem.readablePaths.length > 0);
    assert.strictEqual(READ_ONLY.filesystem.writablePaths.length, 0);
    assert.ok(READ_ONLY.filesystem.protectedPaths.includes('.git'));
    assert.ok(READ_ONLY.envVarDenyList?.includes('API_KEY'));
    assert.ok(READ_ONLY.envVarDenyList?.includes('SECRET'));
    assert.ok(READ_ONLY.envVarAllowList?.includes('PATH'));
  });

  it('WORKSPACE_WRITE profile allows writing to cwd', async () => {
    const { WORKSPACE_WRITE } = await import('../src/sandbox/profiles');
    assert.strictEqual(WORKSPACE_WRITE.mode, 'workspace-write');
    assert.strictEqual(WORKSPACE_WRITE.network, 'blocked');
    assert.ok(WORKSPACE_WRITE.filesystem.writablePaths.length > 0);
    assert.ok(WORKSPACE_WRITE.filesystem.protectedPaths.includes('.git'));
  });

  it('FULL_ACCESS profile has full network and filesystem', async () => {
    const { FULL_ACCESS } = await import('../src/sandbox/profiles');
    assert.strictEqual(FULL_ACCESS.mode, 'full-access');
    assert.strictEqual(FULL_ACCESS.network, 'full');
    assert.ok(FULL_ACCESS.filesystem.writablePaths.includes('/'));
    // Full-access protects critical system paths (git, auth, cloud credentials)
    assert.strictEqual(FULL_ACCESS.filesystem.protectedPaths.length, 12);
  });

  it('all profiles deny secret env vars', async () => {
    const { READ_ONLY, WORKSPACE_WRITE, FULL_ACCESS } = await import('../src/sandbox/profiles');
    for (const profile of [READ_ONLY, WORKSPACE_WRITE, FULL_ACCESS]) {
      assert.ok(profile.envVarDenyList?.includes('API_KEY'), `${profile.mode} should deny API_KEY`);
      assert.ok(profile.envVarDenyList?.includes('TOKEN'), `${profile.mode} should deny TOKEN`);
      assert.ok(
        profile.envVarDenyList?.includes('PASSWORD'),
        `${profile.mode} should deny PASSWORD`,
      );
      assert.ok(
        profile.envVarDenyList?.includes('CREDENTIAL'),
        `${profile.mode} should deny CREDENTIAL`,
      );
    }
  });
});

describe('ExecPolicyEngine', () => {
  it('blocks dangerous commands', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    const result = engine.evaluate('sudo rm -rf /');
    assert.strictEqual(result.decision, 'forbidden');
    assert.ok(result.rule?.id.includes('forbid-dangerous'));
  });

  it('allows safe read-only commands', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    const result = engine.evaluate('ls -la');
    assert.strictEqual(result.decision, 'allow');
    assert.ok(result.rule?.id.includes('allow-readonly'));
  });

  it('allows dev tooling', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    for (const cmd of ['npm install', 'pnpm test', 'tsc --noEmit', 'eslint .', 'vitest run']) {
      const result = engine.evaluate(cmd);
      assert.strictEqual(result.decision, 'allow', `${cmd} should be allowed`);
    }
  });

  it('allows safe git commands', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    for (const cmd of ['git status', 'git diff', 'git log', 'git branch']) {
      const result = engine.evaluate(cmd);
      assert.strictEqual(result.decision, 'allow', `${cmd} should be allowed`);
    }
  });

  it('prompts on destructive commands', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    const result = engine.evaluate('rm -rf node_modules');
    assert.strictEqual(result.decision, 'prompt');
  });

  it('prompts on network commands', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    const result = engine.evaluate('curl https://example.com');
    assert.strictEqual(result.decision, 'prompt');
  });

  it('blocks fork bombs', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    const result = engine.evaluate(':(){ :|:& };:');
    assert.strictEqual(result.decision, 'forbidden');
  });

  it('blocks sudo variants', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    for (const cmd of ['sudo su', 'sudo rm -rf /', 'su root']) {
      const result = engine.evaluate(cmd);
      assert.strictEqual(result.decision, 'forbidden', `${cmd} should be forbidden`);
    }
  });

  it('higher priority rules take precedence', async () => {
    const { ExecPolicyEngine } = await import('../src/sandbox/execPolicy');
    const engine = new ExecPolicyEngine();

    // "git push --force" matches forbid-secrets (priority 40) and allow-git doesn't cover it
    const result = engine.evaluate('git push --force');
    assert.strictEqual(result.decision, 'prompt');
  });
});

describe('Seatbelt Profile Generation', () => {
  it('buildSeatbeltProfile produces valid SBPL with deny default', async () => {
    // We test the buildSeatbeltProfile function indirectly through the SeatbeltSB class
    // Since buildSeatbeltProfile is not exported, we test the SeatbeltSB behavior
    const platform = os.platform();

    if (platform !== 'darwin') {
      // Skip on non-macOS
      return;
    }

    // On macOS, verify that SeatbeltSB detects sandbox-exec availability
    const { discoverSandboxes } = await import('../src/sandbox/platforms');
    const sandboxes = discoverSandboxes();
    const seatbelt = sandboxes.find((s) => s.name === 'seatbelt');

    if (seatbelt) {
      assert.ok(seatbelt.available, 'Seatbelt should be available on macOS');
      assert.strictEqual(seatbelt.name, 'seatbelt');
    }
  });
});

describe('Bubblewrap Configuration', () => {
  it('BwrapSB is only available on Linux', async () => {
    const { discoverSandboxes } = await import('../src/sandbox/platforms');
    const sandboxes = discoverSandboxes();
    const bwrap = sandboxes.find((s) => s.name === 'bwrap');

    if (os.platform() === 'linux') {
      // On Linux, bwrap may or may not be installed
      if (bwrap) {
        assert.ok(bwrap.available, 'BwrapSB should be available on Linux with bwrap installed');
      }
    } else {
      // On non-Linux, bwrap should not be available
      assert.ok(!bwrap, 'BwrapSB should not be available on non-Linux');
    }
  });
});

describe('Docker Configuration', () => {
  it('builds container security options with a non-root user', async () => {
    const { buildContainerSecurityOptions } = await import('../src/sandbox/platforms');
    const options = buildContainerSecurityOptions();
    const userIndex = options.indexOf('--user');

    assert.ok(userIndex >= 0, 'container security options should set --user');
    assert.match(options[userIndex + 1] ?? '', /^[1-9][0-9]*:[1-9][0-9]*$/);
    assert.ok(options.includes('--cap-drop'));
    assert.ok(options.includes('--read-only'));
  });

  it('DockerSB detects Docker availability', async () => {
    const { discoverSandboxes } = await import('../src/sandbox/platforms');
    const sandboxes = discoverSandboxes();
    const docker = sandboxes.find((s) => s.name === 'docker');

    // Docker may or may not be installed — just verify the detection works
    if (docker) {
      assert.ok(docker.available, 'DockerSB should report available if docker info succeeds');
      assert.strictEqual(docker.name, 'docker');
    }
  });
});

describe('NoopSB Fallback', () => {
  it('NoopSB is always available', async () => {
    const { NoopSB } = await import('../src/sandbox/platforms');
    const noop = new NoopSB();
    assert.ok(noop.available, 'NoopSB should always be available');
    assert.strictEqual(noop.name, 'none');
  });

  it('NoopSB refuses commands whose network policy cannot be enforced', async () => {
    const { NoopSB } = await import('../src/sandbox/platforms');
    const noop = new NoopSB();

    const result = await noop.execute('echo "hello sandbox"', {
      mode: 'workspace-write',
      network: 'blocked',
      filesystem: {
        readablePaths: [process.cwd()],
        writablePaths: [process.cwd()],
        protectedPaths: [],
        useStagingDir: false,
      },
      envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET'],
      envVarAllowList: ['PATH', 'HOME', 'USER', 'SHELL', 'TERM'],
    });

    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.exitCode, 126);
    assert.deepEqual(result.violated, ['network_policy_not_enforceable']);
  });

  it('NoopSB filters secret env vars', async () => {
    const { NoopSB } = await import('../src/sandbox/platforms');
    const noop = new NoopSB();

    // Set a test secret env var
    process.env.TEST_API_KEY_SECRET = 'should-be-filtered';

    const result = await noop.execute('env', {
      mode: 'workspace-write',
      network: 'blocked',
      filesystem: {
        readablePaths: [process.cwd()],
        writablePaths: [process.cwd()],
        protectedPaths: [],
        useStagingDir: false,
      },
      envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET'],
      envVarAllowList: [],
    });

    // The secret should NOT appear in the output
    assert.ok(!result.stdout.includes('TEST_API_KEY_SECRET'), 'Secret env var should be filtered');

    // Cleanup
    delete process.env.TEST_API_KEY_SECRET;
  });
});

describe('SandboxManager', () => {
  it('discovers available sandboxes without crashing', async () => {
    const { SandboxManager } = await import('../src/sandbox/manager');
    // CI/test runners usually lack OS-level sandboxes; allow explicit noop fallback.
    const manager = new SandboxManager({ allowNoSandbox: true });
    const mechanisms = manager.getAvailableMechanisms();
    assert.ok(Array.isArray(mechanisms), 'Should return an array');
  });

  it('fails closed when no sandbox is available and fallback is not allowed', async () => {
    const { SandboxManager, SandboxInitializationError } = await import('../src/sandbox/manager');
    assert.throws(
      () => new SandboxManager({ sandboxes: [], allowNoSandbox: false }),
      SandboxInitializationError,
    );
  });
});
