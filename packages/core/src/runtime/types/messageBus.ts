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
  | 'security.event';

/**
 * Priority levels for messages.
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

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
  'system.alert': { level: 'info' | 'warn' | 'error'; message: string; detail?: string };
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
