// packages/core/tests/plugins/gap/types.test.ts
import { describe, it, expect } from 'vitest';
import { isCritical, isOverdue, computeSlaDeadline } from '../../../src/plugins/builtin/gap/types';

describe('gap types', () => {
  it('isCritical returns true for critical severity', () => {
    expect(isCritical('critical')).toBe(true);
    expect(isCritical('high')).toBe(false);
  });

  it('isOverdue returns true when deadline is past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isOverdue(past)).toBe(true);
  });

  it('isOverdue returns false for future deadline', () => {
    const future = new Date(Date.now() + 10000).toISOString();
    expect(isOverdue(future)).toBe(false);
  });

  it('computeSlaDeadline returns correct windows', () => {
    const now = new Date('2026-06-30T00:00:00Z');
    expect(computeSlaDeadline('critical', now)).toBe('2026-07-01T00:00:00.000Z'); // 24h detect
    expect(computeSlaDeadline('high', now)).toBe('2026-07-07T00:00:00.000Z'); // 7d detect
    expect(computeSlaDeadline('medium', now)).toBe('2026-07-30T00:00:00.000Z'); // 30d detect
  });
});
