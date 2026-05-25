import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import { getMessageBus } from '../../src/runtime/messageBus';
import { SSEStream } from '../../src/runtime/sseStream';
import type { MessageBusTopic } from '../../src/runtime/types';

describe('Tool Lifecycle Events', () => {
  let bus: MessageBus;

  beforeEach(() => {
    resetMessageBus();
    bus = new MessageBus(100);
  });

  // ============================================================================
  // MessageBus tool lifecycle event publishing
  // ============================================================================

  it('publishes tool.started with correct payload', () => {
    const received: Array<{ topic: MessageBusTopic; payload: unknown }> = [];
    bus.subscribe('tool.started', (msg) => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });

    const payload = { runId: 'run-1', toolName: 'file_read', args: { path: '/test.txt' } };
    bus.publish('tool.started', 'agent-1', payload);
    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'tool.started');
    assert.deepEqual(received[0].payload, payload);
    assert.equal(received[0].payload['toolName'], 'file_read');
  });

  it('publishes tool.completed with correct payload', () => {
    const received: Array<{ topic: MessageBusTopic; payload: unknown }> = [];
    bus.subscribe('tool.completed', (msg) => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });

    const payload = { runId: 'run-1', toolName: 'file_read', durationMs: 42 };
    bus.publish('tool.completed', 'agent-1', payload);
    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'tool.completed');
    assert.equal(received[0].payload['toolName'], 'file_read');
    assert.equal(received[0].payload['durationMs'], 42);
  });

  it('publishes tool.timeout with correct payload', () => {
    const received: Array<{ topic: MessageBusTopic; payload: unknown }> = [];
    bus.subscribe('tool.timeout', (msg) => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });

    const payload = { runId: 'run-1', toolName: 'web_search', timeoutMs: 5000, durationMs: 5123 };
    bus.publish('tool.timeout', 'agent-1', payload);
    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'tool.timeout');
    assert.equal(received[0].payload['toolName'], 'web_search');
    assert.equal(received[0].payload['timeoutMs'], 5000);
  });

  it('publishes tool.retry with correct payload', () => {
    const received: Array<{ topic: MessageBusTopic; payload: unknown }> = [];
    bus.subscribe('tool.retry', (msg) => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });

    const payload = { runId: 'run-1', toolName: 'python_execute', attempts: 2 };
    bus.publish('tool.retry', 'agent-1', payload);
    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'tool.retry');
    assert.equal(received[0].payload['toolName'], 'python_execute');
    assert.equal(received[0].payload['attempts'], 2);
  });

  it('publishes tool.blocked with correct payload', () => {
    const received: Array<{ topic: MessageBusTopic; payload: unknown }> = [];
    bus.subscribe('tool.blocked', (msg) => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });

    const payload = { runId: 'run-1', toolName: 'shell_execute', reason: 'not_allowed', detail: 'Tool not in allowed list' };
    bus.publish('tool.blocked', 'agent-1', payload);
    assert.equal(received.length, 1);
    assert.equal(received[0].topic, 'tool.blocked');
    assert.equal(received[0].payload['reason'], 'not_allowed');
  });

  it('supports wildcard subscription for tool lifecycle events', () => {
    const received: string[] = [];
    bus.subscribe('*' as MessageBusTopic, (msg) => {
      received.push(msg.topic);
    });

    bus.publish('tool.started', 'agent-1', { toolName: 'test' });
    bus.publish('tool.completed', 'agent-1', { toolName: 'test' });
    bus.publish('tool.timeout', 'agent-1', { toolName: 'test' });
    bus.publish('tool.retry', 'agent-1', { toolName: 'test' });
    bus.publish('tool.blocked', 'agent-1', { toolName: 'test' });

    assert.ok(received.includes('tool.started'));
    assert.ok(received.includes('tool.completed'));
    assert.ok(received.includes('tool.timeout'));
    assert.ok(received.includes('tool.retry'));
    assert.ok(received.includes('tool.blocked'));
  });

  // ============================================================================
  // SSEStream tool lifecycle event relay
  // ============================================================================

  it('SSEStream delivers tool.started event from bus', () => {
    const stream = new SSEStream(['tool.started', 'tool.completed', 'tool.timeout', 'tool.retry', 'tool.blocked']);
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    const msgBus = getMessageBus();
    msgBus.publish('tool.started', 'agent-1', { runId: 'run-1', toolName: 'test' });

    assert.ok(events.length >= 1, 'Should receive tool.started event');
    assert.ok(events[0].includes('tool.started'), `Expected tool.started in event, got: ${events[0]}`);

    stream.close();
  });

  it('SSEStream delivers tool.completed event from bus', () => {
    const stream = new SSEStream(['tool.completed']);
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    const msgBus = getMessageBus();
    msgBus.publish('tool.completed', 'agent-1', { runId: 'run-1', toolName: 'test', durationMs: 100 });

    assert.ok(events.length >= 1);
    assert.ok(events[0].includes('tool.completed'));

    stream.close();
  });

  it('SSEStream delivers tool.timeout event from bus', () => {
    const stream = new SSEStream(['tool.timeout']);
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    const msgBus = getMessageBus();
    msgBus.publish('tool.timeout', 'agent-1', { runId: 'run-1', toolName: 'test', timeoutMs: 5000 });

    assert.ok(events.length >= 1);
    assert.ok(events[0].includes('tool.timeout'));

    stream.close();
  });

  it('SSEStream delivers tool.retry event from bus', () => {
    const stream = new SSEStream(['tool.retry']);
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    const msgBus = getMessageBus();
    msgBus.publish('tool.retry', 'agent-1', { runId: 'run-1', toolName: 'test', attempts: 2 });

    assert.ok(events.length >= 1);
    assert.ok(events[0].includes('tool.retry'));

    stream.close();
  });

  it('SSEStream delivers tool.blocked event from bus', () => {
    const stream = new SSEStream(['tool.blocked']);
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    const msgBus = getMessageBus();
    msgBus.publish('tool.blocked', 'agent-1', { runId: 'run-1', toolName: 'test', reason: 'not_allowed' });

    assert.ok(events.length >= 1);
    assert.ok(events[0].includes('tool.blocked'));

    stream.close();
  });

  it('SSEStream subscribes to all tool lifecycle topics by default', () => {
    const stream = new SSEStream(); // no explicit topics -> uses defaults
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    const msgBus = getMessageBus();
    msgBus.publish('tool.started', 'agent-1', { toolName: 'test' });
    msgBus.publish('tool.completed', 'agent-1', { toolName: 'test' });
    msgBus.publish('tool.timeout', 'agent-1', { toolName: 'test' });
    msgBus.publish('tool.retry', 'agent-1', { toolName: 'test' });
    msgBus.publish('tool.blocked', 'agent-1', { toolName: 'test' });

    const eventText = events.join(' ');
    assert.ok(eventText.includes('tool.started'), 'default subscription should include tool.started');
    assert.ok(eventText.includes('tool.completed'), 'default subscription should include tool.completed');
    assert.ok(eventText.includes('tool.timeout'), 'default subscription should include tool.timeout');
    assert.ok(eventText.includes('tool.retry'), 'default subscription should include tool.retry');
    assert.ok(eventText.includes('tool.blocked'), 'default subscription should include tool.blocked');

    stream.close();
  });

  // ============================================================================
  // Structured SSE event types
  // ============================================================================

  it('emitToolTimeout emits tool_call.timeout structured event', () => {
    const stream = new SSEStream();
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    stream.emitToolTimeout('file_read', { timeoutMs: 5000 });

    assert.ok(events.length >= 1);
    const dataLine = events[0].split('\n').find(l => l.startsWith('data: '));
    assert.ok(dataLine, 'Expected data line in SSE event');
    const parsed = JSON.parse(dataLine!.replace(/^data: /, ''));
    assert.equal(parsed.event, 'tool_call.timeout');
    assert.equal(parsed.data.toolName, 'file_read');
    assert.equal(parsed.data.timeoutMs, 5000);

    stream.close();
  });

  it('emitToolRetry emits tool_call.retry structured event', () => {
    const stream = new SSEStream();
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    stream.emitToolRetry('python_execute', 2, { error: 'timeout' });

    assert.ok(events.length >= 1);
    const dataLine = events[0].split('\n').find(l => l.startsWith('data: '));
    assert.ok(dataLine, 'Expected data line in SSE event');
    const parsed = JSON.parse(dataLine!.replace(/^data: /, ''));
    assert.equal(parsed.event, 'tool_call.retry');
    assert.equal(parsed.data.toolName, 'python_execute');
    assert.equal(parsed.data.attempt, 2);
    assert.equal(parsed.data.error, 'timeout');

    stream.close();
  });

  it('emitToolBlocked emits tool_call.blocked structured event', () => {
    const stream = new SSEStream();
    const events: string[] = [];
    stream.onEvent((event) => { events.push(event); });

    stream.emitToolBlocked('shell_execute', 'not_allowed', { detail: 'tool not in whitelist' });

    assert.ok(events.length >= 1);
    const dataLine = events[0].split('\n').find(l => l.startsWith('data: '));
    assert.ok(dataLine, 'Expected data line in SSE event');
    const parsed = JSON.parse(dataLine!.replace(/^data: /, ''));
    assert.equal(parsed.event, 'tool_call.blocked');
    assert.equal(parsed.data.toolName, 'shell_execute');
    assert.equal(parsed.data.reason, 'not_allowed');

    stream.close();
  });
});
