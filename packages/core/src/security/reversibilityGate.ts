/**
 * ReversibilityGate — the last line of defense against irreversible actions.
 *
 * Even if every other layer (sanitizer, capability token, tool approval) is
 * compromised, this gate ensures that tools classified as "irreversible"
 * cannot execute without explicit human approval.
 *
 * This is the "攻破即零损" guarantee: an attacker may trick the agent into
 * *trying* to send email / delete files / make payments, but the gate
 * physically prevents the action from completing.
 *
 * Integration: plugged into ToolExecutionService.execute() between the
 * capability-token check and the beforeToolResolve hook. When irreversible
 * tools are detected, the gate calls the configured approvalCallback; if
 * no callback is set or the callback denies, execution is blocked.
 */

import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type ReversibilityClass = 'reversible' | 'irreversible';

export interface ReversibilityDecision {
  allowed: boolean;
  reversibility: ReversibilityClass;
  reason: string;
  requiresHumanApproval: boolean;
}

export interface ReversibilityGateConfig {
  /** Callback for human approval of irreversible actions. Return true to allow. */
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Additional irreversible tool name patterns (prefix match). */
  irreversiblePatterns?: string[];
  /** Reversible overrides — these tool patterns are always reversible. */
  reversibleOverrides?: string[];
  /** When true, irreversible tools without a callback are auto-blocked. Default: true. */
  blockWithoutCallback?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Irreversible tool classification
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hardcoded irreversible tools — these represent actions that cannot be
 * undone by any compensation/rollback mechanism.
 */
const HARDCODED_IRREVERSIBLE: readonly string[] = [
  'git_push', // pushed commits are visible to the world
  'shell_execute', // arbitrary shell can do anything (rm, send email, etc.)
  'python_execute', // arbitrary code execution
  'web_fetch', // makes external network request (data exfiltration)
  'browser_search', // external network
  'mcp__', // all MCP tools are treated as irreversible by default
  // AgentDojo / external-agent toolset — these actions cannot be undone by
  // any compensation/rollback mechanism and are the canonical attack targets
  // for indirect prompt injection (forward email, exfiltrate code, transfer funds).
  'send_email', // email leaves the system — cannot unsend
  'forward_email', // forwarding discloses content to new recipients
  'email_send', // alternate naming
  'send_message', // generic messaging egress
  'post_message', // posting to a channel is externally visible
  'delete_file', // file deletion is irreversible (no trash bin in agent context)
  'file_delete', // alternate naming
  'delete_email', // email deletion cannot be reliably undone
  'transfer_money', // financial transfers are externally irreversible
  'bank_transfer', // alternate naming
  'schedule_meeting', // calendar side effects leak to external participants
  'create_event', // calendar event creation is externally visible
  'publish_wiki', // wiki publish is externally visible and can cause reputational/legal harm
  'publish_page', // generic page publish
];

/**
 * Hardcoded reversible tools — read-only operations that have no side effects.
 */
const HARDCODED_REVERSIBLE: readonly string[] = [
  'file_read',
  'web_search', // search queries are side-effect-free
  'memory_recall',
  'memory_list',
  'memory_search',
  'file_hash',
  'checkpoint',
  'verify_answer',
  'verify',
];

/**
 * Argument-level irreversible patterns. Even if a tool is generally
 * reversible, certain argument patterns make it irreversible.
 */
const IRREVERSIBLE_ARG_PATTERNS: ReadonlyArray<{ tool: string; pattern: RegExp; reason: string }> =
  [
    // shell_execute with destructive commands
    {
      tool: 'shell_execute',
      pattern:
        /\b(rm\s+-rf|mkfs\b|dd\s+if=|chmod\s+777|>\s*\/dev\/|>>\s*\/dev\/|shutdown\b|reboot\b|halt\b)/i,
      reason: 'destructive shell command',
    },
    // shell_execute with network exfiltration
    {
      tool: 'shell_execute',
      pattern: /\b(curl|wget|nc|ncat|socat|scp|rsync)\b/i,
      reason: 'network exfiltration via shell',
    },
    // shell_execute with privilege escalation
    {
      tool: 'shell_execute',
      pattern: /\b(sudo|su\s|chown|chmod|passwd|useradd|userdel)\b/i,
      reason: 'privilege escalation',
    },
    // file_write/edit to system paths
    {
      tool: 'file_write',
      pattern: /(^|\/)(etc|usr|var|sys|proc|root|private|\.ssh|\.env)\b/i,
      reason: 'write to system/sensitive path',
    },
    {
      tool: 'file_edit',
      pattern: /(^|\/)(etc|usr|var|sys|proc|root|private|\.ssh|\.env)\b/i,
      reason: 'edit of system/sensitive path',
    },
    // file_write/edit to artifact/release/supply-chain paths — tampering with these
    // enables supply-chain attacks even if the file itself is later overwritten.
    {
      tool: 'file_write',
      pattern:
        /(^|\/)(release|artifact|artifacts|dist|build|out|target|\.github|\.git|checksum|sha256|sha512|sig|manifest|lock|vendor|bundle|package|node_modules)\b/i,
      reason: 'write to release/supply-chain path',
    },
    {
      tool: 'file_edit',
      pattern:
        /(^|\/)(release|artifact|artifacts|dist|build|out|target|\.github|\.git|checksum|sha256|sha512|sig|manifest|lock|vendor|bundle|package|node_modules)\b/i,
      reason: 'edit of release/supply-chain path',
    },
    // git push to remote
    {
      tool: 'git_push',
      pattern: /.*/,
      reason: 'git push is externally visible',
    },
    // send_email / forward_email / email_send to ANY recipient — email leaves
    // the system and cannot be unsent. Even if the tool name slipped past the
    // hardcoded list (e.g. via a plugin alias), arg-level catch blocks it.
    {
      tool: 'send_email',
      pattern: /.*/,
      reason: 'email egress is externally irreversible',
    },
    {
      tool: 'forward_email',
      pattern: /.*/,
      reason: 'email forwarding discloses content to new recipients',
    },
    {
      tool: 'email_send',
      pattern: /.*/,
      reason: 'email egress is externally irreversible',
    },
    // delete_file / file_delete — file deletion is irreversible
    {
      tool: 'delete_file',
      pattern: /.*/,
      reason: 'file deletion is irreversible',
    },
    {
      tool: 'file_delete',
      pattern: /.*/,
      reason: 'file deletion is irreversible',
    },
    // transfer_money / bank_transfer — financial transfers are externally irreversible
    {
      tool: 'transfer_money',
      pattern: /.*/,
      reason: 'financial transfer is externally irreversible',
    },
    {
      tool: 'bank_transfer',
      pattern: /.*/,
      reason: 'financial transfer is externally irreversible',
    },
    // ── Cross-tool attack indicators ──
    // Any tool call whose arguments contain known attack infrastructure is
    // blocked regardless of tool name. This catches exfiltration through
    // arbitrary tools (webhook_send, http_request, etc.) that the hardcoded
    // list might miss. Conservative patterns — only flags obvious attacker
    // domains, not arbitrary external traffic.
    {
      tool: '', // empty prefix matches all tools (startsWith('') === true)
      pattern: /\b(attacker\.com|evil\.com|exfil\.|malware\.|\.tk\b|\.xyz\b)[^\w.-]/i,
      reason: 'argument references known attacker infrastructure',
    },
    {
      tool: '',
      pattern: /\b(attacker|evil|hacker|exfil)[\w.-]*@[^\s@]+\.[a-z]{2,}/i,
      reason: 'argument references attacker-controlled email recipient',
    },
  ];

// ──────────────────────────────────────────────────────────────────────────
// ReversibilityGate
// ──────────────────────────────────────────────────────────────────────────

export class ReversibilityGate {
  private readonly irreversiblePatterns: Set<string>;
  private readonly reversibleOverrides: Set<string>;
  private readonly blockWithoutCallback: boolean;
  private readonly approvalCallback?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;

