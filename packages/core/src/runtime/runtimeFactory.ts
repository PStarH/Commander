import { AgentRuntime } from './agentRuntime';
import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import type { AgentRuntimeConfig, LLMProvider } from './types';
import type { ModelRouter } from './modelRouter';
import type { TenantProvider } from './tenantProvider';

export interface AgentRuntimeFactoryOptions {
  config?: Partial<AgentRuntimeConfig>;
  router?: ModelRouter;
  tenantProvider?: TenantProvider;
  providers?: Record<string, LLMProvider>;
}

export type AgentRuntimeFactory = (tenantId: string) => AgentRuntimeInterface;

export function createAgentRuntimeFactory(
  options: AgentRuntimeFactoryOptions = {},
): AgentRuntimeFactory {
  return (tenantId: string) => {
    const runtime = new AgentRuntime(options.config, options.router, options.tenantProvider);
    if (options.providers) {
      for (const [name, provider] of Object.entries(options.providers)) {
        runtime.registerProvider(name, provider);
      }
    }
    return runtime;
  };
}
