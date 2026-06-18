/**
 * Harness Subsystem
 *
 * Pluggable agent execution strategies (default, code-agent, MCP) plus the
 * shared infrastructure (file watcher, patch engine, sub-agent bridge, etc.)
 * that multi-backend harnesses can reuse.
 */

// Types and constants
export * from './harnessTypes';

// Concrete harness implementations
export { DefaultHarness, DEFAULT_HARNESS_CAPABILITIES } from './defaultHarness';
export {
  CodeAgentHarness,
  CODE_AGENT_HARNESS_CAPABILITIES,
  DEFAULT_GUARDIAN_CONFIG,
} from './codeAgentHarness';
export { McpHarness, MCP_HARNESS_CAPABILITIES } from './mcpHarness';

// Registry
export { HarnessRegistry } from './harnessRegistry';

// Shared infrastructure
export {
  EventBus,
  SkillsBridge,
  SubAgentBridge,
  FileWatcher,
  SessionStore,
  NetworkPolicyEnforcer,
  CommandClassifier,
  SteerQueueImpl as SteerQueue,
  PatchEngine,
  PlanTracker,
  HarnessInfrastructure,
} from './harnessInfrastructure';
export type { HarnessInfrastructureOptions } from './harnessInfrastructure';
