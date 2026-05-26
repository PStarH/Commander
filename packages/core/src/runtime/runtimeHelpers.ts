import type { AgentRuntimeConfig, ToolCall } from './types';

export const DEFAULT_CONFIG: AgentRuntimeConfig = {
  defaultModelTier: 'standard',
  maxStepsPerRun: 20,
  maxRetries: 2,
  retryDelayMs: 1000,
  timeoutMs: 120000,
  maxConcurrency: 5,
  observationMaskWindow: 10,
  enableDescendingScheduler: true,
  budgetHardCapTokens: 64000,
  toolRetrieval: { enabled: false, minTools: 3, maxTools: 10, alwaysInclude: [] },
  entropyGating: { enabled: false },
  speculativeExecution: { enabled: false, maxPredictions: 2, minConfidence: 0.3 },
};

export function generateId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Descending scheduler: reorder tools so broad/capacity tools run first.
 * Research finding (W&D, arXiv Feb 2026): +7.3% on BrowseComp.
 */
export function descendingToolOrder(toolCalls: ToolCall[]): ToolCall[] {
  const broadKeywords = ['search', 'list', 'find', 'glob', 'grep', 'read', 'fetch', 'browse'];
  const broad: ToolCall[] = [];
  const narrow: ToolCall[] = [];
  for (const tc of toolCalls) {
    const isBroad = broadKeywords.some(k => tc.name.toLowerCase().includes(k));
    (isBroad ? broad : narrow).push(tc);
  }
  return [...broad, ...narrow];
}

export function applyObservationMask(
  toolResults: Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }>,
  windowSize: number,
): Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }> {
  if (windowSize <= 0 || toolResults.length <= windowSize) return toolResults;
  return toolResults.map((r, i) => {
    if (i < toolResults.length - windowSize && !r.error && r.output.length > 100) {
      return { ...r, output: `[observation masked: ${r.name} result (${r.output.length} chars)]` };
    }
    return r;
  });
}

export function isMutationTool(name: string): boolean {
  const mutationKeywords = ['write', 'edit', 'delete', 'mkdir', 'mv', 'cp', 'bash', 'shell', 'git'];
  return mutationKeywords.some(k => name.toLowerCase().includes(k));
}
