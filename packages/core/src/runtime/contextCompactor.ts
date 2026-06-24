/**
 * Context Compactor — 4-layer progressive compaction with semantic awareness.
 *
 * Upgraded from Claude Code's approach with:
 * 1. CJK-aware token estimation (TokenGovernor.estimateTokens)
 * 2. Governor-integrated thresholds (tighter under budget pressure)
 * 3. Double-compaction prevention (mark summarized messages)
 * 4. Token-aware retention in layer4 (keep by token budget, not message count)
 * 5. Semantic importance scoring for message preservation
 * 6. Adaptive compaction: task-type-aware profiles + message composition analysis
 *
 * Adaptive compaction adjusts trigger thresholds, retention, and summary verbosity
 * per task type (code, search, analysis, structured, general) plus automatic
 * adjustment based on message composition (tool density, error density, code blocks).
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type { LLMMessage, LLMProvider } from './types';
import { TokenGovernor, getTokenGovernor } from './tokenGovernor';
import { getGlobalLogger } from '../logging';
import { CPUWorkerPool } from './cpuWorkerPool';
import type { RebuildParams } from './rebuildPrompt';
import { getRebuildPrompt } from './rebuildPrompt';

// ============================================================================
// Failure correlation tracker
//
// Records which messages correlated with verification failures. When compacting
// before a retry, those messages are deprioritized so the model is less likely
// to replay the same failed reasoning.
// ============================================================================

export interface FailureCorrelationRecord {
  runId: string;
  timestamp: number;
  failureSignal?: string;
  messageFingerprints: Set<string>;
}

export class FailureCorrelationTracker {
  private records = new Map<string, FailureCorrelationRecord>();
  private globalFingerprints = new Set<string>();
  private readonly maxRecords = 1000;

  private fingerprint(content: string): string {
    // Normalize whitespace and truncate for stable matching
    const normalized = content.replace(/\s+/g, ' ').trim().slice(0, 400);
    return `${normalized.length}:${normalized}`;
  }

  record(runId: string, messages: LLMMessage[], failureSignal?: string): void {
    const fingerprints = new Set<string>();
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length > 10) {
        fingerprints.add(this.fingerprint(content));
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const args = tc.function.arguments ?? '';
          if (args.length > 10) fingerprints.add(this.fingerprint(args));
        }
      }
    }

    this.records.set(runId, {
      runId,
      timestamp: Date.now(),
      failureSignal,
      messageFingerprints: fingerprints,
    });

    for (const fp of fingerprints) {
      this.globalFingerprints.add(fp);
    }

    // Prevent unbounded growth
    if (this.records.size > this.maxRecords) {
      let oldest: FailureCorrelationRecord | undefined;
      for (const r of this.records.values()) {
        if (!oldest || r.timestamp < oldest.timestamp) oldest = r;
      }
      if (oldest) this.records.delete(oldest.runId);
    }
  }

  isCorrelated(msg: LLMMessage): boolean {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length > 10 && this.globalFingerprints.has(this.fingerprint(content))) {
      return true;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const args = tc.function.arguments ?? '';
        if (args.length > 10 && this.globalFingerprints.has(this.fingerprint(args))) {
          return true;
        }
      }
    }
    return false;
  }

  getRunRecord(runId: string): FailureCorrelationRecord | undefined {
    return this.records.get(runId);
  }

  reset(): void {
    this.records.clear();
    this.globalFingerprints.clear();
  }
}

// ============================================================================
// Types
// ============================================================================

export type CompactLayer = 1 | 2 | 3 | 4 | 5;

export type CompactTaskType = 'code' | 'search' | 'analysis' | 'structured' | 'general';

export type CollapseVerbosity = 'detail' | 'balanced' | 'aggressive';

export interface CompactConfig {
  maxContextTokens: number;
  layer1Trigger: number; // % full to trigger layer 1 (default: 0.60)
  layer2Trigger: number; // % full to trigger layer 2 (default: 0.70)
  layer3Trigger: number; // % full to trigger layer 3 (default: 0.82)
  layer4Trigger: number; // % full to trigger layer 4 (default: 0.92)
  keepRecentTurns: number; // turns to preserve in layers 1-3
  maxToolOutputChars: number; // max chars per tool output after microcompact
  /** Enable governor-aware threshold adjustment (default: true) */
  governorAware: boolean;
}

const DEFAULT_CONFIG: CompactConfig = {
  maxContextTokens: 128000,
  layer1Trigger: 0.6,
  layer2Trigger: 0.7,
  layer3Trigger: 0.82,
  layer4Trigger: 0.92,
  keepRecentTurns: 3,
  maxToolOutputChars: 500,
  governorAware: true,
};

export interface CompactAction {
  layer: CompactLayer;
  droppedCount: number;
  tokensSaved: number;
  summary?: string;
  description: string;
  taskTypeApplied?: CompactTaskType | null;
  compositionApplied?: { toolDensity: number; errorDensity: number };
  /** For Layer 5: the rebuild result details */
  rebuildResult?: {
    sections: Array<{ name: string; cap: number; used: number }>;
    rebuildCount: number;
    totalTokens: number;
  };
}

// ============================================================================
// Adaptive profile — per task type
// ============================================================================

export interface AdaptiveProfile {
  layerTriggers: {
    layer1: number;
    layer2: number;
    layer3: number;
    layer4: number;
  };
  keepRecentTurns: number;
  maxToolOutputChars: number;
  importanceConfig: {
    errorBonus: number;
    decisionBonus: number;
    userInstructionBonus: number;
    recencyBonus: number;
    compactedPenalty: number;
  };
  collapseVerbosity: CollapseVerbosity;
}

const DEFAULT_PROFILE: AdaptiveProfile = {
  layerTriggers: { layer1: 0.6, layer2: 0.7, layer3: 0.82, layer4: 0.92 },
  keepRecentTurns: 3,
  maxToolOutputChars: 500,
  importanceConfig: {
    errorBonus: 0.4,
    decisionBonus: 0.3,
    userInstructionBonus: 0.3,
    recencyBonus: 0.2,
    compactedPenalty: -0.2,
  },
  collapseVerbosity: 'balanced',
};

