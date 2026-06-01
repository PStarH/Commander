import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBus, resetMessageBus } from '../../src/runtime/messageBus';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    resetMessageBus();
    bus = new MessageBus(50);
  });

  // -----------------------------------------------------------------------
  // Publish / Subscribe basics
  // -----------------------------------------------------------------------

  it('publishes and delivers messages to subscribers', () => {
    const received: unknown[] = [];
    bus.subscribe('agent.message', (msg) => {
      received.push(msg.payload);
    });
    bus.publish('agent.message', 'agent-1', 'hello');
    assert.deepEqual(received, ['hello']);
  });

  it('broadcasts to multiple subscribers on the same topic', () => {
    let count = 0;
    bus.subscribe('agent.message', () => count++);
    bus.subscribe('agent.message', () => count++);
    bus.publish('agent.message', 'agent-1', 'hello');
    assert.equal(count, 2);
  });

  it('does not deliver to subscribers on other topics', () => {
    let called = false;
    bus.subscribe('system.alert', () => { called = true; });
    bus.publish('agent.message', 'agent-1', 'hi');
    assert.equal(called, false);
  });

  // -----------------------------------------------------------------------
  // Unsubscribe
  // -----------------------------------------------------------------------

  it('supports unsubscribe via returned function', () => {
    let count = 0;
    const unsub = bus.subscribe('agent.message', () => count++);
    bus.publish('agent.message', 'agent-1', 'first');
    unsub();
    bus.publish('agent.message', 'agent-1', 'second');
    assert.equal(count, 1);
  });

  it('unsubscribe is safe to call twice', () => {
    let count = 0;
    const unsub = bus.subscribe('agent.message', () => count++);
    unsub();
    // Second call should not throw
    assert.doesNotThrow(() => unsub());
  });

  it('removes topic from active topics when last subscriber unsubscribes', () => {
    const unsub = bus.subscribe('agent.message', () => {});
    assert.ok(bus.getActiveTopics().includes('agent.message'));
    unsub();
    // Topic should no longer appear in active topics (unless it had published messages)
    // Note: publishing also adds topics, so verify only after subscribe+unsubscribe
    const topics = bus.getActiveTopics();
    // After unsub, the topic was removed from subscriber map.
    // If nothing was published, it should not appear.
    // But topic was added during subscribe — after unsub it's cleaned up.
    assert.ok(!topics.includes('agent.message'));
  });

  // -----------------------------------------------------------------------
  // subscribeMany
  // -----------------------------------------------------------------------

  it('subscribes to multiple topics at once', () => {
    const received: string[] = [];
    const unsub = bus.subscribeMany(['agent.message', 'system.alert'], (msg) => {
      received.push(msg.topic);
    });
    bus.publish('agent.message', 'agent-1', 'hi');
    bus.publish('system.alert', 'system', 'alert!');
    assert.deepEqual(received, ['agent.message', 'system.alert']);
    unsub();
    bus.publish('agent.message', 'agent-1', 'should not appear');
    assert.equal(received.length, 2);
  });

  // -----------------------------------------------------------------------
  // Wildcard subscribers
  // -----------------------------------------------------------------------

  it('wildcard subscriber receives messages from all topics', () => {
    const received: string[] = [];
    bus.subscribe('*', (msg) => {
      received.push(msg.topic);
    });
    bus.publish('agent.message', 'agent-1', 'hi');
    bus.publish('system.alert', 'system', 'alert');
    bus.publish('mission.updated', 'system', { missionId: 'm1', status: 'done' });
    assert.deepEqual(received, ['agent.message', 'system.alert', 'mission.updated']);
  });

  it('wildcard subscriber receives messages published on * topic directly', () => {
    const received: string[] = [];
    bus.subscribe('*', (msg) => {
      received.push(msg.topic);
    });
    // Publishing on '*' dispatches to all handlers subscribed to '*' via the normal path
    bus.publish('*', 'system', 'wildcard-msg');
    assert.equal(received.length, 1);
    assert.equal(received[0], '*');
  });

  it('unsubscribing last wildcard subscriber resets the flag', () => {
    const received: string[] = [];
    const unsub = bus.subscribe('*', (msg) => {
      received.push(msg.topic);
    });
    unsub();
    bus.publish('agent.message', 'agent-1', 'should not trigger');
    assert.equal(received.length, 0);
  });

  // -----------------------------------------------------------------------
  // Message metadata
  // -----------------------------------------------------------------------

  it('includes correct message metadata', () => {
    const msg = bus.publish('agent.message', 'agent-1', 'payload', {
      target: 'agent-2',
      priority: 'high',
    });
    assert.ok(msg.id.startsWith('msg_'));
    assert.equal(msg.source, 'agent-1');
    assert.equal(msg.target, 'agent-2');
    assert.equal(msg.priority, 'high');
    assert.equal(msg.topic, 'agent.message');
    assert.ok(msg.timestamp);
  });

  it('defaults priority to normal when not specified', () => {
    const msg = bus.publish('agent.message', 'agent-1', 'payload');
    assert.equal(msg.priority, 'normal');
  });

  it('includes ttl in message when specified', () => {
    const msg = bus.publish('agent.message', 'agent-1', 'payload', { ttl: 5000 });
    assert.equal(msg.ttl, 5000);
  });

  it('generates unique message IDs', () => {
    const m1 = bus.publish('agent.message', 'agent-1', 'a');
    const m2 = bus.publish('agent.message', 'agent-1', 'b');
    assert.notEqual(m1.id, m2.id);
  });

  // -----------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------

  it('maintains message history', () => {
    bus.publish('agent.message', 'agent-1', 'msg1');
    bus.publish('agent.message', 'agent-2', 'msg2');
    const history = bus.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].payload, 'msg1');
    assert.equal(history[1].payload, 'msg2');
  });

  it('filters history by topic', () => {
    bus.publish('agent.message', 'agent-1', 'msg1');
    bus.publish('system.alert', 'system', 'alert!');
    bus.publish('agent.message', 'agent-2', 'msg2');

    const filtered = bus.getHistory('agent.message');
    assert.equal(filtered.length, 2);
    for (const m of filtered) assert.equal(m.topic, 'agent.message');
  });

  it('returns empty array for history of topic with no messages', () => {
    bus.publish('agent.message', 'agent-1', 'msg1');
    const filtered = bus.getHistory('system.alert');
    assert.equal(filtered.length, 0);
  });

  it('limits history entries (ring buffer overwrite)', () => {
    const smallBus = new MessageBus(3);
    for (let i = 0; i < 5; i++) {
      smallBus.publish('agent.message', 'agent-1', `msg${i}`);
    }
    const history = smallBus.getHistory();
    assert.equal(history.length, 3);
    // Oldest messages (msg0, msg1) should have been overwritten
    assert.equal(history[0].payload, 'msg2');
    assert.equal(history[1].payload, 'msg3');
    assert.equal(history[2].payload, 'msg4');
  });

  it('getHistory with limit returns last N messages', () => {
    for (let i = 0; i < 10; i++) {
      bus.publish('agent.message', 'agent-1', `msg${i}`);
    }
    const limited = bus.getHistory(undefined, 3);
    assert.equal(limited.length, 3);
    assert.equal(limited[0].payload, 'msg7');
    assert.equal(limited[2].payload, 'msg9');
  });

  it('getHistory with topic and limit', () => {
    bus.publish('agent.message', 'agent-1', 'a1');
    bus.publish('system.alert', 'system', 's1');
    bus.publish('agent.message', 'agent-1', 'a2');
    bus.publish('agent.message', 'agent-1', 'a3');

    const limited = bus.getHistory('agent.message', 2);
    assert.equal(limited.length, 2);
    assert.equal(limited[0].payload, 'a2');
    assert.equal(limited[1].payload, 'a3');
  });

  // -----------------------------------------------------------------------
  // Subscriber counts
  // -----------------------------------------------------------------------

  it('tracks subscriber counts per topic', () => {
    bus.subscribe('agent.message', () => {});
    bus.subscribe('agent.message', () => {});
    bus.subscribe('system.alert', () => {});
    assert.equal(bus.getSubscriberCount('agent.message'), 2);
    assert.equal(bus.getSubscriberCount('system.alert'), 1);
    assert.equal(bus.getSubscriberCount('mission.updated'), 0);
  });

  it('returns all subscriber counts', () => {
    bus.subscribe('agent.message', () => {});
    bus.subscribe('agent.message', () => {});
    bus.subscribe('system.alert', () => {});
    const counts = bus.getAllSubscriberCounts();
    assert.equal(counts['agent.message'], 2);
    assert.equal(counts['system.alert'], 1);
  });

  // -----------------------------------------------------------------------
  // Active topics
  // -----------------------------------------------------------------------

  it('tracks active topics from publishing', () => {
    bus.publish('agent.message', 'agent-1', 'hi');
    bus.publish('system.alert', 'system', 'alert');
    const topics = bus.getActiveTopics();
    assert.ok(topics.includes('agent.message'));
    assert.ok(topics.includes('system.alert'));
  });

  // -----------------------------------------------------------------------
  // clearHistory / clearSubscribers
  // -----------------------------------------------------------------------

  it('clears message history', () => {
    bus.publish('agent.message', 'agent-1', 'test');
    bus.publish('system.alert', 'system', 'alert');
    bus.clearHistory();
    assert.equal(bus.getHistory().length, 0);
    assert.equal(bus.getHistory('agent.message').length, 0);
  });

  it('clears subscribers for a specific topic', () => {
    let count = 0;
    bus.subscribe('agent.message', () => count++);
    bus.subscribe('system.alert', () => count++);
    bus.clearSubscribers('agent.message');
    bus.publish('agent.message', 'agent-1', 'test');
    bus.publish('system.alert', 'system', 'alert');
    assert.equal(count, 1); // only system.alert handler fires
  });

  it('clears all subscribers when no topic is specified', () => {
    let count = 0;
    bus.subscribe('agent.message', () => count++);
    bus.subscribe('system.alert', () => count++);
    bus.clearSubscribers();
    bus.publish('agent.message', 'agent-1', 'test');
    bus.publish('system.alert', 'system', 'alert');
    assert.equal(count, 0);
  });

  // -----------------------------------------------------------------------
  // Async handlers
  // -----------------------------------------------------------------------

  it('handles async handlers without blocking publish', () => {
    bus.subscribe('agent.message', async () => {
      await new Promise(r => setTimeout(r, 100));
    });
    assert.doesNotThrow(() => {
      bus.publish('agent.message', 'agent-1', 'async test');
    });
  });

  it('catches errors in sync handlers without crashing', () => {
    bus.subscribe('agent.message', () => {
      throw new Error('handler exploded');
    });
    // Should not throw
    assert.doesNotThrow(() => {
      bus.publish('agent.message', 'agent-1', 'test');
    });
  });
});
