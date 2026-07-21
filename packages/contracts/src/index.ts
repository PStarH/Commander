/**
 * @commander/contracts — Architecture V2 shared public contracts.
 *
 * This package contains ONLY types, constants, and pure validation helpers.
 * It must never import runtime implementation code from @commander/core,
 * @commander/kernel, or any provider/tool package.
 */

export { CONTRACTS_VERSION } from './resources.js';
export type {
  AgentDefinitionV2,
  ArtifactV2,
  ConnectorDefinitionV2,
  ConnectorAuthMode,
  EffectV2,
  EffectStatus,
  EnvironmentV2,
  InteractionV2,
  OrganizationV2,
  PolicyBundleV2,
  PrincipalV2,
  ProjectV2,
  RunV2,
  StepV2,
  ToolDefinitionV2,
  ToolRiskLevel,
  WorkGraphV2,
  WorkerV2,
} from './resources.js';

export {
  isTerminalRunState,
  isTerminalStepState,
  isValidRunTransition,
  isValidStepTransition,
  RUN_STATES,
  RUN_TRANSITIONS,
  STEP_STATES,
  STEP_TRANSITIONS,
  TERMINAL_RUN_STATES,
  TERMINAL_STEP_STATES,
} from './states.js';
export type { RunState, StepState } from './states.js';

export type { AggregateType, KernelEvent } from './events.js';

// --- WS2 Effect Envelope (unified external side-effect contract) ---
export {
  EFFECT_ACTION_NAMESPACES,
  EFFECT_ID_PATTERN,
  actionNamespace,
  isValidEffectEnvelopeIdentity,
} from './effects.js';
export type {
  EffectActionNamespace,
  EffectEnvelope,
  EffectEnvelopeStatus,
} from './effects.js';

export { KERNEL_ERROR_CODES } from './errors.js';
export type { KernelErrorCode, KernelErrorDetails } from './errors.js';

export { validateRunTransition, validateStepTransition } from './transitions.js';
export type { TransitionResult } from './transitions.js';

// --- JSON Schema definitions ---
export { CONTRACT_SCHEMAS } from './schemas.js';
export type { ContractSchemaName } from './schemas.js';

// --- OpenAPI V1 specification ---
export { OPENAPI_V1_SPEC } from './openapi.js';
export type { OpenApiV1Spec } from './openapi.js';

// --- Compatibility & version checking ---
export {
  CONTRACT_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  detectBreakingChanges,
  isCompatibleSchemaVersion,
  snapshotContracts,
  validateResource,
} from './compatibility.js';
export type { ContractSnapshot } from './compatibility.js';

// --- Constitution versioned envelopes + grant (L4 action gateway) ---
export {
  CONSTITUTION_CONTRACT_VERSIONS,
  RUN_CONTRACT_VERSION,
  EVENT_CONTRACT_VERSION,
  EFFECT_CONTRACT_VERSION,
  GRANT_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
} from './versioned.js';
export type { VersionedContract, ConstitutionContractVersion } from './versioned.js';

export { GrantV1, GRANT_CONTRACT_VERSION as GRANT_VERSION, wrapGrantV1 } from './grant.js';
export type { GrantContractV1 } from './grant.js';

export { upcastLegacyGrantToV1, getLegacyGrantUpcastCount } from './upcasters/index.js';
export type { LegacyGrantPayload } from './upcasters/index.js';

export {
  commanderActionMarker,
  compensationIdempotencyKey,
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  FIXED_ACTION_ADAPTER_MANIFESTS,
  githubPrBodyMarker,
  GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
  servicenowCorrelationId,
  SERVICENOW_INCIDENT_CREATE_DESCRIPTOR,
} from './actionAdapters.js';
export type {
  ActionAdapterDescriptorV1,
  ActionGatewayEffect,
} from './actionAdapters.js';

// --- Shared identity, policy, audit, and plugin contracts ---
export {
  CONTROL_PLANE_API_VERSION,
  CONTROL_PLANE_RESOURCES,
} from './controlPlane.js';
export type {
  AuditEventV2,
  ControlPlaneResource,
  PluginSandboxMode,
  PolicyDecisionV2,
  PolicyEffect,
  WorkloadIdentity,
} from './controlPlane.js';
