/**
 * raspExtensionsPlugin — Built-in CommanderPlugin providing Runtime Application
 * Self-Protection (RASP) detectors.
 *
 * Three detectors run inline across the agent lifecycle:
 *   1. Prompt-injection pattern scanner (beforeLLMCall) — 6 regex patterns,
 *      validated for ReDoS safety via `safe-regex` at load time, with a
 *      `performance.now()` per-match budget guard.
 *   2. Token-rate anomaly detector (afterLLMCall) — per-run cumulative token
 *      cap; fires when total tokens exceed `tokenCap`.
 *   3. Tool-failure-rate anomaly detector (afterToolCall) — sliding window of
 *      the last N tool results; fires when the failure ratio exceeds
 *      `toolFailureThreshold`.
 *
 * ReDoS defense (Devil Detail C):
 *   - All patterns are validated with `safe-regex` during onLoad. The plugin
 *     refuses to load if any pattern is unsafe (catastrophic backtracking risk).
 *   - A `performance.now()` budget guard (default 50ms) wraps each regex match
 *     as defense-in-depth: if a match blows the budget, the finding is dropped
 *     and a budget-breach event is logged.
 *
 * Per-pattern severity: base64_payload is 'medium' (Patch B — long base64
 * blobs are a weak signal; log + throttle, no auto-suspend). All other
 * injection patterns are 'high' (log + suspend + revoke tokens).
 *
 * Detection → response loop is closed via `processSecurityAlert()` from the
 * SecurityResponseEngine.
 */
import type {
  CommanderPlugin,
  BeforeLLMCallContext,
  AfterLLMCallContext,
  AfterToolCallContext,
} from '../../pluginManager';
import type { LLMRequest } from '../../runtime/types';
import { processSecurityAlert } from '../../security/securityResponseEngine';
import type {
  SecurityAlert,
  SecurityEventType,
  SecuritySeverity,
} from '../../security/securityResponseEngine';
import { getSecurityAuditLogger } from '../../security/securityAuditLogger';

// safe-regex ships no TypeScript declarations and @types/safe-regex does not
// exist. Suppress the untyped-module import error and cast to the minimal
// shape we rely on. (A project-wide .d.ts shim would also work; this keeps
// the change to a single file.)
// @ts-expect-error — safe-regex has no bundled type declarations
import safeRegexFn from 'safe-regex';

const safeRegex = safeRegexFn as unknown as (
  re: RegExp | string,
  opts?: { limit?: number },
) => boolean;

// ── Prompt-injection patterns ────────────────────────────────────────────

interface InjectionPattern {
  id: string;
  regex: RegExp;
  severity: SecuritySeverity;
  /** Minimum match length required to flag (Patch B: base64 threshold 512). */
  minLength?: number;
}

const BASE64_PAYLOAD_THRESHOLD = 512;

const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    id: 'ignore_instructions',
    // Simplified to pass safe-regex: use bounded wildcards instead of nested
    // optional alternations. Matches "ignore previous instructions",
    // "forget all prior rules", "disregard the above directives", etc.
    regex:
      /(?:ignore|disregard|forget).{0,20}(?:previous|prior|above|earlier).{0,20}(?:instructions?|prompts?|rules?|directives?)/i,
    severity: 'high',
  },
  {
    id: 'reveal_system_prompt',
    regex:
      /(?:reveal|show|display|print|repeat|output|leak)\s+(?:your|the)\s+(?:system|initial|hidden)\s+(?:prompt|instructions?|message)/i,
    severity: 'high',
  },
  {
    id: 'role_override',
    regex: /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on\s+you\s+(?:are|will)|new\s+role\s*:)/i,
    severity: 'high',
  },
  {
    id: 'tag_injection',
    regex: /<\/(?:system|assistant|user|im_start|im_end)\s*>|<\|(?:system|assistant|user|im_start|im_end)\|>/i,
    severity: 'high',
  },
  {
    // Patch B: threshold 512 (only long base64 blobs are suspicious),
    // severity 'medium' (log + throttle, no auto-suspend). minLength enforced
    // in code so the regex itself stays linear (safe-regex friendly). The `g`
    // flag lets `String.match` return every run so we can find a long blob
    // anywhere in the input, not just the first short word.
    id: 'base64_payload',
    regex: /[A-Za-z0-9+/]+={0,2}/g,
    severity: 'medium',
    minLength: BASE64_PAYLOAD_THRESHOLD,
  },
  {
    id: 'jailbreak_dan',
    regex: /(?:\bDAN\b|do\s+anything\s+now|developer\s+mode|jailbreak|AIM\s+mode|evil\s+mode)/i,
    severity: 'high',
  },
];

