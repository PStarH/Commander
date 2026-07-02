// packages/core/tests/security/tenancy.test.ts
import { describe, it, expect } from 'vitest';
import {
  TENANT_ATTACK_SCENARIOS,
  assertTenantIsolation,
  type TenantIsolationCheck,
} from '../../src/security/tenancyScenarios';

describe('Tenancy Red Team Scenarios', () => {
  it('contains 6 multi-tenant attack scenarios', () => {
    expect(TENANT_ATTACK_SCENARIOS).toHaveLength(6);
  });

  it('all scenarios use multi-tenant tag', () => {
    for (const s of TENANT_ATTACK_SCENARIOS) {
      expect(s.tags).toContain('multi-tenant');
    }
  });

  it('all critical scenarios have CVSS >= 9.0', () => {
    for (const s of TENANT_ATTACK_SCENARIOS) {
      if (s.severity === 'critical') {
        expect(s.cvssScore).toBeGreaterThanOrEqual(9.0);
      }
    }
  });

  it('IDs follow TENANT-NNN format', () => {
    for (const s of TENANT_ATTACK_SCENARIOS) {
      expect(s.id).toMatch(/^TENANT-\d{3}$/);
    }
  });

  it('all scenarios declare expectedDefense', () => {
    for (const s of TENANT_ATTACK_SCENARIOS) {
      expect(s.expectedDefense).toBeTruthy();
      expect(s.expectedDefense.length).toBeGreaterThan(0);
    }
  });
});

describe('assertTenantIsolation', () => {
  it('passes when fromTenant equals toTenant', () => {
    const check: TenantIsolationCheck = {
      fromTenant: 'acme',
      toTenant: 'acme',
      dataAccessed: ['memory:1', 'memory:2'],
    };
    const result = assertTenantIsolation(check);
    expect(result.passed).toBe(true);
  });

  it('fails when fromTenant differs from toTenant', () => {
    const check: TenantIsolationCheck = {
      fromTenant: 'acme',
      toTenant: 'globex',
      dataAccessed: ['secret-key-1', 'secret-key-2'],
    };
    const result = assertTenantIsolation(check);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('acme');
    expect(result.reason).toContain('globex');
  });

  it('includes dataAccessed count in failure reason', () => {
    const check: TenantIsolationCheck = {
      fromTenant: 'a',
      toTenant: 'b',
      dataAccessed: ['x', 'y', 'z'],
    };
    const result = assertTenantIsolation(check);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/3 items/);
  });
});