const ADAPTIVE_PROFILES: Record<CompactTaskType, AdaptiveProfile> = {
  code: {
    // Compact later — code tasks need broader context for coherence
    layerTriggers: { layer1: 0.63, layer2: 0.73, layer3: 0.85, layer4: 0.94 },
    keepRecentTurns: 4,
    maxToolOutputChars: 800,
    importanceConfig: {
      errorBonus: 0.5,
      decisionBonus: 0.3,
      userInstructionBonus: 0.4,
      recencyBonus: 0.15,
      compactedPenalty: -0.2,
    },
    collapseVerbosity: 'detail',
  },
  search: {
    // Compact earlier — search facts are independent, less context dependency
    layerTriggers: { layer1: 0.55, layer2: 0.65, layer3: 0.78, layer4: 0.88 },
    keepRecentTurns: 2,
    maxToolOutputChars: 300,
    importanceConfig: {
      errorBonus: 0.3,
      decisionBonus: 0.2,
      userInstructionBonus: 0.2,
      recencyBonus: 0.3,
      compactedPenalty: -0.2,
    },
    collapseVerbosity: 'aggressive',
  },
  analysis: {
    // Default thresholds — analysis needs balanced context
    layerTriggers: { layer1: 0.6, layer2: 0.7, layer3: 0.82, layer4: 0.92 },
    keepRecentTurns: 3,
    maxToolOutputChars: 500,
    importanceConfig: {
      errorBonus: 0.4,
      decisionBonus: 0.4,
      userInstructionBonus: 0.3,
      recencyBonus: 0.2,
      compactedPenalty: -0.2,
    },
    collapseVerbosity: 'balanced',
  },
  structured: {
    // Compact earlier — structured outputs are self-contained
    layerTriggers: { layer1: 0.55, layer2: 0.65, layer3: 0.78, layer4: 0.88 },
    keepRecentTurns: 2,
    maxToolOutputChars: 400,
    importanceConfig: {
      errorBonus: 0.3,
      decisionBonus: 0.2,
      userInstructionBonus: 0.3,
      recencyBonus: 0.3,
      compactedPenalty: -0.2,
    },
    collapseVerbosity: 'aggressive',
  },
  general: {
    // Default profile
    layerTriggers: { layer1: 0.6, layer2: 0.7, layer3: 0.82, layer4: 0.92 },
    keepRecentTurns: 3,
    maxToolOutputChars: 500,
    importanceConfig: {
      errorBonus: 0.4,
      decisionBonus: 0.3,
      userInstructionBonus: 0.3,
      recencyBonus: 0.2,
      compactedPenalty: -0.2,
    },
    collapseVerbosity: 'balanced',
  },
};

// ============================================================================
// Precompiled regex — avoid re-creating RegExp objects in hot loops
// ============================================================================

const RE_QUESTION_INSTRUCTION = /\?|please|do|write|create|fix|implement|analyze/i;
const RE_DECISION_PATTERN = /I will|I'll|going to|plan to|the answer|in conclusion|therefore/i;
const RE_ERROR_CONTENT = /error|fail|exception|cannot|unable/i;
const RE_ERROR_MULTILINE =
  /(?:^|\n)\s*(?:error|Error|ERROR|fail|Fail|FAIL|exception|Exception|traceback|Traceback|cannot|Cannot|unable|Unable)/m;
const RE_HAS_DIGIT = /\d/;
const RE_FINDING_KEYWORDS = /result|found|output|answer|total|sum|count/i;
const RE_ERROR_LINE = /^(error|warning|fail|exception|traceback|cannot|unable)/i;
const RE_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /disregard\s+(all\s+)?(previous\s+)?instructions?/gi,
  /system\s*:\s*you\s+are\s+now/gi,
  /you\s+are\s+now\s+a\s+helpful/gi,
  /forget\s+(all\s+)?(previous\s+)?(rules|instructions)/gi,
  /new\s+instruction\s*:/gi,
  /override\s+(default\s+)?(rules|behavior)/gi,
  /jailbreak/gi,
  /DAN\s*:/gi,
  /developer\s+mode/gi,
  /sudo\s+mode/gi,
  /<script\b[^>]*>/gi,
  /<!--[\s\S]*?-->/g,
];

function containsInjectionPattern(content: string): boolean {
  return RE_INJECTION_PATTERNS.some((p) => p.test(content));
}

function redactUnsafeToolContent(content: string): string | null {
  if (containsInjectionPattern(content)) {
    return '[security redacted: unsafe tool content removed by compactor]';
  }
  return null;
}
const RE_KV_PAIR = /^["']?\w+["']?\s*[:=]/;
const RE_NEWLINE = /\n/g;

const DECISION_PATTERNS: RegExp[] = [
  /(?:^|\n)(?:I will|Let me|Going to|Plan to|Need to|I'll|I'm going to) .{10,100}/i,
  /(?:The answer is|The result is|In conclusion|Therefore|Thus|So)[,:]? .{10,100}/i,
  /(?:Found|Discovered|Confirmed|Determined|Calculated) that .{10,100}/i,
  /(?:This means|This suggests|This indicates) .{10,100}/i,
  /(?:The (?:total|sum|count|average|final)) .{10,80}/i,
  /(?:^|\n)\d+[\.\)]\s+.{10,80}/m,
];

// ============================================================================
// Compaction marker — prevents double-compaction
// ============================================================================

const COMPACTED_MARKER = '__COMPACTED__';

export function isCompacted(msg: LLMMessage): boolean {
  return typeof msg.content === 'string' && msg.content.startsWith(COMPACTED_MARKER);
}

function markCompacted(content: string): string {
  return `${COMPACTED_MARKER}${content}`;
}

// ============================================================================
// Token estimation — CJK-aware via TokenGovernor
// ============================================================================

function estimateTokens(text: string): number {
  return TokenGovernor.estimateTokens(text);
}

/**
 * Estimate the cost savings of removing a specific message.
 * Higher value = more expensive to keep = better compaction target.
 */
function estimateMessageCostImpact(msg: LLMMessage): number {
  const OUTPUT_WEIGHT = 4.0;
  const tokens = estimateTokens(msg.content) + 10;
  const weight = msg.role === 'assistant' ? OUTPUT_WEIGHT : 1.0;
  let total = tokens * weight;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total +=
        (estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments)) * OUTPUT_WEIGHT;
    }
  }
  if (msg.reasoning_content) {
    total += estimateTokens(msg.reasoning_content) * OUTPUT_WEIGHT;
  }
  return total;
}

function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 10; // 10 tokens overhead per message
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
      }
    }
    if (msg.reasoning_content) {
      total += estimateTokens(msg.reasoning_content);
    }
  }
  return total;
}

// ============================================================================
// Importance scoring — rank messages by semantic value
// ============================================================================

interface ScoredMessage {
  msg: LLMMessage;
  index: number;
  importance: number; // 0-1
}

export interface CompositionScore {
  toolDensity: number;
  errorDensity: number;
  messageCount: number;
  codeBlockRatio: number;
}

