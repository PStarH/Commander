/**
 * ContractSnapshot v2 — schema hash + fixture hash freeze for 五项宪法契约。
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTRACTS_VERSION } from './resources.js';
import { RUN_STATES, STEP_STATES } from './states.js';
import { KERNEL_ERROR_CODES } from './errors.js';
import {
  snapshotContracts as snapshotContractsV1,
  detectBreakingChanges as detectBreakingChangesV1,
  type ContractSnapshot as ContractSnapshotV1,
} from './compatibility.js';

function contractsRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (existsSync(join(dir, 'schemas/commander.run/v2.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  const candidates = [
    resolve(process.cwd(), 'packages/contracts'),
    resolve(process.cwd()),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'schemas/commander.run/v2.json'))) return candidate;
  }
  throw new Error('Cannot locate packages/contracts root for constitution schemas');
}

export interface ContractSchemaEntry {
  schemaVersion: string;
  schemaHash: string;
  required: string[];
  enums: Record<string, string[]>;
  properties: Record<string, { type: string; format?: string }>;
  additionalProperties: boolean | Record<string, unknown>;
  fixtureHashes: Record<string, string>;
}

export interface ContractSnapshot {
  packageVersion: string;
  contracts: Record<string, ContractSchemaEntry>;
  runStates: readonly string[];
  stepStates: readonly string[];
  errorCodes: readonly string[];
}

const CONSTITUTION_SCHEMAS: Array<{ key: string; schemaPath: string; fixturePath: string }> = [
  { key: 'run', schemaPath: 'schemas/commander.run/v2.json', fixturePath: 'fixtures/run/v2/minimal.json' },
  { key: 'event', schemaPath: 'schemas/commander.event/v2.json', fixturePath: 'fixtures/event/v2/minimal.json' },
  { key: 'effect', schemaPath: 'schemas/commander.effect/v2.json', fixturePath: 'fixtures/effect/v2/minimal.json' },
  { key: 'grant', schemaPath: 'schemas/commander.grant/v1.json', fixturePath: 'fixtures/grant/v1/minimal.json' },
  { key: 'artifact', schemaPath: 'schemas/commander.artifact/v1.json', fixturePath: 'fixtures/artifact/v1/minimal.json' },
];

export function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function canonicalSchemaHash(schema: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(schema)))
    .digest('hex');
}

export function fixtureHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

function extractPayloadSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties as Record<string, unknown>) ?? {};
  const payload = props.payload as Record<string, unknown> | undefined;
  return payload ?? schema;
}

function extractEnums(properties: Record<string, Record<string, unknown>>): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const enumVals = prop.enum as string[] | undefined;
    if (enumVals) enums[name] = [...enumVals];
  }
  return enums;
}

function extractPropertyTypes(properties: Record<string, Record<string, unknown>>): Record<string, { type: string; format?: string }> {
  const result: Record<string, { type: string; format?: string }> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const type = prop.type as string | undefined;
    if (!type) continue;
    const entry: { type: string; format?: string } = { type };
    if (typeof prop.format === 'string') entry.format = prop.format;
    result[name] = entry;
  }
  return result;
}

function loadSchemaEntry(key: string, schemaPath: string, fixturePath: string): ContractSchemaEntry {
  const root = contractsRoot();
  const schemaAbs = join(root, schemaPath);
  const fixtureAbs = join(root, fixturePath);
  if (!existsSync(schemaAbs) || !existsSync(fixtureAbs)) {
    throw new Error(`Missing constitution schema or fixture for ${key}`);
  }
  const schema = JSON.parse(readFileSync(schemaAbs, 'utf-8')) as Record<string, unknown>;
  const fixtureRaw = readFileSync(fixtureAbs, 'utf-8');
  const payloadSchema = extractPayloadSchema(schema);
  const properties = (payloadSchema.properties as Record<string, Record<string, unknown>>) ?? {};
  return {
    schemaVersion: String(schema.$id ?? schema.schemaVersion ?? key),
    schemaHash: canonicalSchemaHash(schema),
    required: [...((payloadSchema.required as string[]) ?? [])],
    enums: extractEnums(properties),
    properties: extractPropertyTypes(properties),
    additionalProperties: (payloadSchema.additionalProperties as boolean | Record<string, unknown> | undefined) ?? true,
    fixtureHashes: { minimal: fixtureHash(fixtureRaw) },
  };
}

/** Produce v2 constitution snapshot. */
export function snapshotContracts(): ContractSnapshot {
  const contracts: Record<string, ContractSchemaEntry> = {};
  for (const { key, schemaPath, fixturePath } of CONSTITUTION_SCHEMAS) {
    contracts[key] = loadSchemaEntry(key, schemaPath, fixturePath);
  }
  return {
    packageVersion: CONTRACTS_VERSION,
    contracts,
    runStates: RUN_STATES,
    stepStates: STEP_STATES,
    errorCodes: KERNEL_ERROR_CODES,
  };
}

