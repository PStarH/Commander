import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTenantAwareSingleton,
  type TenantAwareSingletonOptions,
} from '../../src/runtime/tenantAwareSingleton';
import {
  runWithTenant,
  getCurrentTenantId,
  validateTenantId,
  tenantKey,
  tenantPathSegment,
  assertSameTenant,
  TenantIsolationError,
} from '../../src/runtime/tenantContext';
import {
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  SimpleTenantProvider,
} from '../../src/runtime/tenantProvider';

describe('tenantContext', () => {
  describe('validateTenantId', () => {
    it('accepts valid tenant ids', () => {
      expect(() => validateTenantId('tenant-a')).not.toThrow();
      expect(() => validateTenantId('org_123')).not.toThrow();
      expect(() => validateTenantId('a.b-c:d')).not.toThrow();
    });

    it('rejects empty tenant ids', () => {
      expect(() => validateTenantId('')).toThrow(TenantIsolationError);
    });

    it('rejects ids with path traversal characters', () => {
      expect(() => validateTenantId('../other')).toThrow(TenantIsolationError);
      expect(() => validateTenantId('tenant\\a')).toThrow(TenantIsolationError);
    });

    it('rejects ids that are too long', () => {
      expect(() => validateTenantId('a'.repeat(129))).toThrow(TenantIsolationError);
    });
  });

  describe('runWithTenant', () => {
    it('sets tenant id in async context', () => {
      runWithTenant('tenant-1', () => {
        expect(getCurrentTenantId()).toBe('tenant-1');
      });
    });

    it('returns function result', () => {
      const result = runWithTenant('tenant-1', () => 42);
      expect(result).toBe(42);
    });

    it('rejects invalid tenant ids', () => {
      expect(() => runWithTenant('bad/id', () => {})).toThrow(TenantIsolationError);
    });
  });

  describe('tenantKey', () => {
    it('prefixes with tenant id', () => {
      expect(tenantKey('tenant-1', 'settings')).toBe('tenant:tenant-1|settings');
    });

    it('rejects unsafe suffixes', () => {
      expect(() => tenantKey('tenant-1', 'foo\0bar')).toThrow(TenantIsolationError);
    });
  });

  describe('tenantPathSegment', () => {
    it('returns safe path segment', () => {
      expect(tenantPathSegment('tenant-1')).toBe('tenant_tenant-1');
    });
  });

  describe('assertSameTenant', () => {
    it('passes when tenant matches', () => {
      runWithTenant('tenant-1', () => {
        expect(() => assertSameTenant('tenant-1')).not.toThrow();
      });
    });

    it('throws on cross-tenant access', () => {
      runWithTenant('tenant-1', () => {
        expect(() => assertSameTenant('tenant-2')).toThrow(TenantIsolationError);
      });
    });

    it('passes outside tenant context', () => {
      expect(() => assertSameTenant('tenant-1')).not.toThrow();
    });
  });
});

describe('tenantAwareSingleton', () => {
  const factory = () => ({ value: Math.random() });

  beforeEach(() => {
    // Use fake timers WITHOUT shouldAdvanceTime so that vi.setSystemTime()
    // controls the clock deterministically.  shouldAdvanceTime: true makes
    // the fake clock drift with real wall-clock time between setSystemTime
    // calls, causing the TTL eviction test to race.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns same instance for same tenant', () => {
    const singleton = createTenantAwareSingleton(factory);
    let a: unknown;
    let b: unknown;
    runWithTenant('tenant-1', () => {
      a = singleton.get();
    });
    runWithTenant('tenant-1', () => {
      b = singleton.get();
    });
    expect(a).toBe(b);
  });

  it('returns different instances for different tenants', () => {
    const singleton = createTenantAwareSingleton(factory);
    let a: unknown;
    let b: unknown;
    runWithTenant('tenant-1', () => {
      a = singleton.get();
    });
    runWithTenant('tenant-2', () => {
      b = singleton.get();
    });
    expect(a).not.toBe(b);
  });

  it('throws outside tenant context by default in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const singleton = createTenantAwareSingleton(factory);
      expect(() => singleton.get()).toThrow(TenantIsolationError);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('falls back to global instance outside tenant context when explicitly allowed', () => {
    const singleton = createTenantAwareSingleton(factory, { allowGlobalFallback: true });
    const a = singleton.get();
    const b = singleton.get();
    expect(a).toBe(b);
  });

  it('ignores explicit allowGlobalFallback when multi-tenant provider is active', () => {
    setGlobalTenantProvider(
      new SimpleTenantProvider([
        {
          tenantId: 'tenant-active',
          tokenBudget: 0,
          maxConcurrency: 0,
          maxRunsPerMinute: 0,
          enabled: true,
        },
      ]),
    );
    try {
      const singleton = createTenantAwareSingleton(factory, { allowGlobalFallback: true });
      expect(() => singleton.get()).toThrow(TenantIsolationError);
    } finally {
      resetGlobalTenantProvider();
    }
  });

  it('disposes evicted tenants on TTL', () => {
    const dispose = vi.fn();
    const singleton = createTenantAwareSingleton(factory, {
      quota: { maxTenants: 1, tenantTtlMs: 1000 },
      dispose,
    });

    const start = Date.now();
    vi.setSystemTime(start);
    runWithTenant('tenant-1', () => singleton.get());
    vi.setSystemTime(start + 2000);
    runWithTenant('tenant-2', () => singleton.get());

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('evicts LRU when max tenants exceeded', () => {
    const dispose = vi.fn();
    const singleton = createTenantAwareSingleton(factory, {
      quota: { maxTenants: 2, tenantTtlMs: 60_000 },
      dispose,
    });

    runWithTenant('tenant-1', () => singleton.get());
    runWithTenant('tenant-2', () => singleton.get());
    runWithTenant('tenant-3', () => singleton.get());

    expect(singleton.tenantCount()).toBe(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('tracks lifetime tenant count', () => {
    const singleton = createTenantAwareSingleton(factory);
    runWithTenant('tenant-1', () => singleton.get());
    runWithTenant('tenant-2', () => singleton.get());
    runWithTenant('tenant-1', () => singleton.get());
    expect(singleton.lifetimeTenantCount()).toBe(2);
  });

  it('enforces lifetime quota', () => {
    const singleton = createTenantAwareSingleton(factory, {
      quota: { maxTenants: 2, tenantTtlMs: 60_000, maxLifetimeTenants: 2 },
    });
    runWithTenant('tenant-1', () => singleton.get());
    runWithTenant('tenant-2', () => singleton.get());
    expect(() => runWithTenant('tenant-3', () => singleton.get())).toThrow(TenantIsolationError);
  });

  it('resets all instances', () => {
    const dispose = vi.fn();
    const singleton = createTenantAwareSingleton(factory, { dispose });
    runWithTenant('tenant-1', () => singleton.get());
    singleton.reset();
    expect(singleton.tenantCount()).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes explicit tenant', () => {
    const dispose = vi.fn();
    const singleton = createTenantAwareSingleton(factory, { dispose });
    runWithTenant('tenant-1', () => singleton.get());
    expect(singleton.disposeTenant('tenant-1')).toBe(true);
    expect(singleton.disposeTenant('tenant-1')).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('validates tenant id on getForTenant', () => {
    const singleton = createTenantAwareSingleton(factory);
    expect(() => singleton.getForTenant('bad/id')).toThrow(TenantIsolationError);
  });
});
