import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initializeRuntimeGuardian,
  isRuntimeGuardianAvailable,
  reviewToolCall,
  resetRuntimeGuardian,
  DEFAULT_RUNTIME_GUARDIAN_CONFIG,
} from '../../src/runtime/runtimeGuardianBridge';
import type { ToolCall } from '../../src/runtime/types';

// Mock provider for testing
function createMockProvider(approve: boolean, delayMs = 0) {
  return {
    call: vi.fn().mockImplementation((input: { model: string; messages: { role: string; content: string }[]; maxTokens: number }) => {
      return new Promise<{ content?: string }>((resolve) => {
        setTimeout(() => {
          resolve({
            content: `APPROVED: ${approve}\nREASON: Test decision\nSUGGESTION: None`,
          });
        }, delayMs);
      });
    }),
  };
}

function createFailingProvider() {
  return {
    call: vi.fn().mockRejectedValue(new Error('LLM provider error')),
  };
}

const safeToolCall: ToolCall = {
  id: 'tc-1',
  name: 'file_read',
  arguments: { path: '/tmp/test.txt' },
};

const dangerousToolCall: ToolCall = {
  id: 'tc-2',
  name: 'shell_execute',
  arguments: { command: 'rm -rf /tmp/test' },
};

describe('runtimeGuardianBridge', () => {
  beforeEach(() => {
    // Reset to uninitialized state — clear cache, provider, and config
    resetRuntimeGuardian();
  });

  describe('isRuntimeGuardianAvailable', () => {
    it('should return false when not initialized', () => {
      // After reset with null provider and disabled
      expect(isRuntimeGuardianAvailable()).toBe(false);
    });

    it('should return true when initialized with a provider and enabled', () => {
      initializeRuntimeGuardian(() => createMockProvider(true), { enabled: true });
      expect(isRuntimeGuardianAvailable()).toBe(true);
    });
  });

  describe('reviewToolCall', () => {
    it('should auto-approve safe tools without LLM call', async () => {
      const mockProvider = createMockProvider(false); // Even if LLM would reject
      initializeRuntimeGuardian(() => mockProvider, { enabled: true });

      const decision = await reviewToolCall(safeToolCall, 'read a file');

      expect(decision.approved).toBe(true);
      expect(decision.reviewed).toBe(false);
      expect(mockProvider.call).not.toHaveBeenCalled();
    });

    it('should auto-approve when guardian is not available', async () => {
      initializeRuntimeGuardian(() => null, { enabled: false });

      const decision = await reviewToolCall(dangerousToolCall, 'test');

      expect(decision.approved).toBe(true);
      expect(decision.reviewed).toBe(false);
    });

    it('should auto-approve when provider is not available', async () => {
      initializeRuntimeGuardian(() => null, { enabled: true });

      const decision = await reviewToolCall(dangerousToolCall, 'test');

      expect(decision.approved).toBe(true);
      expect(decision.reviewed).toBe(false);
    });

    it('should return LLM decision when provider approves', async () => {
      const mockProvider = createMockProvider(true);
      initializeRuntimeGuardian(() => mockProvider, { enabled: true });

      const decision = await reviewToolCall(dangerousToolCall, 'test task');

      expect(decision.approved).toBe(true);
      expect(decision.reviewed).toBe(true);
      expect(mockProvider.call).toHaveBeenCalledTimes(1);
    });

    it('should return LLM decision when provider rejects', async () => {
      const mockProvider = createMockProvider(false);
      initializeRuntimeGuardian(() => mockProvider, { enabled: true });

      const decision = await reviewToolCall(dangerousToolCall, 'test task');

      expect(decision.approved).toBe(false);
      expect(decision.reviewed).toBe(true);
    });

    it('should fail-open on provider errors', async () => {
      const mockProvider = createFailingProvider();
      initializeRuntimeGuardian(() => mockProvider, { enabled: true });

      const decision = await reviewToolCall(dangerousToolCall, 'test task');

      expect(decision.approved).toBe(true);
      expect(decision.reviewed).toBe(false);
    });

    it('should fail-open on timeout', async () => {
      const mockProvider = createMockProvider(true, 10000); // 10s delay
      initializeRuntimeGuardian(() => mockProvider, {
        enabled: true,
        timeoutMs: 100, // 100ms timeout
      });

      const decision = await reviewToolCall(dangerousToolCall, 'test task');

      expect(decision.approved).toBe(true);
      expect(decision.reviewed).toBe(false);
    });

    it('should cache decisions for repeated calls', async () => {
      const mockProvider = createMockProvider(true);
      initializeRuntimeGuardian(() => mockProvider, { enabled: true });

      // First call — should hit LLM
      const decision1 = await reviewToolCall(dangerousToolCall, 'test task');
      expect(mockProvider.call).toHaveBeenCalledTimes(1);

      // Second call with same tool — should hit cache
      const decision2 = await reviewToolCall(dangerousToolCall, 'test task');
      expect(mockProvider.call).toHaveBeenCalledTimes(1); // Still 1, from cache

      expect(decision1.approved).toBe(true);
      expect(decision2.approved).toBe(true);
      expect(decision2.reason).toContain('cached');
    });
  });
});
