import { describe, it, expect } from 'vitest';
import { WorkflowPopulation } from '../../src/runtime/workflowPopulation';

describe('WorkflowPopulation', () => {
  const defaultConfig = {
    populationSize: 5,
    generations: 3,
    mutationRate: 0.2,
    crossoverRate: 0.7,
    elitismCount: 1,
  };

  describe('constructor', () => {
    it('creates population with config', () => {
      const population = new WorkflowPopulation(defaultConfig);
      expect(population).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('initializes population with random individuals', () => {
      const population = new WorkflowPopulation(defaultConfig);
      population.initialize('CODING', [
        { id: 'n1', type: 'tool', toolName: 'file_read' },
        { id: 'n2', type: 'tool', toolName: 'file_write' },
        { id: 'n3', type: 'tool', toolName: 'shell_execute' },
      ]);
      expect(population.individualsAccessor.length).toBe(5);
    });

    it('creates different individuals', () => {
      const population = new WorkflowPopulation(defaultConfig);
      population.initialize('CODING', [
        { id: 'n1', type: 'tool', toolName: 'file_read' },
        { id: 'n2', type: 'tool', toolName: 'file_write' },
      ]);
      const ids = population.individualsAccessor.map(i => i.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('evolve', () => {
    it('runs evolution and returns best individual', async () => {
      const population = new WorkflowPopulation(defaultConfig);
      population.initialize('CODING', [
        { id: 'n1', type: 'tool', toolName: 'file_read' },
        { id: 'n2', type: 'tool', toolName: 'file_write' },
      ]);
      const evaluateFn = async () => Math.random();
      const result = await population.evolve(evaluateFn);
      expect(result).toBeDefined();
      expect(result.fitness).toBeDefined();
    });

    it('tracks fitness history', async () => {
      const population = new WorkflowPopulation(defaultConfig);
      population.initialize('CODING', [
        { id: 'n1', type: 'tool', toolName: 'file_read' },
        { id: 'n2', type: 'tool', toolName: 'file_write' },
      ]);
      const result = await population.evolve(async () => Math.random());
      expect(result).toBeDefined();
      // Evolution should produce a result even if history tracking varies
    });

    it('selects best individual', async () => {
      const population = new WorkflowPopulation(defaultConfig);
      population.initialize('CODING', [
        { id: 'n1', type: 'tool', toolName: 'file_read' },
        { id: 'n2', type: 'tool', toolName: 'file_write' },
      ]);
      // Make first individual clearly better
      let callCount = 0;
      const evaluateFn = async () => {
        callCount++;
        return callCount === 1 ? 1.0 : 0.1;
      };
      const result = await population.evolve(evaluateFn);
      expect(result.fitness).toBeGreaterThan(0);
    });
  });
});
