"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolAvailabilityManager = void 0;
exports.earlySteps = earlySteps;
exports.budgetRelaxed = budgetRelaxed;
exports.budgetNotCritical = budgetNotCritical;
exports.taskType = taskType;
exports.notYetUsed = notYetUsed;
exports.requiresTool = requiresTool;
exports.maxErrors = maxErrors;
exports.allOf = allOf;
exports.anyOf = anyOf;
exports.not = not;
exports.always = always;
exports.never = never;
exports.evaluate = evaluate;
exports.createDefaultRules = createDefaultRules;
// ============================================================================
// Built-in Predicates
// ============================================================================
/** Tool is available only in early steps */
function earlySteps(maxStep) {
    return {
        type: 'predicate',
        predicate: (ctx) => ctx.stepNumber < maxStep,
        label: `step < ${maxStep}`,
    };
}
/** Tool is available only when budget is relaxed */
function budgetRelaxed() {
    return {
        type: 'predicate',
        predicate: (ctx) => ctx.budgetPhase === 'relaxed',
        label: 'budget:relaxed',
    };
}
/** Tool is available when budget is not critical */
function budgetNotCritical() {
    return {
        type: 'predicate',
        predicate: (ctx) => ctx.budgetPhase !== 'critical',
        label: 'budget:not_critical',
    };
}
/** Tool is available for specific task types */
function taskType(...types) {
    const typeSet = new Set(types);
    return {
        type: 'predicate',
        predicate: (ctx) => typeSet.has(ctx.taskType),
        label: `taskType:${types.join('|')}`,
    };
}
/** Tool is available only if not already used */
function notYetUsed() {
    return {
        type: 'predicate',
        predicate: (ctx) => ctx.toolsUsed.length === 0,
        label: 'notYetUsed',
    };
}
/** Tool is available only if another tool was used first */
function requiresTool(toolName) {
    return {
        type: 'predicate',
        predicate: (ctx) => ctx.toolsUsed.includes(toolName),
        label: `requires:${toolName}`,
    };
}
/** Tool is disabled if it has errored too many times */
function maxErrors(maxCount) {
    return {
        type: 'predicate',
        predicate: (ctx) => {
            const target = ctx.toolsUsed[ctx.toolsUsed.length - 1];
            let errorCount = 0;
            for (const t of ctx.toolsErrored) {
                if (t === target)
                    errorCount++;
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
function allOf(...children) {
    return { type: 'allOf', children };
}
/** At least one child must be true */
function anyOf(...children) {
    return { type: 'anyOf', children };
}
/** Negate a child expression */
function not(child) {
    return { type: 'not', child };
}
/** Always available */
function always() {
    return { type: 'always' };
}
/** Never available */
function never() {
    return { type: 'never' };
}
// ============================================================================
// Evaluator
// ============================================================================
/**
 * Evaluate an availability expression against a context.
 */
function evaluate(expr, ctx) {
    switch (expr.type) {
        case 'predicate':
            return expr.predicate(ctx);
        case 'allOf':
            return expr.children.every((child) => evaluate(child, ctx));
        case 'anyOf':
            return expr.children.some((child) => evaluate(child, ctx));
        case 'not':
            return !evaluate(expr.child, ctx);
        case 'always':
            return true;
        case 'never':
            return false;
        default:
            return false;
    }
}
// ============================================================================
// Tool Availability Manager
// ============================================================================
class ToolAvailabilityManager {
    constructor() {
        this.rules = [];
    }
    /**
     * Add an availability rule.
     * Uses insertion sort (O(N)) instead of full sort (O(N log N)).
     */
    addRule(rule) {
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
    addRules(rules) {
        for (const rule of rules) {
            this.rules.push(rule);
        }
        this.rules.sort((a, b) => b.priority - a.priority);
    }
    /**
     * Filter a list of tool names based on availability rules.
     * Returns only tools that pass all matching rules.
     */
    filterTools(availableTools, ctx) {
        return availableTools.filter((toolName) => this.isAvailable(toolName, ctx));
    }
    /**
     * Check if a specific tool is available.
     */
    isAvailable(toolName, ctx) {
        // Default: available unless a rule says otherwise
        let available = true;
        for (const rule of this.rules) {
            if (!this.matchesPattern(toolName, rule.toolPattern))
                continue;
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
    getStatus(availableTools, ctx) {
        return availableTools.map((toolName) => {
            for (const rule of this.rules) {
                if (!this.matchesPattern(toolName, rule.toolPattern))
                    continue;
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
    clearRules() {
        this.rules = [];
    }
    /**
     * Get rule count.
     */
    getRuleCount() {
        return this.rules.length;
    }
    /**
     * Match tool name against pattern. Supports * wildcard.
     */
    matchesPattern(toolName, pattern) {
        if (pattern === '*')
            return true;
        if (pattern.endsWith('*')) {
            return toolName.startsWith(pattern.slice(0, -1));
        }
        if (pattern.startsWith('*')) {
            return toolName.endsWith(pattern.slice(1));
        }
        return toolName === pattern;
    }
}
exports.ToolAvailabilityManager = ToolAvailabilityManager;
// ============================================================================
// Default Rules
// ============================================================================
/**
 * Default availability rules that apply sensible defaults.
 * Users can override or extend these.
 */
function createDefaultRules() {
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
