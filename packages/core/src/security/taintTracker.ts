/**
 * Information Flow Control (IFC) / Taint Tracking System
 *
 * Security (OWASP ASI01): Prevents indirect prompt injection by tracking
 * data provenance. External data (tool outputs, web search results, file
 * contents) is marked as "untrusted" and cannot flow into privileged
 * operations (system prompts, tool call parameters for outbound tools,
 * memory writes with high trust level).
 *
 * Taint propagation rules:
 * - trusted + trusted = trusted
 * - trusted + untrusted = untrusted (most restrictive wins)
 * - untrusted + untrusted = untrusted
 *
 * Enforcement points:
 * - System prompt construction: only trusted data allowed
 * - Tool call parameters (outbound tools): untrusted data blocked
 * - Memory writes: untrusted data flagged but allowed (with reduced trust weight)
 */

import { getGlobalLogger } from '../logging';

// ── Taint Labels ────────────────────────────────────────────────────────────

export type TaintLabel = 'trusted' | 'untrusted' | 'external';

/** Tools that send data externally — untrusted data must not flow into these. */
const OUTBOUND_TOOLS = new Set([
  'web_search', 'web_fetch', 'http_request', 'shell_execute',
  'a2a_delegate', 'send_email', 'webhook_send', 'mcp_call',
]);

// ── Tainted String Wrapper ─────────────────────────────────────────────────

/**
 * A string with an attached taint label.
 * When tainted strings are concatenated, the most restrictive label wins.
 */
export class TaintedString {
  readonly value: string;
  readonly taint: TaintLabel;
  readonly source?: string;

  constructor(value: string, taint: TaintLabel = 'trusted', source?: string) {
    this.value = value;
    this.taint = taint;
    this.source = source;
  }

  /** Concatenate two tainted strings — most restrictive taint wins. */
  concat(other: TaintedString | string): TaintedString {
    if (typeof other === 'string') {
      return new TaintedString(this.value + other, this.taint, this.source);
    }
    const newTaint = combineTaint(this.taint, other.taint);
    return new TaintedString(
      this.value + other.value,
      newTaint,
      this.taint === 'untrusted' || other.taint === 'untrusted' ? 'mixed' : this.source,
    );
  }

  toString(): string {
    return this.value;
  }
}

// ── Taint Combination Logic ────────────────────────────────────────────────

function combineTaint(a: TaintLabel, b: TaintLabel): TaintLabel {
  // Most restrictive wins
  if (a === 'external' || b === 'external') return 'external';
  if (a === 'untrusted' || b === 'untrusted') return 'untrusted';
  return 'trusted';
}

// ── Enforcement API ────────────────────────────────────────────────────────

/**
 * Check if data with a given taint label can flow into a target context.
 *
 * @param dataTaint - The taint label of the data
 * @param targetContext - Where the data is flowing to
 * @returns Whether the flow is allowed
 */
export function canFlow(
  dataTaint: TaintLabel,
  targetContext: 'system_prompt' | 'tool_param' | 'memory_write' | 'llm_input',
  toolName?: string,
): { allowed: boolean; reason?: string } {
  // System prompts can only contain trusted data
  if (targetContext === 'system_prompt') {
    if (dataTaint !== 'trusted') {
      return {
        allowed: false,
        reason: `Blocked: ${dataTaint} data cannot flow into system prompt. Only trusted data is allowed.`,
      };
    }
    return { allowed: true };
  }

  // Tool parameters for outbound tools cannot contain untrusted data
  if (targetContext === 'tool_param' && toolName) {
    if (OUTBOUND_TOOLS.has(toolName) && dataTaint !== 'trusted') {
      return {
        allowed: false,
        reason: `Blocked: ${dataTaint} data cannot flow into outbound tool "${toolName}" parameters. This prevents data exfiltration via indirect prompt injection.`,
      };
    }
    return { allowed: true };
  }

  // LLM input — untrusted data is allowed but should be marked
  if (targetContext === 'llm_input') {
    return { allowed: true };
  }

  // Memory writes — untrusted data allowed but with reduced trust
  if (targetContext === 'memory_write') {
    return { allowed: true };
  }

  return { allowed: true };
}

/**
 * Wrap tool output as untrusted data.
 * All external tool outputs should be wrapped before entering the LLM context.
 */
export function wrapToolOutput(
  output: string,
  toolName: string,
): TaintedString {
  // Internal-only tools produce trusted output
  const internalTools = new Set([
    'code_search', 'file_read', 'list_files', 'index_search',
  ]);
  if (internalTools.has(toolName)) {
    return new TaintedString(output, 'trusted', `tool:${toolName}`);
  }
  // All other tools (web_search, mcp_*, a2a_*, shell_execute) produce untrusted output
  return new TaintedString(output, 'untrusted', `tool:${toolName}`);
}

/**
 * Wrap user input as untrusted by default.
 * User-provided goals and messages are treated as untrusted.
 */
export function wrapUserInput(input: string): TaintedString {
  return new TaintedString(input, 'untrusted', 'user_input');
}

/**
 * Wrap system prompt as trusted.
 */
export function wrapSystemPrompt(prompt: string): TaintedString {
  return new TaintedString(prompt, 'trusted', 'system');
}

/**
 * Check if a tool call's arguments contain untrusted data flowing into
 * an outbound tool. This is the critical enforcement point for preventing
 * data exfiltration via indirect prompt injection.
 */
export function checkToolCallFlow(
  toolName: string,
  args: Record<string, unknown>,
  argTaints: Map<string, TaintLabel>,
): { allowed: boolean; blockedArgs: string[]; reason?: string } {
  if (!OUTBOUND_TOOLS.has(toolName)) {
    return { allowed: true, blockedArgs: [] };
  }

  const blockedArgs: string[] = [];
  for (const [argName, taint] of argTaints) {
    const check = canFlow(taint, 'tool_param', toolName);
    if (!check.allowed) {
      blockedArgs.push(argName);
      getGlobalLogger().warn(
        'TaintTracker',
        `Blocked untrusted data flow to outbound tool argument`,
        {
          toolName,
          argName,
          taint,
          reason: check.reason,
        },
      );
    }
  }

  if (blockedArgs.length > 0) {
    return {
      allowed: false,
      blockedArgs,
      reason: `Blocked ${blockedArgs.length} argument(s) with untrusted taint from flowing into outbound tool "${toolName}"`,
    };
  }

  return { allowed: true, blockedArgs: [] };
}

/**
 * Get the list of outbound tools (for external reference).
 */
export function getOutboundTools(): Set<string> {
  return new Set(OUTBOUND_TOOLS);
}
