/**
 * Consensus & Fault Tolerance Module — Barrel Export
 *
 * Research basis: Two Kimi research reports on multi-agent consensus/deadlock.
 *
 * This module implements the Commander-BFT-C3 consensus protocol architecture:
 *   - Debate Layer: Adaptive stopping (Beta-Binomial + KS test)
 *   - Evaluation Layer: CourtEval adversarial court
 *   - Consensus Layer: SAC receiver-side evaluation
 *   - Monitoring Layer: BPD graph backward propagation + topology state machine
 */

// Adaptive Stopping (Debate Layer)
export {
  AdaptiveStoppingController,
  BetaBinomialTracker,
  ksTest,
  answersToNumeric,
  DEFAULT_CONFIG as DEFAULT_ADAPTIVE_STOPPING_CONFIG,
} from './adaptiveStopping';
export type {
  DebateRound,
  AdaptiveStoppingResult,
  AdaptiveStoppingConfig,
} from './adaptiveStopping';

// BPD Detector (Monitoring Layer)
export {
  BPDDetector,
  getBPDDetector,
  resetBPDDetector,
  DEFAULT_CONFIG as DEFAULT_BPD_CONFIG,
} from './bpdDetector';
export type {
  AgentNode,
  CommunicationEdge,
  RejectionSignal,
  AgentAnomalyReport,
  BPDConfig,
} from './bpdDetector';

// Topology State Machine (Monitoring Layer)
export {
  TopologyStateMachine,
  getTopologyStateMachine,
  resetTopologyStateMachine,
  DEFAULT_CONFIG as DEFAULT_TOPOLOGY_STATE_CONFIG,
} from './topologyStateMachine';
export type {
  TopologyState,
  TopologyStateConfig,
  StateTransitionEvent,
  TopologyStateSnapshot,
  StateTransitionHandler,
} from './topologyStateMachine';

// SAC Protocol (Consensus Layer)
export {
  SACProtocol,
  getSACProtocol,
  resetSACProtocol,
  DEFAULT_CONFIG as DEFAULT_SAC_CONFIG,
} from './sacProtocol';
export type {
  SACProposal,
  SACEvaluation,
  SACConsensusResult,
  SACDimensionAverages,
  ReputationUpdate,
  SACConfig,
} from './sacProtocol';

// CourtEval (Evaluation Layer)
export { CourtEvalEngine, DEFAULT_CONFIG as DEFAULT_COURT_EVAL_CONFIG } from './courtEval';
export type {
  CourtRole,
  CourtParticipant,
  GraderScores,
  CriticAttack,
  DefenseResponse,
  CourtVerdict,
  CourtEvalConfig,
} from './courtEval';
