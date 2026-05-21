/**
 * Tool Call Argument Validator — Zero-Dependency JSON Schema Validation
 *
 * Validates LLM-generated arguments against tool inputSchema before execution.
 * Compiled once at tool registration time for <1ms per validation.
 *
 * Inspired by Hermes' multi-layer validation:
 * 1. Required field check
 * 2. Type check with safe coercion
 * 3. Enum validation
 * 4. Range clamping (minimum/maximum)
 * 5. Default injection
 */

import type { CompiledSchema, ValidationResult } from './types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Schema Compilation
// ============================================================================

/**
 * Pre-process a JSON Schema into an optimized validation structure.
 * Called once at tool registration time, not per invocation.
 */
export function compileSchema(schema: Record<string, unknown>): CompiledSchema {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  const propertyTypes = new Map<string, string>();
  const propertyEnums = new Map<string, unknown[]>();
  const propertyConstraints = new Map<string, { minimum?: number; maximum?: number }>();
  const defaults = new Map<string, unknown>();

  for (const [key, propSchema] of Object.entries(properties)) {
    if (propSchema.type) {
      propertyTypes.set(key, propSchema.type as string);
    }
    if (propSchema.enum) {
      propertyEnums.set(key, propSchema.enum as unknown[]);
    }
    if (propSchema.minimum !== undefined || propSchema.maximum !== undefined) {
      propertyConstraints.set(key, {
        minimum: propSchema.minimum as number | undefined,
        maximum: propSchema.maximum as number | undefined,
      });
    }
    if (propSchema.default !== undefined) {
      defaults.set(key, propSchema.default);
    }
  }

  return {
    requiredFields: required,
    propertyTypes,
    propertyEnums,
    propertyConstraints,
    defaults,
    raw: schema,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate tool call arguments against a compiled schema.
 * Returns validation result with errors and optionally repaired args.
 */
export function validateToolCall(
  args: Record<string, unknown>,
  schema: CompiledSchema,
): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  const repaired: Record<string, unknown> = { ...args };
  const repairs: string[] = [];

  // Step 1: Inject defaults for missing optional fields
  for (const [key, defaultVal] of Array.from(schema.defaults)) {
    if (repaired[key] === undefined) {
      repaired[key] = defaultVal;
      repairs.push(`${key}: injected default value`);
    }
  }

  // Step 2: Check required fields
  for (const field of schema.requiredFields) {
    if (repaired[field] === undefined || repaired[field] === null) {
      errors.push({
        path: field,
        message: `required but missing`,
        expectedType: schema.propertyTypes.get(field),
        actualValue: repaired[field],
      });
    }
  }

  // Step 3: Type checking with safe coercion
  for (const [key, expectedType] of Array.from(schema.propertyTypes)) {
    const value = repaired[key];
    if (value === undefined || value === null) continue; // already handled by required check

    const actualType = typeof value;
    if (actualType === expectedType) continue; // type matches

    // Try safe coercion
    const coerced = tryCoerce(value, expectedType);
    if (coerced !== undefined) {
      repaired[key] = coerced;
      repairs.push(`${key}: coerced from ${actualType} "${value}" to ${expectedType} ${coerced}`);
    } else {
      errors.push({
        path: key,
        message: `expected ${expectedType}, got ${actualType} ${JSON.stringify(value)}`,
        expectedType,
        actualValue: value,
      });
    }
  }

  // Step 4: Enum validation
  for (const [key, allowedValues] of Array.from(schema.propertyEnums)) {
    const value = repaired[key];
    if (value === undefined || value === null) continue;

    // Case-insensitive string comparison
    const normalizedAllowed = allowedValues.map(v =>
      typeof v === 'string' ? v.toLowerCase() : v
    );
    const normalizedValue = typeof value === 'string' ? value.toLowerCase() : value;

    if (!normalizedAllowed.includes(normalizedValue)) {
      // Try exact match too
      if (!allowedValues.includes(value)) {
        errors.push({
          path: key,
          message: `value ${JSON.stringify(value)} not in enum [${allowedValues.map(v => JSON.stringify(v)).join(', ')}]`,
          actualValue: value,
        });
      }
    } else if (typeof value === 'string') {
      // Normalize to the canonical casing from the enum
      const canonicalIdx = normalizedAllowed.indexOf(normalizedValue);
      if (canonicalIdx >= 0 && allowedValues[canonicalIdx] !== value) {
        repaired[key] = allowedValues[canonicalIdx];
        repairs.push(`${key}: normalized case from "${value}" to "${allowedValues[canonicalIdx]}"`);
      }
    }
  }

  // Step 5: Range clamping
  for (const [key, constraints] of Array.from(schema.propertyConstraints)) {
    const value = repaired[key];
    if (typeof value !== 'number') continue;

    if (constraints.minimum !== undefined && value < constraints.minimum) {
      repaired[key] = constraints.minimum;
      repairs.push(`${key}: clamped ${value} to minimum ${constraints.minimum}`);
    }
    if (constraints.maximum !== undefined && value > constraints.maximum) {
      repaired[key] = constraints.maximum;
      repairs.push(`${key}: clamped ${value} to maximum ${constraints.maximum}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    repairedArgs: repairs.length > 0 ? repaired : undefined,
  };
}

/**
 * Try to safely coerce a value to the expected type.
 * Returns undefined if coercion is not possible.
 */
function tryCoerce(value: unknown, expectedType: string): unknown {
  if (expectedType === 'number') {
    if (typeof value === 'string') {
      const num = Number(value);
      if (!isNaN(num) && isFinite(num)) return num;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
  }

  if (expectedType === 'boolean') {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
    }
    if (typeof value === 'number') return value !== 0;
  }

  if (expectedType === 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }

  if (expectedType === 'integer') {
    if (typeof value === 'string') {
      const num = Number(value);
      if (!isNaN(num) && isFinite(num) && Number.isInteger(num)) return num;
      // Also accept float strings and truncate
      if (!isNaN(num) && isFinite(num)) return Math.trunc(num);
    }
    if (typeof value === 'number' && isFinite(value)) return Math.trunc(value);
  }

  if (expectedType === 'array') {
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) { getGlobalLogger().debug('ToolCallValidator', 'Failed to parse array coercion JSON', { error: (e as Error)?.message }); }
    }
    // Wrap a single value in an array
    if (!Array.isArray(value) && value !== undefined && value !== null) return [value];
  }

  return undefined;
}

// ============================================================================
// Error Formatting
// ============================================================================

/**
 * Format validation errors into a structured message for the LLM.
 * Designed for self-correction: the LLM should be able to read this
 * and retry with corrected arguments.
 */
export function formatValidationErrors(
  errors: ValidationResult['errors'],
  toolName: string,
  repairs?: string[],
): string {
  const lines = [`TOOL_VALIDATION_ERROR for "${toolName}":`];

  for (const err of errors) {
    lines.push(`  - argument '${err.path}': ${err.message}`);
  }

  if (repairs && repairs.length > 0) {
    lines.push('');
    lines.push('Auto-repaired:');
    for (const repair of repairs) {
      lines.push(`  - ${repair}`);
    }
  }

  lines.push('');
  lines.push('Please correct your arguments and retry.');

  return lines.join('\n');
}
