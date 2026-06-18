import type { Tool, AgentExecutionContext } from '../runtime/types';
import { InterruptError } from '../runtime/interruptError';

/**
 * Built-in tool that requests human input mid-execution.
 * When ctx.resumeWith is set, returns that value (resume path).
 * Otherwise throws InterruptError to pause execution (interrupt path).
 */
export function createRequestHumanInputTool(): Tool {
  return {
    definition: {
      name: 'request_human_input',
      description:
        'Pause execution and request input from a human. Use when you need approval, clarification, or a decision before continuing. The human response will be returned as the tool result.',
      category: 'control',
      inputSchema: {
        type: 'object' as const,
        properties: {
          reason: {
            type: 'string',
            description:
              'Why you need human input (e.g., "Approve destructive action?", "Which approach should I take?")',
          },
          value: {
            description:
              'Optional payload to present to the human (proposed action, options, etc.)',
          },
        },
        required: ['reason'],
      },
    },
    execute(args: Record<string, unknown>, ctx?: AgentExecutionContext): Promise<string> {
      // Resume path: if human input was provided, return it
      if (ctx?.resumeWith !== undefined) {
        return Promise.resolve(String(ctx.resumeWith));
      }
      // Interrupt path: pause execution
      const reason = String(args.reason ?? 'Human input requested');
      const value = args.value ?? reason;
      throw new InterruptError(reason, value);
    },
    isReadOnly: true,
    riskLevel: 'low',
  };
}
