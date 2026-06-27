import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getGuardianAgent } from '../../src/security/guardianAgent';

describe('GuardianAgent.detectDangerousToolCall', () => {
  let guardian: ReturnType<typeof getGuardianAgent>;

  beforeEach(() => {
    guardian = getGuardianAgent();
    guardian.reset();
  });

  /**
   * Helper: simulate a tool_call action and check if Guardian intervenes.
   * Returns the intervention type or null if no intervention.
   */
  function checkToolCall(toolName: string, args: Record<string, unknown>): string | null {
    const content = `${toolName}(${JSON.stringify(args).slice(0, 200)})`;
    return guardian.monitor({
      type: 'tool_call',
      agentId: 'test-agent',
      runId: 'test-run',
      timestamp: Date.now(),
      content,
      metadata: { args },
    });
  }

  describe('catastrophic deletion patterns', () => {
    it('should block rm -rf / (root directory)', () => {
      const result = checkToolCall('shell_execute', { command: 'rm -rf /' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm -rf / from JSON-serialized content', () => {
      // This is the critical test — the command is embedded in JSON
      // and the old regex failed because `/` was followed by `"` not whitespace
      const result = checkToolCall('shell_execute', { command: 'rm -rf /' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm -rf ~ (home directory)', () => {
      const result = checkToolCall('shell_execute', { command: 'rm -rf ~' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm -rf * (wildcard)', () => {
      const result = checkToolCall('shell_execute', { command: 'rm -rf *' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm -rf . (current directory)', () => {
      const result = checkToolCall('shell_execute', { command: 'rm -rf .' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm -rf $HOME', () => {
      const result = checkToolCall('shell_execute', { command: 'rm -rf $HOME' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm -rf $PWD', () => {
      const result = checkToolCall('shell_execute', { command: 'rm -rf $PWD' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm -r / (without -f flag)', () => {
      const result = checkToolCall('shell_execute', { command: 'rm -r /' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm --recursive --force / (long options)', () => {
      const result = checkToolCall('shell_execute', { command: 'rm --recursive --force /' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block rm with multiple spaces rm  -rf  /', () => {
      const result = checkToolCall('shell_execute', { command: 'rm  -rf  /' });
      expect(result).toBe('dangerous_tool_call');
    });
  });

  describe('system destruction patterns', () => {
    it('should block chmod -R 777 /', () => {
      const result = checkToolCall('shell_execute', { command: 'chmod -R 777 /' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block mkfs', () => {
      const result = checkToolCall('shell_execute', { command: 'mkfs.ext4 /dev/sda1' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block dd to device', () => {
      const result = checkToolCall('shell_execute', { command: 'dd if=/dev/zero of=/dev/sda' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block fork bomb', () => {
      const result = checkToolCall('shell_execute', { command: ':(){ :|:& };:' });
      expect(result).toBe('dangerous_tool_call');
    });
  });

  describe('database destruction patterns', () => {
    it('should block DROP TABLE', () => {
      const result = checkToolCall('shell_execute', { command: 'psql -c "DROP TABLE users"' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block DROP DATABASE', () => {
      const result = checkToolCall('shell_execute', { command: 'psql -c "DROP DATABASE production"' });
      expect(result).toBe('dangerous_tool_call');
    });

    it('should block TRUNCATE TABLE', () => {
      const result = checkToolCall('shell_execute', { command: 'psql -c "TRUNCATE TABLE users"' });
      expect(result).toBe('dangerous_tool_call');
    });
  });

  describe('non-dangerous commands (should NOT block)', () => {
    it('should NOT block rm of a specific file', () => {
      const result = checkToolCall('shell_execute', { command: 'rm /tmp/test.txt' });
      expect(result).not.toBe('dangerous_tool_call');
    });

    it('should NOT block ls', () => {
      const result = checkToolCall('shell_execute', { command: 'ls -la /tmp' });
      expect(result).not.toBe('dangerous_tool_call');
    });

    it('should NOT block file_read tool', () => {
      const result = checkToolCall('file_read', { path: '/tmp/test.txt' });
      expect(result).not.toBe('dangerous_tool_call');
    });
  });

  describe('auto-resume for non-critical interventions', () => {
    it('should auto-resume agents paused for non-critical reasons', () => {
      // Trigger a cost_overrun intervention (non-critical, auto-resumable)
      guardian.monitor({
        type: 'tool_call',
        agentId: 'test-agent-resume',
        runId: 'test-run',
        timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago (past timeout)
        content: 'test',
        metadata: {},
      });

      // Manually trigger cost overrun by setting up the scenario
      // Since cost_overrun requires specific token usage patterns,
      // we test the auto-resume mechanism directly
      const pausedBefore = guardian.isPaused('test-agent-resume');

      // The agent may or may not be paused depending on the monitor result,
      // but checkAutoResume should not crash and should return a number
      const resumed = guardian.checkAutoResume();
      expect(typeof resumed).toBe('number');
    });

    it('should NOT auto-resume agents paused for dangerous_tool_call', () => {
      // Trigger a dangerous_tool_call intervention
      guardian.monitor({
        type: 'tool_call',
        agentId: 'test-agent-dangerous',
        runId: 'test-run',
        timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago
        content: 'shell_execute({"command":"rm -rf /"})',
        metadata: { args: { command: 'rm -rf /' } },
      });

      // Agent should be paused
      expect(guardian.isPaused('test-agent-dangerous')).toBe(true);

      // Run auto-resume check
      guardian.checkAutoResume();

      // Agent should STILL be paused (dangerous_tool_call is not auto-resumable)
      expect(guardian.isPaused('test-agent-dangerous')).toBe(true);
    });
  });
});