export function scoreMessageImportance(
  msg: LLMMessage,
  index: number,
  total: number,
  importanceConfig: AdaptiveProfile['importanceConfig'] = DEFAULT_PROFILE.importanceConfig,
  failureTracker?: FailureCorrelationTracker,
): number {
  let score = 0.5; // baseline

  // System messages are always important
  if (msg.role === 'system') return 1.0;

  // User messages with goals/questions are important
  if (msg.role === 'user') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length > 20) score += importanceConfig.userInstructionBonus;
    // Questions and instructions
    if (RE_QUESTION_INSTRUCTION.test(content)) score += 0.1;
  }

  // Assistant messages with decisions are important
  if (msg.role === 'assistant') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    // Decision patterns
    if (RE_DECISION_PATTERN.test(content)) {
      score += importanceConfig.decisionBonus;
    }
    // Tool calls are somewhat important (they show what was done)
    if (msg.tool_calls && msg.tool_calls.length > 0) score += 0.1;
    // Cost-weighted: long assistant responses are expensive to regenerate
    // If we compact them, the model may need to re-generate similar content
    const contentLength = content.length;
    if (contentLength > 500) score += 0.15; // Long responses are costly to lose
    if (contentLength > 1000) score += 0.1; // Extra bonus for very long responses
  }

  // Tool results with errors are very important
  if (msg.role === 'tool') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (RE_ERROR_CONTENT.test(content)) {
      score += importanceConfig.errorBonus;
    }
    // Cost-weighted: long tool outputs are expensive to re-execute
    if (content.length > 1000) score += 0.1;
  }

  // Recency bonus: more recent messages are more important
  const recencyFactor = index / Math.max(total - 1, 1);
  score += recencyFactor * importanceConfig.recencyBonus;

  // Already-compacted messages get lower priority (don't double-compact)
  if (isCompacted(msg)) score += importanceConfig.compactedPenalty;

  // Failure correlation: messages that preceded a verification failure are
  // less valuable to keep because they led to a dead end.
  if (failureTracker?.isCorrelated(msg)) {
    score = Math.max(0, score - 0.35);
  }

  return Math.max(0, Math.min(1, score));
}

function analyzeComposition(messages: LLMMessage[]): CompositionScore {
  let toolMessages = 0;
  let assistantWithTools = 0;
  let errorMessages = 0;
  let codeBlockMessages = 0;
  const total = messages.length;

  for (const msg of messages) {
    if (msg.role === 'tool') toolMessages++;
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0)
      assistantWithTools++;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (RE_ERROR_MULTILINE.test(content)) {
      errorMessages++;
    }
    if (content.includes('```')) codeBlockMessages++;
  }

  return {
    toolDensity: total > 0 ? (toolMessages + assistantWithTools) / total : 0,
    errorDensity: total > 0 ? errorMessages / total : 0,
    messageCount: total,
    codeBlockRatio: total > 0 ? codeBlockMessages / total : 0,
  };
}

function adjustProfileByComposition(
  profile: AdaptiveProfile,
  composition: CompositionScore,
): AdaptiveProfile {
  const adjusted: AdaptiveProfile = {
    layerTriggers: { ...profile.layerTriggers },
    keepRecentTurns: profile.keepRecentTurns,
    maxToolOutputChars: profile.maxToolOutputChars,
    importanceConfig: { ...profile.importanceConfig },
    collapseVerbosity: profile.collapseVerbosity,
  };

  if (composition.toolDensity > 0.5) {
    adjusted.keepRecentTurns = Math.max(adjusted.keepRecentTurns, 4);
  }
  if (composition.errorDensity > 0.2) {
    adjusted.importanceConfig.errorBonus = Math.min(
      0.8,
      adjusted.importanceConfig.errorBonus + 0.2,
    );
    adjusted.keepRecentTurns = Math.max(adjusted.keepRecentTurns, 3);
  }
  if (composition.codeBlockRatio > 0.3) {
    adjusted.maxToolOutputChars = Math.max(adjusted.maxToolOutputChars, 800);
    adjusted.keepRecentTurns = Math.max(adjusted.keepRecentTurns, 3);
  }
  if (composition.messageCount > 30) {
    // Very long conversations: compact slightly more aggressively
    adjusted.layerTriggers.layer1 = Math.max(0.4, adjusted.layerTriggers.layer1 - 0.05);
    adjusted.layerTriggers.layer2 = Math.max(0.5, adjusted.layerTriggers.layer2 - 0.05);
    adjusted.layerTriggers.layer3 = Math.max(0.65, adjusted.layerTriggers.layer3 - 0.05);
    adjusted.layerTriggers.layer4 = Math.max(0.75, adjusted.layerTriggers.layer4 - 0.05);
  }

  return adjusted;
}

function getProfile(taskType?: CompactTaskType): AdaptiveProfile {
  if (taskType && ADAPTIVE_PROFILES[taskType]) {
    return ADAPTIVE_PROFILES[taskType];
  }
  return DEFAULT_PROFILE;
}

// ============================================================================
// Context Compactor
// ============================================================================

export class ContextCompactor {
  private config: CompactConfig;
  private failureTracker: FailureCorrelationTracker;
  /** Counts how many times compaction has been applied to current messages */
  private compactionCount = 0;
  /** Tracks whether the last compaction was layer 4 (emergency) */
  private lastWasEmergency = false;

