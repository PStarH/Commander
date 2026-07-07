// packages/core/tests/plugins/gap/slaEnforcer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SlaEnforcer } from '../../../src/plugins/builtin/gap/slaEnforcer';
import { GapEntry } from '../../../src/plugins/builtin/gap/types';

describe('SlaEnforcer', () => {
  it('triggers PagerDuty for critical overdue', async () => {
    const pagerDuty = vi.fn();
    const slack = vi.fn();
    const enforcer = new SlaEnforcer({
      pagerDuty,
      slack,
      getRunbookUrl: () => 'https://wiki/runbook',
    });
    const entries: GapEntry[] = [
      {
        id: 'g1',
        source: 'chaos',
        severity: 'critical',
        title: 't',
        description: 'd',
        detectedAt: 'x',
        status: 'open',
        relatedIssues: [],
        slaDeadline: '2020-01-01',
      },
    ];
    await enforcer.enforce(entries);
    expect(pagerDuty).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('g1') }),
    );
  });

  it('sends slack alert for high overdue', async () => {
    const pagerDuty = vi.fn();
    const slack = vi.fn();
    const enforcer = new SlaEnforcer({ pagerDuty, slack, getRunbookUrl: () => '' });
    const entries: GapEntry[] = [
      {
        id: 'g2',
        source: 'chaos',
        severity: 'high',
        title: 't',
        description: 'd',
        detectedAt: 'x',
        status: 'open',
        relatedIssues: [],
        slaDeadline: '2020-01-01',
      },
    ];
    await enforcer.enforce(entries);
    expect(slack).toHaveBeenCalledWith(expect.stringContaining('g2'));
    expect(pagerDuty).not.toHaveBeenCalled();
  });

  it('does nothing for medium overdue (weekly summary only)', async () => {
    const pagerDuty = vi.fn();
    const slack = vi.fn();
    const enforcer = new SlaEnforcer({ pagerDuty, slack, getRunbookUrl: () => '' });
    const entries: GapEntry[] = [
      {
        id: 'g3',
        source: 'chaos',
        severity: 'medium',
        title: 't',
        description: 'd',
        detectedAt: 'x',
        status: 'open',
        relatedIssues: [],
        slaDeadline: '2020-01-01',
      },
    ];
    await enforcer.enforce(entries);
    expect(pagerDuty).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
  });
});