function isOptionalOnlyChange(
  baseline: ContractSchemaEntry,
  current: ContractSchemaEntry,
): boolean {
  if (baseline.schemaVersion !== current.schemaVersion) return false;
  if (baseline.schemaHash === current.schemaHash) return true;

  const baseReq = new Set(baseline.required);
  const curReq = new Set(current.required);
  for (const field of curReq) {
    if (!baseReq.has(field)) return false;
  }
  for (const field of baseline.required) {
    if (!curReq.has(field)) return false;
  }

  for (const [field, baseEnum] of Object.entries(baseline.enums)) {
    const curEnum = current.enums[field];
    if (!curEnum) return false;
    for (const val of baseEnum) {
      if (!curEnum.includes(val)) return false;
    }
  }

  for (const [field, baseProp] of Object.entries(baseline.properties)) {
    const curProp = current.properties[field];
    if (!curProp) return false;
    if (baseProp.type !== curProp.type) return false;
    if (baseProp.format !== curProp.format) return false;
  }

  const curOnlyFields = Object.keys(current.properties).filter((f) => !(f in baseline.properties));
  if (curOnlyFields.length === 0) return false;
  for (const field of curOnlyFields) {
    if (curReq.has(field)) return false;
  }
  if (baseline.additionalProperties !== current.additionalProperties) return false;
  return true;
}

/** Detect semantic breaking changes between constitution contract entries. */
export function detectSchemaBreakingChanges(
  baseline: ContractSnapshot,
  current: ContractSnapshot,
): string[] {
  const changes: string[] = [];

  for (const state of baseline.runStates) {
    if (!current.runStates.includes(state)) {
      changes.push(`BREAKING: run state '${state}' was removed`);
    }
  }
  for (const state of baseline.stepStates) {
    if (!current.stepStates.includes(state)) {
      changes.push(`BREAKING: step state '${state}' was removed`);
    }
  }
  for (const code of baseline.errorCodes) {
    if (!current.errorCodes.includes(code)) {
      changes.push(`BREAKING: error code '${code}' was removed`);
    }
  }

  for (const [key, baseEntry] of Object.entries(baseline.contracts)) {
    const curEntry = current.contracts[key];
    if (!curEntry) {
      changes.push(`BREAKING: constitution contract '${key}' was removed`);
      continue;
    }
    if (baseEntry.schemaVersion !== curEntry.schemaVersion && baseEntry.schemaHash !== curEntry.schemaHash) {
      continue;
    }
    if (baseEntry.schemaVersion === curEntry.schemaVersion && baseEntry.schemaHash !== curEntry.schemaHash) {
      if (!isOptionalOnlyChange(baseEntry, curEntry)) {
        changes.push(
          `BREAKING: schema hash changed for '${key}' (${baseEntry.schemaVersion}) without version bump`,
        );
      }
    }
    for (const field of baseEntry.required) {
      if (!curEntry.required.includes(field)) {
        changes.push(`BREAKING: required field '${field}' removed from '${key}'`);
      }
    }
    for (const field of curEntry.required) {
      if (!baseEntry.required.includes(field)) {
        changes.push(`BREAKING: new required field '${field}' added to '${key}'`);
      }
    }
    for (const [field, baseEnum] of Object.entries(baseEntry.enums)) {
      const curEnum = curEntry.enums[field] ?? [];
      for (const val of baseEnum) {
        if (!curEnum.includes(val)) {
          changes.push(`BREAKING: enum value '${val}' removed from '${key}.${field}'`);
        }
      }
    }
    for (const [field, baseProp] of Object.entries(baseEntry.properties)) {
      const curProp = curEntry.properties[field];
      if (!curProp) {
        changes.push(`BREAKING: property '${field}' removed from '${key}'`);
        continue;
      }
      if (baseProp.type !== curProp.type) {
        changes.push(`BREAKING: property '${key}.${field}' type narrowed from ${baseProp.type} to ${curProp.type}`);
      }
    }
    for (const [fixture, hash] of Object.entries(baseEntry.fixtureHashes)) {
      const curHash = curEntry.fixtureHashes[fixture];
      if (curHash && curHash !== hash && baseEntry.schemaVersion === curEntry.schemaVersion) {
        changes.push(`BREAKING: fixture '${key}/${fixture}' hash changed without version bump`);
      }
    }
  }

  return changes;
}

/** Combined v1 removal + v2 semantic freeze detection. */
export function detectBreakingChanges(baseline: ContractSnapshot, current: ContractSnapshot): string[] {
  const v1Baseline: ContractSnapshotV1 = {
    version: baseline.packageVersion,
    resources: snapshotContractsV1().resources,
    runStates: baseline.runStates,
    stepStates: baseline.stepStates,
    errorCodes: baseline.errorCodes,
    schemaNames: snapshotContractsV1().schemaNames,
  };
  const v1Current: ContractSnapshotV1 = {
    version: current.packageVersion,
    resources: snapshotContractsV1().resources,
    runStates: current.runStates,
    stepStates: current.stepStates,
    errorCodes: current.errorCodes,
    schemaNames: snapshotContractsV1().schemaNames,
  };
  return [...detectBreakingChangesV1(v1Baseline, v1Current), ...detectSchemaBreakingChanges(baseline, current)];
}

export { snapshotContractsV1, type ContractSnapshotV1 };
