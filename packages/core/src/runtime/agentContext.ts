import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentContextStore {
  agentId: string;
  outputDir?: string;
}

export const agentContext = new AsyncLocalStorage<AgentContextStore>();
