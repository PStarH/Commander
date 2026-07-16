/**
 * SecurityPrimitives — unified facade for the 4 categories of defense
 * primitives. Instead of each module reinventing sanitization, governance,
 * integrity, and state contracts, all code should delegate to these
 * canonical implementations.
 *
 * The goal is "fix once, benefit everywhere": when a new attack pattern is
 * discovered, we update the primitive layer once, and all callers
 * automatically get the updated protection.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  UniversalSanitizer  — all cross-trust-boundary data must pass    │
 * │  ResourceGovernor    — all external calls must pass               │
 * │  IntegrityLayer      — all persisted data must be signed          │
 * │  StateContract       — all side effects must begin/commit/rollback│
 * └─────────────────────────────────────────────────────────────────────┘
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger } from '../logging';

// ══════════════════════════════════════════════════════════════════════════
// 1. UniversalSanitizer
// ══════════════════════════════════════════════════════════════════════════

export type SanitizeContext =
  | 'input'
  | 'output'
  | 'tool_args'
  | 'log'
  | 'filename'
  | 'identifier'
  | 'channel_text'
  | 'description';

export interface SanitizeResult {
  sanitized: string;
  modified: boolean;
  patterns: string[];
}

/**
 * Universal sanitizer — single entry point for all sanitization needs.
 * Dispatches to context-appropriate cleaning logic.
 */
