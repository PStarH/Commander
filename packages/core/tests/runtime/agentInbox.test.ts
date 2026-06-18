import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AgentInbox, type InboxMessage } from '../../src/runtime/agentInbox';

const TEST_INBOX_DIR = path.join(process.cwd(), '.test_inboxes');

describe('AgentInbox', () => {
  let inbox: AgentInbox;

  beforeEach(() => {
    if (fs.existsSync(TEST_INBOX_DIR)) {
      fs.rmSync(TEST_INBOX_DIR, { recursive: true, force: true });
    }
    inbox = new AgentInbox(TEST_INBOX_DIR, 10000);
  });

  afterEach(() => {
    inbox.dispose();
    if (fs.existsSync(TEST_INBOX_DIR)) {
      fs.rmSync(TEST_INBOX_DIR, { recursive: true, force: true });
    }
  });

  it('creates base directory on construction', () => {
    expect(fs.existsSync(TEST_INBOX_DIR)).toBe(true);
  });

  it('sends and retrieves messages', () => {
    inbox.send({
      id: 'msg-1',
      from: 'agent_a',
      to: 'agent_b',
      subject: 'Test',
      body: 'Hello',
      priority: 'normal',
      tags: [],
    });
    const msgs = inbox.getMessages('agent_b');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('Hello');
    expect(msgs[0].status).toBe('unread');
  });

  it('getMessages returns all messages for an agent', () => {
    inbox.send({
      id: 'msg-1',
      from: 'a',
      to: 'b',
      subject: 'First',
      body: 'one',
      priority: 'normal',
      tags: [],
    });
    inbox.send({
      id: 'msg-2',
      from: 'a',
      to: 'b',
      subject: 'Second',
      body: 'two',
      priority: 'normal',
      tags: [],
    });
    const msgs = inbox.getMessages('b');
    expect(msgs).toHaveLength(2);
  });

  it('getMessages filters by status', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 'Unread',
      body: '',
      priority: 'normal',
      tags: [],
    });
    inbox.pollInbox('b');
    inbox.send({
      id: 'm2',
      from: 'a',
      to: 'b',
      subject: 'New unread',
      body: '',
      priority: 'normal',
      tags: [],
    });
    const unread = inbox.getMessages('b', 'unread');
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe('m2');
  });

  it('pollInbox returns unread messages and marks them as read', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 'Test',
      body: '',
      priority: 'normal',
      tags: [],
    });
    const unread = inbox.pollInbox('b');
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe('m1');

    const again = inbox.pollInbox('b');
    expect(again).toHaveLength(0);
  });

  it('acknowledge marks message as acknowledged', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 'Test',
      body: '',
      priority: 'normal',
      tags: [],
    });
    const ok = inbox.acknowledge('b', 'm1');
    expect(ok).toBe(true);
    const msg = inbox.getMessages('b')[0];
    expect(msg.status).toBe('acknowledged');
    expect(msg.acknowledgedAt).toBeDefined();
  });

  it('acknowledge returns false for unknown message', () => {
    expect(inbox.acknowledge('b', 'nonexistent')).toBe(false);
  });

  it('deleteMessage removes a message', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 'Test',
      body: '',
      priority: 'normal',
      tags: [],
    });
    expect(inbox.getInboxSize('b')).toBe(1);

    const ok = inbox.deleteMessage('b', 'm1');
    expect(ok).toBe(true);
    expect(inbox.getInboxSize('b')).toBe(0);
  });

  it('deleteMessage returns false for unknown message', () => {
    expect(inbox.deleteMessage('b', 'nonexistent')).toBe(false);
  });

  it('getInboxSize returns correct count', () => {
    expect(inbox.getInboxSize('agent_x')).toBe(0);
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'agent_x',
      subject: 'A',
      body: '',
      priority: 'low',
      tags: [],
    });
    inbox.send({
      id: 'm2',
      from: 'a',
      to: 'agent_x',
      subject: 'B',
      body: '',
      priority: 'high',
      tags: [],
    });
    expect(inbox.getInboxSize('agent_x')).toBe(2);
  });

  it('prune removes acknowledged messages', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 'T',
      body: '',
      priority: 'normal',
      tags: [],
    });
    inbox.acknowledge('b', 'm1');
    expect(inbox.prune('b')).toBe(1);
    expect(inbox.getInboxSize('b')).toBe(0);
  });

  it('prune removes expired messages', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 'Expired',
      body: '',
      priority: 'normal',
      ttlMs: -1,
      tags: [],
    });
    expect(inbox.prune('b')).toBe(1);
  });

  it('prune keeps non-acknowledged non-expired messages', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'b',
      subject: 'Keep',
      body: '',
      priority: 'normal',
      ttlMs: 60000,
      tags: [],
    });
    expect(inbox.prune('b')).toBe(0);
    expect(inbox.getInboxSize('b')).toBe(1);
  });

  it('listAgents returns agents with inboxes', () => {
    inbox.send({
      id: 'm1',
      from: 'a',
      to: 'alpha',
      subject: 'T',
      body: '',
      priority: 'normal',
      tags: [],
    });
    inbox.send({
      id: 'm2',
      from: 'b',
      to: 'beta',
      subject: 'T',
      body: '',
      priority: 'normal',
      tags: [],
    });
    const agents = inbox.listAgents();
    expect(agents).toContain('alpha');
    expect(agents).toContain('beta');
  });

  it('persists messages to disk on flush', () => {
    inbox.send({
      id: 'persist-1',
      from: 'a',
      to: 'persist_agent',
      subject: 'Persist',
      body: 'data',
      priority: 'normal',
      tags: [],
    });
    inbox.dispose();

    const inbox2 = new AgentInbox(TEST_INBOX_DIR, 10000);
    const msgs = inbox2.getMessages('persist_agent');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('data');
    inbox2.dispose();
  });

  it('handles priority levels correctly', () => {
    inbox.send({
      id: 'low',
      from: 'a',
      to: 'b',
      subject: 'Low',
      body: '',
      priority: 'low',
      tags: [],
    });
    inbox.send({
      id: 'crit',
      from: 'a',
      to: 'b',
      subject: 'Crit',
      body: '',
      priority: 'critical',
      tags: [],
    });
    const msgs = inbox.getMessages('b');
    expect(msgs.find((m) => m.id === 'low')!.priority).toBe('low');
    expect(msgs.find((m) => m.id === 'crit')!.priority).toBe('critical');
  });
});
