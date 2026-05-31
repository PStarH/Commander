import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExecPolicyEngine } from '../src/sandbox/execPolicy';
import { SandboxManager } from '../src/sandbox/manager';

describe('Sandbox security hardening', () => {
  it('full-access profile still filters sensitive environment variables', () => {
    const manager = new SandboxManager();
    const profile = manager.getProfile('full-access');

    assert.ok(profile.envVarDenyList?.includes('API_KEY'));
    assert.ok(profile.envVarDenyList?.includes('TOKEN'));
    assert.deepStrictEqual(profile.envVarAllowList, ['PATH', 'HOME', 'USER', 'SHELL', 'TERM']);
  });

  it('exec policy detects network commands after pipes and command substitution', () => {
    const policy = new ExecPolicyEngine();

    assert.strictEqual(policy.evaluate('echo ok | curl https://example.com').decision, 'prompt');
    assert.strictEqual(policy.evaluate('echo $(curl https://example.com)').decision, 'prompt');
    assert.strictEqual(policy.evaluate('echo `wget https://example.com/file`').decision, 'prompt');
    assert.strictEqual(policy.evaluate('HTTPS_PROXY=http://proxy curl https://example.com').decision, 'prompt');
  });

  it('exec policy matches command names without matching harmless arguments', () => {
    const policy = new ExecPolicyEngine();

    // 'echo' is a known safe command → allow
    assert.strictEqual(policy.evaluate('echo curl').decision, 'allow');
    // 'mycurl' is an unknown command → prompt (fail-safe default)
    assert.strictEqual(policy.evaluate('mycurl https://example.com').decision, 'prompt');
  });

  it('exec policy forbids destructive shell payloads and device writes', () => {
    const policy = new ExecPolicyEngine();

    assert.strictEqual(policy.evaluate(':(){ :|:& };:').decision, 'forbidden');
    assert.strictEqual(policy.evaluate('dd if=/dev/zero of=/dev/sda').decision, 'forbidden');
    assert.strictEqual(policy.evaluate('mkfs.ext4 /dev/sda1').decision, 'forbidden');
  });

  it('exec policy resolves symlinked command paths before matching', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-policy-'));
    const curlTarget = path.join(tmpDir, 'curl');
    const linkPath = path.join(tmpDir, 'fetch-data');
    try {
      fs.writeFileSync(curlTarget, '');
      fs.symlinkSync(curlTarget, linkPath);
      const policy = new ExecPolicyEngine();
      assert.strictEqual(policy.evaluate(`${linkPath} https://example.com`).decision, 'prompt');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
