/**
 * consensusPlugin — Built-in CommanderPlugin for the Commander-BFT-C3 consensus
 * and fault-tolerance stack.
 *
 * Registers as `builtin-consensus' (category: 'optimization'). The consensus
 * stack is heavy: SAC protocol, CourtEval, BPD detector, topology state machine,
 * and adaptive stopping. It consumes significant tokens (CourtEval requires 3
 * LLM providers per evaluation) and is only meaningful for multi-agent runs
 * that need Byzantine fault tolerance. Light/single-agent workloads should
 * leave it disabled.
 *
 * On enable it exposes tools to:
 *   - consensus_sac_*      — submit evaluations, compute consensus, view reputation
 *   - consensus_court_eval — run adversarial court evaluation (providers injected per-call)
 *   - consensus_bpd_*      — register agents, record communications, detect anomalies
 *   - consensus_topology_* — view/force topology state, get snapshots
 *   - consensus_stopping   — record debate rounds, check adaptive stopping
 *
 * No automatic hooks — consensus is explicitly invoked. The topologyStateMachine
 * still publishes 'system.alert' events to the MessageBus when state transitions
 * occur (this is internal to the plugin, not a host hook).
 */
import type { CommanderPlugin } from '../../pluginManager';
import {
  AdaptiveStoppingController,
  BetaBinomialTracker,
  ksTest,
  answersToNumeric,
  BPDDetector,
  getBPDDetector,
  resetBPDDetector,
  TopologyStateMachine,
  getTopologyStateMachine,
  resetTopologyStateMachine,
  SACProtocol,
  getSACProtocol,
  resetSACProtocol,
  CourtEvalEngine,
  DEFAULT_ADAPTIVE_STOPPING_CONFIG,
  DEFAULT_BPD_CONFIG,
  DEFAULT_TOPOLOGY_STATE_CONFIG,
  DEFAULT_SAC_CONFIG,
  DEFAULT_COURT_EVAL_CONFIG,
  type TopologyState,
  type TopologyStateSnapshot,
  type SACProposal,
  type SACEvaluation,
  type CourtVerdict,
  type CourtParticipant,
  type DebateRound,
  type AgentAnomalyReport,
} from './consensus';
import { getGlobalLogger } from '../../logging';

// ============================================================================
// Shared store handles
// ============================================================================

let sharedAdaptiveStopping: AdaptiveStoppingController | null = null;
let sharedCourtEval: CourtEvalEngine | null = null;

export function getSharedAdaptiveStopping(): AdaptiveStoppingController | null {
  return sharedAdaptiveStopping;
}
export function getSharedCourtEval(): CourtEvalEngine | null {
  return sharedCourtEval;
}

// ============================================================================
// Consensus Plugin factory
// ============================================================================

