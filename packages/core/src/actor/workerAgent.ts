/**
 * WorkerAgent actor for executing subtasks.
 *
 * Wraps the existing SubAgentExecutor functionality into an actor
 * that can be supervised and communicate via messages.
 *
 * Each WorkerAgent:
 * - Processes one task at a time (state machine)
 * - Reports results via SubtaskResultMessage
 * - Handles errors with supervisor restart strategies
 * - Tracks execution metrics
 */

import type {
  ActorContext,
  ActorBehavior,
  ActorDefinition,
  WorkerAgentConfig,
  WorkerAgentState,
  ExecuteSubtaskMessage,
  SubtaskResultMessage,
  StatusQueryMessage,
  StatusResponseMessage,
  StopMessage,
  WorkerAgentMessage,
} from './types';
import type { AgentRuntime } from '../runtime/agentRuntime';
import type { AgentExecutionContext, AgentExecutionResult } from '../runtime/types';
import type { TaskTreeNode } from '../ultimate/types';

/**
 * WorkerAgent executes subtasks as an actor.
 */
export class WorkerAgent {
  private readonly agentRuntime: AgentRuntime;
  private readonly config: WorkerAgentConfig;

  constructor(config: WorkerAgentConfig) {
    this.config = config;
    this.agentRuntime = config.agentRuntime as AgentRuntime;
  }

  get definition(): ActorDefinition<WorkerAgentState> {
    return {
      typeName: 'WorkerAgent',
      behavior: this.createBehavior(),
      mailboxConfig: {
        capacity: 100,
        defaultPriority: 0,
        overflowProtectionTypes: ['stop', 'status_query'],
        deduplication: true,
        maxMessageAgeMs: 600000,
      },
    };
  }

  private createBehavior(): ActorBehavior<WorkerAgentState> {
    return {
      initialState: {
        completedTasks: 0,
        failedTasks: 0,
        totalExecutionTimeMs: 0,
      },

      onStarted: async (context) => {
        context.logger.info('WorkerAgent started', { actorId: context.actorId });
      },

      onStopped: async (context, state) => {
        context.logger.info('WorkerAgent stopped', {
          actorId: context.actorId,
          completedTasks: state.completedTasks,
          failedTasks: state.failedTasks,
        });
      },

      receive: async (context, state, message) => {
        switch (message.type) {
          case 'execute_subtask':
            return this.handleExecuteSubtask(context, state, message as ExecuteSubtaskMessage);

          case 'status_query':
            this.handleStatusQuery(context, state, message as StatusQueryMessage);
            return state;

          case 'stop':
            return this.handleStop(context, state, message as StopMessage);

          default:
            context.logger.warn('Unknown message type', {
              actorId: context.actorId,
              messageType: message.type,
            });
            return state;
        }
      },
    };
  }

  private async handleExecuteSubtask(
    context: ActorContext,
    state: WorkerAgentState,
    message: ExecuteSubtaskMessage,
  ): Promise<WorkerAgentState> {
    const startTime = Date.now();

    context.logger.info('Executing subtask', {
      actorId: context.actorId,
      taskId: message.taskNode.id,
    });

    try {
      const result = await this.executeTask(
        message.taskNode,
        message.projectId,
        message.baseContext,
      );

      const executionTime = Date.now() - startTime;

      const responseMessage: SubtaskResultMessage = {
        id: `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'subtask_result',
        timestamp: Date.now(),
        sender: context.actorId,
        correlationId: message.correlationId,
        taskId: message.taskNode.id,
        result,
        success: true,
      };

      if (message.sender) {
        context.send(message.sender, responseMessage);
      }

      return {
        ...state,
        completedTasks: state.completedTasks + 1,
        totalExecutionTimeMs: state.totalExecutionTimeMs + executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      context.logger.error('Subtask execution failed', error as Error, {
        actorId: context.actorId,
        taskId: message.taskNode.id,
      });

      const responseMessage: SubtaskResultMessage = {
        id: `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'subtask_result',
        timestamp: Date.now(),
        sender: context.actorId,
        correlationId: message.correlationId,
        taskId: message.taskNode.id,
        result: {
          runId: '',
          agentId: context.actorId,
          status: 'failed',
          summary: `Execution failed: ${(error as Error).message}`,
          steps: [],
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: executionTime,
          error: (error as Error).message,
        },
        success: false,
        error: (error as Error).message,
      };

      if (message.sender) {
        context.send(message.sender, responseMessage);
      }

      throw error;
    }
  }

  private handleStatusQuery(
    context: ActorContext,
    state: WorkerAgentState,
    message: StatusQueryMessage,
  ): void {
    const response: StatusResponseMessage = {
      id: `status_response_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'status_response',
      timestamp: Date.now(),
      sender: context.actorId,
      correlationId: message.correlationId,
      state: context.self.state,
      actorId: context.actorId,
      mailboxSize: 0,
      uptimeMs: 0, // Actor creation time not tracked — return 0 as safe default
      processedCount: state.completedTasks + state.failedTasks,
      failedCount: state.failedTasks,
    };

    if (message.sender) {
      context.send(message.sender, response);
    }
  }

  private handleStop(
    context: ActorContext,
    state: WorkerAgentState,
    message: StopMessage,
  ): WorkerAgentState {
    context.logger.info('WorkerAgent stopping', {
      actorId: context.actorId,
      reason: message.reason,
    });

    return state;
  }

  private async executeTask(
    taskNode: TaskTreeNode,
    projectId: string,
    baseContext: Record<string, unknown>,
  ): Promise<AgentExecutionResult> {
    const context: AgentExecutionContext = {
      agentId: `worker-${taskNode.id}`,
      projectId,
      goal: taskNode.goal,
      contextData: {
        ...baseContext,
        taskNode,
      } as AgentExecutionContext['contextData'],
      availableTools: taskNode.context.availableTools ?? [],
      maxSteps: 50,
      tokenBudget: taskNode.context.estimatedTokens ?? 5000,
    };

    const result = await this.agentRuntime.execute(context);
    return result;
  }
}
