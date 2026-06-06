import { describe, it, expect } from 'vitest';
import { ToolApproval, DEFAULT_APPROVAL_POLICIES } from '../../src/runtime/toolApproval';

describe('ToolApproval', () => {
  describe('constructor', () => {
    it('creates approval system with default config', () => {
      const approval = new ToolApproval();
      expect(approval).toBeDefined();
    });
  });

  describe('requestApproval', () => {
    it('auto-approves safe tools', async () => {
      const approval = new ToolApproval();
      const result = await approval.requestApproval('file_read', {}, 'agent-1', 'run-1');
      expect(result).toBeDefined();
      expect(result.approved).toBe(true);
    });

    it('auto-approves web_search', async () => {
      const approval = new ToolApproval();
      const result = await approval.requestApproval('web_search', { query: 'test' }, 'agent-1', 'run-1');
      expect(result.approved).toBe(true);
    });

    it('handles dangerous tools', async () => {
      const approval = new ToolApproval({
        callback: async () => true, // Auto-approve for testing
      });
      const result = await approval.requestApproval('shell_execute', { command: 'ls' }, 'agent-1', 'run-1');
      expect(result).toBeDefined();
    });
  });

  describe('getPendingApprovals', () => {
    it('returns pending approvals', () => {
      const approval = new ToolApproval();
      const pending = approval.getPendingApprovals();
      expect(Array.isArray(pending)).toBe(true);
    });
  });

  describe('getStats', () => {
    it('returns approval statistics', () => {
      const approval = new ToolApproval();
      const stats = approval.getStats();
      expect(stats).toBeDefined();
    });
  });

  describe('DEFAULT_APPROVAL_POLICIES', () => {
    it('has default policies', () => {
      expect(DEFAULT_APPROVAL_POLICIES.length).toBeGreaterThan(0);
    });

    it('includes shell_execute as manual', () => {
      const shellPolicy = DEFAULT_APPROVAL_POLICIES.find(p => p.pattern === 'shell_execute');
      expect(shellPolicy).toBeDefined();
      expect(shellPolicy!.level).toBe('manual');
    });

    it('includes web_search as auto', () => {
      const webPolicy = DEFAULT_APPROVAL_POLICIES.find(p => p.pattern === 'web_search');
      expect(webPolicy).toBeDefined();
      expect(webPolicy!.level).toBe('auto');
    });

    it('includes web_search as auto', () => {
      const webPolicy = DEFAULT_APPROVAL_POLICIES.find(p => p.pattern === 'web_search');
      expect(webPolicy).toBeDefined();
      expect(webPolicy!.level).toBe('auto');
    });
  });
});
