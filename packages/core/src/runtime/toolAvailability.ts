/**
 * Tool Availability — Boolean Expression System
 *
 * Surpasses OpenClaw's availability expressions by supporting:
 * - Boolean logic: allOf, anyOf, not
 * - Context predicates: budget phase, task type, step number, tool history
 * - Composable expressions: nest conditions arbitrarily
 * - Zero-cost evaluation: pure predicate functions, no LLM calls
 *
 * Used to dynamically filter which tools are available at each step,
 * reducing prompt size and preventing the model from calling tools
 * that aren't appropriate for the current context.
 */

// ============================================================================
// Availability Predicate Types
// ============================================================================

/** Context available for predicate evaluation */
export interface AvailabilityContext {
  /** Current step number (0-indexed) */
  stepNumber: number;
  /** Total steps allowed */
  maxSteps: number;
  /** Token budget phase */
  budgetPhase: 'relaxed' | 'moderate' | 'tight' | 'critical';
  /** Remaining tokens */
  remainingTokens: number;
  /** Detected task type */
  taskType: string;
  /** Tools already used this run */
  toolsUsed: string[];
  /** Tools that errored this run */
  toolsErrored: string[];
  /** Agent ID */
  agentId: string;
  /** Run ID */
  runId: string;
}

/** A predicate that evaluates to true/false given context */
export type AvailabilityPredicate = (ctx: AvailabilityContext) => boolean;

/** An availability expression: either a predicate or a boolean combinator */
export type AvailabilityExpression =
  | { type: 'predicate'; predicate: AvailabilityPredicate; label?: string }
  | { type: 'allOf'; children: AvailabilityExpression[] }
  | { type: 'anyOf'; children: AvailabilityExpression[] }
  | { type: 'not'; child: AvailabilityExpression }
  | { type: 'always' }
  | { type: 'never' };

// ============================================================================
// Tool Availability Rule
// ============================================================================

export interface ToolAvailabilityRule {
  /** Tool name or pattern (supports * wildcard) */
  toolPattern: string;
  /** Availability expression */
  when: AvailabilityExpression;
  /** Priority (higher = checked first, allows override) */
  priority: number;
  /** Human-readable reason (for debugging/tracing) */
  reason?: string;
}

// ============================================================================
// Built-in Predicates
// ============================================================================

/** Tool is available only in early steps */
export function earlySteps(maxStep: number): AvailabilityExpression {
  return {
    type: 'predicate',
    predicate: (ctx) => ctx.stepNumber < maxStep,
    label: `step < ${maxStep}`,
  };
}

/** Tool is available only when budget is relaxed */
export function budgetRelaxed(): AvailabilityExpression {
  return {
    type: 'predicate',
    predicate: (ctx) => ctx.budgetPhase === 'relaxed',
    label: 'budget:relaxed',
  };
}

/** Tool is available when budget is not critical */
export function budgetNotCritical(): AvailabilityExpression {
  return {
    type: 'predicate',
    predicate: (ctx) => ctx.budgetPhase !== 'critical',
    label: 'budget:not_critical',
  };
}

/** Tool is available for specific task types */
export function taskType(...types: string[]): AvailabilityExpression {
  const typeSet = new Set(types);
  return {
    type: 'predicate',
    predicate: (ctx) => typeSet.has(ctx.taskType),
    label: `taskType:${types.join('|')}`,
  };
}

/** Tool is available only if not already used */
export function notYetUsed(): AvailabilityExpression {
  return {
    type: 'predicate',
    predicate: (ctx) => ctx.toolsUsed.length === 0,
    label: 'notYetUsed',
  };
}

/** Tool is available only if another tool was used first */
export function requiresTool(toolName: string): AvailabilityExpression {
  return {
    type: 'predicate',
    predicate: (ctx) => ctx.toolsUsed.includes(toolName),
    label: `requires:${toolName}`,
  };
}

/** Tool is disabled if it has errored too many times */
export function maxErrors(maxCount: number): AvailabilityExpression {
  return {
    type: 'predicate',
    predicate: (ctx) => {
      const target = ctx.toolsUsed[ctx.toolsUsed.length - 1];
      let errorCount = 0;
      for (const t of ctx.toolsErrored) {
        if (t === target) errorCount++;
      }
      return errorCount < maxCount;
    },
    label: `errors < ${maxCount}`,
  };
}

// ============================================================================
// Combinators
// ============================================================================

/** All children must be true */
export function allOf(...children: AvailabilityExpression[]): AvailabilityExpression {
  return { type: 'allOf', children };
}

