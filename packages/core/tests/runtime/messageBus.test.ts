import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { MessageBus, resetMessageBus } from '../../src/runtime/messageBus';

describe('MessageBus', () => {
  let bus: MessageBus;

  before(() => {
    resetMessageBus();
    bus = new MessageBus(50);
  });

  it('publishes and delivers messages', () => {
    const received: string[] = [];
    bus.subscribe('agent.message', (msg) => {
      received.push(msg.payload as string);
    });
    bus.publish('agent.message', 'agent-1', 'hello');
    expect(received).toEqual(['hello']);
  });

  it('broadcasts to multiple subscribers', () => {
    let count = 0;
    bus.subscribe('agent.message', () => count++);
    bus.subscribe('agent.message', () => count++);
    bus.publish('agent.message', 'agent-1', 'hello');
    expect(count).toBe(2);
  });

  it('subscribes to multiple topics at once', () => {
    const received: string[] = [];
    const unsub = bus.subscribeMany(['agent.message', 'system.alert'], (msg) => {
      received.push(msg.topic);
    });
    bus.publish('agent.message', 'agent-1', 'hi');
    bus.publish('system.alert', 'system', 'alert!');
    expect(received).toEqual(['agent.message', 'system.alert']);
    unsub();
    bus.publish('agent.message', 'agent-1', 'should not appear');
    expect(received.length).toBe(2);
  });

  it('supports unsubscribe', () => {
    let count = 0;
    const unsub = bus.subscribe('agent.message', () => count++);
    bus.publish('agent.message', 'agent-1', 'first');
    unsub();
    bus.publish('agent.message', 'agent-1', 'second');
    expect(count).toBe(1);
  });

  it('maintains message history', () => {
    bus.publish('agent.message', 'agent-1', 'msg1');
    bus.publish('agent.message', 'agent-2', 'msg2');
    const history = bus.getHistory();
    expect(history.length).toBe(2);
  });

  it('filters history by topic', () => {
    bus.publish('agent.message', 'agent-1', 'msg1');
    bus.publish('system.alert', 'system', 'alert!');
    const filtered = bus.getHistory('agent.message');
    expect(filtered.length).toBe(1);
    expect(filtered[0].topic).toBe('agent.message');
  });

  it('limits history entries', () => {
    const smallBus = new MessageBus(3);
    for (let i = 0; i < 5; i++) {
      smallBus.publish('agent.message', 'agent-1', `msg${i}`);
    }
    expect(smallBus.getHistory().length).toBe(3);
  });

  it('tracks subscriber counts', () => {
    bus.subscribe('agent.message', () => {});
    bus.subscribe('agent.message', () => {});
    bus.subscribe('system.alert', () => {});
    expect(bus.getSubscriberCount('agent.message')).toBe(2);
    expect(bus.getSubscriberCount('system.alert')).toBe(1);
    expect(bus.getSubscriberCount('mission.updated')).toBe(0);
  });

  it('tracks active topics', () => {
    bus.publish('agent.message', 'agent-1', 'hi');
    bus.publish('system.alert', 'system', 'alert');
    const topics = bus.getActiveTopics();
    expect(topics).toContain('agent.message');
    expect(topics).toContain('system.alert');
  });

  it('clears history', () => {
    bus.publish('agent.message', 'agent-1', 'test');
    bus.clearHistory();
    expect(bus.getHistory().length).toBe(0);
  });

  it('clears subscribers', () => {
    let count = 0;
    bus.subscribe('agent.message', () => count++);
    bus.clearSubscribers('agent.message');
    bus.publish('agent.message', 'agent-1', 'test');
    expect(count).toBe(0);
  });

  it('handles async handlers without blocking', async () => {
    bus.subscribe('agent.message', async () => {
      await new Promise(r => setTimeout(r, 10));
    });
    expect(() => {
      bus.publish('agent.message', 'agent-1', 'async test');
    }).not.toThrow();
  });

  it('includes correct message metadata', () => {
    const msg = bus.publish('agent.message', 'agent-1', 'payload', {
      target: 'agent-2',
      priority: 'high',
    });
    expect(msg.id).toBeTruthy();
    expect(msg.source).toBe('agent-1');
    expect(msg.target).toBe('agent-2');
    expect(msg.priority).toBe('high');
    expect(msg.topic).toBe('agent.message');
    expect(msg.timestamp).toBeTruthy();
  });
});
