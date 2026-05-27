import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AgentHandoff } from '../../src/runtime/agentHandoff';
import { AgentInbox } from '../../src/runtime/agentInbox';

const TEST_INBOX_DIR = path.join(process.cwd(), '.test_handoff_inboxes');

describe('AgentHandoff', () => {
  let inbox: AgentInbox;
  let handoff: AgentHandoff;

  beforeEach(() => {
    if (fs.existsSync(TEST_INBOX_DIR)) {
      fs.rmSync(TEST_INBOX_DIR, { recursive: true, force: true });
    }
    inbox = new AgentInbox(TEST_INBOX_DIR, 10000);
    handoff = new AgentHandoff(inbox);
  });

  afterEach(() => {
    inbox.dispose();
    if (fs.existsSync(TEST_INBOX_DIR)) {
      fs.rmSync(TEST_INBOX_DIR, { recursive: true, force: true });
    }
  });

  const makeRequest = () => ({
    handoffId: 'ho-1',
    fromAgent: 'agent_a',
    toAgent: 'agent_b',
    goal: 'Complete the task',
    context: {
      missionId: 'mission-1',
      runId: 'run-1',
      messages: [{ role: 'user', content: 'do it' }],
      intermediateResults: ['step 1 done'],
      availableTools: ['read_file'],
      tokenBudget: 5000,
    },
  });

  it('creates a handoff request with requested status', async () => {
    const req = await handoff.request(makeRequest());
    expect(req.status).toBe('requested');
    expect(req.fromAgent).toBe('agent_a');
    expect(req.toAgent).toBe('agent_b');
    expect(req.createdAt).toBeDefined();
  });

  it('stores handoff request in internal map', async () => {
    await handoff.request(makeRequest());
    const stored = handoff.getHandoff('ho-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('requested');
  });

  it('sends inbox message to target agent on request', async () => {
    await handoff.request(makeRequest());
    const msgs = inbox.getMessages('agent_b');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].subject).toContain('handoff');
    expect(msgs[0].tags).toContain('handoff');
  });

  it('accepts a handoff and sends acknowledgment', async () => {
    await handoff.request(makeRequest());
    const accepted = await handoff.accept('ho-1', 'Will do!');
    expect(accepted).not.toBeNull();
    expect(accepted!.status).toBe('accepted');
    expect(accepted!.response).toBe('Will do!');
    expect(accepted!.resolvedAt).toBeDefined();

    const ackMsgs = inbox.getMessages('agent_a');
    expect(ackMsgs).toHaveLength(1);
    expect(ackMsgs[0].tags).toContain('accepted');
  });

  it('returns null when accepting non-existent handoff', async () => {
    const result = await handoff.accept('nonexistent', 'ok');
    expect(result).toBeNull();
  });

  it('returns null when accepting already-accepted handoff', async () => {
    await handoff.request(makeRequest());
    await handoff.accept('ho-1', 'ok');
    const again = await handoff.accept('ho-1', 'again');
    expect(again).toBeNull();
  });

  it('rejects a handoff and sends rejection', async () => {
    await handoff.request(makeRequest());
    const rejected = await handoff.reject('ho-1', 'Too busy');
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe('rejected');
    expect(rejected!.response).toBe('Too busy');

    const rejMsgs = inbox.getMessages('agent_a');
    expect(rejMsgs).toHaveLength(1);
    expect(rejMsgs[0].tags).toContain('rejected');
  });

  it('returns null when rejecting non-existent handoff', async () => {
    const result = await handoff.reject('nonexistent', 'no');
    expect(result).toBeNull();
  });

  it('completes a handoff', async () => {
    await handoff.request(makeRequest());
    handoff.complete('ho-1');
    const stored = handoff.getHandoff('ho-1');
    expect(stored!.status).toBe('completed');
    expect(stored!.resolvedAt).toBeDefined();
  });

  it('complete is no-op for unknown handoff', () => {
    handoff.complete('nonexistent');
    // Should not throw
  });

  it('lists handoffs for an agent', async () => {
    await handoff.request({ ...makeRequest(), handoffId: 'ho-1' });
    await handoff.request({
      ...makeRequest(),
      handoffId: 'ho-2',
      fromAgent: 'agent_c',
      toAgent: 'agent_a',
    });

    const forA = handoff.listForAgent('agent_a');
    expect(forA).toHaveLength(2);

    const forB = handoff.listForAgent('agent_b');
    expect(forB).toHaveLength(1);

    const forC = handoff.listForAgent('agent_c');
    expect(forC).toHaveLength(1);
  });

  it('getHandoff returns undefined for unknown', () => {
    expect(handoff.getHandoff('nope')).toBeUndefined();
  });

  it('handles full lifecycle: request → accept → complete', async () => {
    await handoff.request(makeRequest());
    await handoff.accept('ho-1', 'Starting now');
    handoff.complete('ho-1');

    const stored = handoff.getHandoff('ho-1');
    expect(stored!.status).toBe('completed');
    // Should have 2 inbox messages: request notification + ack
    expect(inbox.getMessages('agent_b')).toHaveLength(1);
    expect(inbox.getMessages('agent_a')).toHaveLength(1);
  });

  it('handles rejected lifecycle: request → reject', async () => {
    await handoff.request(makeRequest());
    await handoff.reject('ho-1', 'Cannot take this');

    const stored = handoff.getHandoff('ho-1');
    expect(stored!.status).toBe('rejected');
  });
});