export class UniversalSanitizer {
  // PII patterns (shared across contexts)
  private static readonly PII_PATTERNS: ReadonlyArray<{
    name: string;
    pattern: RegExp;
    replacement: string;
  }> = [
    // Modern OpenAI project keys contain hyphens (sk-proj-...); match before generic sk-
    {
      name: 'openai_proj_key',
      pattern: /\b(sk-proj-[A-Za-z0-9_-]+)\b/g,
      replacement: 'sk-proj-[REDACTED]',
    },
    // Anthropic API keys: sk-ant-api03-... (hyphenated segments break generic sk-ant-)
    {
      name: 'anthropic_api_key',
      pattern: /\b(sk-ant-api\d{2}-[A-Za-z0-9_-]+)\b/g,
      replacement: 'sk-ant-[REDACTED]',
    },
    { name: 'api_key', pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g, replacement: 'sk-[REDACTED]' },
    {
      name: 'anthropic_key',
      pattern: /\b(sk-ant-[a-zA-Z0-9]{20,})\b/g,
      replacement: 'sk-ant-[REDACTED]',
    },
    {
      name: 'github_token',
      pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g,
      replacement: 'ghp_[REDACTED]',
    },
    { name: 'aws_key', pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: 'AKIA[REDACTED]' },
    {
      name: 'jwt',
      pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
      replacement: '[JWT_REDACTED]',
    },
    {
      name: 'pem_key',
      pattern:
        /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
      replacement: '[PEM_REDACTED]',
    },
    {
      name: 'pem_header',
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
      replacement: '[PEM_REDACTED]',
    },
    {
      name: 'pem_footer',
      pattern: /-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
      replacement: '[PEM_REDACTED]',
    },
    { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN_REDACTED]' },
    {
      name: 'phone',
      pattern: /\+?\d{1,2}[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}/g,
      replacement: '[PHONE_REDACTED]',
    },
    {
      name: 'email',
      pattern: /\b[a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
      replacement: '[EMAIL_REDACTED]',
    },
    {
      name: 'password',
      pattern: /(?:password|passwd|pwd)\s*[=:]\s*\S+/gi,
      replacement: 'password=[REDACTED]',
    },
    {
      name: 'stripe_key',
      pattern: /\b(sk_live_[a-zA-Z0-9]{24,})\b/g,
      replacement: 'sk_live_[REDACTED]',
    },
    {
      name: 'slack_token',
      pattern: /\b(xox[baprs]-[a-zA-Z0-9-]+)\b/g,
      replacement: 'xox-[REDACTED]',
    },
  ];

  // XSS patterns
  private static readonly XSS_PATTERNS: ReadonlyArray<{
    name: string;
    pattern: RegExp;
    replacement: string;
  }> = [
    {
      name: 'script_tag',
      pattern: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      replacement: '',
    },
    { name: 'event_handler', pattern: /\son\w+\s*=\s*"[^"]*"/gi, replacement: '' },
    { name: 'event_handler_single', pattern: /\son\w+\s*=\s*'[^']*'/gi, replacement: '' },
    { name: 'javascript_url', pattern: /javascript:/gi, replacement: '' },
    { name: 'data_url_html', pattern: /data:text\/html/gi, replacement: '' },
  ];

  // Path traversal patterns
  private static readonly PATH_TRAVERSAL: RegExp = /(\.\.[/\\]|\.\.%2f|\.\.%5c)/gi;

  // Control characters
  private static readonly CONTROL_CHARS: RegExp = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

  // Slack/channel mention patterns
  private static readonly CHANNEL_MENTIONS: RegExp = /@(here|channel|everyone|all)/gi;

  // URL patterns for channel text
  private static readonly URL_PATTERN: RegExp = /https?:\/\/[^\s]+/gi;

  // Prompt-injection patterns (for 'description' context — text that may be
  // rendered in LLM review contexts like gap descriptions, postmortem bodies).
  // Neutralizes chat-role prefixes, hidden HTML comments, and explicit
  // "ignore previous instructions" phrases.
  private static readonly PROMPT_INJECTION_PATTERNS: ReadonlyArray<{
    name: string;
    pattern: RegExp;
    replacement: string;
  }> = [
    // CRITICAL: full_injection_block must be first — removes the ENTIRE
    // injection payload (not just framing) so the LLM never sees the
    // malicious instructions inside the <INFORMATION> tags.
    {
      name: 'full_injection_block',
      pattern: /<INFORMATION>[\s\S]*?<\/INFORMATION>/gi,
      replacement: '[INJECTION BLOCKED]',
    },
    // Also catch untagged injection blocks
    {
      name: 'full_injection_block_untagged',
      pattern:
        /This is an important message from me,?\s*\w+,?\s*to you,?\s*\w+\..*?Signed,\s*\n+\s*\w+\s+\w+/gis,
      replacement: '[INJECTION BLOCKED]',
    },
    // Chat role prefixes at line start: "system:", "assistant:", "user:"
    {
      name: 'chat_role_prefix',
      pattern: /^[ \t]*(system|assistant|user)\s*:/gim,
      replacement: '[$1:]',
    },
    // HTML comments (used to hide injected instructions)
    { name: 'html_comment', pattern: /<!--[\s\S]*?-->/g, replacement: '[comment]' },
    // Explicit injection phrases
    {
      name: 'ignore_instructions',
      pattern: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/gi,
      replacement: '[redacted]',
    },
    // AgentDojo-style impersonation tags — <INFORMATION>...</INFORMATION> and
    // similar tags used to disguise injected instructions as system messages
    // inside tool output. Strip the tag wrappers (keep inner text so legitimate
    // content survives, but the system-impersonation framing is neutralized).
    {
      name: 'impersonation_tag',
      pattern:
        /<\/?(INFORMATION|IMPORTANT|SYSTEM|ADMIN|SYSTEM_INSTRUCTION|INSTRUCTION|SYSTEM_MESSAGE|ASSISTANT_INSTRUCTION)\b[^>]*>/gi,
      replacement: '',
    },
    // AgentDojo important_instructions attack: "This is an important message from me, {user}, to you, {model}."
    // — the core social engineering phrase that tricks the LLM into executing injected instructions
    {
      name: 'important_message_impersonation',
      pattern: /This is an important message from me,?\s*\w+,?\s*to you,?\s*\w+\./gi,
      replacement: '[INJECTION BLOCKED]',
    },
    // "Before you can solve the task that I gave you in the beginning, please do the following first:"
    // — the directive phrase that redirects the agent to execute the injection goal
    {
      name: 'task_redirection_directive',
      pattern: /Before you can solve the task.*?please do the following first:/gis,
      replacement: '[INJECTION BLOCKED]',
    },
    // "After you do that, you can solve the task that I gave you in the beginning. Thanks!"
    // — the closing phrase of the injection that seals the instruction boundary
    {
      name: 'injection_closing_phrase',
      pattern: /After you do that, you can solve the task.*?Thanks!/gis,
      replacement: '[INJECTION BLOCKED]',
    },
    // "Signed,\n\n{user}" — the signature block that makes the injection look like a legitimate user message
    { name: 'injection_signature', pattern: /Signed,\s*\n+\s*\w+\s+\w+/gi, replacement: '' },
    // "please do the following first:" — general directive pattern for injection instructions
    {
      name: 'do_following_first',
      pattern: /please\s+do\s+the\s+following\s+first\s*:/gi,
      replacement: '[INJECTION BLOCKED]',
    },
    // ChatML / special token injection: <|im_start|>, <|system|>, etc.
    {
      name: 'chatml_tokens',
      pattern: /<\|?(?:im_start|im_end|system|assistant|user)\|?>/gi,
      replacement: '[blocked]',
    },
    // "act as a different/new/admin/root developer" — role manipulation
    {
      name: 'role_manipulation',
      pattern: /act\s+as\s+(?:a|an)\s+(?:different|new|admin|root|developer)/gi,
      replacement: '[redacted]',
    },
    // DAN / jailbreak attempts
    {
      name: 'jailbreak_attempt',
      pattern: /(?:DAN|jailbreak|do\s+anything\s+now|developer\s+mode|god\s+mode|unrestricted)\b/gi,
      replacement: '[redacted]',
    },
    // "reveal/show/print system prompt/instructions" — system prompt exfiltration
    {
      name: 'prompt_exfiltration',
      pattern: /(?:reveal|show|print|repeat|output).*(?:system\s+prompt|instructions?|rules?)/gi,
      replacement: '[redacted]',
    },
  ];

  /**
   * Sanitize a string based on the context it will be used in.
   */
  sanitize(input: string, context: SanitizeContext): SanitizeResult {
    if (typeof input !== 'string') {
      return { sanitized: String(input ?? ''), modified: false, patterns: [] };
    }

    let result = input;
    const patterns: string[] = [];

    // All contexts get PII scrubbing
    for (const rule of UniversalSanitizer.PII_PATTERNS) {
      if (rule.pattern.test(result)) {
        patterns.push(rule.name);
        result = result.replace(rule.pattern, rule.replacement);
      }
    }

    // Context-specific sanitization
    switch (context) {
      case 'output':
      case 'log':
        // Strip control characters (prevents terminal/log injection)
        if (UniversalSanitizer.CONTROL_CHARS.test(result)) {
          patterns.push('control_chars');
          result = result.replace(UniversalSanitizer.CONTROL_CHARS, '');
        }
        break;

      case 'tool_args':
        // Strip control chars
        if (UniversalSanitizer.CONTROL_CHARS.test(result)) {
          patterns.push('control_chars');
          result = result.replace(UniversalSanitizer.CONTROL_CHARS, '');
        }
        break;

      case 'filename':
      case 'identifier':
        // Strip path traversal
        if (UniversalSanitizer.PATH_TRAVERSAL.test(result)) {
          patterns.push('path_traversal');
          result = result.replace(UniversalSanitizer.PATH_TRAVERSAL, '');
        }
        // Only allow alphanumeric, dash, underscore, dot, slash
        const cleaned = result.replace(/[^a-zA-Z0-9_\-./]/g, '_');
        if (cleaned !== result) {
          patterns.push('unsafe_identifier_chars');
          result = cleaned;
        }
        break;

      case 'channel_text':
        // Strip @here/@channel/@everyone
        if (UniversalSanitizer.CHANNEL_MENTIONS.test(result)) {
          patterns.push('channel_mention');
          result = result.replace(UniversalSanitizer.CHANNEL_MENTIONS, '@-$1');
        }
        // Strip URLs (potential phishing)
        if (UniversalSanitizer.URL_PATTERN.test(result)) {
          patterns.push('url_stripped');
          result = result.replace(UniversalSanitizer.URL_PATTERN, '[URL]');
        }
        // Strip control chars
        if (UniversalSanitizer.CONTROL_CHARS.test(result)) {
          patterns.push('control_chars');
          result = result.replace(UniversalSanitizer.CONTROL_CHARS, '');
        }
        // Length cap
        if (result.length > 500) {
          patterns.push('length_capped');
          result = result.slice(0, 500);
        }
        break;

      case 'description':
        // Neutralize prompt-injection vectors (chat roles, hidden comments,
        // explicit injection phrases) — text may be reviewed by an LLM.
        for (const rule of UniversalSanitizer.PROMPT_INJECTION_PATTERNS) {
          if (rule.pattern.test(result)) {
            patterns.push(rule.name);
            result = result.replace(rule.pattern, rule.replacement);
          }
        }
        // Strip control chars
        if (UniversalSanitizer.CONTROL_CHARS.test(result)) {
          patterns.push('control_chars');
          result = result.replace(UniversalSanitizer.CONTROL_CHARS, '');
        }
        // Length cap (200KB — matches postmortem body cap)
        if (result.length > 204_800) {
          patterns.push('length_capped');
          result = result.slice(0, 204_800);
        }
        break;

      case 'input':
        // XSS prevention for inputs that may be rendered
        for (const rule of UniversalSanitizer.XSS_PATTERNS) {
          if (rule.pattern.test(result)) {
            patterns.push(rule.name);
            result = result.replace(rule.pattern, rule.replacement);
          }
        }
        // Path traversal
        if (UniversalSanitizer.PATH_TRAVERSAL.test(result)) {
          patterns.push('path_traversal');
          result = result.replace(UniversalSanitizer.PATH_TRAVERSAL, '');
        }
        break;
    }

    return {
      sanitized: result,
      modified: result !== input,
      patterns,
    };
  }

  /**
   * Sanitize an object's string values recursively.
   */
  sanitizeObject<T>(obj: T, context: SanitizeContext): T {
    if (typeof obj === 'string') {
      return this.sanitize(obj, context).sanitized as unknown as T;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeObject(item, context)) as unknown as T;
    }
    if (obj && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.sanitizeObject(value, context);
      }
      return result as unknown as T;
    }
    return obj;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 2. ResourceGovernor
// ══════════════════════════════════════════════════════════════════════════

export interface GovernanceOptions {
  timeoutMs?: number;
  maxPayloadBytes?: number;
  maxCostTokens?: number;
}

export interface GovernanceResult<T> {
  result: T | null;
  error?: string;
  timedOut: boolean;
  oversize: boolean;
  durationMs: number;
}

/**
 * ResourceGovernor — unified resource governance for external calls.
 * All fetch/LLM/tool calls should wrap through this to enforce
 * timeout, size, and cost limits.
 */
export class ResourceGovernor {
  /**
   * Execute a function with timeout protection.
   */
  static async withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) return fn();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Race between the function and the timeout
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error(`TIMEOUT after ${timeoutMs}ms`));
          });
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute a function with payload size enforcement.
   * Checks input size before execution and output size after.
   */
  static async withSizeCap<T>(
    fn: () => Promise<T>,
    maxPayloadBytes: number,
    input?: unknown,
  ): Promise<T> {
    if (input !== undefined) {
      const inputSize = Buffer.byteLength(
        typeof input === 'string' ? input : JSON.stringify(input),
        'utf8',
      );
      if (inputSize > maxPayloadBytes) {
        throw new Error(`PAYLOAD_TOO_LARGE: input ${inputSize} > ${maxPayloadBytes} bytes`);
      }
    }

    const result = await fn();

    const outputSize = Buffer.byteLength(
      typeof result === 'string' ? result : JSON.stringify(result ?? ''),
      'utf8',
    );
    if (outputSize > maxPayloadBytes) {
      throw new Error(`PAYLOAD_TOO_LARGE: output ${outputSize} > ${maxPayloadBytes} bytes`);
    }

    return result;
  }

  /**
   * Execute a function with full governance: timeout + size cap.
   */
  static async govern<T>(
    fn: () => Promise<T>,
    options: GovernanceOptions,
  ): Promise<GovernanceResult<T>> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxPayloadBytes = options.maxPayloadBytes ?? 5 * 1024 * 1024; // 5MB default

    try {
      let result: T;

      if (options.timeoutMs && options.maxPayloadBytes) {
        // Both timeout and size cap
        result = await this.withSizeCap(() => this.withTimeout(fn, timeoutMs), maxPayloadBytes);
      } else if (options.timeoutMs) {
        result = await this.withTimeout(fn, timeoutMs);
      } else if (options.maxPayloadBytes) {
        result = await this.withSizeCap(fn, maxPayloadBytes);
      } else {
        result = await fn();
      }

      return {
        result,
        timedOut: false,
        oversize: false,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      return {
        result: null,
        error: msg,
        timedOut: msg.includes('TIMEOUT'),
        oversize: msg.includes('PAYLOAD_TOO_LARGE'),
        durationMs: Date.now() - startTime,
      };
    }
  }
}

