import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuditChainLedger } from '../packages/core/src/security/auditChainLedger.js';
import { verifyRotationReceipt, type RotationReceipt } from './verify-rotation-receipt.js';

describe('verify-rotation-receipt', () => {
  it('verifies a receipt against the persisted HMAC entry and rejects tampering', () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-rotation-receipt-'));
    try {
      const key = Buffer.from('rotation-receipt-test-key-0123456789012345');
      const ledger = new AuditChainLedger({ persistDir: directory, masterKey: key });
      const entry = ledger.logEvent({
        type: 'key_rotation_attempt',
        severity: 'medium',
        source: 'commander-rotate',
        message: 'key_rotation_attempt for OPENAI_API_KEY',
        details: {
          envVar: 'OPENAI_API_KEY',
          rotationId: 'rotation-1',
          secretClass: 'Production LLM provider keys',
          cadenceDays: 90,
        },
      });
      const receipt: RotationReceipt = {
        schema: 'commander-key-rotation-receipt/v1',
        envVar: 'OPENAI_API_KEY',
        rotationId: 'rotation-1',
        action: 'attempt',
        auditRecordId: entry.id,
        chainId: entry.chainId,
        sequence: entry.seq,
        timestamp: entry.timestamp,
        hmac: entry.hmac,
      };

      const environment = {
        NODE_ENV: 'test',
        COMMANDER_AUDIT_CHAIN_KEY: key.toString('utf8'),
      };
      assert.deepEqual(verifyRotationReceipt(receipt, directory, environment), {
        ok: true,
        receipt,
      });
      assert.deepEqual(
        verifyRotationReceipt({ ok: true, rotationReceipt: receipt }, directory, environment),
        { ok: true, receipt },
      );
      assert.deepEqual(
        verifyRotationReceipt({ ...receipt, hmac: '0'.repeat(64) }, directory, environment),
        { ok: false, reason: 'ROTATION_RECEIPT_ENTRY_MISMATCH' },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