/** At least one child must be true */
export function anyOf(...children: AvailabilityExpression[]): AvailabilityExpression {
  return { type: 'anyOf', children };
}

/** Negate a child expression */
export function not(child: AvailabilityExpression): AvailabilityExpression {
  return { type: 'not', child };
}

/** Always available */
export function always(): AvailabilityExpression {
  return { type: 'always' };
}

/** Never available */
export function never(): AvailabilityExpression {
  return { type: 'never' };
}

// ============================================================================
// Evaluator
// ============================================================================

/**
 * Evaluate an availability expression against a context.
 */
export function evaluate(expr: AvailabilityExpression, ctx: AvailabilityContext): boolean {
  switch (expr.type) {
    case 'predicate':
      return expr.predicate(ctx);
    case 'allOf':
      return expr.children.every(child => evaluate(child, ctx));
    case 'anyOf':
      return expr.children.some(child => evaluate(child, ctx));
    case 'not':
      return !evaluate(expr.child, ctx);
    case 'always':
      return true;
    case 'never':
      return false;
  }
}

// ============================================================================
// Tool Availability Manager
// ============================================================================

export class ToolAvailabilityManager {
  private rules: ToolAvailabilityRule[] = [];

  /**
   * Add an availability rule.
   * Uses insertion sort (O(N)) instead of full sort (O(N log N)).
   */
  addRule(rule: ToolAvailabilityRule): void {
    let insertIdx = this.rules.length;
    for (let i = 0; i < this.rules.length; i++) {
      if (rule.priority > this.rules[i].priority) {
        insertIdx = i;
        break;
      }
    }
    this.rules.splice(insertIdx, 0, rule);
  }

  /**
   * Add multiple rules at once.
   * Sorts once after all inserts instead of per-insert.
   */
  addRules(rules: ToolAvailabilityRule[]): void {
    for (const rule of rules) {
      this.rules.push(rule);
    }
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Filter a list of tool names based on availability rules.
   * Returns only tools that pass all matching rules.
   */
  filterTools(availableTools: string[], ctx: AvailabilityContext): string[] {
    return availableTools.filter(toolName => this.isAvailable(toolName, ctx));
  }

  /**
   * Check if a specific tool is available.
   */
  isAvailable(toolName: string, ctx: AvailabilityContext): boolean {
    // Default: available unless a rule says otherwise
    let available = true;

    for (const rule of this.rules) {
      if (!this.matchesPattern(toolName, rule.toolPattern)) continue;

      const result = evaluate(rule.when, ctx);
      if (!result) {
        available = false;
        break; // Highest priority rule that matches and fails → unavailable
      }
    }

    return available;
  }

  /**
   * Get availability status for all tools (for debugging/tracing).
   */
  getStatus(
    availableTools: string[],
    ctx: AvailabilityContext,
  ): Array<{ tool: string; available: boolean; reason?: string }> {
    return availableTools.map(toolName => {
      for (const rule of this.rules) {
        if (!this.matchesPattern(toolName, rule.toolPattern)) continue;
        const result = evaluate(rule.when, ctx);
        if (!result) {
          return { tool: toolName, available: false, reason: rule.reason };
        }
      }
      return { tool: toolName, available: true };
    });
  }

  /**
   * Clear all rules.
   */
  clearRules(): void {
    this.rules = [];
  }

  /**
   * Get rule count.
   */
  getRuleCount(): number {
    return this.rules.length;
  }

  /**
   * Match tool name against pattern. Supports * wildcard.
   */
  private matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      return toolName.startsWith(pattern.slice(0, -1));
    }
    if (pattern.startsWith('*')) {
      return toolName.endsWith(pattern.slice(1));
    }
    return toolName === pattern;
  }
}

// ============================================================================
// Default Rules
// ============================================================================

/**
 * Default availability rules that apply sensible defaults.
 * Users can override or extend these.
 */
export function createDefaultRules(): ToolAvailabilityRule[] {
  return [
    // Expensive tools only in early steps
    {
      toolPattern: 'agent',
      when: earlySteps(10),
      priority: 10,
      reason: 'Sub-agent spawning only in early steps',
    },
    // Write tools disabled under critical budget
    {
      toolPattern: 'file_write',
      when: budgetNotCritical(),
      priority: 5,
      reason: 'File writes disabled under critical budget',
    },
    {
      toolPattern: 'file_edit',
      when: budgetNotCritical(),
      priority: 5,
      reason: 'File edits disabled under critical budget',
    },
  ];
}
