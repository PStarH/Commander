import { AsyncLocalStorage } from 'node:async_hooks';
export interface AgentContextStore {
    agentId: string;
    outputDir?: string;
}
export declare const agentContext: AsyncLocalStorage<AgentContextStore>;
//# sourceMappingURL=agentContext.d.ts.map