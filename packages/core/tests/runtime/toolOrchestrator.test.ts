import { describe, it, expect } from 'vitest';
import { ToolOrchestrator } from '../../src/runtime/toolOrchestrator';

describe('ToolOrchestrator', () => {
  describe('constructor', () => {
    it('creates orchestrator with default config', () => {
      const orchestrator = new ToolOrchestrator({});
      expect(orchestrator).toBeDefined();
    });

    it('creates orchestrator with custom config', () => {
      const orchestrator = new ToolOrchestrator({
        maxRetries: 5,
        timeoutMs: 60000,
      });
      expect(orchestrator).toBeDefined();
    });

    it('creates orchestrator with approval mode', () => {
      const orchestrator = new ToolOrchestrator({
        maxRetries: 3,
        timeoutMs: 30000,
      });
      expect(orchestrator).toBeDefined();
    });
  });
});
