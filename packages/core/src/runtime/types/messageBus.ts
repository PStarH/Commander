// ============================================================================
// Message Bus Types
// ============================================================================

/**
 * Topics for inter-agent messages.
 */
export type MessageBusTopic =
  | '*'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.message'
  | 'agent.started.typed'
  | 'agent.completed.typed'
  | 'agent.failed.typed'
  | 'mission.updated'
  | 'mission.blocked'
  | 'mission.completed'
  | 'memory.written'
  | 'skills.created'
  | 'system.alert'
  | 'tool.executed'
  | 'trace.recorded'
  | 'workflow.replan'
  | 'channel.message'
  | 'channel.connected'
  | 'channel.disconnected'
  | 'channel.error'
  | 'channel.interaction'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.timeout'
  | 'tool.retry'
  | 'tool.blocked'
  | 'tool.compensation_planned'
  | 'tool.compensation_step'
  | 'agent.interrupted'
  | 'human.approval_required'
  | 'human.approval_received'
  | 'human.approval_rejected'
  | 'human.approval_timeout'
  | 'goal.started'
  | 'goal.decomposed'
  | 'goal.round_started'
  | 'goal.round_completed'
  | 'goal.worker_started'
  | 'goal.worker_completed'
  | 'goal.worker_failed'
  | 'goal.critic_started'
  | 'goal.critic_completed'
  | 'goal.manager_review'
  | 'goal.completed'
  | 'goal.judge_started'
  | 'goal.judge_completed'
  | 'swarm.started'
  | 'swarm.fission'
  | 'swarm.fusion_conflict'
  | 'swarm.round_completed'
  | 'swarm.completed'
  | 'sop.generated'
  | 'drive.started'
  | 'drive.step_started'
  | 'drive.step_completed'
  | 'drive.step_failed'
  | 'drive.completed'
  | 'checkpoint.written'
  | 'context.rebuilt'
  | 'security.event'
  | 'recovery.completed'
  // --- Hub Glue: closed-loop event taxonomy (Phase 1 wiring) ---
  // Orchestration arc
  | 'orchestrator.topology_optimized'
  | 'orchestrator.suggested_replan'
  // Runtime arc
  | 'runtime.conversation_turn'
  | 'runtime.dlq_enqueued'
  // Sandbox arc
  | 'sandbox.escape_attempted'
  | 'sandbox.executed'
  // Telemetry arc
  | 'telemetry.metric.recorded'
  | 'telemetry.intent.recorded'
  // Memory arc
  | 'memory.queried'
  | 'memory.semantic_promoted'
  | 'memory.user.interaction_recorded'
  | 'memory.episodic_reinforced'
  | 'memory.lesson_derived'
  | 'memory.feedback_signal'
  | 'memory.procedural_compiled'
  // Security arc
  | 'security.capability_minted'
  | 'security.capability_revoked'
  | 'security.token_delegated';

/**
 * Priority levels for messages.
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

// ============================================================================
// system.alert — discriminated-union variant taxonomy
//
// Each variant carries `type: '<literal>'` as the discriminant. Producers
// (agentRuntime.ts, orchestrator.ts, compensationService.ts, regressionGate.ts,
// swarmOrchestrator.ts, toolExecutionService.ts) emit these literal-level
// discriminated payloads. Consumers (Hub Glue handlers in Phase 2) do
// `switch (payload.type)` with a `never`-guard default to enforce exhaustive
// coverage at compile time.
//
// Adding a new variant: declare a new `SystemAlertXxx extends SystemAlertBase`
// interface, then add it to the `SystemAlertVariant` union below. Every
// `switch (payload.type)` consumer will fail to compile until it handles the
// new variant (the `never` guard surfaces this loudly).
// ============================================================================

interface SystemAlertBase {
  /** Discriminant — every system.alert payload carries one of these literals. */
  readonly type: string;
}

export interface SystemAlertSemanticCircuitTrip extends SystemAlertBase {
  type: 'semantic_circuit_trip';
  consecutiveFailures: number;
  reason: string;
}

export interface SystemAlertRetryLoopDetected extends SystemAlertBase {
  type: 'retry_loop_detected';
  toolName: string;
  pattern: string;
  consecutiveCalls: number;
  // Every observed producer (agentRuntime.checkRetryLoop) emits toolLoopCount.
  toolLoopCount: number;
}

