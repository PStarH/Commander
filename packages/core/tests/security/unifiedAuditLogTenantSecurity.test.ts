import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UnifiedAuditLog } from '../../src/security/unifiedAuditLog';
import { runWithTenant } from '../../src/runtime/tenantContext';

describe('UnifiedAuditLog tenant isolation', () => {
  let tmpDir: string;
  let audit: UnifiedAuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-audit-tenant-'));
    const auditDir = path.join(tmpDir, '.commander', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'user-actions.ndjson'),
      [
        {
          id: 'tenant-a-event',
          timestamp: '2026-07-22T01:00:00.000Z',
          category: 'user_action',
          eventType: 'tenant.a.action',
          severity: 'info',
          tenantId: 'tenant-a',
          message: 'tenant A secret',
          source: 'test',
        },
        {
          id: 'tenant-b-event',
          timestamp: '2026-07-22T02:00:00.000Z',
          category: 'user_action',
          eventType: 'tenant.b.action',
          severity: 'warn',
          tenantId: 'tenant-b',
          message: 'tenant B secret',
          source: 'test',
        },
        {
          id: 'unscoped-event',
          timestamp: '2026-07-22T03:00:00.000Z',
          category: 'user_action',
          eventType: 'unscoped.action',
          severity: 'critical',
          message: 'must fail closed',
          source: 'test',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
    audit = new UnifiedAuditLog({ baseDir: tmpDir, cacheTtlMs: 0 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns only explicitly same-tenant entries for query and stats', async () => {
    const entries = await audit.query({ tenantId: 'tenant-a' });
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['tenant-a-event'],
    );

    const stats = await audit.getStats(undefined, 'tenant-a');
    assert.equal(stats.total, 1);
    assert.deepEqual(stats.topEventTypes, [{ eventType: 'tenant.a.action', count: 1 }]);
  });

  it('excludes cross-tenant and unscoped records from JSON and CSV exports', async () => {
    const json = await audit.exportLogs({ tenantId: 'tenant-b' }, 'json');
    assert.match(json, /tenant-b-event/);
    assert.doesNotMatch(json, /tenant-a-event/);
    assert.doesNotMatch(json, /unscoped-event/);

    const csv = await audit.exportLogs({ tenantId: 'tenant-a' }, 'csv');
    assert.match(csv, /tenant-a-event/);
    assert.doesNotMatch(csv, /tenant-b-event/);
    assert.doesNotMatch(csv, /unscoped-event/);
  });

  it('binds producer entries to the active tenant when the producer omits tenantId', async () => {
    await runWithTenant('tenant-a', () =>
      audit.log({
        category: 'user_action',
        eventType: 'producer.bound',
        severity: 'info',
        message: 'bound through tenant context',
        source: 'test',
      }),
    );
    const entries = await audit.query({ tenantId: 'tenant-a' });
    assert.ok(entries.some((entry) => entry.eventType === 'producer.bound'));
    assert.equal(
      (await audit.query({ tenantId: 'tenant-b' })).some(
        (entry) => entry.eventType === 'producer.bound',
      ),
      false,
    );
  });
});
