import { reportSilentFailure } from '../silentFailureReporter';
import type { AgentRuntimeConfig, ToolCall } from './types';
import { purifyObservation } from './observationPurifier';
import { createContentScanner } from '../contentScanner';
import type { PolicyToolContext } from '../atr/policy/types';

export const DEFAULT_CONFIG: AgentRuntimeConfig = {
  defaultModelTier: 'standard',
  maxStepsPerRun: 20,
  maxRetries: 2,
  retryDelayMs: 1000,
  timeoutMs: 180000,
  llmTimeoutMs: 120000,
  maxConcurrency: 5,
  observationMaskWindow: 10,
  enableDescendingScheduler: true,
  budgetHardCapTokens: 200000,
  toolRetrieval: { enabled: false, minTools: 3, maxTools: 10, alwaysInclude: [] },
  entropyGating: { enabled: false },
  speculativeExecution: { enabled: false, maxPredictions: 2, minConfidence: 0.3 },
  semanticCache: {
    enabled: true,
    similarityThreshold: 0.92,
    maxEntries: 10_000,
    defaultTtlMs: 86_400_000,
    maxBucketSize: 64,
    cacheStochastic: false,
    cacheToolCalls: false,
    pruneIntervalMs: 60_000,
  },
  singleFlight: { enabled: true, maxInFlight: 1000 },
};

export function generateId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
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
    const lower = (tc.name ?? '').toLowerCase();
    const isBroad = broadKeywords.some((k) => lower.includes(k));
    (isBroad ? broad : narrow).push(tc);
  }
  return [...broad, ...narrow];
}

export async function applyObservationMask(
  toolResults: Array<{
    toolCallId: string;
    name: string;
    output: string;
    error?: string;
    durationMs: number;
  }>,
  windowSize: number,
): Promise<
  Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }>