export interface SystemAlertBatchRoutingSelected extends SystemAlertBase {
  type: 'batch_routing_selected';
  model: string;
  provider: string;
  tier: string;
  // agentRuntime writes `$${cost}` — every emission includes this; required.
  estimatedSavings: string;
}

export interface SystemAlertPrivacyRoutingLocal extends SystemAlertBase {
  type: 'privacy_routing_local';
  originalModel: string;
  routedModel: string;
  provider: string;
  // privacyRouter.decision.matches.length — every emission has this; required.
  matchCount: number;
}

export interface SystemAlertToolProvisioned extends SystemAlertBase {
  type: 'tool_provisioned';
}

export interface SystemAlertTokenUsageAnomaly extends SystemAlertBase {
  type: 'token_usage_anomaly';
  // Spread from anomalyDetector.checkForAnomaly() result; allow additional
  // fields permissively because the producer spreads a dynamic record.
  [key: string]: unknown;
}

export interface SystemAlertStagnation extends SystemAlertBase {
  type: 'stagnation';
  similarity: number;
  runId: string;
  agentId: string;
  stepNumber: number;
}

export interface SystemAlertEntropyGate extends SystemAlertBase {
  type: 'entropy_gate';
  reason: string;
}

export interface SystemAlertCycleDetected extends SystemAlertBase {
  type: 'cycle_detected';
  toolName: string;
  description: string;
}

export interface SystemAlertToolOutputInjectionBlocked extends SystemAlertBase {
  type: 'tool_output_injection_blocked';
  reason: string;
  // toolCallId is emitted from contentScanner callers but not all sites —
  // declared optional so union matches every observed shape.
  toolCallId?: string;
}

export interface SystemAlertToolOutputSanitized extends SystemAlertBase {
  type: 'tool_output_sanitized';
  categories: string[];
  toolCallId?: string;
}

export interface SystemAlertSlidingWindowSolidify extends SystemAlertBase {
  type: 'sliding_window_solidify';
  turnsSolidified: number;
  tokensFreed: number;
}

export interface SystemAlertSlidingWindowApplied extends SystemAlertBase {
  type: 'sliding_window_applied';
  turnsDropped: number;
  tokensFreed: number;
}

export interface SystemAlertSlidingWindowRetrieval extends SystemAlertBase {
  type: 'sliding_window_retrieval';
  entriesRetrieved: number;
  injectedTokens: number;
}

export interface SystemAlertContextCompaction extends SystemAlertBase {
  type: 'context_compaction';
  layer: string;
  droppedCount: number;
  tokensSaved: number;
}

export interface SystemAlertCascadeEscalation extends SystemAlertBase {
  type: 'cascade_escalation';
  from: string;
  to: string;
}

export interface SystemAlertContentThreatBlocked extends SystemAlertBase {
  type: 'content_threat_blocked';
  threats: string[];
  riskScore: number;
}

export interface SystemAlertCompensationSagaThrew extends SystemAlertBase {
  type: 'compensation_saga_threw';
  error: string;
  totalSteps: number;
  runId: string;
}

export interface SystemAlertNonReversibleTool extends SystemAlertBase {
  type: 'non_reversible_tool';
  tool: string;
  runId: string;
  agentId: string;
}

export interface SystemAlertEvolutionApplied extends SystemAlertBase {
  type: 'evolution_applied';
  applied: number;
  details: string[];
}

export interface SystemAlertFusionConflicts extends SystemAlertBase {
  type: 'fusion_conflicts';
  round: number;
  conflictCount: number;
}

export interface SystemAlertRegressionDetected extends SystemAlertBase {
  type: 'regression_detected';
  strategy: string;
  modelId: string;
  dropRatio: number;
}

/**
 * Discriminated union of every system.alert sub-event variant observed in
 * production code (Phase 2 catalog, June 2026). Used as
 * `BusPayloadMap['system.alert']` so Hub Glue handlers can `switch` on
 * `payload.type` with compile-time exhaustiveness checks.
 */
