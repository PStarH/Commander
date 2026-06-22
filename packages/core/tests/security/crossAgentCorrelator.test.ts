/**
 * CrossAgentCorrelator Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CrossAgentCorrelator,
  resetCrossAgentCorrelator,
} from '../../src/security/crossAgentCorrelator';
import type { CrossAgentEvent } from '../../src/security/crossAgentCorrelator';

function makeEvent(overrides: Partial<CrossAgentEvent> = {}): CrossAgentEvent {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    agentId: overrides.agentId ?? 'agent-1',
    runId: 'run-1',
    type: 'tool_call',
    summary: 'Test event',
    metadata: {},
    timestamp: Date.now(),
    severity: 'low',
    ...overrides,
  };
}

describe('CrossAgentCorrelator', () => {
  let correlator: CrossAgentCorrelator;

  beforeEach(() => {
    resetCrossAgentCorrelator();
    correlator = new CrossAgentCorrelator();
  });

  afterEach(() => {
    resetCrossAgentCorrelator();
  });

  describe('event ingestion', () => {
    it('ingests and correlates events', () => {
      const event = makeEvent({ agentId: 'agent-1', type: 'tool_call' });
      const matches = correlator.ingest(event);
      expect(Array.isArray(matches)).toBe(true);
    });

    it('ingests batch events', () => {
      const events = [
        makeEvent({ agentId: 'agent-1' }),
        makeEvent({ agentId: 'agent-2' }),
        makeEvent({ agentId: 'agent-3' }),
      ];
      const matches = correlator.ingestBatch(events);
      expect(Array.isArray(matches)).toBe(true);
    });

    it('enforces max events per agent', () => {
      const maxPerAgent = 10;
      const corrSmall = new CrossAgentCorrelator({ maxEventsPerAgent: maxPerAgent });
      for (let i = 0; i < maxPerAgent + 20; i++) {
        corrSmall.ingest(makeEvent({ agentId: 'agent-1' }));
      }
      const events = corrSmall.getEvents();
      const agent1Events = events.filter((e) => e.agentId === 'agent-1');
      expect(agent1Events.length).toBeLessThanOrEqual(maxPerAgent);
    });
  });

  describe('coordinated exfiltration detection', () => {
    it('detects when one agent reads and another writes', () => {
      const readEvent = makeEvent({
        agentId: 'agent-reader',
        type: 'data_read',
        dataLabels: ['sensitive', 'internal'],
        metadata: {},
      });
      const writeEvent = makeEvent({
        agentId: 'agent-sender',
        type: 'network_request',
        dataLabels: [],
        metadata: {},
      });

      correlator.ingest(readEvent);
      const matches = correlator.ingest(writeEvent);

      const exfilMatches = matches.filter((m) => m.ruleType === 'coordinated_exfiltration');
      expect(exfilMatches.length).toBeGreaterThan(0);
    });

    it('does not flag when same agent reads and writes', () => {
      const readEvent = makeEvent({
        agentId: 'same-agent',
        type: 'data_read',
        dataLabels: ['sensitive'],
      });
      const writeEvent = makeEvent({
        agentId: 'same-agent',
        type: 'network_request',
      });

      correlator.ingest(readEvent);
      const matches = correlator.ingest(writeEvent);

      const exfilMatches = matches.filter((m) => m.ruleType === 'coordinated_exfiltration');
      // Same agent doing both is not flagged as coordinated exfil
      expect(exfilMatches.length).toBe(0);
    });
  });

  describe('privilege escalation detection', () => {
    it('detects agent spawn with higher privilege child', () => {
      // Add a dummy event for the parent agent to satisfy minAgents: 2
      correlator.ingest(makeEvent({ agentId: 'parent-agent', type: 'tool_call' }));

      const spawn = makeEvent({
        agentId: 'child-agent',
        parentAgentId: 'parent-agent',
        type: 'agent_spawn',
        metadata: {
          parentPrivilege: 'low',
          childPrivilege: 'high',
        },
      });

      const matches = correlator.ingest(spawn);
      const escMatches = matches.filter((m) => m.ruleType === 'privilege_escalation_chain');
      expect(escMatches.length).toBeGreaterThan(0);
    });

    it('does not flag equal-privilege spawns', () => {
      const spawn = makeEvent({
        agentId: 'child-agent',
        parentAgentId: 'parent-agent',
        type: 'agent_spawn',
        metadata: {
          parentPrivilege: 'medium',
          childPrivilege: 'medium',
        },
      });

      const matches = correlator.ingest(spawn);
      const escMatches = matches.filter((m) => m.ruleType === 'privilege_escalation_chain');
      expect(escMatches.length).toBe(0);
    });
  });

  describe('distributed DoS detection', () => {
    it('detects when multiple agents make excessive tool calls', () => {
      // 3 agents making 60 tool calls each
      for (const agentId of ['agent-a', 'agent-b', 'agent-c']) {
        for (let i = 0; i < 60; i++) {
          correlator.ingest(
            makeEvent({
              agentId,
              type: 'tool_call',
              timestamp: Date.now() - i * 10,
            }),
          );
        }
      }

      const allMatches = correlator.getMatches();
      const dosMatches = allMatches.filter((m) => m.ruleType === 'distributed_dos');
      expect(dosMatches.length).toBeGreaterThan(0);
    });
  });

  describe('command and control detection', () => {
    it('detects when agent receives external input and spawns sub-agents', () => {
      const externalInput = makeEvent({
        agentId: 'c2-agent',
        type: 'network_request',
        metadata: { external: true },
      });
      const spawn1 = makeEvent({
        agentId: 'child',
        parentAgentId: 'c2-agent',
        type: 'agent_spawn',
      });
      // Add a second child to satisfy minAgents: 3
      const spawn2 = makeEvent({
        agentId: 'child-2',
        parentAgentId: 'c2-agent',
        type: 'agent_spawn',
      });

      correlator.ingest(externalInput);
      correlator.ingest(spawn1);
      const matches = correlator.ingest(spawn2);

      const c2Matches = matches.filter((m) => m.ruleType === 'command_and_control');
      expect(c2Matches.length).toBeGreaterThan(0);
    });
  });

  describe('collusion detection', () => {
    it('detects when multiple agents bypass governance', () => {
      const override1 = makeEvent({
        agentId: 'agent-x',
        type: 'governance_override',
      });
      const override2 = makeEvent({
        agentId: 'agent-y',
        type: 'state_change',
        metadata: { bypassedGovernance: true },
      });

      correlator.ingest(override1);
      const matches = correlator.ingest(override2);

      const collusionMatches = matches.filter((m) => m.ruleType === 'collusion');
      expect(collusionMatches.length).toBeGreaterThan(0);
    });
  });

  describe('lateral movement detection', () => {
    it("detects when agent consumes another agent's tool output", () => {
      const toolResult = makeEvent({
        agentId: 'agent-producer',
        type: 'tool_result',
      });
      const llmCall = makeEvent({
        agentId: 'agent-consumer',
        type: 'llm_call',
        metadata: { consumedAgentOutput: 'agent-producer' },
      });

      correlator.ingest(toolResult);
      const matches = correlator.ingest(llmCall);

      const lateralMatches = matches.filter((m) => m.ruleType === 'lateral_movement');
      expect(lateralMatches.length).toBeGreaterThan(0);
    });
  });

  describe('match metadata', () => {
    it('correlation matches include agent IDs and risk scores', () => {
      // Trigger a simple correlation
      const readEvent = makeEvent({
        agentId: 'agent-reader',
        type: 'data_read',
        dataLabels: ['sensitive'],
      });
      const writeEvent = makeEvent({
        agentId: 'agent-sender',
        type: 'network_request',
      });

      correlator.ingest(readEvent);
      correlator.ingest(writeEvent);

      const matches = correlator.getMatches();
      const exfil = matches.find((m) => m.ruleType === 'coordinated_exfiltration');
      expect(exfil).toBeDefined();
      expect(exfil!.riskScore).toBeGreaterThan(0);
      expect(exfil!.agentIds.length).toBeGreaterThanOrEqual(2);
      expect(exfil!.description.length).toBeGreaterThan(0);
      expect(exfil!.recommendation.length).toBeGreaterThan(0);
    });
  });

  describe('getMatchesForAgent', () => {
    it('returns matches involving a specific agent', () => {
      const readEvent = makeEvent({
        agentId: 'agent-target',
        type: 'data_read',
        dataLabels: ['sensitive'],
      });
      const writeEvent = makeEvent({
        agentId: 'agent-other',
        type: 'network_request',
      });

      correlator.ingest(readEvent);
      correlator.ingest(writeEvent);

      const agentMatches = correlator.getMatchesForAgent('agent-target');
      expect(agentMatches.length).toBeGreaterThan(0);
    });
  });

  describe('maxMatches pruning', () => {
    it('prunes old matches when over limit', () => {
      const smallCorr = new CrossAgentCorrelator({ maxMatches: 5 });

      // Trigger multiple correlations by different agent pairs
      for (let i = 0; i < 10; i++) {
        smallCorr.ingest(
          makeEvent({
            agentId: `reader-${i}`,
            type: 'data_read',
            dataLabels: ['sensitive'],
          }),
        );
        smallCorr.ingest(
          makeEvent({
            agentId: `sender-${i}`,
            type: 'network_request',
            timestamp: Date.now() + 100,
          }),
        );
      }

      const matches = smallCorr.getMatches();
      expect(matches.length).toBeLessThanOrEqual(5);
    });
  });

  describe('reset', () => {
    it('clears events and matches', () => {
      correlator.ingest(makeEvent({ agentId: 'a' }));
      correlator.ingest(makeEvent({ agentId: 'b' }));
      correlator.reset();
      expect(correlator.getEvents().length).toBe(0);
      expect(correlator.getMatches().length).toBe(0);
    });
  });
});
