#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTerminalEvidence,
  verifyEvidenceBundle,
  type EvidenceBundle,
} from '../packages/effect-broker/src/evidenceBundle.js';

export interface IntegrityEvidenceRecord {
  tenantId: string;
  bundleId: string;
  body: EvidenceBundle;
  retentionUntil: string;
}

export type EvidenceIntegrityResult =
  | { ok: true; checked: number; expired: number }
  | { ok: false; checked: number; expired: number; brokenBundleId: string; reason: string };

export function checkEvidenceIntegrity(
  records: readonly IntegrityEvidenceRecord[],
  tenantId: string,
  now = new Date(),
): EvidenceIntegrityResult {
  const scoped = records.filter((record) => record.tenantId === tenantId);
  let expired = 0;
  for (let index = 0; index < scoped.length; index++) {
    const record = scoped[index];
    if (Date.parse(record.retentionUntil) <= now.getTime()) expired += 1;
    const verification = verifyEvidenceBundle(record.body);
    if (!verification.ok) {
      return {
        ok: false,
        checked: index + 1,
        expired,
        brokenBundleId: record.bundleId,
        reason: verification.reason ?? 'EVIDENCE_INVALID',
      };
    }
    try {
      assertTerminalEvidence(record.body);
    } catch {
      return {
        ok: false,
        checked: index + 1,
        expired,
        brokenBundleId: record.bundleId,
        reason: 'TERMINAL_EVIDENCE_REQUIRED',
      };
    }
  }
  return { ok: true, checked: scoped.length, expired };
}

function main(argv: string[]): number {
  const tenantFlag = argv.indexOf('--tenant');
  const inputFlag = argv.indexOf('--input');
  const tenantId = tenantFlag >= 0 ? argv[tenantFlag + 1] : undefined;
  if (!tenantId) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'EVIDENCE_TENANT_REQUIRED' })}\n`);
    return 2;
  }
  try {
    const text =
      inputFlag >= 0 && argv[inputFlag + 1]
        ? readFileSync(resolve(argv[inputFlag + 1]), 'utf8')
        : readFileSync(0, 'utf8');
    const records = JSON.parse(text) as IntegrityEvidenceRecord[];
    if (!Array.isArray(records)) throw new Error('invalid');
    const result = checkEvidenceIntegrity(records, tenantId);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'EVIDENCE_INPUT_MALFORMED' })}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
