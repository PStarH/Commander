import { KernelStepExecutor, createAgentRuntimeFactory } from '@commander/core';
import type { StepExecutor } from './types.js';
import type { AgentRuntimeFactoryOptions } from '@commander/core';
import type { EffectBroker } from '@commander/effect-broker';

export { KernelStepExecutor } from '@commander/core';
// WS7: SandboxManager is re-exported so sandboxReadiness can consume it via
// this file — the constitution's single sanctioned worker-plane→core bridge
// (scripts/arch-guard.sh isWorkerCoreBridge).
export { SandboxManager } from '@commander/core';

export interface AgentStepExecutorOptions extends AgentRuntimeFactoryOptions {
  defaultMaxSteps?: number;
  defaultTokenBudget?: number;
  defaultProjectId?: string;
  /**
   * WS2 §10 Phase 2.4: the unified EffectBroker the agent runtime must use for
   * external LLM provider calls (action namespace `llm.*`). When provided, the
   * runtime's provider-call layer should route each LLM request through
   * `broker.execute({ type: 'llm.<provider>', ... })` so every external side
   * effect goes through the sole PEP. Provider-call interception itself is an
   * incremental follow-up; this field establishes the wiring contract.
   */
  effectBroker?: EffectBroker;
}

export function createAgentStepExecutor(options: AgentStepExecutorOptions = {}): StepExecutor {
  const runtimeFactory = createAgentRuntimeFactory(options);
  const executor = new KernelStepExecutor(runtimeFactory, {
    defaultMaxSteps: options.defaultMaxSteps,
    defaultTokenBudget: options.defaultTokenBudget,
    defaultProjectId: options.defaultProjectId,
  });
  // WS2 §10: the broker is wired but provider-call interception is deferred.
  // When options.effectBroker is set, downstream LLM provider calls should be
  // wrapped through broker.execute({ type: 'llm.*' }). See spec §1 architecture.
  void options.effectBroker;
  return executor;
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