// ── Per-run state ────────────────────────────────────────────────────────

interface RunState {
  cumulativeTokens: number;
  toolResults: boolean[]; // true = failure (result.error set)
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fireAlert(
  type: SecurityEventType,
  severity: SecuritySeverity,
  agentId: string,
  runId: string,
  message: string,
  details: Record<string, unknown>,
): void {
  const alert: SecurityAlert = {
    type,
    severity,
    agentId,
    runId,
    message,
    details: { source: 'builtin-rasp-extensions', ...details },
    timestamp: new Date(),
  };
  try {
    processSecurityAlert(alert);
  } catch {
    // Best-effort fallback if the response engine is unavailable.
    getSecurityAuditLogger().logEvent({
      type: 'security_decision',
      severity,
      source: 'builtin-rasp-extensions',
      message,
      details,
    });
  }
}

// ── Plugin factory ───────────────────────────────────────────────────────

export function createRaspExtensionsPlugin(): CommanderPlugin {
  const runState = new Map<string, RunState>();
  let tokenCap = 2_000_000;
  let toolFailureThreshold = 0.5;
  let toolFailureWindow = 10;
  let regexBudgetMs = 50;

  return {
    name: 'builtin-rasp-extensions',
    version: '0.1.0',
    description:
      'Runtime Application Self-Protection: prompt-injection scanner, token-rate anomaly, and tool-failure-rate anomaly detectors (OWASP LLM01 / LLOvip08)',
    category: 'security',
    configSchema: {
      type: 'object',
      properties: {
        tokenCap: {
          type: 'number',
          description: 'Per-run cumulative token cap; fires a token-rate alert when exceeded',
          default: 2_000_000,
        },
        toolFailureThreshold: {
          type: 'number',
          description: 'Tool-failure ratio (0-1) over the sliding window that triggers an alert',
          default: 0.5,
        },
        toolFailureWindow: {
          type: 'number',
          description: 'Sliding window size (number of recent tool calls) for failure-rate detection',
          default: 10,
        },
        regexBudgetMs: {
          type: 'number',
          description: 'Per-regex match budget in milliseconds (ReDoS defense-in-depth)',
          default: 50,
        },
      },
    },

    // ── Lifecycle ──────────────────────────────────────────────────────

    onLoad: async (ctx) => {
      tokenCap = Number(ctx.config.tokenCap) || 2_000_000;
      toolFailureThreshold = Number(ctx.config.toolFailureThreshold) || 0.5;
      toolFailureWindow = Math.max(1, Math.floor(Number(ctx.config.toolFailureWindow) || 10));
      regexBudgetMs = Number(ctx.config.regexBudgetMs) || 50;

      // ReDoS defense (Devil Detail C): validate every pattern with safe-regex.
      // Refuse to load if any pattern is unsafe — a catastrophic regex could
      // hang the agent process on adversarial input.
      for (const p of INJECTION_PATTERNS) {
        if (!safeRegex(p.regex)) {
          throw new Error(
            `builtin-rasp-extensions: pattern "${p.id}" failed safe-regex validation (ReDoS risk); refusing to load`,
          );
        }
      }
    },

    onUnload: async () => {
      runState.clear();
    },

    // ── Hooks (top-level on CommanderPlugin, not nested under `hooks`) ──

    onAgentStart: ({ runId }) => {
      runState.set(runId, { cumulativeTokens: 0, toolResults: [] });
    },

    onAgentComplete: ({ runId }) => {
      runState.delete(runId);
    },

    // Detector 1: prompt-injection pattern scan
    beforeLLMCall: (ctx: BeforeLLMCallContext): LLMRequest => {
      const messages = ctx.request.messages ?? [];
      for (const msg of messages) {
        const content = msg.content ?? '';
        if (!content) continue;
        for (const p of INJECTION_PATTERNS) {
          const start = performance.now();
          let snippet: string | null = null;
          if (p.regex.global) {
            // Returns every match as a string[] — used by base64_payload to
            // find a long blob anywhere in the input, not just the first run.
            const runs = content.match(p.regex);
            if (runs) {
              const hit = runs.find((r) => r.length >= (p.minLength ?? 0));
              if (hit) snippet = hit;
            }
          } else {
            const m = p.regex.exec(content);
            if (m && m[0].length >= (p.minLength ?? 0)) snippet = m[0];
          }
          const elapsedMs = performance.now() - start;

          // Budget guard (ReDoS defense-in-depth): if a single match blew the
          // budget, drop the finding and log a budget-breach event.
          if (elapsedMs > regexBudgetMs) {
            fireAlert(
              'prompt_injection_detected',
              'medium',
              ctx.agentId,
              ctx.runId,
              `Regex budget exceeded for pattern "${p.id}" (${elapsedMs.toFixed(1)}ms > ${regexBudgetMs}ms) — possible ReDoS attempt`,
              { detector: 'prompt-injection', patternId: p.id, budgetBreached: true, elapsedMs },
            );
            continue;
          }

          if (snippet) {
            fireAlert(
              'prompt_injection_detected',
              p.severity,
              ctx.agentId,
              ctx.runId,
              `Prompt-injection pattern "${p.id}" matched in ${msg.role} message`,
              {
                detector: 'prompt-injection',
                patternId: p.id,
                role: msg.role,
                snippet: snippet.slice(0, 80),
              },
            );
          }
        }
      }
      return ctx.request;
    },

    // Detector 2: token-rate anomaly
    afterLLMCall: (ctx: AfterLLMCallContext): AfterLLMCallContext => {
      const state = runState.get(ctx.runId);
      if (!state) return ctx;
      const resp = ctx.response;
      const total = resp?.usage?.totalTokens;
      if (typeof total !== 'number' || total <= 0) return ctx;

      state.cumulativeTokens += total;
      if (state.cumulativeTokens > tokenCap) {
        fireAlert(
          'excessive_agency',
          'medium',
          ctx.agentId,
          ctx.runId,
          `Token-rate anomaly: cumulative tokens ${state.cumulativeTokens} exceeded cap ${tokenCap}`,
          {
            detector: 'token-rate',
            cumulativeTokens: state.cumulativeTokens,
            tokenCap,
            lastCallTokens: total,
          },
        );
      }
      return ctx;
    },

    // Detector 3: tool-failure-rate anomaly (sliding window)
    afterToolCall: (ctx: AfterToolCallContext) => {
      const state = runState.get(ctx.runId);
      if (!state) return ctx.result;

      const failed = Boolean(ctx.result.error);
      state.toolResults.push(failed);
      if (state.toolResults.length > toolFailureWindow) {
        state.toolResults.shift();
      }

      // Require at least half the window populated before flagging — avoids
      // false positives on the first 1-2 failures of a fresh run.
      const minSamples = Math.max(1, Math.floor(toolFailureWindow / 2));
      if (state.toolResults.length >= minSamples) {
        const failures = state.toolResults.filter((v) => v).length;
        const rate = failures / state.toolResults.length;
        if (rate > toolFailureThreshold) {
          fireAlert(
            'unknown_threat',
            'medium',
            ctx.agentId,
            ctx.runId,
            `Tool-failure-rate anomaly: ${failures}/${state.toolResults.length} recent calls failed (rate ${(rate * 100).toFixed(0)}% > threshold ${(toolFailureThreshold * 100).toFixed(0)}%)`,
            {
              detector: 'tool-failure-rate',
              failures,
              samples: state.toolResults.length,
              rate,
              threshold: toolFailureThreshold,
              lastTool: ctx.toolName,
            },
          );
        }
      }
      return ctx.result;
    },
  };
}