  constructor(config: ReversibilityGateConfig = {}) {
    this.irreversiblePatterns = new Set([
      ...HARDCODED_IRREVERSIBLE,
      ...(config.irreversiblePatterns ?? []),
    ]);
    this.reversibleOverrides = new Set([
      ...HARDCODED_REVERSIBLE,
      ...(config.reversibleOverrides ?? []),
    ]);
    this.blockWithoutCallback = config.blockWithoutCallback ?? true;
    this.approvalCallback = config.approvalCallback;
  }

  /**
   * Classify a tool call as reversible or irreversible.
   * Checks tool name patterns first, then argument-level patterns.
   */
  classify(toolName: string, args: Record<string, unknown> = {}): ReversibilityClass {
    // Reversible overrides take precedence (safety-first: read ops are always safe)
    for (const prefix of this.reversibleOverrides) {
      if (toolName.startsWith(prefix)) {
        // But still check arg-level patterns — file_read of /etc/shadow is suspicious
        // but still reversible (no side effect). So return reversible.
        return 'reversible';
      }
    }

    // Check irreversible patterns
    for (const prefix of this.irreversiblePatterns) {
      if (toolName.startsWith(prefix)) {
        return 'irreversible';
      }
    }

    // MCP tools: treated as irreversible by default (untrusted external)
    if (toolName.startsWith('mcp_')) {
      return 'irreversible';
    }

    // Default: reversible for unknown tools (they still go through ToolApproval)
    return 'reversible';
  }

