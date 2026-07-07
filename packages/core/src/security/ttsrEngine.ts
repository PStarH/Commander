/**
 * TTSR Engine — Time Traveling Streamed Rules.
 *
 * Inspired by OhMyPi's TTSR: rules that remain dormant (costing zero context)
 * until the model's output stream matches a trigger regex, at which point the
 * rule is injected mid-stream and the request retried.
 *
 * Key properties:
 * - Rules are defined with regex triggers + a reminder message
 * - Rules consume zero context tokens until triggered
 * - Each rule fires at most once per session to prevent loops
 * - Injection survives context compaction (persisted in session state)
 * - Supports both blocking (hard block) and advisory (soft reminder) modes
 *
 * Use cases:
 * - "Don't use deprecated APIs" → triggers when model writes deprecated function
 * - "No console.log in production" → triggers when model writes console.log
 * - "Use async/await not .then()" → triggers when model writes .then() chains
 * - "SQL injection prevention" → triggers when model builds SQL via string concat
 * - "Rate limit: max 3 API calls" → triggers when model schedules 4th API call
 */

import { reportSilentFailure } from '../silentFailureReporter';

// ============================================================================
// Types
// ============================================================================

export type TtsrRuleMode = 'block' | 'advisory';

export interface TtsrRule {
  /** Unique identifier for the rule */
  id: string;
  /** Human-readable description */
  description: string;
  /** Regex pattern to trigger the rule on model output */
  trigger: RegExp;
  /** The reminder message injected when triggered */
  message: string;
  /** Block mode: abort the output. Advisory: inject a note and continue. */
  mode: TtsrRuleMode;
  /** Priority — higher priority rules fire first */
  priority?: number;
  /** Whether this rule has been fired in the current session */
  fired?: boolean;
  /** When this rule was last fired (timestamp) */
  lastFiredAt?: number;
  /** Maximum times this rule can fire per session (default: 1) */
  maxFires?: number;
  /** Number of times fired in this session */
  fireCount?: number;
}

export interface TtsrRuleSet {
  name: string;
  description?: string;
  rules: TtsrRule[];
}

export interface TtsrMatchResult {
  rule: TtsrRule;
  /** The matched text that triggered the rule */
  matchedText: string;
  /** The position in the stream where the match occurred */
  matchPosition: number;
}

export interface TtsrSessionState {
  /** Rules that have been triggered in this session */
  triggeredRuleIds: Set<string>;
  /** Per-rule fire counts */
  fireCounts: Map<string, number>;
  /** Total number of injections this session */
  totalInjections: number;
  /** Total context tokens saved by not pre-loading rules */
  estimatedTokensSaved: number;
}

// ============================================================================
// Built-in Rule Sets
// ============================================================================

/**
 * Security-focused rules — prevent common security mistakes.
 */
