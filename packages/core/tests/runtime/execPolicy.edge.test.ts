/**
 * D3 hardening-sprint — ExecPolicyEngine edge-case coverage.
 *
 * What this file pins down (and why)
 * ───────────────────────────────────
 * The D3 pre-commit hook can only make safe calls to the policy engine if
 * the engine's behaviour at boundaries is well-tested and stable. These
 * tests document the security contract for command shapes that are easy to
 * misclassify or that have historically been attack vectors:
 *
 *   1. Pipes       — `cat /etc/shadow | sha256sum` (both commands safe-readonly)
 *   2. $(…) sub    — `zzz-unknown $(xxx-not-real)` (extracted subst does NOT match by itself)
 *   3. backticks   — `zzz-unknown \`xxx-not-real\``  (same shape, backtick form)
 *   4. fork bomb   — `:(){ :|:& };:`                (forbid-dangerous shell-payload match)
 *   5. sudo        — `sudo rm -rf /`                (forbid-dangerous command-name match)
 *   6. wrapper     — `timeout 30 cat /etc/passwd`   (wrapper-strip re-evaluates stripped command)
 *   7. symlink     — `/tmp/sym → /bin/cat …`       (commandNameAliases.resolveRealPath)
 *   8. default     — unknown command                (fail-safe: prompt)
 *
 * Each test asserts the CURRENT behaviour. If a test starts failing after
 * a policy change, the security contract has shifted and the D3 gate docs
 * (`docs/security/hardening-sprint.md` §3 D3) must be updated.
 *
 * These tests do NOT cover the runtime sandbox itself; the sandbox layer
 * (Workspace/Seatbelt/Bubblewrap) is what actually protects the host
 * filesystem. ExecPolicy is the upstream *classification* layer.
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import { ExecPolicyEngine } from '../../src/sandbox/execPolicy';

describe('D3 hardening — ExecPolicyEngine edge cases', () => {
  let engine: ExecPolicyEngine;

  beforeEach(() => {
    // Fresh engine per test so per-rule state cannot leak between cases.
    engine = new ExecPolicyEngine();
  });

  afterEach(() => {
    // No global teardown required — each test owns its own engine.
  });

  describe('pipes', () => {
    it('cat /etc/shadow | sha256sum → allow (both safe-readonly; sandbox is the protection layer)', () => {
      const r = engine.evaluate('cat /etc/shadow | sha256sum');
      assert.equal(r.decision, 'allow');
      assert.ok(['cat', 'sha256sum'].includes(r.matchedPattern ?? ''));
      // Documentation contract: ExecPolicy ALLOWS this; the workspace sandbox
      // (Lane + protectedPaths) is responsible for blocking the protected-path
      // read at execution time. See tests/sandbox/lane.test.ts.
    });
  });

  describe('shell command substitution $(...)', () => {
    it('...with a non-matching extracted payload → prompt via implicit-command-substitution', () => {
      const r = engine.evaluate('zzz-no-such-tool $(some-nonexistent-thing-12345)');
      assert.equal(r.decision, 'prompt');
      assert.equal(r.rule?.id, 'implicit-command-substitution');
      assert.equal(r.matchedPattern, '$(');
    });

    it('nested $(...) where innermost payload does NOT match a safe rule falls through to implicit-command-substitution', () => {
      // extractCommandSubstitutions regex /\$\(([^()]*)\)/ matches only the
      // innermost no-inner-parens $(). After extraction queue = [original,
      // 'my-custom-script']; candidates.commandNames = {'unknown-app',
      // 'my-custom-script'}; neither is in SAFE_READONLY/SAFE_GIT/SAFE_DEV.
      // No rule matches, then hasCommandSubstitution → 'prompt' rule id
      // 'implicit-command-substitution'.
      const r = engine.evaluate('unknown-app $(cat $(my-custom-script))');
      assert.equal(r.decision, 'prompt');
      assert.equal(r.rule?.id, 'implicit-command-substitution');
      assert.equal(r.matchedPattern, '$(');
    });
  });

  describe('backtick substitution', () => {
    it('`...` with a non-matching extracted payload → prompt via implicit-command-substitution', () => {
      const r = engine.evaluate('zzz-no-such-tool `some-nonexistent-thing-12345`');
      assert.equal(r.decision, 'prompt');
      assert.equal(r.rule?.id, 'implicit-command-substitution');
    });
  });

  describe('forbid-dangerous', () => {
    it('`sudo anything` is forbidden by priority-100 rule', () => {
      const r = engine.evaluate('sudo rm -rf /');
      assert.equal(r.decision, 'forbidden');
      assert.equal(r.rule?.id, 'forbid-dangerous');
      assert.equal(r.matchedPattern, 'sudo');
    });

    it('`npx` is forbidden (supply-chain / MCP hard rule)', () => {
      const r = engine.evaluate('npx -y some-pkg');
      assert.equal(r.decision, 'forbidden');
      assert.equal(r.matchedPattern, 'npx');
    });

    it('fork bomb colon-fn pattern is forbidden', () => {
      const r = engine.evaluate(':(){ :|:& };:');
      assert.equal(r.decision, 'forbidden');
      assert.equal(r.rule?.id, 'forbid-dangerous');
    });
  });

  describe('wrapper-prefix strip', () => {
    it('`timeout 30 cat /etc/passwd` strips `timeout 30 ` and re-evaluates as `cat`', () => {
      const r = engine.evaluate('timeout 30 cat /etc/passwd');
      assert.equal(r.decision, 'allow');
      assert.equal(r.matchedPattern, 'cat');
    });
  });

  describe('symlink-following via commandNameAliases.resolveRealPath', () => {
    it('a tmp symlink to /bin/cat resolves to command name `cat` and is allow-classified', () => {
      // Windows symlinks require admin/developer mode, and `which cat` returns
      // `cat.exe` — the policy pattern `cat` won't match `cat.exe`. Skip cleanly.
      if (process.platform === 'win32') return;

      // Resolve the platform's real `cat` binary path. macOS hides /bin behind
      // a redirector in some configs; Linux is straightforward. We surface the
      // environment failure as a test error rather than a silent skip so CI
      // is unaware of regressions in the symlink-resolution path.
      let realCat: string;
      try {
        realCat = execSync('which cat', { encoding: 'utf-8' }).trim();
        if (!realCat) throw new Error('which cat returned empty');
      } catch (err) {
        throw new Error(
          `symlink test requires \`which cat\` to succeed (got: ${(err as Error).message}). ` +
            'Symlink-via-resolveRealPath cannot be exercised in this environment.',
        );
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execPolicy-symlink-'));
      try {
        const link = path.join(tmpDir, 'mycat');
        fs.symlinkSync(realCat, link);
        const r = engine.evaluate(`${link} /etc/shadow`);
        // After commandNameAliases.resolveRealPath, the basename is 'cat';
        // 'cat' is in SAFE_READONLY (priority 1).
        assert.equal(r.decision, 'allow');
        assert.equal(r.matchedPattern, 'cat');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('default', () => {
    it('unknown + no substitution → prompt via default-unknown-command (fail-safe)', () => {
      const r = engine.evaluate('totally-unknown-cmd-zyxwvut-not-real');
      assert.equal(r.decision, 'prompt');
      assert.equal(r.rule?.id, 'default-unknown-command');
    });
  });
});