  constructor(config?: Partial<CompactConfig>, failureTracker?: FailureCorrelationTracker) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.failureTracker = failureTracker ?? new FailureCorrelationTracker();
  }

  /**
   * Record that the current messages correlated with a verification failure.
   * Future compactions will deprioritize these messages.
   */
  recordFailureCorrelation(runId: string, messages: LLMMessage[], failureSignal?: string): void {
    this.failureTracker.record(runId, messages, failureSignal);
  }

  /** Access the failure tracker (for testing/inspection). */
  getFailureTracker(): FailureCorrelationTracker {
    return this.failureTracker;
  }

  getUsage(messages: LLMMessage[]): { total: number; pct: number } {
    const total = estimateMessagesTokens(messages);
    return { total, pct: total / this.config.maxContextTokens };
  }

  needsCompaction(messages: LLMMessage[], taskType?: CompactTaskType): CompactLayer | null {
    const { pct } = this.getUsage(messages);

    const adjusted = this.adjustThresholds(taskType, messages);

    // Layer 5 trigger: if we've already compacted at layer 4 and still >95% full
    // OR if this run has exceeded the rebuild threshold (>97%)
    const layer5Threshold = Math.min(0.97, adjusted.layer4 + 0.03);
    if (pct >= layer5Threshold && this.lastWasEmergency) return 5;

    if (pct >= adjusted.layer4) return 4;
    if (pct >= adjusted.layer3) return 3;
    if (pct >= adjusted.layer2) return 2;
    if (pct >= adjusted.layer1) return 1;
    return null;
  }

  /**
   * Check if rebuild (Layer 5) should be triggered for a given run.
   * Public for use by agentRuntime to decide whether to invoke rebuild.
   */
  needsRebuild(_runId: string): boolean {
    return this.lastWasEmergency && this.compactionCount >= 2;
  }

  compact(
    messages: LLMMessage[],
    provider?: LLMProvider,
    taskType?: CompactTaskType,
  ): { messages: LLMMessage[]; action: CompactAction } {
    // Provider-aware context limit adjustment (research: Anthropic 200k, OpenAI 128k, smaller 32k)
    if (provider && this.config.maxContextTokens === DEFAULT_CONFIG.maxContextTokens) {
      const providerLimit = this.getProviderContextLimit(provider);
      if (providerLimit !== this.config.maxContextTokens) {
        this.config = { ...this.config, maxContextTokens: providerLimit };
      }
    }

    const profile = this.getEffectiveProfile(taskType, messages);

    // Loop through layers until no further compaction is needed.
    // Each pass applies one layer (snip → microcompact → collapse → autocompact),
    // then re-checks whether the reduced message set still exceeds the threshold.
    // Guard against infinite loops with a hard cap.
    const MAX_COMPACT_PASSES = 4;
    let current = messages;
    let totalDropped = 0;
    let totalTokensSaved = 0;
    let lastAction: CompactAction | null = null;
    let lastEmergency = false;

    for (let pass = 0; pass < MAX_COMPACT_PASSES; pass++) {
      const layer = this.needsCompaction(current, taskType);
      if (!layer) break;

      this.compactionCount++;
      let result: { messages: LLMMessage[]; action: CompactAction };

      switch (layer) {
        case 1:
          result = this.layer1Snip(current, profile);
          break;
        case 2:
          result = this.layer2Microcompact(current, profile);
          break;
        case 3:
          result = this.layer3Collapse(current, provider, profile);
          break;
        case 4:
          result = this.layer4Autocompact(current, provider, profile);
          lastEmergency = true;
          break;
        case 5: {
          // Layer 5 is a marker — actual rebuild happens externally via rebuild()
          getGlobalLogger().info('ContextCompactor', 'Layer 5 rebuild recommended', {
            compactionCount: this.compactionCount,
          });
          return {
            messages: current,
            action: {
              layer: 5,
              droppedCount: totalDropped,
              tokensSaved: totalTokensSaved,
              description: 'Layer 5 rebuild recommended — call rebuild() to reconstruct context',
              taskTypeApplied: taskType ?? null,
            },
          };
        }
        default:
          return {
            messages: current,
            action: {
              layer: 1,
              droppedCount: 0,
              tokensSaved: 0,
              description: 'No compaction needed',
              taskTypeApplied: null,
            },
          };
      }

      totalDropped += result.action.droppedCount;
      totalTokensSaved += result.action.tokensSaved;
      current = result.messages;
      lastAction = result.action;

      if (result.action.tokensSaved === 0 && result.action.droppedCount === 0) break;
    }

    if (lastEmergency) this.lastWasEmergency = true;

    return {
      messages: current,
      action: {
        layer: lastAction?.layer ?? 1,
        droppedCount: totalDropped,
        tokensSaved: totalTokensSaved,
        summary: lastAction?.summary,
        description: lastAction?.description ?? 'No compaction needed',
        taskTypeApplied: taskType ?? null,
        compositionApplied: lastAction?.compositionApplied,
      },
    };
  }

  /**
   * Layer 5: Rebuild — completely reset the context window and reconstruct
   * from persistent state (checkpoint.md + ThreeLayerMemory).
   *
   * This is different from Layers 1-4: instead of compressing existing messages,
   * we DISCARD all history and build a fresh prompt from structured records.
   *
   * @returns The rebuilt messages and action metadata
   */
  async rebuild(
    runId: string,
    goal: string,
    phase: string,
    stepNumber: number,
    systemPrompt: LLMMessage[],
    recentUserMessages: LLMMessage[],
    tokenUsage: { totalTokens: number; budgetHardCap: number },
  ): Promise<{ messages: LLMMessage[]; action: CompactAction }> {
    const rebuildPrompt = getRebuildPrompt();

    const params: RebuildParams = {
      runId,
      goal,
      phase,
      stepNumber,
      systemPrompt,
      recentUserMessages,
      tokenUsage,
    };

    const result = await rebuildPrompt.rebuild(params);

    // Reset compaction tracking since we rebuilt
    this.compactionCount = 0;
    this.lastWasEmergency = false;

    return {
      messages: result.messages,
      action: {
        layer: 5,
        droppedCount: -1, // All history discarded
        tokensSaved: 0,
        summary: result.description,
        description: result.description,
        rebuildResult: {
          sections: result.sections.map((s) => ({ name: s.name, cap: s.cap, used: s.used })),
          rebuildCount: 1,
          totalTokens: result.totalTokens,
        },
      },
    };
  }

  /** Reset compaction tracking (e.g., after rebuild or new run). */
  resetCompactionTracking(): void {
    this.compactionCount = 0;
    this.lastWasEmergency = false;
  }

  /** Get the current compaction count (for diagnostics). */
  getCompactionCount(): number {
    return this.compactionCount;
  }

  /**
   * Async compaction with LLM-based summarization for layer3/4.
   * Uses the LLM to summarize conversation turns when provider is available,
   * producing higher-quality compression than rule-based extraction.
   *
   * Evidence:
   * - AutoCompressor (Google, 2023): LLM summarization preserves 95% info, reduces tokens 60-80%
   * - LLMLingua (Microsoft, 2023): prompt compression reduces tokens 2-5x with <5% quality loss
   * - Cost tradeoff: summarization costs ~500-1000 tokens but saves 5000-20000 tokens (8-20x ROI)
   */
  async compactAsync(
    messages: LLMMessage[],
    provider?: LLMProvider,
    taskType?: CompactTaskType,
  ): Promise<{ messages: LLMMessage[]; action: CompactAction }> {
    // Provider-aware context limit adjustment
    if (provider && this.config.maxContextTokens === DEFAULT_CONFIG.maxContextTokens) {
      const providerLimit = this.getProviderContextLimit(provider);
      if (providerLimit !== this.config.maxContextTokens) {
        this.config = { ...this.config, maxContextTokens: providerLimit };
      }
    }

    const layer = this.needsCompaction(messages, taskType);
    if (!layer) {
      return {
        messages,
        action: {
          layer: 1,
          droppedCount: 0,
          tokensSaved: 0,
          description: 'No compaction needed',
          taskTypeApplied: taskType ?? null,
        },
      };
    }

    const profile = this.getEffectiveProfile(taskType, messages);

    switch (layer) {
      case 1:
        return this.layer1Snip(messages, profile);
      case 2:
        return this.layer2Microcompact(messages, profile);
      case 3:
        return this.layer3CollapseAsync(messages, provider, profile);
      case 4:
        return this.layer3CollapseAsync(messages, provider, profile); // Layer 4 also uses LLM summarization
      default:
        return {
          messages,
          action: {
            layer: 1,
            droppedCount: 0,
            tokensSaved: 0,
            description: 'No compaction needed',
            taskTypeApplied: null,
          },
        };
    }
  }

  /**
   * CPU-offloaded compaction for layer3/4 — delegates scoring + summary building to worker_threads.
   * Falls back to sync path if worker pool is unavailable or layer is 1/2 (fast enough on main thread).
   */
  async compactWithWorkerOffload(
    messages: LLMMessage[],
    workerPool: CPUWorkerPool,
    provider?: LLMProvider,
    taskType?: CompactTaskType,
  ): Promise<{ messages: LLMMessage[]; action: CompactAction }> {
    if (provider && this.config.maxContextTokens === DEFAULT_CONFIG.maxContextTokens) {
      const providerLimit = this.getProviderContextLimit(provider);
      if (providerLimit !== this.config.maxContextTokens) {
        this.config = { ...this.config, maxContextTokens: providerLimit };
      }
    }

    const layer = this.needsCompaction(messages, taskType);
    if (!layer) {
      return {
        messages,
        action: {
          layer: 1,
          droppedCount: 0,
          tokensSaved: 0,
          description: 'No compaction needed',
          taskTypeApplied: taskType ?? null,
        },
      };
    }

    const profile = this.getEffectiveProfile(taskType, messages);

    if (layer <= 2) {
      return layer === 1
        ? this.layer1Snip(messages, profile)
        : this.layer2Microcompact(messages, profile);
    }

    return this.layerWithWorkerOffload(messages, workerPool, provider, profile, layer);
  }

  private async layerWithWorkerOffload(
    messages: LLMMessage[],
    workerPool: CPUWorkerPool,
    provider: LLMProvider | undefined,
    profile: AdaptiveProfile,
    layer: CompactLayer,
  ): Promise<{ messages: LLMMessage[]; action: CompactAction }> {
    const system: LLMMessage[] = [];
    const turns: LLMMessage[][] = [];
    let current: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system.push(msg);
        continue;
      }
      if (msg.role === 'user' && current.length > 0) {
        turns.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) turns.push(current);

    const keep = Math.max(1, profile.keepRecentTurns);
    if (turns.length <= keep + 1) {
      return {
        messages,
        action: {
          layer,
          droppedCount: 0,
          tokensSaved: 0,
          description: `Layer ${layer}: not enough turns`,
        },
      };
    }

    const collapseTargets = turns.slice(0, turns.length - keep);
    const recent = turns.slice(turns.length - keep);

    const [importantMessages, summary] = await Promise.all([
      this.extractImportantMessagesWorker(collapseTargets, profile, workerPool),
      this.buildSummaryWorker(collapseTargets, provider, profile, workerPool),
    ]);

    const summaryMsg: LLMMessage = {
      role: 'system',
      content: markCompacted(
        `[Compacted summary of ${collapseTargets.length} earlier turns:\n${summary}]`,
      ),
    };

    const before = estimateMessagesTokens(messages);
    const result = [...system, summaryMsg, ...importantMessages, ...recent.flat()];
    const after = estimateMessagesTokens(result);
    const composition = analyzeComposition(messages);

    return {
      messages: result,
      action: {
        layer,
        droppedCount: collapseTargets.length,
        tokensSaved: before - after,
        summary,
        description: `Layer ${layer} collapse: compressed ${collapseTargets.length} turns into summary (worker-offloaded)`,
        taskTypeApplied: null,
        compositionApplied: {
          toolDensity: composition.toolDensity,
          errorDensity: composition.errorDensity,
        },
      },
    };
  }

  private async extractImportantMessagesWorker(
    turns: LLMMessage[][],
    profile: AdaptiveProfile,
    workerPool: CPUWorkerPool,
  ): Promise<LLMMessage[]> {
    const allMsgs = turns.flat();
    const fingerprints = this.failureTracker
      ? [...(this.failureTracker.getRunRecord('current')?.messageFingerprints ?? [])]
      : [];

    const workerResult = await workerPool.execute<
      {
        messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
        importanceConfig: typeof profile.importanceConfig;
        failureFingerprints: string[];
      },
      Array<{ index: number; importance: number }>
    >('compact_score_messages', {
      messages: allMsgs.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
        tool_calls: m.tool_calls,
      })),
      importanceConfig: profile.importanceConfig,
      failureFingerprints: fingerprints,
    });

    return workerResult
      .filter((s) => s.importance > 0.6 && !isCompacted(allMsgs[s.index]))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)
      .map((s) => allMsgs[s.index]);
  }

  private async buildSummaryWorker(
    turns: LLMMessage[][],
    provider: LLMProvider | undefined,
    profile: AdaptiveProfile,
    workerPool: CPUWorkerPool,
  ): Promise<string> {
    const collapseTokens = estimateMessagesTokens(turns.flat());

    if (provider && collapseTokens > 2000) {
      const llmSummary = await this.llmSummarize(turns, provider, 500);
      if (llmSummary) return llmSummary;
    }

    return workerPool.execute<
      {
        turns: Array<Array<{ role: string; content: string; tool_calls?: unknown[] }>>;
        verbosity: string;
      },
      string
    >('compact_build_summary', {
      turns: turns.map((t) =>
        t.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : '',
          tool_calls: m.tool_calls,
        })),
      ),
      verbosity: profile.collapseVerbosity,
    });
  }

  /**
   * Compute the effective adaptive profile given task type and messages.
   * Public for testing.
   */
  getEffectiveProfile(taskType?: CompactTaskType, messages?: LLMMessage[]): AdaptiveProfile {
    let profile = getProfile(taskType);
    if (messages && messages.length > 0) {
      const composition = analyzeComposition(messages);
      profile = adjustProfileByComposition(profile, composition);
    }
    // Constructor config overrides take priority over adaptive profile.
    // Only overrides when value differs from DEFAULT_CONFIG (i.e., user explicitly set it).
    if (this.config.layer1Trigger !== DEFAULT_CONFIG.layer1Trigger)
      profile.layerTriggers.layer1 = this.config.layer1Trigger;
    if (this.config.layer2Trigger !== DEFAULT_CONFIG.layer2Trigger)
      profile.layerTriggers.layer2 = this.config.layer2Trigger;
    if (this.config.layer3Trigger !== DEFAULT_CONFIG.layer3Trigger)
      profile.layerTriggers.layer3 = this.config.layer3Trigger;
    if (this.config.layer4Trigger !== DEFAULT_CONFIG.layer4Trigger)
      profile.layerTriggers.layer4 = this.config.layer4Trigger;
    if (this.config.keepRecentTurns !== DEFAULT_CONFIG.keepRecentTurns)
      profile.keepRecentTurns = this.config.keepRecentTurns;
    if (this.config.maxToolOutputChars !== DEFAULT_CONFIG.maxToolOutputChars)
      profile.maxToolOutputChars = this.config.maxToolOutputChars;
    return profile;
  }

  /** Public for testing */
  getCurrentTaskTypeProfile(taskType: CompactTaskType): AdaptiveProfile {
    return { ...(ADAPTIVE_PROFILES[taskType] ?? DEFAULT_PROFILE) };
  }

  /**
   * Analyze message composition. Public for testing.
   */
  analyzeComposition(messages: LLMMessage[]): CompositionScore {
    return analyzeComposition(messages);
  }

  /**
   * Get provider-specific context window limit.
   * Research: Anthropic 200k, OpenAI 128k, Gemini 1M, smaller models 32k.
   * Uses provider.maxContextTokens if available, otherwise infers from model ID.
   */
  private getProviderContextLimit(provider: LLMProvider): number {
    // Use explicit limit from provider if available (some providers expose this)
    const p = provider as unknown as Record<string, unknown>;
    if (p.maxContextTokens && typeof p.maxContextTokens === 'number')
      return p.maxContextTokens as number;
    // Infer from model ID if available
    const model = (p.modelId as string)?.toLowerCase?.() ?? '';
    if (model.includes('opus') || model.includes('sonnet') || model.includes('claude'))
      return 200000;
    if (model.includes('gpt-5') || model.includes('gpt-4')) return 128000;
    if (model.includes('gemini')) return 1000000;
    if (model.includes('haiku')) return 200000;
    return 128000; // safe default
  }

  // Layer 1: Remove oldest turn-pairs, keeping recent turns
  private layer1Snip(
    messages: LLMMessage[],
    profile: AdaptiveProfile,
  ): { messages: LLMMessage[]; action: CompactAction } {
    const system: LLMMessage[] = [];
    const pairs: LLMMessage[][] = [];
    let current: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system.push(msg);
        continue;
      }
      if (msg.role === 'user' && current.length > 0) {
        pairs.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) pairs.push(current);

    const keep = Math.max(1, profile.keepRecentTurns);
    const dropped = Math.max(0, pairs.length - keep);
    const kept = pairs.slice(Math.max(0, pairs.length - keep));

    const before = estimateMessagesTokens(messages);
    const result = [...system, ...kept.flat()];
    const after = estimateMessagesTokens(result);

    const composition = analyzeComposition(messages);

    return {
      messages: result,
      action: {
        layer: 1,
        droppedCount: dropped,
        tokensSaved: before - after,
        description: `Layer 1 snip: removed ${dropped} oldest turn(s)`,
        taskTypeApplied: null,
        compositionApplied: {
          toolDensity: composition.toolDensity,
          errorDensity: composition.errorDensity,
        },
      },
    };
  }

  // Layer 2: Trim verbose tool outputs with intelligent preservation
  private layer2Microcompact(
    messages: LLMMessage[],
    profile: AdaptiveProfile,
  ): { messages: LLMMessage[]; action: CompactAction } {
    const before = estimateMessagesTokens(messages);
    let trimmedCount = 0;
    let redactedCount = 0;

    const maxChars = profile.maxToolOutputChars;
    const result = messages.map((msg) => {
      if (msg.role === 'tool' && msg.content.length > maxChars) {
        // Security-first: redact unsafe tool content instead of normal truncation.
        const redacted = redactUnsafeToolContent(msg.content);
        if (redacted) {
          redactedCount++;
          return { ...msg, content: redacted };
        }
        trimmedCount++;
        const truncated = this.intelligentTruncate(msg.content, maxChars);
        return { ...msg, content: truncated };
      }
      return msg;
    });

    const after = estimateMessagesTokens(result);
    const composition = analyzeComposition(messages);

    return {
      messages: result,
      action: {
        layer: 2,
        droppedCount: trimmedCount + redactedCount,
        tokensSaved: before - after,
        description: `Layer 2 microcompact: trimmed ${trimmedCount} tool outputs, redacted ${redactedCount} unsafe outputs`,
        taskTypeApplied: null,
        compositionApplied: {
          toolDensity: composition.toolDensity,
          errorDensity: composition.errorDensity,
        },
      },
    };
  }

  // Layer 3: Collapse middle turns into summary, preserving important messages
  // Uses LLM summarization when provider is available for higher-quality compression
  private async layer3CollapseAsync(
    messages: LLMMessage[],
    provider: LLMProvider | undefined,
    profile: AdaptiveProfile,
  ): Promise<{ messages: LLMMessage[]; action: CompactAction }> {
    const system: LLMMessage[] = [];
    const turns: LLMMessage[][] = [];
    let current: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system.push(msg);
        continue;
      }
      if (msg.role === 'user' && current.length > 0) {
        turns.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) turns.push(current);

    const keep = Math.max(1, profile.keepRecentTurns);
    if (turns.length <= keep + 1) {
      return {
        messages,
        action: {
          layer: 3,
          droppedCount: 0,
          tokensSaved: 0,
          description: 'Layer 3 collapse: not enough turns',
        },
      };
    }

    const collapseTargets = turns.slice(0, turns.length - keep);
    const recent = turns.slice(turns.length - keep);

    // Extract important messages from collapse targets (don't lose critical info)
    const importantMessages = this.extractImportantMessages(collapseTargets, profile);

    // Try LLM summarization first (higher quality, costs ~500-1000 tokens)
    // Fall back to structured summary if LLM fails or is unavailable
    let summary: string;
    const collapseTokens = estimateMessagesTokens(collapseTargets.flat());

    if (provider && collapseTokens > 2000) {
      // LLM summarization: costs ~500-1000 tokens but saves 5000-20000 tokens
      // Only worth it when content is long enough (>2000 tokens)
      const llmSummary = await this.llmSummarize(collapseTargets, provider, 500);
      if (llmSummary) {
        summary = llmSummary;
      } else {
        summary = this.buildStructuredSummary(collapseTargets, provider, profile);
      }
    } else {
      summary = this.buildStructuredSummary(collapseTargets, provider, profile);
    }

    const summaryMsg: LLMMessage = {
      role: 'system',
      content: markCompacted(
        `[Compacted summary of ${collapseTargets.length} earlier turns:\n${summary}]`,
      ),
    };

    const before = estimateMessagesTokens(messages);
    const result = [...system, summaryMsg, ...importantMessages, ...recent.flat()];
    const after = estimateMessagesTokens(result);

    const composition = analyzeComposition(messages);

    return {
      messages: result,
      action: {
        layer: 3,
        droppedCount: collapseTargets.length,
        tokensSaved: before - after,
        summary,
        description: `Layer 3 collapse: compressed ${collapseTargets.length} turns into summary (llm=${provider ? 'yes' : 'no'})`,
        taskTypeApplied: null,
        compositionApplied: {
          toolDensity: composition.toolDensity,
          errorDensity: composition.errorDensity,
        },
      },
    };
  }

  // Layer 3: Synchronous fallback (when async not available)
  private layer3Collapse(
    messages: LLMMessage[],
    provider: LLMProvider | undefined,
    profile: AdaptiveProfile,
  ): { messages: LLMMessage[]; action: CompactAction } {
    const system: LLMMessage[] = [];
    const turns: LLMMessage[][] = [];
    let current: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system.push(msg);
        continue;
      }
      if (msg.role === 'user' && current.length > 0) {
        turns.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) turns.push(current);

    const keep = Math.max(1, profile.keepRecentTurns);
    if (turns.length <= keep + 1) {
      return {
        messages,
        action: {
          layer: 3,
          droppedCount: 0,
          tokensSaved: 0,
          description: 'Layer 3 collapse: not enough turns',
        },
      };
    }

    const collapseTargets = turns.slice(0, turns.length - keep);
    const recent = turns.slice(turns.length - keep);

    // Extract important messages from collapse targets (don't lose critical info)
    const importantMessages = this.extractImportantMessages(collapseTargets, profile);

    const summary = this.buildStructuredSummary(collapseTargets, provider, profile);
    const summaryMsg: LLMMessage = {
      role: 'system',
      content: markCompacted(
        `[Compacted summary of ${collapseTargets.length} earlier turns:\n${summary}]`,
      ),
    };

    const before = estimateMessagesTokens(messages);
    const result = [...system, summaryMsg, ...importantMessages, ...recent.flat()];
    const after = estimateMessagesTokens(result);

    const composition = analyzeComposition(messages);

    return {
      messages: result,
      action: {
        layer: 3,
        droppedCount: collapseTargets.length,
        tokensSaved: before - after,
        summary,
        description: `Layer 3 collapse: compressed ${collapseTargets.length} turns into summary`,
        taskTypeApplied: null,
        compositionApplied: {
          toolDensity: composition.toolDensity,
          errorDensity: composition.errorDensity,
        },
      },
    };
  }

  // Layer 4: Emergency — keep by cost-weighted token budget, not message count
  private layer4Autocompact(
    messages: LLMMessage[],
    provider: LLMProvider | undefined,
    profile: AdaptiveProfile,
  ): { messages: LLMMessage[]; action: CompactAction } {
    const system: LLMMessage[] = messages.filter((m) => m.role === 'system');
    const nonSystem: LLMMessage[] = messages.filter((m) => m.role !== 'system');

    const retentionBudget = Math.floor(this.config.maxContextTokens * 0.2);
    const kept: LLMMessage[] = [];
    let usedCostWeightedTokens = 0;

    const scored: Array<{ msg: LLMMessage; costImpact: number; index: number }> = nonSystem.map(
      (msg, i) => ({
        msg,
        costImpact: this.failureTracker?.isCorrelated(msg)
          ? Math.floor(estimateMessageCostImpact(msg) * 0.25)
          : estimateMessageCostImpact(msg),
        index: i,
      }),
    );

    this.selectTopKByCost(scored, retentionBudget);

    const selectedIndices = new Set<number>();
    for (const s of scored) {
      if (usedCostWeightedTokens + s.costImpact > retentionBudget) break;
      selectedIndices.add(s.index);
      usedCostWeightedTokens += s.costImpact;
    }

    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (selectedIndices.has(i)) {
        kept.unshift(nonSystem[i]);
      }
    }

    const summary = this.buildStructuredSummary([nonSystem], provider, profile);
    const summaryMsg: LLMMessage = {
      role: 'system',
      content: markCompacted(`[Emergency compact: full conversation summary\n${summary}]`),
    };

    const before = estimateMessagesTokens(messages);
    const result = [...system, summaryMsg, ...kept];
    const after = estimateMessagesTokens(result);

    const composition = analyzeComposition(messages);

    return {
      messages: result,
      action: {
        layer: 4,
        droppedCount: nonSystem.length - kept.length,
        tokensSaved: before - after,
        summary,
        description: `Layer 4 autocompact: emergency, kept ${kept.length} messages by token budget`,
        taskTypeApplied: null,
        compositionApplied: {
          toolDensity: composition.toolDensity,
          errorDensity: composition.errorDensity,
        },
      },
    };
  }

  /**
   * Extract important messages from collapse targets.
   * These are preserved alongside the summary to prevent information loss.
   */
  private extractImportantMessages(turns: LLMMessage[][], profile: AdaptiveProfile): LLMMessage[] {
    const allMsgs = turns.flat();
    const scored: ScoredMessage[] = allMsgs.map((msg, i) => ({
      msg,
      index: i,
      importance: scoreMessageImportance(
        msg,
        i,
        allMsgs.length,
        profile.importanceConfig,
        this.failureTracker,
      ),
    }));

    // Keep messages with importance > 0.6 (errors, decisions, user instructions)
    // Lowered from 0.7 to preserve early user instructions that get low recency bonus
    // Cap at 5 messages to avoid blowing the budget
    return scored
      .filter((s) => s.importance > 0.6 && !isCompacted(s.msg))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)
      .map((s) => s.msg);
  }

  private selectTopKByCost(
    scored: Array<{ msg: LLMMessage; costImpact: number; index: number }>,
    budget: number,
  ): void {
    const minHeap: Array<{ costImpact: number; idx: number }> = [];
    let totalCost = 0;

    for (let i = 0; i < scored.length; i++) {
      const item = scored[i];
      if (totalCost + item.costImpact <= budget) {
        minHeap.push({ costImpact: item.costImpact, idx: i });
        totalCost += item.costImpact;
        this.bubbleUp(minHeap, minHeap.length - 1);
      } else if (minHeap.length > 0 && item.costImpact > minHeap[0].costImpact) {
        totalCost -= minHeap[0].costImpact;
        minHeap[0] = { costImpact: item.costImpact, idx: i };
        totalCost += item.costImpact;
        this.bubbleDown(minHeap, 0);
      }
    }

    const keepSet = new Set(minHeap.map((h) => h.idx));
    let writeIdx = 0;
    for (let i = 0; i < scored.length; i++) {
      if (keepSet.has(i)) {
        scored[writeIdx++] = scored[i];
      }
    }
    scored.length = writeIdx;
    scored.sort((a, b) => b.costImpact - a.costImpact);
  }

  private bubbleUp(heap: Array<{ costImpact: number; idx: number }>, i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].costImpact <= heap[i].costImpact) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  private bubbleDown(heap: Array<{ costImpact: number; idx: number }>, i: number): void {
    const n = heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && heap[left].costImpact < heap[smallest].costImpact) smallest = left;
      if (right < n && heap[right].costImpact < heap[smallest].costImpact) smallest = right;
      if (smallest === i) break;
      [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
      i = smallest;
    }
  }

  private adjustThresholds(
    taskType?: CompactTaskType,
    messages?: LLMMessage[],
  ): { layer1: number; layer2: number; layer3: number; layer4: number } {
    const profile = this.getEffectiveProfile(taskType, messages);

    const base = {
      layer1: profile.layerTriggers.layer1,
      layer2: profile.layerTriggers.layer2,
      layer3: profile.layerTriggers.layer3,
      layer4: profile.layerTriggers.layer4,
    };

    if (!this.config.governorAware) {
      return base;
    }

    try {
      const governor = getTokenGovernor();
      const phase = governor.getState().phase;

      // Under pressure, lower thresholds to compact earlier
      const shift =
        phase === 'critical' ? 0.15 : phase === 'tight' ? 0.1 : phase === 'moderate' ? 0.05 : 0;

      base.layer1 = Math.max(0.3, base.layer1 - shift);
      base.layer2 = Math.max(0.4, base.layer2 - shift);
      base.layer3 = Math.max(0.55, base.layer3 - shift);
      base.layer4 = Math.max(0.7, base.layer4 - shift);

      return base;
    } catch (e) {
      getGlobalLogger().warn('ContextCompactor', 'Failed to adjust thresholds', {
        error: (e as Error)?.message,
      });
      return base;
    }
  }

  private buildStructuredSummary(
    turns: LLMMessage[][],
    _provider?: LLMProvider,
    profile?: AdaptiveProfile,
  ): string {
    const verbosity = profile?.collapseVerbosity ?? 'balanced';
    const maxDecisions = verbosity === 'aggressive' ? 1 : verbosity === 'detail' ? 5 : 3;
    const maxFindings = verbosity === 'aggressive' ? 1 : verbosity === 'detail' ? 5 : 3;
    const maxErrors = verbosity === 'aggressive' ? 2 : verbosity === 'detail' ? 5 : 3;
    const maxFiles = verbosity === 'aggressive' ? 3 : verbosity === 'detail' ? 10 : 8;

    const toolCalls = new Set<string>();
    const errors: string[] = [];
    const decisions: string[] = [];
    const files: string[] = [];
    const keyFindings: string[] = [];
    let userGoals = '';

    for (const turn of turns) {
      for (const msg of turn) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (text.length > 20 && text.length < 500) userGoals = text.slice(0, 200);
        }
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            toolCalls.add(tc.function.name);
            try {
              const args = JSON.parse(tc.function.arguments);
              if (args.path) files.push(args.path);
              if (args.file_path) files.push(args.file_path);
            } catch (e) {
              getGlobalLogger().debug('ContextCompactor', 'Failed to parse tool call arguments', {
                error: (e as Error)?.message,
              });
            }
          }
        }
        if (msg.role === 'tool') {
          const c = typeof msg.content === 'string' ? msg.content : '';
          if (c.startsWith('error:') || c.startsWith('tool_error') || c.startsWith('ERROR')) {
            errors.push(c.split('\n')[0].slice(0, 120));
          } else {
            const lines = c.split('\n');
            let foundFinding = false;
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.length > 20 && trimmed.length < 150) {
                if (RE_HAS_DIGIT.test(trimmed) || RE_FINDING_KEYWORDS.test(trimmed)) {
                  keyFindings.push(trimmed.slice(0, 100));
                  foundFinding = true;
                  break;
                }
              }
            }
            // Per-message fallback: extract first long line if no keyword match found
            if (!foundFinding && keyFindings.length < maxFindings) {
              const first = lines.find((l) => l.trim().length > 20);
              if (first) keyFindings.push(first.trim().slice(0, 100));
            }
          }
        }
        if (msg.role === 'assistant' && !msg.tool_calls) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          for (const pattern of DECISION_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
              decisions.push(match[0].replace(RE_NEWLINE, ' ').trim().slice(0, 120));
              if (decisions.length >= maxDecisions) break;
            }
          }
        }
      }
    }

    const parts: string[] = ['## Progress'];
    if (userGoals) parts.push(`Goal: ${userGoals}`);
    if (toolCalls.size > 0) parts.push(`Tools: ${[...toolCalls].join(', ')}`);
    if (files.length > 0) parts.push(`Files: ${[...new Set(files)].slice(0, maxFiles).join(', ')}`);
    if (decisions.length > 0)
      parts.push(`\n## Key Decisions\n${decisions.slice(0, maxDecisions).join('\n')}`);
    if (keyFindings.length > 0)
      parts.push(`\n## Findings\n${keyFindings.slice(0, maxFindings).join('\n')}`);
    if (errors.length > 0) parts.push(`\n## Issues\n${errors.slice(0, maxErrors).join('\n')}`);

    return parts.join('\n') || `${turns.length} turn(s) compacted`;
  }

  /**
   * Intelligent truncation: preserve error lines, key-value pairs, and structural elements.
   */
  private intelligentTruncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;

    const redacted = redactUnsafeToolContent(content);
    if (redacted) return redacted;

    if (content.length <= maxChars * 2) {
      return this.truncateSmall(content, maxChars);
    }

    return this.truncateLarge(content, maxChars);
  }

  private truncateSmall(content: string, maxChars: number): string {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const important: string[] = [];
    const rest: string[] = [];

    for (let i = 0; i < lineCount; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (RE_ERROR_LINE.test(trimmed)) {
        important.push(line);
      } else if (RE_KV_PAIR.test(trimmed) && trimmed.length < 120) {
        important.push(line);
      } else if (i < 2 || i > lineCount - 3) {
        important.push(line);
      } else {
        rest.push(line);
      }
    }

    let result = important.join('\n');
    if (result.length < maxChars * 0.6) {
      for (const line of rest) {
        if (result.length + line.length + 1 > maxChars - 50) break;
        result += '\n' + line;
      }
    }

    if (result.length > maxChars) {
      result = result.slice(0, maxChars);
    }

    return `${result}\n...[+${content.length - result.length} more chars]`;
  }

  private truncateLarge(content: string, maxChars: number): string {
    const headSize = Math.floor(maxChars * 0.7);
    const tailSize = Math.floor(maxChars * 0.2);
    const head = content.slice(0, headSize);
    const tail = content.slice(content.length - tailSize);
    const omitted = content.length - headSize - tailSize;
    const omittedLines = this.countNewlinesFast(content, headSize, content.length - tailSize);
    return `${head}\n...[+${omittedLines} lines, ${omitted} chars omitted]...\n${tail}`;
  }

  private countNewlinesFast(content: string, start: number, end: number): number {
    let count = 0;
    const chunkSize = 8192;
    for (let i = start; i < end; i += chunkSize) {
      const chunkEnd = Math.min(i + chunkSize, end);
      for (let j = i; j < chunkEnd; j++) {
        if (content.charCodeAt(j) === 10) count++;
      }
    }
    return count;
  }

  /**
   * LLM-based prompt compression: use the LLM to summarize conversation turns.
   *
   * Evidence:
   * - AutoCompressor (Google, 2023): LLM-based summarization preserves 95% of information
   *   while reducing tokens by 60-80%
   * - LLMLingua (Microsoft, 2023): prompt compression via summarization reduces tokens by 2-5x
   *   with <5% quality loss on QA tasks
   * - Cost tradeoff: summarization costs ~500-1000 tokens but saves 5000-20000 tokens
   *   Net savings: 4000-19000 tokens per compression (8-20x ROI)
   *
   * @param turns - The conversation turns to summarize
   * @param provider - The LLM provider to use for summarization
   * @param maxSummaryTokens - Maximum tokens for the summary (default: 500)
   * @returns Summarized text, or null if summarization fails
   */
  async llmSummarize(
    turns: LLMMessage[][],
    provider: LLMProvider,
    maxSummaryTokens: number = 500,
  ): Promise<string | null> {
    // Flatten turns into a single text block for summarization
    const flatContent: string[] = [];
    for (const turn of turns) {
      for (const msg of turn) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.length > 0) {
          const prefix =
            msg.role === 'user'
              ? 'User'
              : msg.role === 'assistant'
                ? 'Assistant'
                : msg.role === 'tool'
                  ? 'Tool'
                  : 'System';
          flatContent.push(`${prefix}: ${content.slice(0, 500)}`);
        }
      }
    }

    const fullText = flatContent.join('\n\n');
    if (fullText.length < 200) return null; // Too short to summarize

    const summarizationPrompt: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a conversation summarizer. Summarize the following conversation turns into a concise summary that preserves: (1) key decisions and their rationale, (2) important findings and results, (3) errors encountered and how they were resolved, (4) the current state of the task. Be factual and concise. Do not add information not present in the original.',
      },
      {
        role: 'user',
        content: `Summarize this conversation in ${maxSummaryTokens} tokens or less:\n\n${fullText.slice(0, 8000)}`,
      },
    ];

    try {
      const response = await provider.call({
        model: '', // Provider will use its default model
        messages: summarizationPrompt,
        maxTokens: maxSummaryTokens,
        temperature: 0, // Deterministic summarization
      });

      if (response && response.content && response.content.length > 0) {
        return response.content;
      }
    } catch (err) {
      reportSilentFailure(err, 'contextCompactor:1765');
      // Summarization failed; fall back to structured summary
    }

    return null;
  }
}