export const SECURITY_TTSR_RULES: TtsrRule[] = [
  {
    id: 'ttsr:no-hardcoded-secrets',
    description: 'Prevent hardcoded API keys, tokens, or passwords in code',
    trigger: /(?:api[_-]?key|secret[_-]?key|password|token)\s*[=:]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
    message:
      'SECURITY: Do not hardcode secrets, API keys, or passwords. Use environment variables (process.env.X) or a secrets manager. The value you just wrote looks like a credential.',
    mode: 'block',
    priority: 100,
  },
  {
    id: 'ttsr:no-sql-injection',
    description: 'Prevent SQL injection via string concatenation',
    trigger: /(?:execute|query|run)\s*\(\s*(?:["'`]|`\s*\+)/i,
    message:
      'SECURITY: Potential SQL injection. Use parameterized queries with placeholders ($1, ?) instead of string concatenation. String-built SQL queries are a major security risk.',
    mode: 'block',
    priority: 95,
  },
  {
    id: 'ttsr:no-eval',
    description: 'Prevent use of eval() or Function() constructor',
    trigger: /\b(eval|Function)\s*\(/g,
    message:
      'SECURITY: Avoid eval() and Function() constructor — they enable arbitrary code execution. Use JSON.parse() for data parsing or a proper parser.',
    mode: 'block',
    priority: 90,
  },
  {
    id: 'ttsr:no-innerhtml',
    description: 'Prevent XSS via innerHTML',
    trigger: /\.innerHTML\s*=/g,
    message:
      'SECURITY: Avoid innerHTML — it enables XSS attacks. Use textContent for text, or createElement/appendChild for DOM construction. If you must use innerHTML, sanitize the input first.',
    mode: 'advisory',
    priority: 80,
  },
  {
    id: 'ttsr:no-unsafe-regex',
    description: 'Prevent ReDoS via unsafe regex patterns',
    trigger: /new\s+RegExp\s*\(\s*["'][^"']*\(\?[^"']*\+[^"']*\)[^"']*["']/g,
    message:
      'SECURITY: This regex pattern may be vulnerable to ReDoS (Regular Expression Denial of Service). Avoid nested quantifiers like (a+)+. Use atomic groups or test with a timeout.',
    mode: 'advisory',
    priority: 70,
  },
];

/**
 * Code quality rules — enforce best practices.
 */
export const QUALITY_TTSR_RULES: TtsrRule[] = [
  {
    id: 'ttsr:no-console-log',
    description: 'Prevent console.log in production code',
    trigger: /\bconsole\.(log|debug|warn)\s*\(/g,
    message:
      'CODE QUALITY: Avoid console.log/debug/warn in production code. Use a proper logging library (winston, pino, etc.) or structured logging. Only use console.error for critical errors.',
    mode: 'advisory',
    priority: 50,
  },
  {
    id: 'ttsr:no-any-type',
    description: 'Prevent use of TypeScript "any" type',
    trigger: /\b(:\s*any|as\s+any)\b(?!\s*\/\/\s*eslint)/g,
    message:
      'CODE QUALITY: Avoid the "any" type in TypeScript — it defeats the purpose of type checking. Use "unknown" for truly unknown values, or define a proper interface/type.',
    mode: 'advisory',
    priority: 40,
  },
  {
    id: 'ttsr:no-todo-without-ticket',
    description: 'Prevent TODO comments without issue references',
    trigger: /\/\/\s*TODO(?!\s*[\(#]\s*\w+[\-/#]\d+)/gi,
    message:
      'CODE QUALITY: TODO comments should reference an issue or ticket number. Format: // TODO(#1234): description. This helps track and prioritize technical debt.',
    mode: 'advisory',
    priority: 30,
  },
  {
    id: 'ttsr:prefer-async-await',
    description: 'Prefer async/await over .then() chains',
    trigger: /\.then\s*\(\s*(?:function|\([^)]*\)\s*=>)/g,
    message:
      'CODE QUALITY: Prefer async/await over .then() chains. async/await produces cleaner, more readable code with better error handling via try/catch.',
    mode: 'advisory',
    priority: 35,
  },
  {
    id: 'ttsr:no-var',
    description: 'Prevent use of "var" keyword',
    trigger: /\bvar\s+\w+\s*=/g,
    message:
      'CODE QUALITY: Use "const" or "let" instead of "var". "var" has function scope and hoisting behavior that leads to bugs. "const" is preferred for immutable bindings.',
    mode: 'advisory',
    priority: 30,
  },
];

/**
 * Commander-specific rules — prevent misuse of the framework.
 */
export const COMMANDER_TTSR_RULES: TtsrRule[] = [
  {
    id: 'ttsr:commander-no-npx',
    description: 'MCP commands must not use npx (blocked by whitelist)',
    trigger: /\bnpx\b/g,
    message:
      'COMMANDER: MCP commands using "npx" are explicitly forbidden by the security whitelist. Use a directly installed tool or a pre-approved command instead.',
    mode: 'block',
    priority: 100,
  },
  {
    id: 'ttsr:commander-sanitize-input',
    description: 'All cross-trust-boundary data must go through UniversalSanitizer',
    trigger: /(?:req\.body|req\.query|req\.params|user\.input|formData\.get)\s*(?!.*sanitize)/gi,
    message:
      'COMMANDER: All cross-trust-boundary data must pass through UniversalSanitizer. Call sanitize(input, context) before using user-supplied data.',
    mode: 'advisory',
    priority: 85,
  },
  {
    id: 'ttsr:commander-use-resource-governor',
    description: 'External calls must use ResourceGovernor for timeout/size caps',
    trigger: /\bfetch\s*\(\s*(?!.*ResourceGovernor)/gi,
    message:
      'COMMANDER: All external calls (fetch, LLM, etc.) must wrap through ResourceGovernor.withTimeout() or .govern() to enforce timeout and size limits.',
    mode: 'advisory',
    priority: 80,
  },
];

/**
 * All built-in rule sets.
 */
export const BUILTIN_TTSR_RULE_SETS: TtsrRuleSet[] = [
  { name: 'security', description: 'Security-focused rules', rules: SECURITY_TTSR_RULES },
  { name: 'quality', description: 'Code quality rules', rules: QUALITY_TTSR_RULES },
  { name: 'commander', description: 'Commander-specific rules', rules: COMMANDER_TTSR_RULES },
];

// ============================================================================
// TTSR Engine
// ============================================================================

export class TtsrEngine {
  private rules: TtsrRule[] = [];
  private sessionState: TtsrSessionState = {
    triggeredRuleIds: new Set(),
    fireCounts: new Map(),
    totalInjections: 0,
    estimatedTokensSaved: 0,
  };

  /**
   * Load rules from one or more rule sets.
   */
  loadRuleSets(...sets: TtsrRuleSet[]): void {
    for (const set of sets) {
      for (const rule of set.rules) {
        this.addRule(rule);
      }
    }
  }

  /**
   * Add a single rule.
   */
  addRule(rule: TtsrRule): void {
    // Reset session state for the rule
    rule.fired = false;
    rule.fireCount = 0;
    this.rules.push(rule);

    // Estimate tokens saved: each rule would cost ~50-200 tokens in the system prompt
    this.sessionState.estimatedTokensSaved += 100;
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /**
   * Load the default built-in rule sets (security + quality + commander).
   */
  loadDefaults(): void {
    this.loadRuleSets(...BUILTIN_TTSR_RULE_SETS);
  }

  /**
   * Check if a text chunk matches any TTSR rules.
   * Returns the first match found (highest priority first), or null.
   * Rules are checked in priority order.
   */
  checkStream(chunk: string, streamPosition: number): TtsrMatchResult | null {
    // Sort by priority (descending) for deterministic matching
    const sorted = [...this.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const rule of sorted) {
      // Skip rules that have exceeded their max fires
      const maxFires = rule.maxFires ?? 1;
      if ((rule.fireCount ?? 0) >= maxFires) continue;

      // Reset regex lastIndex for global regexes
      if (rule.trigger.global) {
        rule.trigger.lastIndex = 0;
      }

      const match = rule.trigger.exec(chunk);
      if (match) {
        return {
          rule,
          matchedText: match[0],
          matchPosition: streamPosition + match.index,
        };
      }
    }

    return null;
  }

  /**
   * Mark a rule as fired (prevent re-triggering).
   * Returns the formatted injection message.
   */
  fireRule(rule: TtsrRule): string {
    rule.fired = true;
    rule.lastFiredAt = Date.now();
    rule.fireCount = (rule.fireCount ?? 0) + 1;

    this.sessionState.triggeredRuleIds.add(rule.id);
    this.sessionState.fireCounts.set(rule.id, rule.fireCount ?? 1);
    this.sessionState.totalInjections++;

    const prefix = rule.mode === 'block' ? '⚠️ BLOCKED' : '💡 REMINDER';
    return `\n\n[${prefix} — TTSR Rule: ${rule.id}]\n${rule.message}\n[End TTSR]\n\n`;
  }

  /**
   * Check if a rule has been triggered in this session.
   */
  wasTriggered(ruleId: string): boolean {
    return this.sessionState.triggeredRuleIds.has(ruleId);
  }

  /**
   * Get all rules (including session state).
   */
  getRules(): ReadonlyArray<Readonly<TtsrRule>> {
    return this.rules;
  }

  /**
   * Get session statistics.
   */
  getSessionState(): Readonly<TtsrSessionState> {
    return {
      triggeredRuleIds: new Set(this.sessionState.triggeredRuleIds),
      fireCounts: new Map(this.sessionState.fireCounts),
      totalInjections: this.sessionState.totalInjections,
      estimatedTokensSaved: this.sessionState.estimatedTokensSaved,
    };
  }

  /**
   * Get a summary of TTSR activity for the session.
   */
  formatSessionSummary(): string {
    const state = this.sessionState;
    if (state.totalInjections === 0) {
      return `TTSR: ${this.rules.length} rules loaded, 0 triggered. ~${state.estimatedTokensSaved} context tokens saved.`;
    }

    const lines: string[] = [
      `TTSR Session: ${this.rules.length} rules loaded, ${state.totalInjections} injection(s)`,
      `Tokens saved: ~${state.estimatedTokensSaved} (rules not pre-loaded in context)`,
      '',
      'Triggered rules:',
    ];

    for (const ruleId of state.triggeredRuleIds) {
      const rule = this.rules.find((r) => r.id === ruleId);
      const count = state.fireCounts.get(ruleId) ?? 0;
      if (rule) {
        lines.push(`  [${rule.mode.toUpperCase()}] ${rule.id}: ${rule.description} (${count}x)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Reset session state (e.g., on new conversation).
   */
  resetSession(): void {
    this.sessionState = {
      triggeredRuleIds: new Set(),
      fireCounts: new Map(),
      totalInjections: 0,
      estimatedTokensSaved: this.sessionState.estimatedTokensSaved,
    };

    for (const rule of this.rules) {
      rule.fired = false;
      rule.fireCount = 0;
    }
  }

  /**
   * Clear all rules and session state.
   */
  reset(): void {
    this.rules = [];
    this.resetSession();
    this.sessionState.estimatedTokensSaved = 0;
  }
}

// ============================================================================
// Stream Interceptor
// ============================================================================

/**
 * TtsrStreamInterceptor — wraps a readable stream and intercepts TTSR matches.
 *
 * When a match is found, the interceptor:
 * 1. Aborts the current stream
 * 2. Returns the TTSR injection message
 * 3. Signals that a retry is needed
 *
 * The caller (LLM provider) should:
 * 1. Check if a retry is needed
 * 2. If so, inject the TTSR message into the conversation
 * 3. Retry the completion request
 */
export interface TtsrInterceptResult {
  /** Whether the stream was intercepted */
  intercepted: boolean;
  /** The accumulated text up to the match point */
  textBeforeMatch: string;
  /** The TTSR injection message */
  injectionMessage: string;
  /** The matched text */
  matchedText: string;
  /** The rule that was triggered */
  ruleId: string;
}

/**
 * Scan streaming text chunks for TTSR matches.
 * Call this on each chunk of the model's output stream.
 *
 * Returns null if no match, or a TtsrInterceptResult if a rule was triggered.
 */
export function scanStreamChunk(
  engine: TtsrEngine,
  chunk: string,
  streamPosition: number,
): TtsrInterceptResult | null {
  const match = engine.checkStream(chunk, streamPosition);
  if (!match) return null;

  const injectionMessage = engine.fireRule(match.rule);

  return {
    intercepted: true,
    textBeforeMatch: chunk.slice(0, match.matchPosition - streamPosition),
    injectionMessage,
    matchedText: match.matchedText,
    ruleId: match.rule.id,
  };
}

// ============================================================================
// Global Singleton
// ============================================================================

let globalTtsrEngine: TtsrEngine | null = null;

export function getTtsrEngine(): TtsrEngine {
  if (!globalTtsrEngine) {
    globalTtsrEngine = new TtsrEngine();
    globalTtsrEngine.loadDefaults();
  }
  return globalTtsrEngine;
}

export function resetTtsrEngine(): void {
  globalTtsrEngine = null;
}
