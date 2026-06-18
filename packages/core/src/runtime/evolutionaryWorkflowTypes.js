"use strict";
/**
 * Types for the Evolutionary Workflow Engine.
 * Extracted from evolutionaryWorkflowEngine.ts to keep modules under 500 lines.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EVOLUTION_CONFIG = void 0;
exports.DEFAULT_EVOLUTION_CONFIG = {
    populationSize: 10,
    maxGenerations: 50,
    mutationRate: 0.15,
    crossoverRate: 0.7,
    elitismRate: 0.2,
    minFitnessThreshold: 0.7,
    stagnationGenerations: 10,
    evaluationMethod: 'hybrid',
};