> {
  if (windowSize <= 0 || toolResults.length <= windowSize) return toolResults;

  const scanner = createContentScanner();

  const processed = await Promise.all(
    toolResults.map(async (r, i) => {
      if (i < toolResults.length - windowSize && !r.error && r.output.length > 100) {
        const purified = purifyObservation(r.output, r.name);

        // Security scan: replace HIGH/CRITICAL threats with a redaction marker instead
        // of letting them enter the LLM context.
        try {
          const scan = await scanner.scan(purified);
          const severe = scan.threats.filter(
            (t) => t.severity === 'HIGH' || t.severity === 'CRITICAL',
          );
          if (severe.length > 0) {
            const threatTypes = [...new Set(severe.map((t) => t.type))].join(', ');
            return {
              ...r,
              output: `[security filter: ${r.name} result blocked due to ${threatTypes}]`,
            };
          }
        } catch (err) {
          reportSilentFailure(err, 'runtimeHelpers:99');
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
    }),
  );

  return processed;
}

export interface ToolEffectClassification extends Pick<
  PolicyToolContext,
  'riskLevel' | 'destructive' | 'isReadOnly' | 'category'
> {
  compensable: boolean;
  /** Concrete legacy semantic used by reversibility and audit controls. */
  semanticToolName: string;
  /** Legacy registry key used to undo a consolidated action. */
  compensationToolName?: string;
}

type ToolCategory = ToolEffectClassification['category'];

function readOnlyEffect(
  category: ToolCategory,
  semanticToolName: string,
): ToolEffectClassification {
  return {
    riskLevel: 'medium',
    destructive: false,
    isReadOnly: true,
    category,
    compensable: false,
    semanticToolName,
  };
}

function mutationEffect(
  category: ToolCategory,
  semanticToolName: string,
  compensationToolName?: string,
): ToolEffectClassification {
  return {
    riskLevel: 'high',
    destructive: true,
    isReadOnly: false,
    category,
    compensable: compensationToolName !== undefined,
    semanticToolName,
    compensationToolName,
  };
}

const CONSOLIDATED_EFFECTS: Record<string, Record<string, ToolEffectClassification>> = {
  file: {
    write: mutationEffect('file_write', 'file_write', 'file_write'),
    edit: mutationEffect('file_write', 'file_edit', 'file_edit'),
    read: readOnlyEffect('file_read', 'file_read'),
    search: readOnlyEffect('file_read', 'file_search'),
    list: readOnlyEffect('file_read', 'file_list'),
    glob: readOnlyEffect('file_read', 'glob'),
  },
  memory: {
    store: mutationEffect('destructive', 'memory_store', 'memory_store'),
    recall: readOnlyEffect('api', 'memory_recall'),
    list: readOnlyEffect('api', 'memory_list'),
  },
  web: {
    search: readOnlyEffect('network', 'web_search'),
    fetch: readOnlyEffect('network', 'web_fetch'),
  },
  browser: {
    search: readOnlyEffect('network', 'browser_search'),
    fetch: readOnlyEffect('network', 'browser_fetch'),
  },
  code: {
    refine: mutationEffect('file_write', 'refine_code', 'code_refiner'),
    fix: mutationEffect('file_write', 'fix_code', 'code_fixer'),
    search: readOnlyEffect('compute', 'code_search'),
  },
  checkpoint: {
    save: mutationEffect('destructive', 'checkpoint_save'),
    rewind: mutationEffect('destructive', 'checkpoint_rewind'),
    collapse: mutationEffect('destructive', 'checkpoint_collapse'),
    list: readOnlyEffect('api', 'checkpoint_list'),
  },
  handoff: {
    send: mutationEffect('api', 'handoff'),
    check: readOnlyEffect('api', 'handoff_check'),
  },
  exec: {
    shell: mutationEffect('shell', 'shell_execute'),
    python: mutationEffect('shell', 'python_execute'),
    script: mutationEffect('shell', 'execute_script'),
  },
  media: {
    screenshot: mutationEffect('file_write', 'screenshot_capture'),
    analyze_image: readOnlyEffect('compute', 'vision_analyze'),
    extract_pdf: readOnlyEffect('compute', 'pdf_extract'),
  },
  system: {
    human_input: mutationEffect('api', 'request_human_input'),
    tool_schema: readOnlyEffect('api', 'request_tool'),
  },
};

const LEGACY_READ_EFFECTS: Record<string, ToolEffectClassification> = {
  file_read: readOnlyEffect('file_read', 'file_read'),
  file_search: readOnlyEffect('file_read', 'file_search'),
  file_list: readOnlyEffect('file_read', 'file_list'),
  glob: readOnlyEffect('file_read', 'glob'),
  memory_recall: readOnlyEffect('api', 'memory_recall'),
  memory_list: readOnlyEffect('api', 'memory_list'),
  web_search: readOnlyEffect('network', 'web_search'),
  web_fetch: readOnlyEffect('network', 'web_fetch'),
  browser_search: readOnlyEffect('network', 'browser_search'),
  browser_fetch: readOnlyEffect('network', 'browser_fetch'),
  code_search: readOnlyEffect('compute', 'code_search'),
  checkpoint_list: readOnlyEffect('api', 'checkpoint_list'),
  handoff_check: readOnlyEffect('api', 'handoff_check'),
  vision_analyze: readOnlyEffect('compute', 'vision_analyze'),
  pdf_extract: readOnlyEffect('compute', 'pdf_extract'),
  request_tool: readOnlyEffect('api', 'request_tool'),
};

const LEGACY_COMPENSATION_TOOLS: Record<string, ToolCategory> = {
  file_write: 'file_write',
  file_edit: 'file_write',
  file_delete: 'file_write',
  apply_patch: 'file_write',
  mkdir: 'file_write',
  code_fixer: 'file_write',
  code_refiner: 'file_write',
  memory_store: 'destructive',
};

export function classifyToolEffect(
  name: string,
  args: Record<string, unknown> = {},
): ToolEffectClassification {
  const lower = name.toLowerCase();
  const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';

  const consolidated = CONSOLIDATED_EFFECTS[lower];
  if (consolidated) {
    return { ...(consolidated[action] ?? mutationEffect('unknown', lower)) };
  }

  const legacyRead = LEGACY_READ_EFFECTS[lower];
  if (legacyRead) return { ...legacyRead };

  const legacyCompensationCategory = LEGACY_COMPENSATION_TOOLS[lower];
  if (legacyCompensationCategory) {
    return mutationEffect(legacyCompensationCategory, lower, lower);
  }

  const mutationKeywords = ['write', 'edit', 'delete', 'mkdir', 'mv', 'cp', 'bash', 'shell', 'git'];
  if (mutationKeywords.some((keyword) => lower.includes(keyword))) {
    return mutationEffect(
      lower.includes('shell') || lower === 'bash' ? 'shell' : 'destructive',
      lower,
    );
  }

  return mutationEffect('unknown', lower);
}

export function isMutationTool(name: string, args: Record<string, unknown> = {}): boolean {
  return classifyToolEffect(name, args).destructive;
}
