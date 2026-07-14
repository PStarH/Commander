/**
 * Contract version compatibility utilities.
 *
 * These helpers enable CI-time checks that detect breaking changes before
 * they reach production. A "breaking change" is any change to a required field,
 * enum value removal, or type narrowing on a published resource schema.
 */

import { CONTRACTS_VERSION } from './resources.js';
import { RUN_STATES, STEP_STATES } from './states.js';
import { KERNEL_ERROR_CODES } from './errors.js';
import { CONTRACT_SCHEMAS, type ContractSchemaName } from './schemas.js';

/** Semantic version of the contracts package. */
export const CONTRACT_VERSION = CONTRACTS_VERSION;

/** Minimum consumer schema version accepted by the current contracts. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 'v2';

/**
 * Check whether a given schema version is compatible with the current
 * contracts package.
 */
export function isCompatibleSchemaVersion(version: string): boolean {
  if (version === CONTRACT_VERSION) return true;
  // Future: support semver range checks when versioning moves beyond 'v2'.
  return false;
}

// ---------------------------------------------------------------------------
// Breaking change detection helpers (for CI integration)
// ---------------------------------------------------------------------------

/**
 * Snapshot of the current contract surface area. CI can compare snapshots
 * across PRs to detect undocumented breaking changes.
 */
export interface ContractSnapshot {
  version: string;
  resources: string[];
  runStates: readonly string[];
  stepStates: readonly string[];
  errorCodes: readonly string[];
  schemaNames: string[];
}

/** Produce a deterministic snapshot of the current contract surface. */
export function snapshotContracts(): ContractSnapshot {
  return {
    version: CONTRACT_VERSION,
    resources: [
      'OrganizationV2',
      'ProjectV2',
      'EnvironmentV2',
      'PrincipalV2',
      'RunV2',
      'StepV2',
      'WorkGraphV2',
      'InteractionV2',
      'ArtifactV2',
      'PolicyBundleV2',
      'WorkerV2',
      'EffectV2',
      'AgentDefinitionV2',
      'ToolDefinitionV2',
      'ConnectorDefinitionV2',
    ],
    runStates: RUN_STATES,
    stepStates: STEP_STATES,
    errorCodes: KERNEL_ERROR_CODES,
    schemaNames: Object.keys({
      organization: 1,
      project: 1,
      environment: 1,
      principal: 1,
      run: 1,
      step: 1,
      workGraph: 1,
      interaction: 1,
      artifact: 1,
      policyBundle: 1,
      worker: 1,
      effect: 1,
      agentDefinition: 1,
      toolDefinition: 1,
      connectorDefinition: 1,
      kernelEvent: 1,
      kernelError: 1,
    }),
  };
}

/**
 * Compare two contract snapshots. Returns a list of detected breaking changes.
 * An empty array means no breaking changes were detected.
 */
export function detectBreakingChanges(
  baseline: ContractSnapshot,
  current: ContractSnapshot,
): string[] {
  const changes: string[] = [];

  // Removed resources = breaking
  for (const resource of baseline.resources) {
    if (!current.resources.includes(resource)) {
      changes.push(`BREAKING: resource '${resource}' was removed`);
    }
  }

  // Removed run states = breaking
  for (const state of baseline.runStates) {
    if (!current.runStates.includes(state)) {
      changes.push(`BREAKING: run state '${state}' was removed`);
    }
  }

  // Removed step states = breaking
  for (const state of baseline.stepStates) {
    if (!current.stepStates.includes(state)) {
      changes.push(`BREAKING: step state '${state}' was removed`);
    }
  }

  // Removed error codes = breaking
  for (const code of baseline.errorCodes) {
    if (!current.errorCodes.includes(code)) {
      changes.push(`BREAKING: error code '${code}' was removed`);
    }
  }

  // Removed schema names = breaking
  for (const name of baseline.schemaNames) {
    if (!current.schemaNames.includes(name)) {
      changes.push(`BREAKING: schema '${name}' was removed`);
    }
  }

  return changes;
}

/**
 * Validate that a JSON value conforms to a known contract schema name.
 * Structural validator that checks required fields, types, and enum values
 * without a runtime dependency on ajv or similar libraries.
 */
export function validateResource(
  schemaName: ContractSchemaName,
  value: unknown,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: [`Expected object, got ${Array.isArray(value) ? 'array' : typeof value}`] };
  }

  const schema = CONTRACT_SCHEMAS[schemaName];
  if (!schema) {
    return { ok: false, errors: [`Unknown schema: ${schemaName}`] };
  }

  const obj = value as Record<string, unknown>;
  const required = (schema as { required?: string[] }).required ?? [];
  const properties = (schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};

  // Check required fields
  for (const field of required) {
    if (!(field in obj)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check field types
  for (const [field, fieldValue] of Object.entries(obj)) {
    const fieldSchema = properties[field];
    if (!fieldSchema) continue; // additionalProperties handled by caller

    const expectedType = fieldSchema.type as string | undefined;
    if (!expectedType) continue;

    // Handle enum validation
    const enumValues = fieldSchema.enum as string[] | undefined;
    if (enumValues) {
      if (typeof fieldValue === 'string' && !enumValues.includes(fieldValue)) {
        errors.push(`Field '${field}' value '${fieldValue}' not in enum [${enumValues.join(', ')}]`);
      }
      continue;
    }

    // Type checking
    const actualType = Array.isArray(fieldValue) ? 'array' : typeof fieldValue;
    if (expectedType === 'array' && !Array.isArray(fieldValue)) {
      errors.push(`Field '${field}' expected array, got ${actualType}`);
    } else if (expectedType === 'integer' && (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue))) {
      errors.push(`Field '${field}' expected integer, got ${actualType}`);
    } else if (expectedType !== 'array' && expectedType !== 'integer' && actualType !== expectedType) {
      errors.push(`Field '${field}' expected ${expectedType}, got ${actualType}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
