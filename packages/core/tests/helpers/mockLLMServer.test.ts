/**
 * Tests for MockLLMServer — request introspection and invariant validation.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  MockLLMServer,
  CapturedRequest,
  validateRequestInvariants,
  type ParsedMessage,
  type InvariantViolation,
} from './mockLLMServer';

describe('CapturedRequest', () => {
  function makeRequest(messages: ParsedMessage[], extra?: Record<string, unknown>): CapturedRequest {
    return new CapturedRequest(
      Date.now(),
      { model: 'test-model', messages, stream: false, ...extra },
      { 'content-type': 'application/json' },
    );
  }

  // ── Basic properties ──────────────────────────────────────────────────────

  describe('basic properties', () => {
    it('exposes model', () => {
      const req = makeRequest([], { model: 'gpt-4' });
      assert.strictEqual(req.model, 'gpt-4');
    });

    it('exposes stream flag', () => {
      const reqFalse = makeRequest([]);
      assert.strictEqual(reqFalse.stream, false);

      const reqTrue = new CapturedRequest(Date.now(), { stream: true }, {});
      assert.strictEqual(reqTrue.stream, true);
    });

    it('exposes temperature', () => {
      const req = makeRequest([], { temperature: 0.7 });
      assert.strictEqual(req.temperature, 0.7);
    });

    it('exposes tools', () => {
      const tools = [{ function: { name: 'web_search' } }];
      const req = makeRequest([], { tools });
      assert.deepStrictEqual(req.tools, tools);
    });
  });

  // ── Message introspection ─────────────────────────────────────────────────

  describe('message introspection', () => {
    const messages: ParsedMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'Search for AI papers' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"AI papers"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'Found 10 papers' },
      { role: 'assistant', content: 'I found 10 papers about AI.' },
    ];

    it('returns all messages', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.messages.length, 7);
    });

    it('filters messages by role', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.messagesByRole('system').length, 1);
      assert.strictEqual(req.messagesByRole('user').length, 2);
      assert.strictEqual(req.messagesByRole('assistant').length, 3);
      assert.strictEqual(req.messagesByRole('tool').length, 1);
    });

    it('extracts system prompt', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.systemPrompt(), 'You are a helpful assistant.');
    });

    it('extracts user messages', () => {
      const req = makeRequest(messages);
      assert.deepStrictEqual(req.userMessages(), ['Hello', 'Search for AI papers']);
    });

    it('extracts last user message', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.lastUserMessage(), 'Search for AI papers');
    });

    it('returns undefined for lastUserMessage when no user messages', () => {
      const req = makeRequest([{ role: 'system', content: 'hi' }]);
      assert.strictEqual(req.lastUserMessage(), undefined);
    });

    it('extracts assistant texts (excluding tool-call-only)', () => {
      const req = makeRequest(messages);
      assert.deepStrictEqual(req.assistantTexts(), ['Hi there!', 'I found 10 papers about AI.']);
    });
  });

  // ── Tool call introspection ───────────────────────────────────────────────

  describe('tool call introspection', () => {
    const messages: ParsedMessage[] = [
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"AI"}' } },
        { id: 'call_2', type: 'function', function: { name: 'file_read', arguments: '{"path":"/tmp/test"}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'results' },
      { role: 'tool', tool_call_id: 'call_2', name: 'file_read', content: 'file contents' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_3', type: 'function', function: { name: 'web_search', arguments: '{"q":"ML"}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_3', name: 'web_search', content: 'more results' },
    ];

    it('returns all tool calls', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.allToolCalls().length, 3);
    });

    it('checks if a tool was called', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.hasToolCall('web_search'), true);
      assert.strictEqual(req.hasToolCall('file_read'), true);
      assert.strictEqual(req.hasToolCall('nonexistent'), false);
    });

    it('gets tool calls by name', () => {
      const req = makeRequest(messages);
      const searches = req.toolCallsByName('web_search');
      assert.strictEqual(searches.length, 2);
      assert.strictEqual(searches[0].id, 'call_1');
      assert.strictEqual(searches[1].id, 'call_3');
    });

    it('gets tool call by id', () => {
      const req = makeRequest(messages);
      const tc = req.toolCallById('call_2');
      assert.ok(tc);
      assert.strictEqual(tc.name, 'file_read');
      assert.strictEqual(tc.arguments, '{"path":"/tmp/test"}');
    });

    it('returns undefined for nonexistent call id', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.toolCallById('nonexistent'), undefined);
    });
  });

  // ── Tool output introspection ─────────────────────────────────────────────

  describe('tool output introspection', () => {
    const messages: ParsedMessage[] = [
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'file_read', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'search results' },
      { role: 'tool', tool_call_id: 'call_2', name: 'file_read', content: 'file data' },
    ];

    it('returns all tool outputs', () => {
      const req = makeRequest(messages);
      const outputs = req.allToolOutputs();
      assert.strictEqual(outputs.length, 2);
      assert.strictEqual(outputs[0].tool_call_id, 'call_1');
      assert.strictEqual(outputs[0].content, 'search results');
    });

    it('gets tool output by call_id', () => {
      const req = makeRequest(messages);
      assert.strictEqual(req.toolOutputByCallId('call_1'), 'search results');
      assert.strictEqual(req.toolOutputByCallId('call_2'), 'file data');
      assert.strictEqual(req.toolOutputByCallId('nonexistent'), undefined);
    });

    it('gets tool outputs by name', () => {
      const req = makeRequest(messages);
      assert.deepStrictEqual(req.toolOutputsByName('web_search'), ['search results']);
      assert.deepStrictEqual(req.toolOutputsByName('file_read'), ['file data']);
      assert.deepStrictEqual(req.toolOutputsByName('nonexistent'), []);
    });
  });

  // ── Requested tools ───────────────────────────────────────────────────────

  describe('requested tools', () => {
    it('returns requested tool names', () => {
      const req = makeRequest([], {
        tools: [
          { function: { name: 'web_search' } },
          { function: { name: 'file_read' } },
        ],
      });
      assert.deepStrictEqual(req.requestedToolNames(), ['web_search', 'file_read']);
    });

    it('checks if tool was requested', () => {
      const req = makeRequest([], {
        tools: [{ function: { name: 'web_search' } }],
      });
      assert.strictEqual(req.hasRequestedTool('web_search'), true);
      assert.strictEqual(req.hasRequestedTool('file_read'), false);
    });

    it('returns empty array when no tools', () => {
      const req = makeRequest([]);
      assert.deepStrictEqual(req.requestedToolNames(), []);
    });
  });
});

// ── Invariant Validation ────────────────────────────────────────────────────

describe('validateRequestInvariants', () => {
  function makeRequest(messages: ParsedMessage[]): CapturedRequest {
    return new CapturedRequest(Date.now(), { model: 'test', messages }, {});
  }

  it('passes for well-formed request', () => {
    const req = makeRequest([
      { role: 'user', content: 'search' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'results' },
      { role: 'assistant', content: 'Found results.' },
    ]);
    const violations = validateRequestInvariants(req);
    assert.strictEqual(violations.length, 0);
  });

  it('detects orphaned tool output (output without matching call)', () => {
    const req = makeRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', tool_call_id: 'call_orphan', name: 'unknown', content: 'data' },
    ]);
    const violations = validateRequestInvariants(req);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].type, 'orphaned_output');
    assert.ok(violations[0].message.includes('call_orphan'));
  });

  it('detects missing tool output (call without matching output)', () => {
    const req = makeRequest([
      { role: 'user', content: 'search' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'file_read', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'results' },
      // call_2 has no output!
    ]);
    const violations = validateRequestInvariants(req);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].type, 'missing_output');
    assert.ok(violations[0].message.includes('call_2'));
  });

  it('detects multiple violations', () => {
    const req = makeRequest([
      { role: 'user', content: 'test' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', name: 'tool_a', content: 'ok' },
      { role: 'tool', tool_call_id: 'call_orphan', name: 'tool_b', content: 'orphan' },
    ]);
    const violations = validateRequestInvariants(req);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].type, 'orphaned_output');
  });

  it('passes for single-message request with no tool calls', () => {
    const req = makeRequest([
      { role: 'user', content: 'hello' },
    ]);
    const violations = validateRequestInvariants(req);
    assert.strictEqual(violations.length, 0);
  });

  it('passes for empty messages', () => {
    const req = makeRequest([]);
    const violations = validateRequestInvariants(req);
    assert.strictEqual(violations.length, 0);
  });
});

// ── MockLLMServer Invariant Integration ─────────────────────────────────────

describe('MockLLMServer invariant validation', () => {
  let server: MockLLMServer;

  beforeEach(async () => {
    server = new MockLLMServer({ validateInvariants: true });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('captures invariant violations from requests', async () => {
    server.enqueueResponse({ content: 'ok' });

    // Send a request with orphaned tool output
    const body = JSON.stringify({
      model: 'test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'tool', tool_call_id: 'orphan_call', name: 'unknown', content: 'data' },
      ],
    });

    const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.strictEqual(res.status, 200);

    const violations = server.getInvariantViolations();
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].type, 'orphaned_output');
  });

  it('calls onInvariantViolation callback', async () => {
    let callbackViolations: InvariantViolation[] = [];
    server = new MockLLMServer({
      validateInvariants: true,
      onInvariantViolation: (v) => { callbackViolations = v; },
    });
    await server.start();
    server.enqueueResponse({ content: 'ok' });

    const body = JSON.stringify({
      model: 'test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'orphan', name: 'x', content: 'y' },
      ],
    });

    await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    assert.strictEqual(callbackViolations.length, 1);
    assert.strictEqual(callbackViolations[0].type, 'orphaned_output');
  });

  it('skips validation when disabled', async () => {
    server = new MockLLMServer({ validateInvariants: false });
    await server.start();
    server.enqueueResponse({ content: 'ok' });

    const body = JSON.stringify({
      model: 'test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'orphan', name: 'x', content: 'y' },
      ],
    });

    await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    assert.strictEqual(server.getInvariantViolations().length, 0);
  });
});

// ── MockLLMServer Request Capture ───────────────────────────────────────────

describe('MockLLMServer request capture', () => {
  let server: MockLLMServer;

  beforeEach(async () => {
    server = new MockLLMServer({ validateInvariants: false });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('captures requests with deep introspection', async () => {
    server.enqueueResponse({ content: 'ok' });

    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
      ],
      tools: [{ function: { name: 'web_search' } }],
    });

    await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const req = server.lastRequest()!;
    assert.ok(req);
    assert.strictEqual(req.model, 'gpt-4');
    assert.strictEqual(req.systemPrompt(), 'Be helpful');
    assert.strictEqual(req.lastUserMessage(), 'Hello');
    assert.deepStrictEqual(req.requestedToolNames(), ['web_search']);
  });

  it('lastRequest returns most recent', async () => {
    server.enqueueResponse({ content: 'ok' });
    server.enqueueResponse({ content: 'ok' });

    await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'first' }] }),
    });

    await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm2', messages: [{ role: 'user', content: 'second' }] }),
    });

    assert.strictEqual(server.lastRequest()!.model, 'm2');
    assert.strictEqual(server.lastRequest()!.lastUserMessage(), 'second');
  });
});
