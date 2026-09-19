/**
 * Configuration loading for the Architecture V2 gate (LM-18 step 4).
 *
 * Why this module exists
 * ----------------------
 * The gate used to do `JSON.parse(readFileSync(...)) as GateConfig` and then
 * consume the object directly. Nothing checked the shape at runtime, so:
 *
 *   - a typo'd key (`forbiddenCoreImport` for `forbiddenCoreImports`) removed a
 *     whole gate family while the gate still printed "passed" — the failure
 *     surfaced only later, as an opaque `TypeError` from deep inside a loop, if
 *     at all;
 *   - the config declared `"$schema": "./architecture-gate.schema.json"` while
 *     that file did not exist, so editors and CI had nothing to validate
 *     against and the dangling reference went unnoticed.
 *
 * Every rule below is fail-closed: an unknown key, a wrong type, a missing
 * required key or a `$schema` that does not resolve is a configuration error
 * that stops the gate. Silently ignoring part of the config is the failure mode
 * this module exists to remove.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface GateConfig {
  v2Packages: string[];
  forbiddenCoreImports: string[];
  v2ImportExceptions: string[];
  api: {
    path: string;
    legacyImportExceptions: string[];
    unversionedRouteExceptions: string[];
  };
  authorityExceptions: string[];
}

/** Raised for any configuration problem. The message names the exact key. */
export class GateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateConfigError';
  }
}

const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'comment',
  'v2Packages',
  'forbiddenCoreImports',
  'v2ImportExceptions',
  'api',
  'authorityExceptions',
]);

const API_KEYS = new Set(['path', 'legacyImportExceptions', 'unversionedRouteExceptions']);

/** Keys whose value is a list of non-empty strings. */
const REQUIRED_STRING_ARRAYS = [
  'v2Packages',
  'forbiddenCoreImports',
  'v2ImportExceptions',
  'authorityExceptions',
] as const;

/** Arrays that may legitimately be empty (no exception of that kind yet). */
const MAY_BE_EMPTY = new Set(['v2ImportExceptions', 'authorityExceptions']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringArray(
  value: unknown,
  key: string,
  { allowEmpty }: { allowEmpty: boolean },
): string[] {
  if (!Array.isArray(value)) {
    throw new GateConfigError(`"${key}" must be an array of strings, got ${describe(value)}`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new GateConfigError(
      `"${key}" must not be empty — an empty list silently disables the check it configures`,
    );
  }
  value.forEach((entry, i) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new GateConfigError(
        `"${key}[${i}]" must be a non-empty string, got ${describe(entry)}`,
      );
    }
  });
  return value as string[];
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

function assertNoUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  scope: string,
): void {
  const unknown = Object.keys(obj).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    // Naming the offending key is the whole point: an unknown key is almost
    // always a typo of a real one, and the old code accepted it in silence.
    throw new GateConfigError(
      `unknown key${unknown.length > 1 ? 's' : ''} in ${scope}: ${unknown.join(', ')} ` +
        `(known keys: ${[...known].join(', ')})`,
    );
  }
}

/**
 * Read and validate the gate configuration.
 *
 * @throws {GateConfigError} on any unreadable, unparseable or malformed config.
 */
export function loadGateConfig(configPath: string): GateConfig {
  if (!existsSync(configPath)) {
    throw new GateConfigError(`configuration file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GateConfigError(`configuration is not valid JSON: ${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new GateConfigError(`configuration must be a JSON object, got ${describe(parsed)}`);
  }

  assertNoUnknownKeys(parsed, TOP_LEVEL_KEYS, 'architecture-gate.config.json');

  // `$schema` is metadata, but a reference that points at nothing is a defect:
  // it means nobody — editor or CI — can validate this file.
  if (parsed.$schema !== undefined) {
    if (typeof parsed.$schema !== 'string' || parsed.$schema.length === 0) {
      throw new GateConfigError(`"$schema" must be a non-empty string`);
    }
    const schemaPath = isAbsolute(parsed.$schema)
      ? parsed.$schema
      : resolve(dirname(configPath), parsed.$schema);
    if (!existsSync(schemaPath)) {
      throw new GateConfigError(
        `"$schema" points at a file that does not exist: ${parsed.$schema} (resolved: ${schemaPath})`,
      );
    }
  }

  if (parsed.comment !== undefined && typeof parsed.comment !== 'string') {
    throw new GateConfigError(`"comment" must be a string when present`);
  }

  const stringArrays = {} as Record<string, string[]>;
  for (const key of REQUIRED_STRING_ARRAYS) {
    if (parsed[key] === undefined) {
      throw new GateConfigError(`missing required key "${key}"`);
    }
    stringArrays[key] = assertStringArray(parsed[key], key, {
      allowEmpty: MAY_BE_EMPTY.has(key),
    });
  }

  const api = parsed.api;
  if (!isPlainObject(api)) {
    throw new GateConfigError(`"api" must be an object, got ${describe(api)}`);
  }
  assertNoUnknownKeys(api, API_KEYS, '"api"');
  if (typeof api.path !== 'string' || api.path.length === 0) {
    throw new GateConfigError(`"api.path" must be a non-empty string`);
  }
  const legacyImportExceptions = assertStringArray(
    api.legacyImportExceptions,
    'api.legacyImportExceptions',
    { allowEmpty: true },
  );
  const unversionedRouteExceptions = assertStringArray(
    api.unversionedRouteExceptions,
    'api.unversionedRouteExceptions',
    { allowEmpty: true },
  );

  return {
    v2Packages: stringArrays.v2Packages!,
    forbiddenCoreImports: stringArrays.forbiddenCoreImports!,
    v2ImportExceptions: stringArrays.v2ImportExceptions!,
    authorityExceptions: stringArrays.authorityExceptions!,
    api: { path: api.path, legacyImportExceptions, unversionedRouteExceptions },
  };
}
