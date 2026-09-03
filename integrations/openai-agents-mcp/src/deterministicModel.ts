import {
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents';

function toolResultText(input: ModelRequest['input']): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type !== 'function_call_result') continue;
    if (typeof item.output === 'string') return item.output;
    if (!Array.isArray(item.output) && item.output.type === 'text') return item.output.text;
    return JSON.stringify(item.output);
  }
  return undefined;
}

export class DeterministicToolModel implements Model {
  readonly toolName: string;
  readonly args: Record<string, unknown>;

  constructor(toolName: string, args: Record<string, unknown>) {
    this.toolName = toolName;
    this.args = structuredClone(args);
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const result = toolResultText(request.input);
    if (result !== undefined) {
      return {
        usage: new Usage(),
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: result }],
          },
        ],
        responseId: 'commander-deterministic-final',
      };
    }

    return {
      usage: new Usage(),
      output: [
        {
          type: 'function_call',
          callId: 'commander-call-1',
          name: this.toolName,
          arguments: JSON.stringify(this.args),
          status: 'completed',
        },
      ],
      responseId: 'commander-deterministic-tool-call',
    };
  }

  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('DETERMINISTIC_STREAMING_UNSUPPORTED');
  }
}
