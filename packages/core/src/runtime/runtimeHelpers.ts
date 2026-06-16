import type { AgentRuntimeConfig, ToolCall } from './types';
import { purifyObservation } from './observationPurifier';
import { createContentScanner } from '../contentScanner';

export const DEFAULT_CONFIG: AgentRuntimeConfig = {
  defaultModelTier: 'standard',
  maxStepsPerRun: 20,
  maxRetries: 2,
  retryDelayMs: 1000,
  timeoutMs: 180000,
  maxConcurrency: 5,
  observationMaskWindow: 10,
  enableDescendingScheduler: true,
  budgetHardCapTokens: 200000,
  toolRetrieval: { enabled: false, minTools: 3, maxTools: 10, alwaysInclude: [] },
  entropyGating: { enabled: false },
  speculativeExecution: { enabled: false, maxPredictions: 2, minConfidence: 0.3 },
  semanticCache: { enabled: true, similarityThreshold: 0.92, maxEntries: 10_000, defaultTtlMs: 86_400_000, maxBucketSize: 64, cacheStochastic: false, cacheToolCalls: false, pruneIntervalMs: 60_000 },
  singleFlight: { enabled: true, maxInFlight: 1000 },
};

export function generateId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref(); });
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
    const lower = tc.name.toLowerCase();
    const isBroad = broadKeywords.some(k => lower.includes(k));
    (isBroad ? broad : narrow).push(tc);
  }
  return [...broad, ...narrow];
}

export async function applyObservationMask(
  toolResults: Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }>,
  windowSize: number,
): Promise<Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }>> {
  if (windowSize <= 0 || toolResults.length <= windowSize) return toolResults;

  const scanner = createContentScanner();

  const processed = await Promise.all(toolResults.map(async (r, i) => {
    if (i < toolResults.length - windowSize && !r.error && r.output.length > 100) {
      const purified = purifyObservation(r.output, r.name);

      // Security scan: replace HIGH/CRITICAL threats with a redaction marker instead
      // of letting them enter the LLM context.
      try {
        const scan = await scanner.scan(purified);
        const severe = scan.threats.filter(t => t.severity === 'HIGH' || t.severity === 'CRITICAL');
        if (severe.length > 0) {
          const threatTypes = [...new Set(severe.map(t => t.type))].join(', ');
          return {
            ...r,
            output: `[security filter: ${r.name} result blocked due to ${threatTypes}]`,
          };
        }
      } catch {
        // Scan failure should not break execution; fall through to normal masking.
      }

      const charsBefore = r.output.length;
      const charsAfter = purified.length;
      const saved = charsBefore - charsAfter;
      return {
        ...r,
        output: `[observation purified: ${r.name} result, ${charsBefore} → ${charsAfter} chars (${saved} saved)]\n${purified.slice(0, 300)}`,
      };
    }
    return r;
  }));

  return processed;
}

export function isMutationTool(name: string): boolean {
  const mutationKeywords = ['write', 'edit', 'delete', 'mkdir', 'mv', 'cp', 'bash', 'shell', 'git'];
  const lower = name.toLowerCase();
  return mutationKeywords.some(k => lower.includes(k));
}
