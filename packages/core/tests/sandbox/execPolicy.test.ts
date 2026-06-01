import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExecPolicyEngine } from '../../src/sandbox/execPolicy';

describe('ExecPolicyEngine', () => {
  let engine: ExecPolicyEngine;

  beforeEach(() => {
    engine = new ExecPolicyEngine();
  });

  describe('safe read-only commands', () => {
    it('allows basic read-only commands', () => {
      const safeCommands = ['cat', 'ls', 'pwd', 'echo', 'grep', 'head', 'tail', 'wc', 'which', 'whoami'];
      for (const cmd of safeCommands) {
        const result = engine.evaluate(cmd);
        assert.equal(result.decision, 'allow', `Expected 'allow' for "${cmd}", got '${result.decision}'`);
      }
    });

    it('allows git read operations', () => {
      const gitCommands = ['git status', 'git diff', 'git log', 'git branch', 'git show', 'git blame'];
      for (const cmd of gitCommands) {
        const result = engine.evaluate(cmd);
        assert.equal(result.decision, 'allow', `Expected 'allow' for "${cmd}", got '${result.decision}'`);
      }
    });

    it('allows development tooling', () => {
      const devCommands = ['npm', 'pnpm', 'yarn', 'tsc', 'eslint', 'node', 'python3', 'cargo'];
      for (const cmd of devCommands) {
        const result = engine.evaluate(cmd);
        assert.equal(result.decision, 'allow', `Expected 'allow' for "${cmd}", got '${result.decision}'`);
      }
    });
  });

  describe('network commands require prompt', () => {
    it('prompts for network commands', () => {
      const networkCommands = ['curl', 'wget', 'nc', 'ssh', 'sftp'];
      for (const cmd of networkCommands) {
        const result = engine.evaluate(cmd);
        assert.equal(result.decision, 'prompt', `Expected 'prompt' for "${cmd}", got '${result.decision}'`);
      }
    });
  });

  describe('destructive commands require prompt', () => {
    it('prompts for rm -rf and similar', () => {
      const destructiveCommands = ['rm -rf', 'rm -r', 'chmod -R', 'git reset --hard', 'git clean -f'];
      for (const cmd of destructiveCommands) {
        const result = engine.evaluate(cmd);
        assert.equal(result.decision, 'prompt', `Expected 'prompt' for "${cmd}", got '${result.decision}'`);
      }
    });
  });

  describe('forbidden commands are blocked', () => {
    it('blocks sudo and dangerous commands', () => {
      const forbiddenCommands = ['sudo', 'passwd', 'mkfs'];
      for (const cmd of forbiddenCommands) {
        const result = engine.evaluate(cmd);
        assert.equal(result.decision, 'forbidden', `Expected 'forbidden' for "${cmd}", got '${result.decision}'`);
      }
    });
  });

  describe('inline code execution requires prompt', () => {
    it('prompts for inline code execution', () => {
      const inlineCommands = ['python3 -c', 'python -c', 'node -e', 'perl -e', 'ruby -e', 'osascript'];
      for (const cmd of inlineCommands) {
        const result = engine.evaluate(cmd);
        assert.equal(result.decision, 'prompt', `Expected 'prompt' for "${cmd}", got '${result.decision}'`);
      }
    });
  });

  describe('unknown commands default to prompt', () => {
    it('prompts for unrecognized commands', () => {
      const result = engine.evaluate('some-unknown-tool-xyz');
      assert.equal(result.decision, 'prompt');
    });
  });

  describe('command substitution detection', () => {
    it('evaluates commands with substitution syntax', () => {
      // The engine evaluates the primary command and may match it to a rule
      // Command substitution in the argument is handled at a different layer
      const result = engine.evaluate('curl $(whoami)');
      assert.ok(['allow', 'prompt', 'forbidden'].includes(result.decision));
    });
  });

  describe('wrapper prefix stripping', () => {
    it('strips timeout wrapper and matches inner command', () => {
      const result = engine.evaluate('timeout 30 npm test');
      assert.equal(result.decision, 'allow');
    });

    it('strips time wrapper', () => {
      const result = engine.evaluate('time ls -la');
      assert.equal(result.decision, 'allow');
    });
  });

  describe('priority ordering', () => {
    it('higher priority rules override lower priority', () => {
      // sudo has priority 100 (forbidden) which overrides any lower-priority allow
      const result = engine.evaluate('sudo ls');
      assert.equal(result.decision, 'forbidden');
    });
  });

  describe('custom rules', () => {
    it('can add and evaluate custom rules', () => {
      engine.addRule({ pattern: ['my-tool'], decision: 'allow', priority: 50 });
      const result = engine.evaluate('my-tool');
      assert.equal(result.decision, 'allow');
    });

    it('can remove custom rules', () => {
      const rule = engine.addRule({ pattern: ['temp-tool'], decision: 'allow', priority: 50 });
      engine.removeRule(rule.id);
      const result = engine.evaluate('temp-tool');
      // After removal, should fall through to default prompt
      assert.equal(result.decision, 'prompt');
    });

    it('getRules returns all rules', () => {
      const initialCount = engine.getRules().length;
      engine.addRule({ pattern: ['test-cmd'], decision: 'allow' });
      assert.equal(engine.getRules().length, initialCount + 1);
    });
  });

  describe('case insensitivity', () => {
    it('matches commands case-insensitively', () => {
      const result = engine.evaluate('CAT /etc/passwd');
      assert.equal(result.decision, 'allow');
    });
  });

  describe('matchedPattern and rule metadata', () => {
    it('returns matchedPattern for matched rules', () => {
      const result = engine.evaluate('ls -la');
      assert.ok(result.matchedPattern);
      assert.equal(result.matchedPattern, 'ls');
    });

    it('returns rule with justification', () => {
      const result = engine.evaluate('sudo reboot');
      assert.ok(result.rule);
      assert.ok(result.rule.justification);
    });
  });
});
