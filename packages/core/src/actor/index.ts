/**
 * Actor Model infrastructure for Commander.
 *
 * Provides the Actor Model pattern for concurrent agent execution.
 * Each actor is an independent unit of computation with its own mailbox,
 * communicating only via async messages with built-in supervision.
 *
 * Usage:
 * ```typescript
 * import { ActorSystem, WorkerAgent } from './actor';
 *
 * const system = new ActorSystem({ name: 'my-system' });
 * system.start();
 *
 * const worker = new WorkerAgent({ agentRuntime: runtime });
 * const ref = system.createActor(worker.definition);
 *
 * system.send(ref.id, {
 *   id: 'task-1',
 *   type: 'execute_subtask',
 *   timestamp: Date.now(),
 *   taskNode: myTask,
 *   projectId: 'project-1',
 *   baseContext: {},
 * });
 * ```
 */

export type {
  ActorId,
  ActorState,
  ActorMessage,
  ActorContext,
  ActorRef,
  ActorBehavior,
  ActorDefinition,
  ActorLogger,
  ActorMetrics,
  ActorSystemConfig,
  ActorSystemMetrics,
  MailboxConfig,
  MailboxEntry,
  SupervisorConfig,
  RestartStrategy,
  RestartRecord,
  StartMessage,
  StopMessage,
  SuspendMessage,
  ResumeMessage,
  RestartMessage,
  StatusQueryMessage,
  StatusResponseMessage,
  ExecuteSubtaskMessage,
  SubtaskResultMessage,
  ParallelCoordinationMessage,
  WorkerAgentConfig,
  WorkerAgentState,
  WorkerAgentMessage,
} from './types';

export {
  DEFAULT_MAILBOX_CONFIG,
  DEFAULT_SUPERVISOR_CONFIG,
  DEFAULT_ACTOR_SYSTEM_CONFIG,
  isSystemMessage,
  isRequestMessage,
  createStatusQuery,
  createStopMessage,
} from './types';

export { Mailbox } from './mailbox';
export { Supervisor } from './supervisor';
export { ActorSystem, getActorSystem, resetActorSystem } from './actorSystem';
export { WorkerAgent } from './workerAgent';
