/**
 * CycleDetector — tool call cycle detection
 *
 * Detects and interrupts repeating tool-call patterns to prevent infinite loops.
 * Inspired by OpenClaw's loop-detection design, but more adaptive:
 * - Detects consecutive identical tool calls (same tool + same args)
 * - Detects alternating loops (A→B→A→B)
 * - Detects slow-drift loops (repeated calls with small parameter changes)
 * - Provides structured feedback so the model knows why execution was stopped
 */

interface CycleDetectorConfig {
  /** 最大允许的相同连续工具调用次数 (默认: 3) */
  maxConsecutiveSameTool: number;
  /** 检测交替模式的窗口大小 (默认: 6) */
  alternatingPatternWindow: number;
  /** 漂移检测：允许参数微调的最大次数 (默认: 5) */
  maxDriftIterations: number;
  /** 漂移追踪器最大条目数 (默认: 200) */
  maxDriftEntries: number;
}

const DEFAULT_CONFIG: CycleDetectorConfig = {
  maxConsecutiveSameTool: 3,
  alternatingPatternWindow: 6,
  maxDriftIterations: 5,
  maxDriftEntries: 200,
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if', 'while',
  'about', 'against', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'they', 'them', 'their', 'what', 'which', 'who', 'whom',
]);

/**
 * Parameter key that distinguishes consecutive calls to the same tool.
 * If the value of this parameter differs between calls, it's not a cycle.
 */
const DIFFERENTIATING_PARAM: Record<string, string> = {
  file_write: 'path',
  file_edit: 'path',
  file_read: 'path',
  file_list: 'path',
  file_search: 'pattern',
  web_search: 'query',
  web_fetch: 'url',
  web_scrape: 'url',
  shell_execute: 'command',
  bash: 'command',
  git: 'command',
  python_execute: 'code',
};

type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  stepNumber: number;
};

export type CycleDetectionResult =
  | { detected: false }
  | {
      detected: true;
      type: 'consecutive' | 'alternating' | 'drift' | 'semantic_stagnation';
      description: string;
      advice: string;
      similarity?: number;
    };

export class CycleDetector {
  private config: CycleDetectorConfig;
  // Ring buffer for history — O(1) insert, no allocation on overflow
  private history: ToolCallRecord[];
  private historyHead = 0;
  private historyCount = 0;
  private readonly maxHistory: number;
  private consecutiveSameToolCount = 0;
  private lastToolName: string | null = null;
  private lastDiffParamValue: string | null = null;
  private lastStepNumber = -1;
  private driftTracker: Map<string, number> = new Map();
  private outputHistory: string[] = [];
  private readonly maxOutputHistory = 5;

  constructor(config?: Partial<CycleDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.maxHistory = this.config.alternatingPatternWindow * 3;
    this.history = new Array(this.maxHistory);
  }

  /**
   * 检查新工具调用是否构成循环
   */
  check(toolName: string, args: Record<string, unknown>, stepNumber: number): CycleDetectionResult {
    const record: ToolCallRecord = { name: toolName, args, stepNumber };
    // Ring buffer: O(1) insert, no allocation
    this.history[this.historyHead] = record;
    this.historyHead = (this.historyHead + 1) % this.maxHistory;
    if (this.historyCount < this.maxHistory) this.historyCount++;

    // 1. 检测连续相同工具调用
    const consecutive = this.detectConsecutive(toolName, args, stepNumber);
    if (consecutive.detected) return consecutive;

    // 2. 检测交替模式 (A→B→A→B)
    const alternating = this.detectAlternating();
    if (alternating.detected) return alternating;

    // 3. 检测参数漂移循环
    const drift = this.detectDrift(toolName, args);
    if (drift.detected) return drift;

    return { detected: false };
  }

