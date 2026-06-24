/**
 * Reflexion Generator — Structured self-reflection for failed actions.
 *
 * Based on Reflexion (Shinn et al., NeurIPS 2023): after a failure, generate a
 * structured reflection (what failed, why, what to try next) and inject it into
 * the next attempt's context. The paper's ablation shows +8% absolute improvement
 * on HumanEval over raw retry — the highest-leverage self-improvement technique
 * available without model retraining.
 *
 * Strategy: heuristic-first, LLM-fallback. Most errors are common patterns
 * (timeout, not found, permission) that don't need an LLM call. Only novel or
 * ambiguous errors trigger an LLM call. LLM calls are bounded (200 tokens,
 * 10s timeout) to control cost.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import type { LLMProvider } from './types';
import type { ErrorClass } from './llmRetry';
import { getGlobalLogger } from '../logging';

export interface ReflexionContext {
  /** Original user goal this action is part of. */
  goal: string;
  /** Human-readable description of what was attempted (e.g., tool name + args). */
  attemptedAction: string;
  /** The result/output that was returned before the error (if any). */
  actionResult: string;
  /** The error message. */
  error: string;
  /** Classified error class. */
  errorClass: ErrorClass;
  /** Which retry attempt this is (1-indexed). */
  attemptNumber: number;
  /** Previous reflexions for this action (so the next attempt avoids repeating them). */
  previousReflexions?: ReadonlyArray<Reflexion>;
}

export interface Reflexion {
  /** One sentence: what specifically went wrong. */
  whatFailed: string;
  /** One sentence: the likely root cause. */
  whyFailed: string;
  /** One sentence: a concrete, different approach to try next. */
  whatToTryNext: string;
  /** Confidence in this reflexion (0-1). */
  confidence: number;
  /** Whether this came from a heuristic pattern or an LLM call. */
  source: 'heuristic' | 'llm';
  /** Optional raw LLM output for debugging. */
  raw?: string;
}

interface HeuristicPattern {
  match: (ctx: ReflexionContext) => boolean;
  reflect: (
    ctx: ReflexionContext,
  ) => Pick<Reflexion, 'whatFailed' | 'whyFailed' | 'whatToTryNext' | 'confidence'>;
}

/**
 * Order matters: first match wins. Each pattern targets a specific, common
 * error class with actionable advice. Keep this list ordered by frequency
 * (most common patterns first to short-circuit LLM cost).
 */
