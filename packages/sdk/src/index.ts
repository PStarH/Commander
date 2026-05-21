/**
 * @commander/sdk — Commander Agent SDK
 *
 * Embed Commander's multi-agent orchestration in your own applications.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { CommanderClient } from '@commander/sdk';
 *
 * const client = new CommanderClient({ provider: 'openai' });
 * await client.connect();
 *
 * const result = await client.run('analyze this repository');
 * console.log(result.summary);
 *
 * await client.disconnect();
 * ```
 *
 * ## Events
 *
 * ```typescript
 * const unsub = client.onEvent((event) => {
 *   console.log(`[${event.type}]`, event.data);
 * });
 * ```
 */

export { CommanderClient } from './commanderClient';
export type {
  CommanderClientConfig,
  ExecutionResult,
  ExecutionEvent,
  ExecutionStepSummary,
  SessionSummary,
  SystemStatus,
} from './types';