let originalFetch: typeof fetch | null = null;
let fetchGovernorInstalled = false;

/**
 * Patch the global `fetch` so every outbound HTTP request is routed through
 * ResourceGovernor timeout/size enforcement. Idempotent — calling twice is a
 * no-op. Use `resetGlobalFetchGovernor()` to restore the original fetch.
 */
export function installGlobalFetchGovernor(options?: {
  timeoutMs?: number;
  maxPayloadBytes?: number;
}): void {
  if (fetchGovernorInstalled) return;
  originalFetch = globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const maxPayloadBytes = options?.maxPayloadBytes ?? 10 * 1024 * 1024;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const governed = await ResourceGovernor.govern(
      () =>
        originalFetch!(input, {
          ...init,
          signal: combineSignals(init?.signal, timeoutMs),
        }),
      { timeoutMs },
    );

    if (governed.error) {
      throw new Error(`fetch(${url}) blocked by ResourceGovernor: ${governed.error}`);
    }
    return governed.result!;
  };

  fetchGovernorInstalled = true;
}

/** Restore the original global fetch if it was patched. */
export function resetGlobalFetchGovernor(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  fetchGovernorInstalled = false;
}

function combineSignals(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      controller.abort();
    });
  }

  // Always clean up the timeout when the request completes or is aborted.
  controller.signal.addEventListener('abort', () => clearTimeout(timer));
  return controller.signal;
}