const HEURISTIC_PATTERNS: ReadonlyArray<HeuristicPattern> = [
  {
    match: (ctx) =>
      /timeout|timed\s*out|TOOL_TIMEOUT|ETIMEDOUT|exceeded\s+\d+\s*ms/i.test(ctx.error),
    reflect: (ctx) => ({
      whatFailed: `Action exceeded its time budget (${ctx.attemptedAction})`,
      whyFailed: `The operation was too slow to complete in the allotted time. Common causes: large input, slow downstream service, or infinite loop.`,
      whatToTryNext: `Break the operation into smaller parts, increase the timeout, or process the data in batches. If it's a query, narrow the filter.`,
      confidence: 0.85,
    }),
  },
  {
    match: (ctx) =>
      /\b(ENOENT|not\s+found|does\s+not\s+exist|no\s+such\s+file|cannot\s+find|missing)\b/i.test(
        ctx.error,
      ),
    reflect: (ctx) => ({
      whatFailed: `Resource referenced in the action was not found`,
      whyFailed: `The path or identifier is incorrect, the resource was deleted, or the action is looking in the wrong location.`,
      whatToTryNext: `Verify the path/identifier exists first using a search or list tool. Check for typos and case sensitivity. If the path is relative, confirm the working directory.`,
      confidence: 0.9,
    }),
  },
  {
    match: (ctx) =>
      /\b(EACCES|permission\s+denied|forbidden|unauthorized|401|403|insufficient\s+permissions)\b/i.test(
        ctx.error,
      ),
    reflect: (ctx) => ({
      whatFailed: `Action was denied due to permissions`,
      whyFailed: `The agent or user does not have the required permissions to perform this action.`,
      whatToTryNext: `Check the permission requirements for this resource. If running in a sandbox, verify the file/network is allowed. For tools, check the approval policy.`,
      confidence: 0.9,
    }),
  },
  {
    match: (ctx) => /\b(429|rate\s*limit|too\s+many\s+requests|throttl)/i.test(ctx.error),
    reflect: (ctx) => ({
      whatFailed: `External service rate-limited the request`,
      whyFailed: `Too many requests were sent in a short period, exceeding the service's quota.`,
      whatToTryNext: `Wait before retrying (use exponential backoff). Reduce request frequency, batch operations, or use cached results if available.`,
      confidence: 0.95,
    }),
  },
  {
    match: (ctx) =>
      /\b(invalid\s+(argument|param|input|format)|validation\s+failed|missing\s+required|required\s+field|schema\s+validation)\b/i.test(
        ctx.error,
      ),
    reflect: (ctx) => ({
      whatFailed: `Input failed validation`,
      whyFailed: `One or more arguments do not match the expected format, type, or required schema.`,
      whatToTryNext: `Re-read the tool's schema or documentation. Check argument types, required fields, and value ranges. Common culprits: wrong types (string vs number), missing required fields, enum values.`,
      confidence: 0.85,
    }),
  },
  {
    match: (ctx) =>
      /\b(TypeError|cannot\s+read\s+(property|properties)|is\s+not\s+a\s+function|undefined\s+is\s+not|null\s+is\s+not)\b/i.test(
        ctx.error,
      ),
    reflect: (ctx) => ({
      whatFailed: `Code threw a type error (likely null/undefined access)`,
      whyFailed: `A value was assumed to be present but was null/undefined, or a function was called on the wrong type.`,
      whatToTryNext: `Add null checks before accessing properties. Verify the value exists before calling methods on it. Inspect the actual data shape returned by the previous step.`,
      confidence: 0.8,
    }),
  },
  {
    match: (ctx) =>
      /\b(SyntaxError|Unexpected\s+token|JSON\.parse|invalid\s+JSON|unexpected\s+end\s+of\s+JSON|malformed)\b/i.test(
        ctx.error,
      ),
    reflect: (ctx) => ({
      whatFailed: `Failed to parse input (likely JSON, code, or structured data)`,
      whyFailed: `The input was not valid for the parser — likely truncated, malformed, or contains unexpected characters.`,
      whatToTryNext: `Inspect the raw input before parsing. Check for truncation (long outputs may be cut off), trailing commas, or escape characters. Try a more lenient parser or pre-process to clean the input.`,
      confidence: 0.8,
    }),
  },
  {
    match: (ctx) =>
      /\b(ECONNREFUSED|ENETUNREACH|ECONNRESET|EHOSTUNREACH|network\s+error|fetch\s+failed|getaddrinfo|socket\s+hang\s+up)\b/i.test(
        ctx.error,
      ),
    reflect: (ctx) => ({
      whatFailed: `Network request failed`,
      whyFailed: `Could not establish or maintain a connection to the target host. Common causes: host is down, DNS failure, firewall, or proxy issues.`,
      whatToTryNext: `Verify the host is reachable. Check the URL for typos. If behind a proxy or VPN, verify the network path. Try a known-good endpoint as a connectivity test.`,
      confidence: 0.8,
    }),
  },
  {
    match: (ctx) =>
      /\b(409|conflict|already\s+exists|duplicate\s+key|UNIQUE\s+constraint)\b/i.test(ctx.error),
    reflect: (ctx) => ({
      whatFailed: `Conflict: the resource already exists or state is incompatible`,
      whyFailed: `An attempt to create a new resource collided with an existing one, or the system is in an incompatible state.`,
      whatToTryNext: `Check if the resource exists first. If it does, decide whether to update vs. fail. For state conflicts, query the current state before retrying.`,
      confidence: 0.85,
    }),
  },
  {
    match: (ctx) =>
      /\b(ENOSPC|out\s+of\s+(memory|disk|space)|heap\s+space|allocation\s+failed|memory\s+exhausted)\b/i.test(
        ctx.error,
      ),
    reflect: (ctx) => ({
      whatFailed: `Ran out of memory, disk, or other resource`,
      whyFailed: `The operation required more resources than were available.`,
      whatToTryNext: `Process the data in smaller batches. Free up memory by streaming instead of loading. For disk, check available space and clean up temp files.`,
      confidence: 0.85,
    }),
  },
  {
    match: (ctx) =>
      /\b(circuit\s+breaker|circuit\s+is\s+open|service\s+unavailable|503)\b/i.test(ctx.error),
    reflect: (ctx) => ({
      whatFailed: `Service or circuit breaker is unavailable`,
      whyFailed: `The downstream service is failing repeatedly, so requests are being blocked to prevent cascading failures.`,
      whatToTryNext: `Wait for the circuit to reset, then retry. If the service is critical, use a fallback path or cached data. Consider switching to a different provider.`,
      confidence: 0.9,
    }),
  },
];

