import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { VCRProvider, createVCRProvider } from '../../src/runtime/vcrProvider';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/runtime/types';

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  callCount = 0;
  private responses: LLMResponse[];

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    return this.responses[this.callCount - 1] ?? {
      content: 'default',
      model: request.model,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    };
  }
}

function makeRequest(model = 'gpt-4o'): LLMRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'hello' }],
  };
}

function makeResponse(content = 'hi'): LLMResponse {
  return {
    content,
    model: 'gpt-4o',
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    finishReason: 'stop',
  };
}

const CASSETTE_DIR = path.join(__dirname, '.vcr-test-cassettes');

describe('VCRProvider', () => {
  beforeEach(() => {
    fs.mkdirSync(CASSETTE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(CASSETTE_DIR, { recursive: true, force: true });
  });

  describe('record mode', () => {
    it('records request/response pairs to cassette', async () => {
      const stub = new StubProvider([makeResponse('recorded')]);
      const vcr = new VCRProvider(stub, { cassetteDir: CASSETTE_DIR, mode: 'record' });

      const result = await vcr.call(makeRequest());
      expect(result.content).toBe('recorded');
      expect(stub.callCount).toBe(1);

      const cassette = vcr.getCassette();
      expect(cassette.entries).toHaveLength(1);
      expect(cassette.entries[0].response.content).toBe('recorded');
    });

    it('deduplicates by request hash', async () => {
      const stub = new StubProvider([makeResponse('a'), makeResponse('b')]);
      const vcr = new VCRProvider(stub, { cassetteDir: CASSETTE_DIR, mode: 'record' });

      await vcr.call(makeRequest());
      await vcr.call(makeRequest());
      expect(vcr.getCassette().entries).toHaveLength(1);
      expect(stub.callCount).toBe(2);
    });
  });

  describe('replay mode', () => {
    it('replays from cassette without calling provider', async () => {
      const stub1 = new StubProvider([makeResponse('original')]);
      const vcr1 = new VCRProvider(stub1, { cassetteDir: CASSETTE_DIR, mode: 'record' });
      await vcr1.call(makeRequest());

      const stub2 = new StubProvider([makeResponse('should not be used')]);
      const vcr2 = new VCRProvider(stub2, { cassetteDir: CASSETTE_DIR, mode: 'replay' });
      const result = await vcr2.call(makeRequest());

      expect(result.content).toBe('original');
      expect(stub2.callCount).toBe(0);
    });

    it('throws on cache miss', async () => {
      const stub = new StubProvider([makeResponse()]);
      const vcr = new VCRProvider(stub, { cassetteDir: CASSETTE_DIR, mode: 'replay' });

      await expect(vcr.call(makeRequest())).rejects.toThrow('VCR: no cassette match');
    });

    it('tracks hit/miss stats', async () => {
      const stub1 = new StubProvider([makeResponse('ok')]);
      const vcr1 = new VCRProvider(stub1, { cassetteDir: CASSETTE_DIR, mode: 'record' });
      await vcr1.call(makeRequest());

      const stub2 = new StubProvider([makeResponse()]);
      const vcr2 = new VCRProvider(stub2, { cassetteDir: CASSETTE_DIR, mode: 'replay' });
      await vcr2.call(makeRequest());
      try { await vcr2.call(makeRequest('different-request')); } catch { /* expected miss */ }

      const stats = vcr2.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });
  });

  describe('passthrough mode', () => {
    it('passes through to wrapped provider', async () => {
      const stub = new StubProvider([makeResponse('passthrough')]);
      const vcr = new VCRProvider(stub, { cassetteDir: CASSETTE_DIR, mode: 'passthrough' });
      const result = await vcr.call(makeRequest());
      expect(result.content).toBe('passthrough');
      expect(stub.callCount).toBe(1);
    });
  });

  describe('createVCRProvider helper', () => {
    it('creates a VCRProvider with default replay mode', () => {
      const stub = new StubProvider([makeResponse()]);
      const vcr = createVCRProvider(stub, CASSETTE_DIR);
      expect(vcr.name).toBe('vcr:stub');
    });
  });
});