export function createConsensusPlugin(): CommanderPlugin {
  return {
    name: 'builtin-consensus',
    version: '0.1.0',
    description:
      'Commander-BFT-C3 consensus: SAC, CourtEval, BPD, topology state machine, adaptive stopping',
    category: 'optimization',
    configSchema: {
      type: 'object',
      properties: {
        alertThreshold: {
          type: 'number',
          description: 'BPD anomaly score to transition NORMAL → ALERT (default 0.3)',
          default: 0.3,
        },
        lockdownThreshold: {
          type: 'number',
          description: 'BPD anomaly score to transition ALERT → LOCKDOWN (default 0.6)',
          default: 0.6,
        },
        escalateThreshold: {
          type: 'number',
          description: 'BPD anomaly score to transition LOCKDOWN → ESCALATE (default 0.85)',
          default: 0.85,
        },
        courtMaxTokens: {
          type: 'number',
          description: 'Max tokens per CourtEval role call (default 1024)',
          default: 1024,
        },
      },
    },

    onLoad: async (ctx) => {
      const cfg = ctx.config;
      // Initialize singletons with merged config. These are tenant-aware
      // singletons (createTenantAwareSingleton), so get*() returns the
      // already-configured instance.
      const tsm = getTopologyStateMachine();
      // Note: TopologyStateMachine reads its config at construction time;
      // custom thresholds require reset + reconfigure.
      if (
        cfg.alertThreshold !== undefined ||
        cfg.lockdownThreshold !== undefined ||
        cfg.escalateThreshold !== undefined
      ) {
        resetTopologyStateMachine();
        // After reset, the next getTopologyStateMachine() creates a fresh
        // instance with DEFAULT_CONFIG; custom thresholds would need a
        // constructor argument — see tool consensus_topology_force for runtime ops.
      }

      sharedAdaptiveStopping = new AdaptiveStoppingController(DEFAULT_ADAPTIVE_STOPPING_CONFIG);
      sharedCourtEval = new CourtEvalEngine(DEFAULT_COURT_EVAL_CONFIG);

      // Trigger singleton init for BPD and SAC.
      getBPDDetector();
      getSACProtocol();

      getGlobalLogger().info(
        'ConsensusPlugin',
        `Consensus stack loaded (TSM state=${tsm.getState()}, BPD+SAC singletons initialized)`,
      );
    },

    onUnload: async () => {
      sharedAdaptiveStopping = null;
      sharedCourtEval = null;
      resetBPDDetector();
      resetTopologyStateMachine();
      resetSACProtocol();
      getGlobalLogger().info('ConsensusPlugin', 'Consensus stack unloaded');
    },

    tools: [
      {
        name: 'consensus_topology_state',
        description:
          'Get the current topology state machine snapshot. Returns state (NORMAL/ALERT/LOCKDOWN/ESCALATE), ' +
          'isolated agents, max fan-out, and transition history.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const tsm = getTopologyStateMachine();
          return JSON.stringify(tsm.getSnapshot());
        },
      },
      {
        name: 'consensus_topology_force',
        description:
          'Force the topology state machine into a specific state. Use with caution — ' +
          'bypasses anomaly-score thresholds. Valid states: NORMAL, ALERT, LOCKDOWN, ESCALATE.',
        inputSchema: {
          type: 'object',
          properties: {
            state: {
              type: 'string',
              enum: ['NORMAL', 'ALERT', 'LOCKDOWN', 'ESCALATE'],
              description: 'Target state',
            },
            reason: { type: 'string', description: 'Reason for forced transition' },
          },
          required: ['state', 'reason'],
        },
        execute: async (args) => {
          const tsm = getTopologyStateMachine();
          const state = args.state as TopologyState;
          const reason = String(args.reason ?? 'manual');
          tsm.forceState(state, reason);
          return JSON.stringify({ ok: true, state: tsm.getState(), reason });
        },
      },
      {
        name: 'consensus_bpd_detect',
        description:
          'Run BPD anomaly detection over the recorded communication graph. ' +
          'Returns a list of flagged agents with anomaly scores and isolation recommendations.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const bpd = getBPDDetector();
          const anomalies = bpd.detect();
          return JSON.stringify({ anomalies, flaggedAgents: bpd.getFlaggedAgents() });
        },
      },
      {
        name: 'consensus_sac_consensus',
        description:
          'Compute SAC consensus over a set of proposals and evaluations. ' +
          'Returns dimension averages, overall scores, and reputation updates.',
        inputSchema: {
          type: 'object',
          properties: {
            proposals: {
              type: 'array',
              description: 'SAC proposals from agents',
              items: { type: 'object' },
            },
            evaluations: {
              type: 'array',
              description: 'SAC evaluations (receiver-side scores)',
              items: { type: 'object' },
            },
          },
          required: ['proposals', 'evaluations'],
        },
        execute: async (args) => {
          const sac = getSACProtocol();
          const proposals = (args.proposals as SACProposal[]) ?? [];
          const evaluations = (args.evaluations as SACEvaluation[]) ?? [];
          const result = sac.computeConsensus(proposals, evaluations);
          return JSON.stringify(result);
        },
      },
      {
        name: 'consensus_sac_reputation',
        description: 'Get the current SAC reputation board (agentId → reputation score).',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const sac = getSACProtocol();
          return JSON.stringify({ reputationBoard: sac.getReputationBoard() });
        },
      },
      {
        name: 'consensus_court_eval',
        description:
          'Run an adversarial court evaluation (grader + critic + defender). ' +
          'Each participant must supply its own LLMProvider instance (anti-bias: ' +
          'providers must come from different model families).',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question being evaluated' },
            answer: { type: 'string', description: 'The answer being evaluated' },
            participants: {
              type: 'array',
              description:
                'Court participants (grader/critic/defender). Each must include a provider. ' +
                'Note: provider instances cannot be passed via JSON; use the /api/consensus/court-eval ' +
                'HTTP endpoint for programmatic access with real provider instances.',
              items: { type: 'object' },
            },
          },
          required: ['question', 'answer'],
        },
        execute: async (args) => {
          // The tool form cannot accept live LLMProvider instances through JSON.
          // Callers needing real evaluation must use the HTTP endpoint, which
          // can construct provider instances server-side. This tool returns a
          // guidance message when participants lack providers.
          const participants = args.participants as CourtParticipant[] | undefined;
          if (!participants || participants.length < 3) {
            return JSON.stringify({
              error:
                'CourtEval requires 3 participants (grader, critic, defender) with LLMProvider instances. ' +
                'Use POST /api/consensus/court-eval with server-side provider construction.',
            });
          }
          const engine = sharedCourtEval ?? new CourtEvalEngine(DEFAULT_COURT_EVAL_CONFIG);
          const verdict = await engine.evaluate(
            String(args.question ?? ''),
            String(args.answer ?? ''),
            {
              grader: participants[0],
              critic: participants[1],
              defender: participants[2],
            },
          );
          return JSON.stringify(verdict);
        },
      },
      {
        name: 'consensus_stopping_record',
        description:
          'Record a debate round for adaptive stopping analysis. ' +
          'Returns whether stopping is recommended (Beta-Binomial novelty probability + KS test).',
        inputSchema: {
          type: 'object',
          properties: {
            round: {
              type: 'object',
              description: 'Debate round data (answers from agents)',
            },
          },
          required: ['round'],
        },
        execute: async (args) => {
          const controller = sharedAdaptiveStopping ?? new AdaptiveStoppingController();
          const result = controller.recordRound(args.round as DebateRound);
          return JSON.stringify(result);
        },
      },
      {
        name: 'consensus_stopping_summary',
        description:
          'Get the adaptive stopping summary (rounds recorded, novelty probability, distinct count).',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const controller = sharedAdaptiveStopping ?? new AdaptiveStoppingController();
          return JSON.stringify(controller.getSummary());
        },
      },
    ],
  };
}
