/**
 * Deliberation Engine - DOVA-inspired meta-reasoning before tool invocation.
 *
 * DOVA research shows deliberation-first orchestration reduces unnecessary
 * API calls by 40-60% on simple tasks while preserving deep reasoning capacity.
 * The engine determines whether external info is needed, classifies the task,
 * and allocates thinking budget before any agent is spawned.
 *
 * Two modes:
 *   deliberate()          — fast, keyword-based (no LLM call)
 *   deliberateWithLLM()   — LLM-powered meta-reasoning (richer, more accurate)
 */
import type { DeliberationPlan } from './types';
import type { LLMProvider } from '../runtime/types';
export declare function deliberate(goal: string, context?: Record<string, unknown>): DeliberationPlan;
/**
 * Astraea-inspired: classify task as I/O-bound or compute-bound.
 * I/O-bound tasks spend most time waiting for external data (web search, API calls).
 * Compute-bound tasks spend most time in LLM reasoning.
 * This classification informs scheduling: I/O-bound tasks benefit more from parallelism.
 */
export declare function classifyTaskNature(taskType: DeliberationPlan['taskType'], requiresExternalInfo: boolean): 'IO_BOUND' | 'COMPUTE_BOUND' | 'MIXED';
/**
 * LLM-powered deliberation — rich meta-reasoning using a cheap LLM call.
 * Falls back to keyword-based deliberate() if no provider is available or the call fails.
 */
export declare function deliberateWithLLM(goal: string, provider?: LLMProvider, context?: Record<string, unknown>): Promise<DeliberationPlan>;
//# sourceMappingURL=deliberation.d.ts.map