export interface ReflexionGeneratorOptions {
  /** Max tokens for LLM-generated reflexion. Default: 200. */
  maxReflexionTokens?: number;
  /** Timeout for LLM call in ms. Default: 10000. */
  llmTimeoutMs?: number;
  /** When true, always use heuristic (skip LLM). */
  heuristicOnly?: boolean;
  /** When true, always use LLM (skip heuristic). */
  llmOnly?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<ReflexionGeneratorOptions, 'heuristicOnly' | 'llmOnly'>> = {
  maxReflexionTokens: 200,
  llmTimeoutMs: 10000,
};

/**
 * Generates structured reflexions for failed actions.
 *
 * Always returns a usable reflexion — even when no LLM is available and no
 * pattern matches, a generic low-confidence reflexion is returned.
 */
export class ReflexionGenerator {
  public readonly stats = {
    heuristicHits: 0,
    llmCalls: 0,
    llmFailures: 0,
    genericFallbacks: 0,
  };

  private readonly llmProvider: LLMProvider | undefined;
  private readonly options: Required<Omit<ReflexionGeneratorOptions, 'heuristicOnly' | 'llmOnly'>> &
    ReflexionGeneratorOptions;

  constructor(llmProvider?: LLMProvider, options?: ReflexionGeneratorOptions) {
    this.llmProvider = llmProvider;
    this.options = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  }

  /**
   * Generate a reflexion for the given context. Always returns a usable
   * reflexion (never throws). On error, falls back to generic heuristic.
   */
  async generate(ctx: ReflexionContext): Promise<Reflexion> {
    if (!this.options.llmOnly) {
      const heuristic = this.tryHeuristic(ctx);
      if (heuristic) {
        this.stats.heuristicHits++;
        return { ...heuristic, source: 'heuristic' };
      }
    }

    if (!this.options.heuristicOnly && this.llmProvider) {
      this.stats.llmCalls++;
      try {
        return await this.generateWithLLM(ctx);
      } catch (e) {
        this.stats.llmFailures++;
        getGlobalLogger().debug(
          'ReflexionGenerator',
          'LLM reflexion failed, using generic fallback',
          {
            error: e instanceof Error ? e.message : 'unknown',
          },
        );
      }
    }

    this.stats.genericFallbacks++;
    return {
      whatFailed: `Action failed: ${truncate(ctx.error, 100)}`,
      whyFailed: `Error class: ${ctx.errorClass}. No specific pattern matched and LLM reflexion was unavailable.`,
      whatToTryNext: `Re-read the error message carefully. Consider what assumption may have been wrong and try a fundamentally different approach.`,
      confidence: 0.3,
      source: 'heuristic',
    };
  }

  private tryHeuristic(ctx: ReflexionContext): Omit<Reflexion, 'source'> | null {
    for (const pattern of HEURISTIC_PATTERNS) {
      if (pattern.match(ctx)) {
        return pattern.reflect(ctx);
      }
    }
    return null;
  }

  private async generateWithLLM(ctx: ReflexionContext): Promise<Reflexion> {
    const prompt = this.buildPrompt(ctx);
    const raw = await this.callLLMWithTimeout(prompt, this.options.llmTimeoutMs);
    return this.parseReflexion(raw, ctx);
  }

  private buildPrompt(ctx: ReflexionContext): string {
    const previousStrategies =
      ctx.previousReflexions && ctx.previousReflexions.length > 0
        ? `\nPREVIOUS REFLEXIONS (do NOT repeat these strategies — try a fundamentally different approach):\n${ctx.previousReflexions
            .map((r, i) => `  Attempt ${i + 1}: ${r.whatToTryNext}`)
            .join('\n')}\n`
        : '';

    return `You are analyzing a failed action in an autonomous agent. Produce a concise self-reflection.

GOAL: ${truncate(ctx.goal, 300)}
ATTEMPT #${ctx.attemptNumber}: ${truncate(ctx.attemptedAction, 200)}
RESULT: ${truncate(ctx.actionResult, 400)}
ERROR (${ctx.errorClass}): ${truncate(ctx.error, 400)}${previousStrategies}

Output ONLY a JSON object with exactly three fields (no other text, no markdown):
{
  "whatFailed": "<one sentence: what specifically went wrong>",
  "whyFailed": "<one sentence: likely root cause>",
  "whatToTryNext": "<one sentence: a concrete, DIFFERENT approach>"
}

Be specific. Avoid generic advice like "try again" or "be more careful".`;
  }