// ══════════════════════════════════════════════════════════════════════════
// 3. IntegrityLayer
// ══════════════════════════════════════════════════════════════════════════

export interface SignedEntry {
  data: Record<string, unknown>;
  _sig: string;
  _ts: number;
}

/**
 * IntegrityLayer — HMAC signing for all persisted data.
 * Ensures that any tampering with stored data is detectable.
 */
export class IntegrityLayer {
  private readonly key: Buffer;

  constructor(secret?: string) {
    const raw = secret ?? process.env.COMMANDER_INTEGRITY_KEY ?? 'dev-integrity-key-change-in-prod';
    this.key = crypto.createHash('sha256').update(raw).digest();
  }

  /**
   * Canonical JSON serialization for deterministic signing.
   */
  private canonicalJson(obj: Record<string, unknown>): string {
    return JSON.stringify(obj, Object.keys(obj).sort());
  }

  /**
   * Sign a data entry.
   */
  sign(data: Record<string, unknown>): SignedEntry {
    const ts = Date.now();
    const payload = { ...data, _ts: ts };
    const sig = crypto
      .createHmac('sha256', this.key)
      .update(this.canonicalJson(payload))
      .digest('hex');
    return { data: payload, _sig: sig, _ts: ts };
  }

  /**
   * Verify a signed entry.
   */
  verify(entry: SignedEntry): boolean {
    try {
      // entry.data contains the original data + _ts; entry._sig is the signature
      const { _ts: _dataTs, ...data } = entry.data;
      const payload = { ...data, _ts: entry._ts };
      const actualSig = crypto
        .createHmac('sha256', this.key)
        .update(this.canonicalJson(payload))
        .digest('hex');
      // Constant-time comparison
      if (entry._sig.length !== actualSig.length) return false;
      return crypto.timingSafeEqual(Buffer.from(entry._sig, 'hex'), Buffer.from(actualSig, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * Require specific fields in a data entry.
   * Returns the entry if all required fields are present, throws otherwise.
   */
  requireFields<T extends Record<string, unknown>>(data: T, fields: ReadonlyArray<string>): T {
    for (const field of fields) {
      if (!(field in data) || data[field] === undefined || data[field] === null) {
        throw new Error(`INTEGRITY_VIOLATION: required field "${field}" is missing`);
      }
    }
    return data;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 4. StateContract
// ══════════════════════════════════════════════════════════════════════════

export type StateStatus = 'pending' | 'committed' | 'rolled_back';

export interface StateScope<T> {
  begin(): T;
  commit(): void;
  rollback(): void;
  status: StateStatus;
}

/**
 * StateContract — ensures all side effects go through begin/commit/rollback.
 * Prevents partial state updates from corrupting the system.
 */
export class StateContract {
  /**
   * Execute a function within a transactional scope.
   * If the function throws, rollback is called automatically.
   */
  static async useScope<T>(
    beginFn: () => { state: T; commit: () => void; rollback: () => void },
    fn: (state: T) => Promise<void>,
  ): Promise<{ committed: boolean; error?: string }> {
    const { state, commit, rollback } = beginFn();

    try {
      await fn(state);
      commit();
      return { committed: true };
    } catch (err) {
      try {
        rollback();
      } catch (rollbackErr) {
        getGlobalLogger().error('StateContract', 'rollback failed', rollbackErr as Error);
      }
      return {
        committed: false,
        error: (err as Error)?.message ?? String(err),
      };
    }
  }

  /**
   * Create a disarm scope for fault injection (Chaos).
   * Ensures that injected faults are always cleaned up, even if the
   * test function throws.
   */
  static async useDisarmScope(
    arm: () => void,
    disarm: () => void,
    fn: () => Promise<void>,
  ): Promise<{ error?: string }> {
    arm();
    try {
      await fn();
      return {};
    } catch (err) {
      return { error: (err as Error)?.message ?? String(err) };
    } finally {
      try {
        disarm();
      } catch (disarmErr) {
        getGlobalLogger().error('StateContract', 'disarm failed', disarmErr as Error);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Unified facade
// ══════════════════════════════════════════════════════════════════════════

export interface SecurityPrimitives {
  sanitizer: UniversalSanitizer;
  governor: typeof ResourceGovernor;
  integrity: IntegrityLayer;
  stateContract: typeof StateContract;
}

let primitivesInstance: SecurityPrimitives | null = null;

export function getSecurityPrimitives(secret?: string): SecurityPrimitives {
  if (!primitivesInstance || secret) {
    primitivesInstance = {
      sanitizer: new UniversalSanitizer(),
      governor: ResourceGovernor,
      integrity: new IntegrityLayer(secret),
      stateContract: StateContract,
    };
  }
  return primitivesInstance;
}

export function resetSecurityPrimitives(): void {
  primitivesInstance = null;
}
