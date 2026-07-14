import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import {
  startAuditAggregatorBridge,
  stopAuditAggregatorBridge,
} from '../../src/security/auditAggregatorBridge';
import { getUnifiedAuditLog, resetUnifiedAuditLog } from '../../src/security/unifiedAuditLog';

describe('auditAggregatorBridge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-bridge-'));
    resetMessageBus();
    resetUnifiedAuditLog();
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.commander', 'audit'), { recursive: true });
    startAuditAggregatorBridge();
  });

  afterEach(() => {
    stopAuditAggregatorBridge();
    resetMessageBus();
    resetUnifiedAuditLog();
    process.chdir(os.tmpdir());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forwards security.event payloads to UnifiedAuditLog', async () => {
    const bus = getMessageBus();
    bus.publish('security.event', 'test', {
      type: 'content_threat',
      severity: 'high',
      message: 'injection detected',
      details: { runId: 'run-1' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const audit = getUnifiedAuditLog({ baseDir: tmpDir });
    const entries = await audit.query({
      category: ['security'],
      eventType: ['content_threat'],
      limit: 10,
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.message).toContain('injection');
  });
});
