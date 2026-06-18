"use strict";
/**
 * Ultimate Multi-Agent Orchestration Types
 *
 * Comprehensive types for the world's most advanced multi-agent system,
 * incorporating research from Anthropic, OpenAI, CAMEL, ROMA, AdaptOrch,
 * DOVA, FoA, RecursiveMAS, and other state-of-the-art systems.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ULTIMATE_CONFIG = exports.DEFAULT_SYNTHESIS_CONFIG = exports.DEFAULT_THINKING_BUDGET = void 0;
exports.DEFAULT_THINKING_BUDGET = {
    enabled: true,
    maxThinkingTokens: 4096,
    subAgentThinkingTokens: 1024,
    minThinkingBeforeTools: 256,
};
exports.DEFAULT_SYNTHESIS_CONFIG = {
    strategy: 'LEAD_SYNTHESIS',
    maxRounds: 2,
    consensusThreshold: 0.7,
    includeDissent: true,
    qualityGates: [
        {
            name: 'hallucination',
            type: 'HALLUCINATION_CHECK',
            enabled: true,
            threshold: 0.8,
            autoFix: false,
        },
        { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: false },
        { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
    ],
};
exports.DEFAULT_ULTIMATE_CONFIG = {
    defaultBudget: { hardCapTokens: 128000, softCapTokens: 96000, costCapUsd: 5.0 },
    defaultThinkingBudget: exports.DEFAULT_THINKING_BUDGET,
    defaultSynthesisConfig: exports.DEFAULT_SYNTHESIS_CONFIG,
    defaultEffortLevel: 'MODERATE',
    maxRecursiveDepth: 3,
    maxParallelSubAgents: 10,
    enableDeliberation: true,
    enableArtifactSystem: true,
    enableTeams: true,
    enableCapabilityRouting: true,
    enableCircuitBreaker: true,
    qualityGates: [
        {
            name: 'hallucination',
            type: 'HALLUCINATION_CHECK',
            enabled: true,
            threshold: 0.8,
            autoFix: true,
        },
        { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: true },
        { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
        { name: 'accuracy', type: 'ACCURACY', enabled: true, threshold: 0.7, autoFix: false },
        { name: 'safety', type: 'SAFETY', enabled: true, threshold: 0.9, autoFix: false },
    ],
    modelTierMapping: {
        SIMPLE: 'eco',
        MODERATE: 'standard',
        COMPLEX: 'power',
        DEEP_RESEARCH: 'consensus',
    },
};
