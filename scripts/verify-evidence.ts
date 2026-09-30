#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionEvidenceSchema } from '../packages/contracts/src/index.js';
import {
  assertTerminalEvidence,
  canonicalEvidenceBody,
  verifyEvidenceBundle,
  verifyEvidenceSignature,
  type EvidenceBundle,
  type EvidenceJwks,
} from '../packages/effect-broker/src/index.js';

export interface EvidenceVerificationResult {
  ok: boolean;
  reason?: string;
}

interface PublishedJsonSchema {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, PublishedJsonSchema>;
  additionalProperties?: boolean | PublishedJsonSchema;
  items?: PublishedJsonSchema;
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
}

const publishedReceiptSchema = actionEvidenceSchema.properties.receipt as PublishedJsonSchema;
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function matchesPublishedSchema(value: unknown, schema: PublishedJsonSchema): boolean {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    if (schema.required?.some((field) => !(field in record))) return false;
    for (const [field, child] of Object.entries(record)) {
      const childSchema = properties[field];
      if (childSchema) {
        if (!matchesPublishedSchema(child, childSchema)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        typeof schema.additionalProperties === 'object' &&
        !matchesPublishedSchema(child, schema.additionalProperties)
      ) {
        return false;
      }
    }
    return true;
  }

  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      (!schema.items || value.every((item) => matchesPublishedSchema(item, schema.items!)))
    );
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (
      schema.format === 'date-time' &&
      (!RFC3339_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))
    ) {
      return false;
    }
    return true;
  }
  if (schema.type === 'integer') {
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      (schema.minimum === undefined || value >= schema.minimum)
    );
  }
  if (schema.type === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.minimum === undefined || value >= schema.minimum)
    );
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return true;
}

function isReceipt(value: unknown): value is EvidenceBundle {
  return matchesPublishedSchema(value, publishedReceiptSchema);
}

function isJwks(value: unknown): value is EvidenceJwks {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { keys?: unknown }).keys)
  );
}

export function verifyEvidenceReceipt(
  receipt: EvidenceBundle,
  jwks: EvidenceJwks,
): EvidenceVerificationResult {
  if (!isReceipt(receipt)) return { ok: false, reason: 'EVIDENCE_SCHEMA_INVALID' };
  const structural = verifyEvidenceBundle(receipt);
  if (!structural.ok) return { ok: false, reason: structural.reason ?? 'EVIDENCE_INVALID' };
  try {
    assertTerminalEvidence(receipt);
  } catch {
    return { ok: false, reason: 'TERMINAL_EVIDENCE_REQUIRED' };
  }
  if (!receipt.scope.tenantId || !receipt.scope.runId) {
    return { ok: false, reason: 'EVIDENCE_SCOPE_INVALID' };
  }
  if (!receipt.signature) return { ok: false, reason: 'EVIDENCE_SIGNATURE_REQUIRED' };
  if (!verifyEvidenceSignature(canonicalEvidenceBody(receipt), receipt.signature, jwks)) {
    return { ok: false, reason: 'EVIDENCE_SIGNATURE_INVALID' };
  }
  return { ok: true };
}

function usage(): string {
  return 'Usage: verify-evidence <receipt.json> --jwks <jwks.json>';
}

export function runVerifyEvidence(argv: string[]): { exitCode: 0 | 1 | 2; result: object } {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { exitCode: 0, result: { ok: true, help: usage() } };
  }
  const receiptPath = argv[0];
  const jwksFlag = argv.indexOf('--jwks');
  const jwksPath = jwksFlag >= 0 ? argv[jwksFlag + 1] : undefined;
  if (!receiptPath || !jwksPath) {
    return {
      exitCode: 2,
      result: { ok: false, reason: 'EVIDENCE_ARGUMENTS_INVALID', help: usage() },
    };
  }
  try {
    const receipt: unknown = JSON.parse(readFileSync(resolve(receiptPath), 'utf8'));
    const jwks: unknown = JSON.parse(readFileSync(resolve(jwksPath), 'utf8'));
    if (!isReceipt(receipt) || !isJwks(jwks)) {
      return { exitCode: 2, result: { ok: false, reason: 'EVIDENCE_INPUT_MALFORMED' } };
    }
    const result = verifyEvidenceReceipt(receipt, jwks);
    return { exitCode: result.ok ? 0 : 1, result };
  } catch {
    return { exitCode: 2, result: { ok: false, reason: 'EVIDENCE_INPUT_MALFORMED' } };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = runVerifyEvidence(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  process.exitCode = outcome.exitCode;
}
