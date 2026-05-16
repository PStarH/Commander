/**
 * PASTE-style Speculative Execution
 *
 * Research finding (arXiv 2603.18897): Pattern-aware speculative execution
 * achieves 48.5% reduction in task completion time. Agents exhibit stable
 * control flows — the same tool sequences recur across tasks.
 *
 * During LLM thinking/processing time, we pre-execute the most likely
 * next tool calls based on observed patterns. If the model actually makes
 * those calls, results are already available (zero-wait). Wrong predictions
 * are discarded at no cost (read-only tools only).
 *
 * Safety: Only READ-ONLY tools are speculatively executed.
 * State-mutating tools (write, edit, shell, git) are NEVER speculatively
 * executed.
 */

const MAX_PATTERN_LENGTH = 4;
const MAX_TRACKED_PATTERNS = 50;

/**
 * A tracked tool-call sequence pattern.
 */
interface ToolPattern {
  sequence: string[];        // Tool names in order
  frequency: number;         // Times this exact sequence has been observed
  lastSeen: number;          // Timestamp of last observation
  confidence: number;        // 0-1, how reliable this pattern is
}

/**
 * Pattern tracker — records tool call sequences and identifies
 * recurring patterns.
 */
export class PatternTracker {
  private patterns: Map<string, ToolPattern> = new Map();
  private recentSequence: string[] = [];
  private observationCount = 0;

  /**
   * Record an observed tool call sequence.
   */
  recordSequence(toolNames: string[]): void {
    this.recentSequence.push(...toolNames);
    this.observationCount++;

    // Keep recent sequence bounded
    if (this.recentSequence.length > MAX_PATTERN_LENGTH * 3) {
      this.recentSequence = this.recentSequence.slice(-MAX_PATTERN_LENGTH * 2);
    }

    // Extract n-grams from the incoming tool names
    this.extractNGrams(toolNames);
    // Also extract n-grams from the accumulated history for single-tool calls
    if (toolNames.length === 1 && this.recentSequence.length >= 2) {
      this.extractNGrams(this.recentSequence.slice(-MAX_PATTERN_LENGTH));
    }

    // Periodically prune low-confidence patterns
    if (this.observationCount % 20 === 0) {
      this.prunePatterns();
    }
  }

  /**
   * Given a partial sequence, predict the most likely next tool(s).
   * Returns predictions sorted by confidence.
   */
  predictNext(partialSequence: string[]): Array<{ toolName: string; confidence: number }> {
    const predictions = new Map<string, number>();

    for (let len = Math.min(partialSequence.length, MAX_PATTERN_LENGTH - 1); len >= 1; len--) {
      const suffix = partialSequence.slice(-len).join('→');

      for (const [, pattern] of this.patterns) {
        if (pattern.sequence.length > len && pattern.sequence.slice(0, len).join('→') === suffix) {
          const nextTool = pattern.sequence[len];
          const current = predictions.get(nextTool) ?? 0;
          predictions.set(nextTool, Math.max(current, pattern.confidence));
        }
      }

      if (predictions.size > 0) break;
    }

    return [...predictions.entries()]
      .map(([toolName, confidence]) => ({ toolName, confidence }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  private extractNGrams(toolNames: string[]): void {
    for (const len of [2, 3, 4]) {
      if (toolNames.length >= len) {
        for (let i = 0; i <= toolNames.length - len; i++) {
          const seq = toolNames.slice(i, i + len);
          const key = seq.join('→');
          const existing = this.patterns.get(key);
          if (existing) {
            existing.frequency++;
            existing.lastSeen = Date.now();
            existing.confidence = Math.min(1, existing.frequency / 10);
          } else if (this.patterns.size < MAX_TRACKED_PATTERNS) {
            this.patterns.set(key, {
              sequence: [...seq],
              frequency: 1,
              lastSeen: Date.now(),
              confidence: 0.1,
            });
          }
        }
      }
    }
  }

  /**
   * Get the most common patterns for debugging/analysis.
   */
  getTopPatterns(n: number): ToolPattern[] {
    return [...this.patterns.values()]
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, n);
  }

  private prunePatterns(): void {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [key, pattern] of this.patterns) {
      if (pattern.frequency < 2 || (now - pattern.lastSeen > staleThreshold && pattern.frequency < 5)) {
        this.patterns.delete(key);
      }
    }
  }
}

/**
 * Global pattern tracker instance shared across executions.
 */
let globalTracker: PatternTracker | null = null;

export function getPatternTracker(): PatternTracker {
  if (!globalTracker) {
    globalTracker = new PatternTracker();
  }
  return globalTracker;
}

export function resetPatternTracker(): void {
  globalTracker = null;
}

/**
 * Tools that are safe for speculative execution (read-only).
 */
const SPECULATIVE_SAFE_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'browser_search',
  'browser_fetch',
  'file_read',
  'file_search',
  'file_list',
  'memory_recall',
  'memory_list',
]);

/**
 * Check if a tool is safe to execute speculatively.
 */
export function isSpeculativelySafe(toolName: string): boolean {
  return SPECULATIVE_SAFE_TOOLS.has(toolName);
}

/**
 * Create a speculative execution plan.
 * Returns predicted next tool calls that should be pre-executed.
 */
export function planSpeculativeExecution(
  patternTracker: PatternTracker,
  recentToolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
  availableTools: string[],
): Array<{ name: string; arguments: Record<string, unknown>; confidence: number }> {
  const toolNames = recentToolCalls.map(tc => tc.name);
  const predictions = patternTracker.predictNext(toolNames);

  const result: Array<{ name: string; arguments: Record<string, unknown>; confidence: number }> = [];

  for (const pred of predictions) {
    if (result.length >= 2) break; // Max 2 speculative calls
    if (!isSpeculativelySafe(pred.toolName)) continue;
    if (!availableTools.includes(pred.toolName)) continue;
if (pred.confidence < 0.3) continue; // Minimum confidence threshold

    const lastCall = recentToolCalls.find(tc => tc.name === pred.toolName);
    result.push({
      name: pred.toolName,
      arguments: lastCall?.arguments ?? {},
      confidence: pred.confidence,
    });
  }

  return result;
}