export type SystemAlertVariant =
  | SystemAlertSemanticCircuitTrip
  | SystemAlertRetryLoopDetected
  | SystemAlertBatchRoutingSelected
  | SystemAlertPrivacyRoutingLocal
  | SystemAlertToolProvisioned
  | SystemAlertTokenUsageAnomaly
  | SystemAlertStagnation
  | SystemAlertEntropyGate
  | SystemAlertCycleDetected
  | SystemAlertToolOutputInjectionBlocked
  | SystemAlertToolOutputSanitized
  | SystemAlertSlidingWindowSolidify
  | SystemAlertSlidingWindowApplied
  | SystemAlertSlidingWindowRetrieval
  | SystemAlertContextCompaction
  | SystemAlertCascadeEscalation
  | SystemAlertContentThreatBlocked
  | SystemAlertCompensationSagaThrew
  | SystemAlertNonReversibleTool
  | SystemAlertEvolutionApplied
  | SystemAlertFusionConflicts
  | SystemAlertRegressionDetected;

/**
 * Per-topic payload type map.
 * Each known topic declares what shape its payload has.
 * Topics not listed here (or '*' wildcard) use `unknown`.
 */
export interface BusPayloadMap {
  'agent.started': { taskId: string; goal: string; detail?: string; execId?: string };
  'agent.completed': { taskId: string; status: string; metrics?: Record<string, number> };
  'agent.failed': { taskId: string; error: string };
  'agent.message': { from: string; content: string };
  'goal.started': { goal: string; mode: string };
  'goal.decomposed': { subGoalCount: number; decomposition: unknown };
  'goal.round_started': { round: number; activeGoals: number };
  'goal.round_completed': { round: number; decision: string };
  'goal.worker_started': { goalId: string; goal: string };
  'goal.worker_completed': { goalId: string };
  'goal.worker_failed': { goalId: string; error: string };
  'goal.critic_started': { goalId: string };
  'goal.critic_completed': { goalId: string };
  'goal.manager_review': { round: number };
  'goal.completed': { goal: string; status: string; summary: string };
  'goal.judge_started': { runId: string; conditionCount: number; evidenceCount: number };
  'goal.judge_completed': {
    runId: string;
    passed: boolean;
    confidence: number;
    tokensUsed: number;
    modelUsed?: string;
  };
  'drive.started': { goal: string; mode: string };
  'drive.step_started': { stepId: string; description: string };
  'drive.step_completed': { stepId: string; result?: string };
  'drive.step_failed': { stepId: string; error: string };
  'drive.completed': { summary: string };
  'swarm.started': { goal: string; agentCount: number };
  'swarm.fission': { parentId: string; childIds: string[] };
  'swarm.fusion_conflict': { agentIds: string[]; conflict: string };
  'swarm.round_completed': { round: number; results: unknown[] };
  'swarm.completed': { summary: string };
  'sop.generated': {
    runId: string;
    agentId: string;
    goal: string;
    path: string;
    stepCount: number;
    status: string;
    tags?: string[];
  };
  'memory.written': { layer: string; content: string; tags?: string[] };
  'skills.created': { skills: string[]; execId: string };
  'system.alert': SystemAlertVariant;
  'tool.executed': { name: string; durationMs: number; success: boolean };
  'tool.started': { name: string };
  'tool.completed': { name: string; durationMs: number };
  'tool.timeout': { name: string; timeoutMs: number };
  'tool.retry': { name: string; attempt: number; error: string };
  'tool.blocked': { name: string; reason: string };
  'tool.compensation_planned': { runId: string; toolName: string; stepCount: number; risk: string };
  'tool.compensation_step': {
    runId: string;
    toolName: string;
    actionId: string;
    stepIndex: number;
    totalSteps: number;
    status: 'started' | 'completed' | 'failed';
    error?: string;
  };
  'agent.interrupted': { runId: string; reason: string; value?: unknown };
  'human.approval_required': {
    approvalId: string;
    runId: string;
    nodeId: string;
    nodeGoal: string;
    gate: string;
    riskLevel: string;
    timeoutMs: number;
    requesterId: string;
  };
  'human.approval_received': {
    approvalId: string;
    runId: string;
    nodeId: string;
    approverId: string;
    decision: string;
    note?: string;
  };
  'human.approval_rejected': { approvalId: string; runId: string; nodeId: string; reason: string };
  'human.approval_timeout': {
    approvalId: string;
    runId: string;
    nodeId: string;
    requestedAt: string;
  };
  'workflow.replan': { phase: string; reason: string; agentId: string };
  'channel.message': { channelId: string; content: string };
  'channel.connected': { channelId: string };
  'channel.disconnected': { channelId: string };
  'channel.error': { channelId: string; error: string };
  'channel.interaction': { channelId: string; type: string; data: unknown };
  'mission.updated': { missionId: string; status: string };
  'mission.blocked': { missionId: string; reason: string };
  'mission.completed': { missionId: string; result: string };
  'trace.recorded': { traceId: string; spanCount: number };
  'checkpoint.written': {
    runId: string;
    version: number;
    triggerPercent: number;
    tokensUsed: number;
    completedCount: number;
    pendingCount: number;
    filePath: string;
  };
  'context.rebuilt': {
    runId: string;
    rebuildCount: number;
    totalTokens: number;
    sections: Array<{ name: string; used: number; cap: number }>;
    durationMs: number;
  };
  'security.event': SecurityEvent;
  'recovery.completed': {
    scanned: number;
    recovered: number;
    aborted: number;
    skipped: number;
    details: Array<{
      runId: string;
      tenantId?: string;
      state: string;
      action: string;
      reason: string;
    }>;
  };
  // --- Hub Glue: closed-loop event payloads (Phase 1 wiring) ---
  'orchestrator.topology_optimized': {
    runId: string;
    original: string;
    suggested: string;
    reasoning: string[];
  };
  'orchestrator.suggested_replan': {
    runId: string;
    phase: string;
    reason: string;
    plan: string;
  };
  'runtime.conversation_turn': {
    runId: string;
    sessionId: string;
    role: string;
    content: string;
  };
  'runtime.dlq_enqueued': {
    runId: string;
    category: string;
    operation: string;
    error: string;
  };
  'sandbox.escape_attempted': {
    runId: string;
    lane: string;
    toolName: string;
    args: string;
    constraint: string;
  };
  'sandbox.executed': {
    runId: string;
    lane: string;
    toolName: string;
    durationMs: number;
    result: string;
  };
  'telemetry.metric.recorded': {
    name: string;
    value: number;
    tags: string[];
  };
  'telemetry.intent.recorded': {
    runId: string;
    stage: string;
    decision: string;
    payload: unknown;
  };
  'memory.queried': {
    runId: string;
    query: string;
    resultsFound: number;
    latencyMs: number;
  };
  'memory.semantic_promoted': {
    memoryId: string;
    fromLayer: string;
    toLayer: string;
  };
  'memory.user.interaction_recorded': {
    userId: string;
    interactionType: string;
    content: string;
  };
  'memory.episodic_reinforced': {
    episodeId: string;
    weight: number;
  };
  'memory.lesson_derived': {
    lessonId: string;
    scope: string;
    sourceEpisodeIds: string[];
  };
  'memory.feedback_signal': {
    targetMemoryId: string;
    signal: 'positive' | 'negative';
    weight: number;
  };
  'memory.procedural_compiled': {
    procedureId: string;
    steps: number;
  };
  'security.capability_minted': {
    capabilityId: string;
    subjectId: string;
    scope: string[];
    ttl: number;
  };
  'security.capability_revoked': {
    capabilityId: string;
    reason: string;
  };
  'security.token_delegated': {
    parentId: string;
    childId: string;
    subjectId: string;
  };
}

export interface SecurityEvent {
  type: string;
  timestamp: string;
  severity?: 'info' | 'warn' | 'error' | 'critical';
  details?: Record<string, unknown>;
}

/**
 * A message on the bus, typed per topic.
 * For a known topic T, `payload` is the correct shape.
 * For '*' or unknown topics, `payload` stays `unknown`.
 */
export type TypedBusMessage<T extends MessageBusTopic = MessageBusTopic> =
  T extends keyof BusPayloadMap
    ? Omit<BusMessage, 'topic' | 'payload'> & { topic: T; payload: BusPayloadMap[T] }
    : BusMessage & { topic: T };

/**
 * A message on the bus.
 */
export interface BusMessage {
  id: string;
  topic: MessageBusTopic;
  source: string; // agent ID or 'system'
  target?: string; // specific agent or undefined = broadcast
  payload: unknown;
  priority: MessagePriority;
  timestamp: string;
  ttl?: number; // time-to-live in ms
}

/**
 * Handler for bus messages.
 */
export type MessageHandler = (message: BusMessage) => void | Promise<void>;
