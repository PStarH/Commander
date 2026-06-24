import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export interface VCREntry {
  request: LLMRequest;
  response: LLMResponse;
  recordedAt: string;
  hash: string;
}

export interface VCRCassette {
  name: string;
  version: 1;
  recordedAt: string;
  entries: VCREntry[];
}

export interface VCRConfig {
  cassetteDir: string;
  mode: 'record' | 'replay' | 'passthrough';
  hashAlgorithm?: string;
  matchByContent?: boolean;
}

function hashRequest(request: LLMRequest, algo: string): string {
  const canonical = JSON.stringify({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    tools: request.tools,
  });
  return crypto.createHash(algo).update(canonical).digest('hex');
}

function messagesMatch(a: LLMMessage[], b: LLMMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].role !== b[i].role || a[i].content !== b[i].content) return false;
  }
  return true;
}

type LLMMessage = { role: string; content: string };

export class VCRProvider implements LLMProvider {
  readonly name: string;
  private wrapped: LLMProvider;
  private config: VCRConfig;
  private cassette: VCRCassette;
  private cassettePath: string;
  private hitCount = 0;
  private missCount = 0;

  constructor(wrapped: LLMProvider, config: VCRConfig) {
    this.name = `vcr:${wrapped.name}`;
    this.wrapped = wrapped;
    this.config = {
      hashAlgorithm: 'sha256',
      matchByContent: true,
      ...config,
    };
    this.cassettePath = path.join(
      this.config.cassetteDir,
      `${this.sanitizeName(wrapped.name)}.json`,
    );
    this.cassette = this.loadCassette();
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (this.config.mode === 'replay') {
      const cached = this.findMatch(request);
      if (cached) {
        this.hitCount++;
        return cached.response;
      }
      this.missCount++;
      throw new Error(
        `VCR: no cassette match for model="${request.model}" (hash=${hashRequest(request, this.config.hashAlgorithm!)})`,
      );
    }

    if (this.config.mode === 'record') {
      const response = await this.wrapped.call(request);
      this.recordEntry(request, response);
      return response;
    }

    return this.wrapped.call(request);
  }

  getStats(): { hits: number; misses: number; entries: number } {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      entries: this.cassette.entries.length,
    };
  }

  getCassette(): VCRCassette {
    return { ...this.cassette };
  }

  clearStats(): void {
    this.hitCount = 0;
    this.missCount = 0;
  }

  private findMatch(request: LLMRequest): VCREntry | undefined {
    if (this.config.matchByContent) {
      return this.cassette.entries.find(
        (e) =>
          e.request.model === request.model && messagesMatch(e.request.messages, request.messages),
      );
    }
    const hash = hashRequest(request, this.config.hashAlgorithm!);
    return this.cassette.entries.find((e) => e.hash === hash);
  }

  private recordEntry(request: LLMRequest, response: LLMResponse): void {
    const hash = hashRequest(request, this.config.hashAlgorithm!);
    const existing = this.cassette.entries.findIndex((e) => e.hash === hash);
    const entry: VCREntry = {
      request,
      response,
      recordedAt: new Date().toISOString(),
      hash,
    };
    if (existing >= 0) {
      this.cassette.entries[existing] = entry;
    } else {
      this.cassette.entries.push(entry);
    }
    this.saveCassette();
  }

  private loadCassette(): VCRCassette {
    try {
      if (fs.existsSync(this.cassettePath)) {
        const raw = fs.readFileSync(this.cassettePath, 'utf-8');
        return JSON.parse(raw) as VCRCassette;
      }
    } catch (err) {
      console.warn('[Catch]', err);
      // corrupt cassette → start fresh
    }
    return {
      name: this.wrapped.name,
      version: 1,
      recordedAt: new Date().toISOString(),
      entries: [],
    };
  }

  private saveCassette(): void {
    fs.mkdirSync(path.dirname(this.cassettePath), { recursive: true });
    this.cassette.recordedAt = new Date().toISOString();
    fs.writeFileSync(this.cassettePath, JSON.stringify(this.cassette, null, 2));
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }
}

export function createVCRProvider(
  wrapped: LLMProvider,
  cassetteDir: string,
  mode: 'record' | 'replay' | 'passthrough' = 'replay',
): VCRProvider {
  return new VCRProvider(wrapped, { cassetteDir, mode });
}
