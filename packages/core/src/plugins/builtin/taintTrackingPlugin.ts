/**
 * taintTrackingPlugin — Built-in CommanderPlugin for run-level information
 * flow control (OWASP ASI01).
 *
 * Tracks a per-run TaintTier ('CLEAN' | 'LOCAL_DIRTY' | 'EXTERNAL_DIRTY')
 * based on which tools the LLM has seen output from. When the run reaches
 * EXTERNAL_DIRTY, all tools with riskMetadata.sideEffect === 'external_egress'
 * are blocked (configurable via outboundToolWhitelist).
 *
 * Design rationale (v0.2 — Source Tiering):
 *   - Arg-level taint tracking fails on LLMs due to "epistemic mixing" —
 *     the LLM can paraphrase tainted data, breaking pointer-level tracking.
 *   - Run-level tiering with source classification is the pragmatic middle
 *     ground: LOCAL_DIRTY (internal reads) allows outbound; EXTERNAL_DIRTY
 *     (web_search, a2a_delegate, etc.) triggers outbound熔断.
 *
 * Default disabled. Enable via: commander plugin enable taint-tracking
 */
import type {
  CommanderPlugin,
  BeforeToolCallContext,
  AfterToolCallContext,
  BeforeLLMCallContext,
} from '../../pluginManager';
import type { LLMRequest } from '../../runtime/types';
import { getSecurityAuditLogger } from '../../security/securityAuditLogger';

type TaintTier = 'CLEAN' | 'LOCAL_DIRTY' | 'EXTERNAL_DIRTY';

interface RunState {
  tier: TaintTier;
  sources: string[];
  /** Outbound tools explicitly whitelisted by config (override). */
  whitelist: Set<string>;
}

/** Tool names whose outputs are internal/trusted. */
const INTERNAL_TOOLS = new Set(['code_search', 'file_read', 'list_files', 'index_search']);

/** Fallback: tools without riskMetadata that match these names are external. */
function isKnownExternalTool(name: string): boolean {
  return /^(web_search|web_fetch|http_request|a2a_delegate|send_email|webhook_send|mcp_call)/.test(
    name,
  );
}

export function createTaintTrackingPlugin(): CommanderPlugin {
  const runState = new Map<string, RunState>();
  let blockOnExternalDirty = true;
  // Closure-scoped config — avoids polluting the factory function object.
  let cfgWhitelist: Set<string> = new Set();

  return {
    name: 'builtin-taint-tracking',
    version: '0.1.0',
    description: 'Information flow control via run-level taint tiering (OWASP ASI01)',
    category: 'security',
    configSchema: {
      type: 'object',
      properties: {
        blockOutboundOnExternalDirty: {
          type: 'boolean',
          description: 'Block all external_egress tools once the run has seen EXTERNAL_DIRTY data',
          default: true,
        },
        outboundToolWhitelist: {
          type: 'array',
          description:
            'Outbound tools exempt from taint blocking (e.g. allow web_search to chain even after external fetch)',
          default: [],
        },
      },
    },

    // ── Lifecycle ──────────────────────────────────────────────────────

    onLoad: async (ctx) => {
      blockOnExternalDirty = Boolean(ctx.config.blockOutboundOnExternalDirty);
      const wl = (ctx.config.outboundToolWhitelist ?? []) as string[];
      cfgWhitelist = new Set(wl);
    },

    onUnload: async () => {
      runState.clear();
      cfgWhitelist.clear();
    },

    // ── Hooks (top-level on CommanderPlugin, not nested under `hooks`) ──

    onAgentStart: ({ runId }) => {
      runState.set(runId, {
        tier: 'CLEAN',
        sources: [],
        whitelist: new Set(cfgWhitelist),
      });
    },

    onAgentComplete: ({ runId }) => {
      runState.delete(runId);
    },

    beforeLLMCall: (ctx: BeforeLLMCallContext): LLMRequest => {
      const state = runState.get(ctx.runId);
      if (!state) return ctx.request;
      // Belt-and-suspenders: if any tool message is in history and tier
      // is still CLEAN, bump to LOCAL_DIRTY. The afterToolCall hook is
      // the primary tier-promotion path.
      const hasToolMsg = (ctx.request.messages ?? []).some((m) => m.role === 'tool');
      if (hasToolMsg && state.tier === 'CLEAN') {
        state.tier = 'LOCAL_DIRTY';
      }
      return ctx.request;
    },

    beforeToolCall: (ctx: BeforeToolCallContext) => {
      const state = runState.get(ctx.runId);
      if (!state) return null;
      if (!blockOnExternalDirty) return null;
      if (state.tier !== 'EXTERNAL_DIRTY') return null;

      // Read riskMetadata — the tool self-reports.
      const sideEffect = ctx.tool?.definition?.riskMetadata?.sideEffect;
      const isEgress = sideEffect === 'external_egress';

      if (isEgress && !state.whitelist.has(ctx.toolName)) {
        getSecurityAuditLogger().logEvent({
          // 'dlp_violation' is not in SecurityEventType; 'security_decision'
          // is the closest existing category for a plugin-enforced block.
          type: 'security_decision',
          severity: 'high',
          source: 'builtin-taint-tracking',
          message: `Blocked external_egress tool "${ctx.toolName}" after EXTERNAL_DIRTY data in run ${ctx.runId}`,
          details: { toolName: ctx.toolName, runId: ctx.runId, sources: state.sources },
        });
        return {
          toolCallId: '',
          name: ctx.toolName,
          output: `Blocked: taint tracking prevented data flow to outbound tool "${ctx.toolName}" after external tool output. Override via outboundToolWhitelist config.`,
          error: 'taint_tracking_block',
          durationMs: 0,
        };
      }
      return null;
    },

    afterToolCall: (ctx: AfterToolCallContext) => {
      const state = runState.get(ctx.runId);
      if (!state) return ctx.result;

      const sideEffect = ctx.tool?.definition?.riskMetadata?.sideEffect;
      const isExternal =
        !INTERNAL_TOOLS.has(ctx.toolName) &&
        (sideEffect === 'external_egress' ||
          (sideEffect === undefined && isKnownExternalTool(ctx.toolName)));

      if (isExternal && state.tier !== 'EXTERNAL_DIRTY') {
        state.tier = 'EXTERNAL_DIRTY';
        state.sources.push(ctx.toolName);
        getSecurityAuditLogger().logEvent({
          type: 'security_decision',
          severity: 'low',
          source: 'builtin-taint-tracking',
          message: `Run ${ctx.runId} promoted to EXTERNAL_DIRTY after tool "${ctx.toolName}"`,
          details: { toolName: ctx.toolName },
        });
      } else if (state.tier === 'CLEAN' && !INTERNAL_TOOLS.has(ctx.toolName)) {
        state.tier = 'LOCAL_DIRTY';
      }
      return ctx.result;
    },
  };
}
