import { createHash } from 'node:crypto';
import type { LLMMessage } from './types';

// ============================================================================
// StablePrefix + AppendOnlyLog — P1 #6
//
// Goal: Maximize LLM provider prefix-cache hit ratio (Anthropic cache_control,
// OpenAI automatic caching, Gemini implicit cache, DeepSeek context cache).
//
// Pattern:
//   1. StablePrefix  = system prompt + tool definitions + governance profile.
//      Content here rarely changes mid-run. Providers cache this block cheaply.
//   2. AppendOnlyLog = conversation turns (user/assistant/tool) appended in order.
//      Each new turn is small relative to the prefix, so cached prefix re-bills
//      only the new tokens (90%+ cost reduction on long runs).
//
// Invariants:
//   - StablePrefix is IMMUTABLE after construction; to change, build a new one.
//   - AppendOnlyLog only appends; never re-orders, edits, or deletes prior turns.
//     Compaction replaces the log entirely (provider cache will be invalidated for
//     the post-compaction window, but the prefix is preserved).
// ============================================================================

export interface StablePrefixOptions {
  systemPrompt: string;
  toolDefinitions: Array<{
    name: string;
    description: string;
    parameters?: unknown;
  }>;
  governanceProfile?: string;
}

export class StablePrefix {
  readonly systemPrompt: string;
  readonly toolDefinitions: StablePrefixOptions['toolDefinitions'];
  readonly governanceProfile: string;
  readonly messages: LLMMessage[];
  readonly fingerprint: string;
  readonly hash: string;
  readonly totalChars: number;

  constructor(options: StablePrefixOptions) {
    this.systemPrompt = options.systemPrompt;
    this.toolDefinitions = options.toolDefinitions;
    this.governanceProfile = options.governanceProfile ?? '';
    this.messages = this.buildMessages();
    this.fingerprint = this.computeFingerprint();
    this.hash = createHash('sha256').update(this.fingerprint).digest('hex').slice(0, 16);
    this.totalChars = this.messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  private buildMessages(): LLMMessage[] {
    const out: LLMMessage[] = [];
    out.push({ role: 'system', content: this.systemPrompt });
    if (this.governanceProfile) {
      out.push({ role: 'system', content: `## Governance\n${this.governanceProfile}` });
    }
    if (this.toolDefinitions.length > 0) {
      const toolList = this.toolDefinitions
        .map((t) => `- \`${t.name}\`: ${t.description}`)
        .join('\n');
      out.push({ role: 'system', content: `## Available Tools\n${toolList}` });
    }
    return out;
  }

  private computeFingerprint(): string {
    const toolFp = this.toolDefinitions
      .map((t) => `${t.name}:${t.description.length}:${t.description.slice(0, 80)}`)
      .join('|');
    return `${this.systemPrompt.length}:${this.systemPrompt.slice(0, 80)}|tools=${this.toolDefinitions.length}|${toolFp}|gov=${this.governanceProfile.length}`;
  }

  matches(other: StablePrefix): boolean {
    return this.hash === other.hash && this.fingerprint === other.fingerprint;
  }
}

export class AppendOnlyLog {
  private entries: LLMMessage[] = [];

  append(message: LLMMessage | LLMMessage[]): void {
    if (Array.isArray(message)) {
      for (const m of message) this.appendOne(m);
    } else {
      this.appendOne(message);
    }
  }

  private appendOne(message: LLMMessage): void {
    if (!message || typeof message !== 'object') return;
    if (message.role !== 'system') {
      this.entries.push(message);
      return;
    }
    this.entries.push(message);
  }

  getAll(): readonly LLMMessage[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  last(n: number): LLMMessage[] {
    if (n <= 0) return [];
    return this.entries.slice(-n);
  }

  deltaFrom(from: number): LLMMessage[] {
    if (from < 0) from = 0;
    if (from >= this.entries.length) return [];
    return this.entries.slice(from);
  }

  replaceAll(messages: LLMMessage[]): void {
    this.entries = [...messages];
  }

  clear(): void {
    this.entries = [];
  }
}

export interface BuildRequestInput {
  prefix: StablePrefix;
  log: AppendOnlyLog;
}

export function buildCachedRequest(input: BuildRequestInput): {
  messages: LLMMessage[];
  prefixBoundary: number;
  cacheKey: string;
} {
  const messages = [...input.prefix.messages, ...input.log.getAll()];
  return {
    messages,
    prefixBoundary: input.prefix.messages.length,
    cacheKey: input.prefix.hash,
  };
}
