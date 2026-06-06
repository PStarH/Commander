/**
 * Time-Traveling Stream Rules (TTSR) — catch model mistakes mid-stream.
 *
 * Inspired by oh-my-pi's TTSR system. Rules are dormant until their regex
 * condition matches the model's streaming output. When triggered:
 * 1. The stream is aborted
 * 2. The rule is injected as a system message
 * 3. The request is retried from the same point
 *
 * Key insight: rules that never fire cost zero context tokens.
 * Only triggered rules are injected, and only when needed.
 *
 * Usage:
 *   const ttsr = new TtsrManager();
 *   ttsr.addRule({
 *     name: 'no-box-leak',
 *     condition: ['Box::leak'],
 *     content: 'Do not use Box::leak in production code. Use Arc<str> instead.',
 *     scope: ['text'],
 *   });
 *   // During streaming, check each chunk:
 *   const matches = ttsr.checkDelta(textChunk, { source: 'text' });
 *   if (matches.length > 0) { abortAndRetry(matches); }
 */

// ============================================================================
// Types
// ============================================================================

export type TtsrMatchSource = 'text' | 'thinking' | 'tool';

export interface TtsrMatchContext {
  source: TtsrMatchSource;
  /** Tool name for tool argument deltas, e.g. "edit" or "bash" */
  toolName?: string;
  /** Candidate file paths associated with the current stream chunk */
  filePaths?: string[];
  /** Stable key to isolate buffering (e.g., a tool call ID) */
  streamKey?: string;
}

export interface TtsrRule {
  /** Unique rule name */
  name: string;
  /** Regex patterns that trigger the rule when matched against streaming output */
  condition: string[];
  /** Rule content injected as system reminder when triggered */
  content: string;
  /** Scope: which stream sources to monitor (default: ['text']) */
  scope?: TtsrMatchSource[];
  /** File path globs for additional filtering */
  globs?: string[];
  /** Repeat mode: 'once' (default) or 'after-gap' */
  repeatMode?: 'once' | 'after-gap';
  /** Minimum turns between re-triggers (for 'after-gap' mode, default: 10) */
  repeatGap?: number;
  /** If true, abort stream on match. If false, inject after completion. Default: true */
  interrupt?: boolean;
}

export interface TtsrSettings {
  enabled?: boolean;
  /** What to do with partial output on interrupt: 'discard' or 'keep'. Default: 'discard' */
  contextMode?: 'discard' | 'keep';
  /** Default repeat mode for rules without explicit setting */
  repeatMode?: 'once' | 'after-gap';
  /** Default gap for 'after-gap' repeat mode */
  repeatGap?: number;
}

interface TtsrEntry {
  rule: TtsrRule;
  conditions: RegExp[];
  scope: Set<TtsrMatchSource>;
}

interface InjectionRecord {
  lastInjectedAt: number;
}

// ============================================================================
// TTSR Manager
// ============================================================================

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
  enabled: true,
  contextMode: 'discard',
  repeatMode: 'once',
  repeatGap: 10,
};

export class TtsrManager {
  readonly #settings: Required<TtsrSettings>;
  readonly #rules = new Map<string, TtsrEntry>();
  readonly #injectionRecords = new Map<string, InjectionRecord>();
  readonly #buffers = new Map<string, string>();
  #messageCount = 0;

  constructor(settings?: TtsrSettings) {
    this.#settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  // ── Rule Management ──

  /**
   * Add a TTSR rule. Returns true if added, false if duplicate name.
   */
  addRule(rule: TtsrRule): boolean {
    if (this.#rules.has(rule.name)) return false;

    const compiled = this.#compileConditions(rule);
    if (compiled.length === 0) return false;

    const scope = new Set<TtsrMatchSource>(rule.scope ?? ['text']);

    this.#rules.set(rule.name, {
      rule,
      conditions: compiled,
      scope,
    });
    return true;
  }

  /**
   * Remove a rule by name.
   */
  removeRule(name: string): boolean {
    return this.#rules.delete(name);
  }