  private async callLLMWithTimeout(prompt: string, timeoutMs: number): Promise<string> {
    if (!this.llmProvider) {
      throw new Error('No LLM provider configured');
    }

    const model = resolveDefaultModel(this.llmProvider);
    const request = {
      model,
      messages: [{ role: 'user' as const, content: prompt }],
      maxTokens: this.options.maxReflexionTokens,
      temperature: 0.2,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Reflexion LLM call timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const response = await Promise.race([this.llmProvider.call(request), timeoutPromise]);
      return response.content || '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseReflexion(raw: string, ctx: ReflexionContext): Reflexion {
    // JSON may be wrapped in markdown fences or preceded by prose
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    const candidate = fenceMatch ? fenceMatch[1] : raw;
    const jsonMatch = candidate.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return {
        whatFailed: `Action failed: ${truncate(ctx.error, 100)}`,
        whyFailed: `LLM reflexion output was not parseable JSON`,
        whatToTryNext: `Re-read the error message and try a different approach.`,
        confidence: 0.3,
        source: 'llm',
        raw,
      };
    }

    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (!isReflexionShape(parsed)) {
        return {
          whatFailed: `Action failed: ${truncate(ctx.error, 100)}`,
          whyFailed: `LLM reflexion had wrong shape`,
          whatToTryNext: `Re-read the error message and try a different approach.`,
          confidence: 0.3,
          source: 'llm',
          raw,
        };
      }
      return {
        whatFailed:
          truncate(parsed.whatFailed, 500) || `Action failed: ${truncate(ctx.error, 100)}`,
        whyFailed: truncate(parsed.whyFailed, 500) || 'Unknown',
        whatToTryNext: truncate(parsed.whatToTryNext, 500) || 'Try a different approach.',
        confidence: 0.7,
        source: 'llm',
        raw,
      };
    } catch (err) {
      reportSilentFailure(err, 'reflexionGenerator:377');
      return {
        whatFailed: `Action failed: ${truncate(ctx.error, 100)}`,
        whyFailed: `LLM reflexion JSON parse failed`,
        whatToTryNext: `Re-read the error message and try a different approach.`,
        confidence: 0.3,
        source: 'llm',
        raw,
      };
    }
  }

  /**
   * Format a reflexion for inclusion in an error message that will be shown
   * to the LLM in the next attempt's context.
   */
  static formatForContext(ctx: ReflexionContext, reflexion: Reflexion): string {
    return [
      `Reflexion (attempt ${ctx.attemptNumber}, source: ${reflexion.source}, confidence: ${(reflexion.confidence * 100).toFixed(0)}%):`,
      `  What failed: ${reflexion.whatFailed}`,
      `  Why: ${reflexion.whyFailed}`,
      `  Try next: ${reflexion.whatToTryNext}`,
    ].join('\n');
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

function isReflexionShape(
  value: unknown,
): value is { whatFailed: string; whyFailed: string; whatToTryNext: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.whatFailed === 'string' &&
    typeof v.whyFailed === 'string' &&
    typeof v.whatToTryNext === 'string'
  );
}

/**
 * Walk the prototype chain to find a defaultModel field. Provider classes
 * inherit from BaseOpenAICompatibleProvider and may expose the field at
 * different levels (config.defaultModel, this.defaultModel, this.model).
 * Avoids unsafe `as any` casts while handling all positions.
 */
function resolveDefaultModel(provider: LLMProvider): string {
  let current: object | null = provider as unknown as object;
  while (current && typeof current === 'object') {
    const candidate = (current as Record<string, unknown>).defaultModel;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    const modelField = (current as Record<string, unknown>).model;
    if (typeof modelField === 'string' && modelField.length > 0) return modelField;
    current = Object.getPrototypeOf(current);
  }
  return '';
}