  checkOutput(output: string): CycleDetectionResult {
    const fingerprint = CycleDetector.extractFingerprint(output);
    this.outputHistory.push(fingerprint);
    if (this.outputHistory.length > this.maxOutputHistory) {
      this.outputHistory.shift();
    }

    if (this.outputHistory.length < 2) return { detected: false };

    const prev = this.outputHistory[this.outputHistory.length - 2];
    const curr = this.outputHistory[this.outputHistory.length - 1];
    const similarity = CycleDetector.semanticSimilarity(prev, curr);

    if (similarity > 0.85 && this.outputHistory.length >= 2) {
      const allSimilar = this.outputHistory.slice(-3).every((h, i, arr) => {
        if (i === 0) return true;
        return CycleDetector.semanticSimilarity(arr[i - 1], h) > 0.8;
      });
      if (allSimilar && this.outputHistory.length >= 3) {
        return {
          detected: true,
          type: 'semantic_stagnation',
          description: `LLM output semantic similarity ${(similarity * 100).toFixed(0)}% across last ${this.outputHistory.length} responses`,
          advice: 'The model is producing semantically near-identical outputs. Inject variety: rephrase the goal, add a temperature constraint, or switch to a different model.',
          similarity,
        };
      }
    }

    return { detected: false };
  }

  private static extractFingerprint(text: string): string {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    const trigrams: string[] = [];
    for (let i = 0; i <= words.length - 3; i++) {
      trigrams.push(`${words[i]}_${words[i + 1]}_${words[i + 2]}`);
    }
    if (trigrams.length === 0) return words.join('_');
    return trigrams.join('|');
  }

  private static semanticSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const setA = new Set(a.split('|'));
    const setB = new Set(b.split('|'));
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * 重置检测器状态（用于新任务）
   */
  reset(): void {
    this.historyHead = 0;
    this.historyCount = 0;
    this.consecutiveSameToolCount = 0;
    this.lastToolName = null;
    this.lastDiffParamValue = null;
    this.lastStepNumber = -1;
    this.driftTracker.clear();
    this.outputHistory = [];
  }

  private detectConsecutive(
    toolName: string,
    args?: Record<string, unknown>,
    stepNumber?: number,
  ): CycleDetectionResult {
    // Concurrent calls from the same LLM turn share the same step number.
    // These are parallel tool invocations, not consecutive loops — skip tracking.
    if (stepNumber !== undefined && stepNumber === this.lastStepNumber) {
      return { detected: false };
    }
    if (stepNumber !== undefined) this.lastStepNumber = stepNumber;

    // For tools with differentiating parameters, consecutive calls with
    // different values are not cycles (e.g., searching different queries,
    // fetching different URLs, writing different files).
    const diffParam = DIFFERENTIATING_PARAM[toolName];
    if (diffParam && args?.[diffParam] !== undefined) {
      const currentVal = String(args[diffParam]);
      if (
        this.lastToolName === toolName &&
        this.lastDiffParamValue &&
        this.lastDiffParamValue !== currentVal
      ) {
        this.consecutiveSameToolCount = 1;
        this.lastDiffParamValue = currentVal;
        return { detected: false };
      }
      this.lastDiffParamValue = currentVal;
    }

    if (toolName === this.lastToolName) {
      this.consecutiveSameToolCount++;
    } else {
      this.consecutiveSameToolCount = 1;
      this.lastToolName = toolName;
      this.lastDiffParamValue = null;
    }

    if (this.consecutiveSameToolCount >= this.config.maxConsecutiveSameTool) {
      return {
        detected: true,
        type: 'consecutive',
        description: `Same tool "${toolName}" called ${this.consecutiveSameToolCount} times consecutively`,
        advice: `The tool "${toolName}" was called repeatedly with similar arguments. Consider: (1) checking if previous results were actually used, (2) changing approach, (3) verifying arguments are different each time.`,
      };
    }

    return { detected: false };
  }