  /**
   * Get all registered rule names.
   */
  getRuleNames(): string[] {
    return Array.from(this.#rules.keys());
  }

  /**
   * Check if a rule is registered.
   */
  hasRule(name: string): boolean {
    return this.#rules.has(name);
  }

  // ── Stream Monitoring ──

  /**
   * Reset buffers at the start of a new turn.
   */
  resetBuffer(): void {
    this.#buffers.clear();
  }

  /**
   * Increment message count at turn end.
   */
  onTurnEnd(): void {
    this.#messageCount++;
  }

  /**
   * Check a streaming delta against all registered rules.
   * Returns matching rules that are eligible for injection.
   */
  checkDelta(delta: string, context: TtsrMatchContext): TtsrRule[] {
    if (!this.#settings.enabled) return [];
    if (this.#rules.size === 0) return [];

    // Buffer the delta for pattern matching
    const key = this.#bufferKey(context);
    const existing = this.#buffers.get(key) ?? '';
    const buffered = existing + delta;
    this.#buffers.set(key, buffered);

    // Check all rules
    const matches: TtsrRule[] = [];

    for (const [, entry] of this.#rules) {
      // Check scope
      if (!entry.scope.has(context.source)) continue;

      // Check file path globs
      if (entry.rule.globs && entry.rule.globs.length > 0) {
        if (!context.filePaths || context.filePaths.length === 0) continue;
        const hasMatch = entry.rule.globs.some(glob =>
          context.filePaths!.some(fp => this.#matchGlob(fp, glob))
        );
        if (!hasMatch) continue;
      }

      // Check conditions against buffered content
      const triggered = entry.conditions.some(cond => {
        cond.lastIndex = 0;
        return cond.test(buffered);
      });

      if (!triggered) continue;

      // Check repeat policy
      if (!this.#canTrigger(entry.rule.name, entry.rule)) continue;

      matches.push(entry.rule);
    }

    return matches;
  }

  /**
   * Mark rules as injected (for repeat policy tracking).
   */
  markInjected(ruleNames: string[]): void {
    for (const name of ruleNames) {
      this.#injectionRecords.set(name, { lastInjectedAt: this.#messageCount });
    }
  }

  /**
   * Restore injection records (e.g., from persisted session).
   */
  restoreInjected(ruleNames: string[]): void {
    for (const name of ruleNames) {
      this.#injectionRecords.set(name, { lastInjectedAt: this.#messageCount });
    }
  }

  /**
   * Get names of all injected rules.
   */
  getInjectedRules(): string[] {
    return Array.from(this.#injectionRecords.keys());
  }

  /**
   * Get the settings.
   */
  getSettings(): Required<TtsrSettings> {
    return { ...this.#settings };
  }

  // ── Internal ──

  #compileConditions(rule: TtsrRule): RegExp[] {
    const compiled: RegExp[] = [];
    for (const pattern of rule.condition ?? []) {
      try {
        compiled.push(new RegExp(pattern, 'g'));
      } catch {
        // Invalid regex — skip this condition
      }
    }
    return compiled;
  }

  #bufferKey(context: TtsrMatchContext): string {
    if (context.streamKey) return context.streamKey;
    if (context.source !== 'tool') return context.source;
    return context.toolName ? `tool:${context.toolName}` : 'tool';
  }

  #canTrigger(ruleName: string, rule: TtsrRule): boolean {
    const record = this.#injectionRecords.get(ruleName);
    if (!record) return true;

    const repeatMode = rule.repeatMode ?? this.#settings.repeatMode;
    if (repeatMode === 'once') return false;

    const gap = rule.repeatGap ?? this.#settings.repeatGap;
    return (this.#messageCount - record.lastInjectedAt) >= gap;
  }

  #matchGlob(filePath: string, glob: string): boolean {
    // Simple glob matching: * matches any chars, ** matches any path
    const normalized = filePath.replace(/\\/g, '/');
    const normalizedGlob = glob.replace(/\\/g, '/');

    // Convert glob to regex
    const regexStr = normalizedGlob
      .replace(/\*\*/g, '{{DOUBLESTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\{\{DOUBLESTAR\}\}/g, '.*');

    try {
      return new RegExp(`^${regexStr}$`).test(normalized);
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Injection Content Builder
// ============================================================================

/**
 * Build the injection content for triggered rules.
 * Returns a system-interrupt message that will be injected into the conversation.
 */
export function buildTtsrInjection(rules: TtsrRule[]): string {
  const parts: string[] = [];

  for (const rule of rules) {
    parts.push(`<system-interrupt reason="rule_violation" rule="${rule.name}">`);
    parts.push(rule.content);
    parts.push(`</system-interrupt>`);
    parts.push('');
  }

  return parts.join('\n').trim();
}

/**
 * Build a tool-reminder injection for non-interrupting tool-source rules.
 */
export function buildTtsrToolReminder(rules: TtsrRule[]): string {
  const parts: string[] = [];

  for (const rule of rules) {
    parts.push(`<system-reminder reason="rule_violation" rule="${rule.name}">`);
    parts.push(rule.content);
    parts.push(`</system-reminder>`);
  }

  return parts.join('\n').trim();
}

// ============================================================================
// Global singleton
// ============================================================================

let globalTtsrManager: TtsrManager | null = null;

export function getTtsrManager(): TtsrManager {
  if (!globalTtsrManager) {
    globalTtsrManager = new TtsrManager();
  }
  return globalTtsrManager;
}

export function resetTtsrManager(): void {
  globalTtsrManager = null;
}
