import { describe, it, expect } from 'vitest';
import { WorkflowPopulation } from '../../src/runtime/workflowPopulation';
import { DEFAULT_EVOLUTION_CONFIG } from '../../src/runtime/evolutionaryWorkflowTypes';

/**
 * RTC-17: this file passed a config object that does not match the production
 * `EvolutionConfig` — it used `generations`/`elitismCount` (the real fields are
 * `maxGenerations`/`elitismRate`) and omitted the required
 * `minFitnessThreshold`/`stagnationGenerations`/`evaluationMethod`. Tests are
 * excluded from `tsc`, so the mismatch was invisible; `stagnationGenerations`
 * was `undefined` at runtime, which silently disabled the stagnation check.
 *
 * Every assertion below is on a value the population itself must compute.
 */

const NODES = [
  { id: 'n1', type: 'tool', toolName: 'file_read' },
  { id: 'n2', type: 'tool', toolName: 'file_write' },
  { id: 'n3', type: 'tool', toolName: 'shell_execute' },
] as never;

function makePopulation(overrides: Partial<typeof DEFAULT_EVOLUTION_CONFIG> = {}) {
  return new WorkflowPopulation({
    ...DEFAULT_EVOLUTION_CONFIG,
    populationSize: 5,
    maxGenerations: 3,
    minFitnessThreshold: 0.7,
    ...overrides,
  });
}

function fitnessHistory(population: WorkflowPopulation): number[] {
  return (population as unknown as { fitnessHistory: number[] }).fitnessHistory;
}

describe('WorkflowPopulation', () => {
  describe('constructor', () => {
    it('keeps the supplied evolution config', () => {
      const population = makePopulation();
      const config = (population as unknown as { config: Record<string, unknown> }).config;
      expect(config.populationSize).toBe(5);
      expect(config.maxGenerations).toBe(3);
      expect(config.stagnationGenerations).toBe(DEFAULT_EVOLUTION_CONFIG.stagnationGenerations);
      expect(config.minFitnessThreshold).toBe(0.7);
    });
  });

  describe('initialize', () => {
    it('creates exactly populationSize distinct individuals', () => {
      const population = makePopulation();
      population.initialize('CODING', NODES);

      const individuals = population.individualsAccessor;
      expect(individuals).toHaveLength(5);
      expect(new Set(individuals.map((dag) => dag.id)).size).toBe(5);
      // Every individual is built from the nodes it was handed.
      for (const dag of individuals) {
        expect(dag.nodes.length).toBeGreaterThan(0);
        for (const node of dag.nodes) {
          expect(['n1', 'n2', 'n3']).toContain(node.id);
        }
      }
    });

    it('starts a fresh generation counter', async () => {
      const population = makePopulation({ maxGenerations: 2 });
      population.initialize('CODING', NODES);
      await population.evolve(async () => 0.1);
      expect(population.generationAccessor).toBeGreaterThan(0);

      population.initialize('CODING', NODES);
      expect(population.generationAccessor).toBe(0);
    });
  });

  describe('evolve', () => {
    it('returns the best individual with the exact fitness the evaluator produced', async () => {
      const population = makePopulation();
      population.initialize('CODING', NODES);

      const result = await population.evolve(async () => 0.42);

      expect(result.fitness).toBe(0.42);
      expect(population.bestIndividualAccessor?.fitness).toBe(0.42);
    });

    it('selects the highest-scoring individual, not merely a defined one', async () => {
      const population = makePopulation({ populationSize: 3, maxGenerations: 1 });
      population.initialize('CODING', NODES);

      let call = 0;
      const scores = [0.1, 0.9, 0.5];
      const result = await population.evolve(async () => scores[call++]);

      expect(result.fitness).toBe(0.9);
      expect(call).toBe(3);
    });

    it('records each generation in the fitness history', async () => {
      const population = makePopulation({ maxGenerations: 3, stagnationGenerations: 10 });
      population.initialize('CODING', NODES);

      await population.evolve(async () => 0.2);
      expect(fitnessHistory(population)).toEqual([0.2]);

      await population.evolve(async () => 0.2);
      expect(fitnessHistory(population)).toEqual([0.2, 0.2]);
    });

    it('restarts the population once the configured stagnation window is flat', async () => {
      // stagnationGenerations = 2 means the check needs three recorded
      // generations before it can compare the window; with a flat evaluator the
      // third evolve() must trip the restart (fitnessHistory reset to []).
      const population = makePopulation({ stagnationGenerations: 2 });
      population.initialize('CODING', NODES);

      await population.evolve(async () => 0.1);
      await population.evolve(async () => 0.1);
      expect(fitnessHistory(population)).toHaveLength(2);

      await population.evolve(async () => 0.1);
      expect(fitnessHistory(population)).toHaveLength(0);
      expect(population.generationAccessor).toBe(0);
    });
  });
});