  private detectAlternating(): CycleDetectionResult {
    const window = this.config.alternatingPatternWindow;
    if (this.historyCount < window) return { detected: false };

    // Read last `window` entries from ring buffer
    const entries: Array<{ name: string; diffVal: string | null }> = [];
    for (let i = 0; i < window; i++) {
      const idx = (this.historyHead - window + i + this.maxHistory) % this.maxHistory;
      const rec = this.history[idx];
      const diffParam = DIFFERENTIATING_PARAM[rec.name];
      const diffVal =
        diffParam && rec.args?.[diffParam] != null ? String(rec.args[diffParam]) : null;
      entries.push({ name: rec.name, diffVal });
    }

    // 检查 A→B→A→B 模式
    if (entries.length >= 4) {
      const evenEntries = entries.filter((_, i) => i % 2 === 0);
      const oddEntries = entries.filter((_, i) => i % 2 === 1);

      const evenSame = evenEntries.every((e) => e.name === evenEntries[0].name);
      const oddSame = oddEntries.every((e) => e.name === oddEntries[0].name);

      if (evenSame && oddSame && evenEntries[0].name !== oddEntries[0].name) {
        // Not a cycle if the differentiating parameter values are changing
        // (e.g., file_read → file_edit on different files is a legitimate workflow)
        const evenDiffVals = evenEntries.map((e) => e.diffVal).filter(Boolean);
        const oddDiffVals = oddEntries.map((e) => e.diffVal).filter(Boolean);
        const evenVaries =
          evenDiffVals.length > 1 && !evenDiffVals.every((v) => v === evenDiffVals[0]);
        const oddVaries = oddDiffVals.length > 1 && !oddDiffVals.every((v) => v === oddDiffVals[0]);

        if (!evenVaries && !oddVaries) {
          return {
            detected: true,
            type: 'alternating',
            description: `Alternating pattern detected: "${evenEntries[0].name}" ↔ "${oddEntries[0].name}"`,
            advice: `Tools are alternating in a fixed pattern. This usually means the agent is stuck in a retry loop. Try combining both operations into a single call, or re-examine the overall approach.`,
          };
        }
      }
    }

    return { detected: false };
  }

  private detectDrift(toolName: string, args: Record<string, unknown>): CycleDetectionResult {
    // Fast hash instead of JSON.stringify — sort top-level keys for determinism
    const keys = Object.keys(args).sort();
    let argsHash = '';
    for (let i = 0; i < keys.length; i++) {
      const v = args[keys[i]];
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      argsHash += `${keys[i]}=${val};`;
      if (argsHash.length > 200) {
        argsHash = argsHash.slice(0, 200);
        break;
      }
    }
    const key = `${toolName}:${argsHash}`;
    const count = (this.driftTracker.get(key) ?? 0) + 1;
    this.driftTracker.set(key, count);

    // Evict entries to prevent unbounded memory growth.
    // Strategy: when over limit, remove all entries with count < 2 first,
    // then if still over, remove oldest entries (Map insertion order).
    if (this.driftTracker.size > this.config.maxDriftEntries) {
      for (const [k, v] of this.driftTracker) {
        if (v < 2) this.driftTracker.delete(k);
      }
      // If still over limit after low-count eviction, trim oldest
      while (this.driftTracker.size > this.config.maxDriftEntries) {
        const firstKey = this.driftTracker.keys().next().value;
        if (firstKey !== undefined) this.driftTracker.delete(firstKey);
        else break;
      }
    }

    if (count >= this.config.maxDriftIterations) {
      return {
        detected: true,
        type: 'drift',
        description: `Tool "${toolName}" called ${count} times with similar but slightly different arguments`,
        advice: `The model is making small adjustments to the same tool call repeatedly. This suggests convergence issues. Consider: (1) using a different strategy entirely, (2) examining intermediate results more carefully before retrying.`,
      };
    }

    return { detected: false };
  }

  /**
   * 获取调试信息
   */
  getDebugInfo() {
    return {
      historyLength: this.historyCount,
      consecutiveSameToolCount: this.consecutiveSameToolCount,
      lastToolName: this.lastToolName,
      driftEntries: Object.fromEntries(this.driftTracker),
    };
  }
}
