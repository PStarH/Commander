import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Integration test: verifies IncrementalSCC is correctly wired into the
 * AgentHandoff lifecycle (request → accept/reject/complete).
 *
 * The hoisted `sccMock.throwOnGet` flag lets us force `getIncrementalSCCDetector`
 * to throw (scenario 8) while keeping the real singleton for every other test.
 */
const sccMock = vi.hoisted(() => ({ throwOnGet: false }));

vi.mock('../../src/runtime/incrementalSCC', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/incrementalSCC')>();
  return {
    ...actual,
    getIncrementalSCCDetector: () => {
      if (sccMock.throwOnGet) {
        throw new Error('SCC detector unavailable (forced)');
      }
      return actual.getIncrementalSCCDetector();
    },
  };
});

import { AgentHandoff } from '../../src/runtime/agentHandoff';
import { AgentInbox } from '../../src/runtime/agentInbox';
import {
  getIncrementalSCCDetector,
  resetIncrementalSCCDetector,
} from '../../src/runtime/incrementalSCC';

// Dedicated inbox dir so this suite never collides with agentHandoff.test.ts.
const TEST_INBOX_DIR = path.join(process.cwd(), '.test_scc_inboxes');

describe('IncrementalSCC <-> AgentHandoff lifecycle integration', () => {
  let inbox: AgentInbox;
  let handoff: AgentHandoff;

  beforeEach(() => {
    if (fs.existsSync(TEST_INBOX_DIR)) {
      fs.rmSync(TEST_INBOX_DIR, { recursive: true, force: true });
    }
    // Isolate the SCC singleton between tests.
    resetIncrementalSCCDetector();
    sccMock.throwOnGet = false;

    inbox = new AgentInbox(TEST_INBOX_DIR, 10000);
    handoff = new AgentHandoff(inbox);
  });

  afterEach(() => {
    handoff.dispose();
    inbox.dispose();
    sccMock.throwOnGet = false;
    resetIncrementalSCCDetector();
    if (fs.existsSync(TEST_INBOX_DIR)) {
      fs.rmSync(TEST_INBOX_DIR, { recursive: true, force: true });
    }
  });

  const makeRequest = (from: string, to: string, id: string = 'ho-1') => ({
    handoffId: id,
    fromAgent: from,
    toAgent: to,
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

  /** True if the SCC graph currently contains a directed edge `from -> to`. */
  const hasSCCEdge = (from: string, to: string): boolean => {
    const graph = getIncrementalSCCDetector().getGraph();
    return graph.edges.some((e) => e.from === from && e.to === to);
  };

  it('request adds edge fromAgent→toAgent in SCC graph', async () => {
    await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));

    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(true);
  });

  it('accept removes the wait edge from SCC graph', async () => {
    await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));
    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(true);

    await handoff.accept('ho-1', 'on it');

    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(false);
  });

  it('reject removes the wait edge from SCC graph', async () => {
    await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));
    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(true);

    await handoff.reject('ho-1', 'nope');

    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(false);
  });

  it('complete removes the wait edge from SCC graph', async () => {
    await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));
    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(true);

    handoff.complete('ho-1');

    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(false);
  });

  it('circular handoff A→B→A is rejected with status failed', async () => {
    const first = await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));
    expect(first.status).toBe('requested');

    // Now B tries to hand off back to A while A is still waiting on B → cycle.
    const second = await handoff.request(makeRequest('agent_b', 'agent_a', 'ho-2'));
    expect(second.status).toBe('failed');
    expect(second.handoffId).toBe('ho-2');
  });

  it('circular handoff response contains deadlock chain info', async () => {
    await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));
    const second = await handoff.request(makeRequest('agent_b', 'agent_a', 'ho-2'));

    expect(second.status).toBe('failed');
    expect(second.response).toContain('Deadlock detected');
    // The SCC detector recorded the deadlock.
    expect(getIncrementalSCCDetector().getDeadlockHistory()).toHaveLength(1);
  });

  it('non-circular A→B→C handoff chain succeeds normally', async () => {
    const ab = await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));
    expect(ab.status).toBe('requested');

    const bc = await handoff.request(makeRequest('agent_b', 'agent_c', 'ho-2'));
    expect(bc.status).toBe('requested');

    expect(hasSCCEdge('agent_a', 'agent_b')).toBe(true);
    expect(hasSCCEdge('agent_b', 'agent_c')).toBe(true);
    expect(getIncrementalSCCDetector().hasCycles()).toBe(false);
  });

  it('SCC failure degrades gracefully — handoff still succeeds', async () => {
    sccMock.throwOnGet = true;

    const req = await handoff.request(makeRequest('agent_a', 'agent_b', 'ho-1'));

    // Despite the SCC detector throwing, the handoff proceeds normally.
    expect(req.status).toBe('requested');
    expect(req.fromAgent).toBe('agent_a');
    // Inbox message was still delivered → request ran past the SCC block.
    expect(inbox.getMessages('agent_b')).toHaveLength(1);

    sccMock.throwOnGet = false;
  });
});