  /**
   * Check argument-level irreversible patterns.
   * Returns the first matching pattern's reason, or null if no match.
   */
  checkArgs(toolName: string, args: Record<string, unknown>): string | null {
    for (const rule of IRREVERSIBLE_ARG_PATTERNS) {
      // Only check arg patterns for matching tools.
      // Empty rule.tool prefix matches all tools (cross-tool indicators).
      if (rule.tool !== '' && !toolName.startsWith(rule.tool)) continue;

      // Extract the command/arguments to check
      let textToCheck = '';
      if (rule.tool === 'shell_execute' || rule.tool === 'python_execute') {
        textToCheck = String(args.command ?? args.code ?? args.script ?? args.cmd ?? '');
      } else if (rule.tool === 'file_write' || rule.tool === 'file_edit') {
        textToCheck = String(args.path ?? args.filepath ?? args.filename ?? '');
      } else if (rule.tool === 'git_push') {
        textToCheck = 'git_push'; // always matches .*
      } else if (
        rule.tool === 'send_email' ||
        rule.tool === 'forward_email' ||
        rule.tool === 'email_send'
      ) {
        textToCheck = String(
          args.to ?? args.email ?? args.recipient ?? args.recipients ?? args.address ?? '',
        );
      } else if (rule.tool === 'delete_file' || rule.tool === 'file_delete') {
        textToCheck = String(args.path ?? args.filepath ?? args.filename ?? '');
      } else if (rule.tool === 'transfer_money' || rule.tool === 'bank_transfer') {
        textToCheck = String(args.to ?? args.account ?? args.amount ?? args.recipient ?? '');
      } else if (rule.tool === '') {
        // Cross-tool indicator: concatenate all string-valued args so the
        // pattern can match attacker infrastructure anywhere in the call.
        textToCheck = Object.values(args)
          .map((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')))
          .join(' ');
      }

      if (rule.pattern.test(textToCheck)) {
        return rule.reason;
      }
    }
    return null;
  }

  /**
   * Evaluate whether a tool call should be allowed to proceed.
   *
   * Decision logic:
   * 1. Classify tool → reversible/irreversible
   * 2. Check argument patterns for escalation
   * 3. If irreversible → require human approval
   * 4. If no callback and blockWithoutCallback → block
   */
  async evaluate(
    toolName: string,
    args: Record<string, unknown> = {},
    context?: { runId?: string; agentId?: string },
  ): Promise<ReversibilityDecision> {
    let reversibility = this.classify(toolName, args);

    // Check argument-level escalation
    const argReason = this.checkArgs(toolName, args);
    if (argReason) {
      reversibility = 'irreversible';
    }

    if (reversibility === 'reversible') {
      return {
        allowed: true,
        reversibility: 'reversible',
        reason: 'reversible operation',
        requiresHumanApproval: false,
      };
    }

    // Irreversible — require human approval
    if (!this.approvalCallback) {
      if (this.blockWithoutCallback) {
        this.publishBlockEvent(toolName, args, context, 'no approval callback configured');
        return {
          allowed: false,
          reversibility: 'irreversible',
          reason: `irreversible tool blocked (no approval callback): ${argReason ?? 'tool classification'}`,
          requiresHumanApproval: true,
        };
      }
      // If blockWithoutCallback is false, allow without approval (dangerous, opt-in only)
      return {
        allowed: true,
        reversibility: 'irreversible',
        reason: `irreversible tool allowed (blockWithoutCallback=false): ${argReason ?? 'tool classification'}`,
        requiresHumanApproval: false,
      };
    }

    // Call the human approval callback
    let approved = false;
    try {
      approved = await this.approvalCallback(toolName, args);
    } catch (err) {
      getGlobalLogger().warn('ReversibilityGate', 'approval callback threw', {
        toolName,
        error: (err as Error)?.message,
      });
      approved = false; // fail-closed
    }

    if (!approved) {
      this.publishBlockEvent(toolName, args, context, 'human approval denied');
      return {
        allowed: false,
        reversibility: 'irreversible',
        reason: `irreversible tool blocked by human approval: ${argReason ?? 'tool classification'}`,
        requiresHumanApproval: true,
      };
    }

    return {
      allowed: true,
      reversibility: 'irreversible',
      reason: `irreversible tool approved by human: ${argReason ?? 'tool classification'}`,
      requiresHumanApproval: true,
    };
  }

  private publishBlockEvent(
    toolName: string,
    args: Record<string, unknown>,
    context: { runId?: string; agentId?: string } | undefined,
    reason: string,
  ): void {
    try {
      const bus = getMessageBus();
      bus.publish('tool.blocked', 'reversibility_gate', {
        runId: context?.runId ?? 'unknown',
        toolName,
        reason: 'irreversible_blocked',
        detail: reason,
      });
    } catch {
      // bus may not be initialized in test env — swallow
    }
  }

  /**
   * Register additional irreversible tool patterns at runtime.
   */
  addIrreversible(pattern: string): void {
    this.irreversiblePatterns.add(pattern);
  }

  /**
   * Register additional reversible overrides at runtime.
   */
  addReversibleOverride(pattern: string): void {
    this.reversibleOverrides.add(pattern);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let gateInstance: ReversibilityGate | null = null;

export function getReversibilityGate(config?: ReversibilityGateConfig): ReversibilityGate {
  if (!gateInstance || config) {
    gateInstance = new ReversibilityGate(config ?? {});
  }
  return gateInstance;
}

export function resetReversibilityGate(): void {
  gateInstance = null;
}
