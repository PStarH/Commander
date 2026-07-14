import { KernelStepExecutor, createAgentRuntimeFactory } from '@commander/core';
import type { StepExecutor } from './types.js';
import type { AgentRuntimeFactoryOptions } from '@commander/core';

export { KernelStepExecutor } from '@commander/core';

export interface AgentStepExecutorOptions extends AgentRuntimeFactoryOptions {
  defaultMaxSteps?: number;
  defaultTokenBudget?: number;
  defaultProjectId?: string;
}

export function createAgentStepExecutor(options: AgentStepExecutorOptions = {}): StepExecutor {
  const runtimeFactory = createAgentRuntimeFactory(options);
  return new KernelStepExecutor(runtimeFactory, {
    defaultMaxSteps: options.defaultMaxSteps,
    defaultTokenBudget: options.defaultTokenBudget,
    defaultProjectId: options.defaultProjectId,
  });
}

export interface ExecutorManifestEntry {
  kind: string;
  factory: () => StepExecutor | Promise<StepExecutor>;
}

export interface ExecutorManifest {
  entries: ReadonlyMap<string, ExecutorManifestEntry>;
  validate(capabilities: string[]): void;
}

export function createExecutorManifest(
  factories: Record<string, () => StepExecutor | Promise<StepExecutor>>,
): ExecutorManifest {
  const entries = new Map<string, ExecutorManifestEntry>();
  for (const [kind, factory] of Object.entries(factories)) {
    entries.set(kind, { kind, factory });
  }

  return {
    entries,
    validate(capabilities: string[]) {
      const required = capabilities.includes('*') ? Array.from(entries.keys()) : capabilities;
      const missing = required.filter((cap) => !entries.has(cap));
      if (missing.length > 0) {
        throw new Error(`Executor manifest missing required capabilities: ${missing.join(', ')}`);
      }
    },
  };
}
