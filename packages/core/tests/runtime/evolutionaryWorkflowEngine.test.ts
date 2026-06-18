import { describe, it, expect } from 'vitest';
import { EvolutionaryWorkflowEngine } from '../../src/runtime/evolutionaryWorkflowEngine';

describe('EvolutionaryWorkflowEngine', () => {
  describe('constructor', () => {
    it('creates engine with default config', () => {
      const engine = new EvolutionaryWorkflowEngine();
      expect(engine).toBeDefined();
    });

    it('creates engine with custom config', () => {
      const engine = new EvolutionaryWorkflowEngine({
        populationSize: 20,
        generations: 10,
      });
      expect(engine).toBeDefined();
    });
  });

  describe('evolve', () => {
    it('evolves a simple workflow', async () => {
      const engine = new EvolutionaryWorkflowEngine({
        populationSize: 5,
        generations: 2,
      });
      const result = await engine.evolve({
        taskType: 'CODING',
        availableTools: ['file_read', 'file_write'],
        generations: 1,
      });
      expect(result).toBeDefined();
    });
  });
});
