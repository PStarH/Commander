#!/usr/bin/env tsx
/**
 * Independently verify a commander-rotate JSON receipt against the persisted
 * HMAC audit chain. This verifier never reads a live secret value.
 *
 * Usage:
 *   pnpm rotate:receipt:verify -- <receipt.json> [--audit-dir <dir>]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuditChainLedger,
  collectPersistedEntries,
  resolveMasterKey,
  type AuditChainEntry,
} from '../packages/core/src/security/auditChainLedger';

export interface RotationReceipt {
  schema: 'commander-key-rotation-receipt/v1';
  envVar: string;
  rotationId: string;
  action: 'attempt' | 'confirm' | 'dry';
  auditRecordId: string;
  chainId: string;
  sequence: number;
  timestamp: string;
  hmac: string;
}

export interface RotationReceiptVerification {
  ok: boolean;
  reason?: string;
  receipt?: RotationReceipt;
}

function isReceipt(value: unknown): value is RotationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === 'commander-key-rotation-receipt/v1' &&
    typeof candidate.envVar === 'string' &&
    typeof candidate.rotationId === 'string' &&
    (candidate.action === 'attempt' ||
      candidate.action === 'confirm' ||
      candidate.action === 'dry') &&
    typeof candidate.auditRecordId === 'string' &&
    typeof candidate.chainId === 'string' &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence > 0 &&
    typeof candidate.timestamp === 'string' &&
    typeof candidate.hmac === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.hmac)
  );
}

function unwrapReceipt(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  // Accept the complete `commander-rotate --json` result as well as a
  // receipt extracted with `jq '.rotationReceipt'`. The receipt itself is
  // still validated field-by-field below.
  return 'rotationReceipt' in candidate ? candidate.rotationReceipt : value;
}

function expectedEventType(action: RotationReceipt['action']): AuditChainEntry['type'] {
  if (action === 'attempt') return 'key_rotation_attempt';
  if (action === 'confirm') return 'key_rotation_confirmed';
  return 'key_rotation_dry_run';
}

export function verifyRotationReceipt(
  value: unknown,
  auditDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): RotationReceiptVerification {
  const receiptValue = unwrapReceipt(value);
  if (!isReceipt(receiptValue)) return { ok: false, reason: 'ROTATION_RECEIPT_MALFORMED' };

  try {
    const ledger = new AuditChainLedger({
      persistDir: auditDir,
      masterKey: resolveMasterKey(environment),
    });
    const integrity = ledger.verify();
    if (!integrity.ok) {
      return {
        ok: false,
        reason: `ROTATION_AUDIT_CHAIN_INVALID:${integrity.brokenChain?.reason ?? 'unknown'}`,
      };
    }

    const entry = collectPersistedEntries(auditDir).find(
      (candidate) => candidate.id === receiptValue.auditRecordId,
    );
    if (!entry) return { ok: false, reason: 'ROTATION_RECEIPT_ENTRY_NOT_FOUND' };
    if (
      entry.chainId !== receiptValue.chainId ||
      entry.seq !== receiptValue.sequence ||
      entry.timestamp !== receiptValue.timestamp ||
      entry.hmac !== receiptValue.hmac ||
      entry.type !== expectedEventType(receiptValue.action) ||
      entry.details?.envVar !== receiptValue.envVar ||
      entry.details?.rotationId !== receiptValue.rotationId
    ) {
      return { ok: false, reason: 'ROTATION_RECEIPT_ENTRY_MISMATCH' };
    }
    return { ok: true, receipt: receiptValue };
  } catch (error) {
    return {
      ok: false,
      reason: `ROTATION_RECEIPT_VERIFY_ERROR:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function usage(): string {
  return 'Usage: verify-rotation-receipt <receipt.json> [--audit-dir <dir>]';
}

function main(argv: string[]): number {
  // `pnpm run <script> -- <args>` forwards the separator to the script.
  // Normalize it so the package command and direct `tsx` invocation agree.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const receiptPath = args[0];
  const auditFlag = args.indexOf('--audit-dir');
  const auditDir = resolve(
    (auditFlag >= 0 ? args[auditFlag + 1] : undefined) ??
      process.env.COMMANDER_AUDIT_PERSIST_DIR ??
      '.commander_security',
  );
  if (!receiptPath || (auditFlag >= 0 && !args[auditFlag + 1])) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: 'ROTATION_RECEIPT_ARGUMENTS_INVALID', help: usage() }) +
        '\n',
    );
    return 2;
  }
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(receiptPath), 'utf8'));
    const result = verifyRotationReceipt(value, auditDir);
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 1;
  } catch {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: 'ROTATION_RECEIPT_INPUT_INVALID' }) + '\n',
    );
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
