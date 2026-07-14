import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExecutionScheduler } from '../scheduler';
import { RunLedger } from '../runLedger';
import { LeaseManager } from '../leaseManager';
import { IdempotencyStore, resetIdempotencyStore } from '../idempotencyStore';
import {
  SimpleTenantProvider,
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  type TenantConfig,
} from '../../runtime/tenantProvider';
import { runWithTenant } from '../../runtime/tenantContext';

function makeScheduler(tenants: TenantConfig[] = []) {
  process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
  resetIdempotencyStore();
  setGlobalTenantProvider(new SimpleTenantProvider(tenants));
  const lease = new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
  });
  const idempotency = new IdempotencyStore({ filePath: ':memory:', defaultTtlSeconds: 60 });
  const ledger = new RunLedger(lease, idempotency, {
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'test',
    defaultIdempotencyTtlSeconds: 60,
  });
  const scheduler = new ExecutionScheduler({ lease, idempotency, ledger });
  return {
    scheduler,
    ledger,
    lease,
    idempotency,
    close: () => {
      lease.close();
      idempotency.close();
      ledger.close();
    },
  };
}

function hashIntent(intent: string): string {
  return `hash:${intent}`;
}

function startRun(
  ledger: RunLedger,
  params: { runId: string; intentHash: string; tenantId: string },
): void {
  runWithTenant(params.tenantId, () => ledger.start(params));
}

describe('ExecutionScheduler.claimNextRun tier priority', () => {
  beforeEach(() => {
    process.env.COMMANDER_ATR_IDEMPOTENCY_PATH = ':memory:';
    resetIdempotencyStore();
  });

  afterEach(() => {
    resetIdempotencyStore();
    delete process.env.COMMANDER_ATR_IDEMPOTENCY_PATH;
    resetGlobalTenantProvider();
  });

  it('returns null when no PENDING runs exist', () => {
    const { scheduler, close } = makeScheduler();
    try {
      expect(scheduler.claimNextRun()).toBeNull();
    } finally {
      close();
    }
  });

  it('claims premium tenant runs before standard tenant runs', () => {
    const tenants: TenantConfig[] = [
      {
        tenantId: 'tenant-premium',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
        metadata: { tier: 'premium' },
      },
      {
        tenantId: 'tenant-standard',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
        metadata: { tier: 'standard' },
      },
    ];
    const { scheduler, ledger, close } = makeScheduler(tenants);
    try {
      startRun(ledger, {
        runId: 'r-standard',
        intentHash: hashIntent('s'),
        tenantId: 'tenant-standard',
      });
      startRun(ledger, {
        runId: 'r-premium',
        intentHash: hashIntent('p'),
        tenantId: 'tenant-premium',
      });

      const handle = scheduler.claimNextRun();
      expect(handle).not.toBeNull();
      expect(handle!.runId).toBe('r-premium');
      expect(handle!.state).toBe('EXECUTING');

      const premiumTx = ledger.getTransaction('r-premium', { tenantId: 'tenant-premium' });
      expect(premiumTx?.state).toBe('EXECUTING');

      const second = scheduler.claimNextRun();
      expect(second).not.toBeNull();
      expect(second!.runId).toBe('r-standard');
    } finally {
      close();
    }
  });

  it('falls back to standard tier when premium metadata is missing', () => {
    const tenants: TenantConfig[] = [
      {
        tenantId: 'tenant-known',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
      },
      {
        tenantId: 'tenant-starter',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
        metadata: { tier: 'starter' },
      },
    ];
    const { scheduler, ledger, close } = makeScheduler(tenants);
    try {
      startRun(ledger, { runId: 'r-known', intentHash: hashIntent('k'), tenantId: 'tenant-known' });
      startRun(ledger, {
        runId: 'r-starter',
        intentHash: hashIntent('s'),
        tenantId: 'tenant-starter',
      });

      const first = scheduler.claimNextRun();
      expect(first!.runId).toBe('r-known');
      const second = scheduler.claimNextRun();
      expect(second!.runId).toBe('r-starter');
    } finally {
      close();
    }
  });

  it('uses FIFO ordering within the same tier', async () => {
    const tenants: TenantConfig[] = [
      {
        tenantId: 'tenant-a',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
        metadata: { tier: 'standard' },
      },
      {
        tenantId: 'tenant-b',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
        metadata: { tier: 'standard' },
      },
    ];
    const { scheduler, ledger, close } = makeScheduler(tenants);
    try {
      startRun(ledger, { runId: 'r-first', intentHash: hashIntent('1'), tenantId: 'tenant-a' });
      await new Promise((r) => setTimeout(r, 15));
      startRun(ledger, { runId: 'r-second', intentHash: hashIntent('2'), tenantId: 'tenant-b' });

      const first = scheduler.claimNextRun();
      expect(first!.runId).toBe('r-first');
      const second = scheduler.claimNextRun();
      expect(second!.runId).toBe('r-second');
    } finally {
      close();
    }
  });

  it('filters claims by tenantId when provided', () => {
    const tenants: TenantConfig[] = [
      {
        tenantId: 'tenant-a',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
      },
      {
        tenantId: 'tenant-b',
        tokenBudget: 0,
        maxConcurrency: 0,
        maxRunsPerMinute: 0,
        enabled: true,
      },
    ];
    const { scheduler, ledger, close } = makeScheduler(tenants);
    try {
      startRun(ledger, { runId: 'r-a', intentHash: hashIntent('a'), tenantId: 'tenant-a' });
      startRun(ledger, { runId: 'r-b', intentHash: hashIntent('b'), tenantId: 'tenant-b' });

      const handle = scheduler.claimNextRun({ tenantId: 'tenant-b' });
      expect(handle).not.toBeNull();
      expect(handle!.runId).toBe('r-b');
      expect(handle!.tenantId).toBe('tenant-b');
    } finally {
      close();
    }
  });
});
