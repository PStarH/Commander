import { describe, it, expect, beforeEach } from 'vitest';
import { LaneManager, LaneFairnessRejectionError, LANE_REJECTED_FAIRNESS } from '../lane';
import { TenantFairnessMonitor } from '../../runtime/tenantFairnessMonitor';
import { runWithTenant } from '../../runtime/tenantContext';

describe('LaneManager fairness admission', () => {
  let monitor: TenantFairnessMonitor;

  beforeEach(() => {
    monitor = new TenantFairnessMonitor();
  });

  it('behaves normally when no fairness monitor is configured', async () => {
    const manager = new LaneManager(100);
    const laneName = await manager.acquireSlot({ agentId: 'agent-1', tenantId: 'tenant-a' });
    expect(laneName).toBe('default');
    manager.releaseSlot(laneName);
  });

  it('rejects the highest-share tenant when Jain index is below 0.85', async () => {
    const manager = new LaneManager(100, { fairnessMonitor: monitor });
    for (let i = 0; i < 50; i++) monitor.recordCompletion('tenant-rich');
    monitor.recordCompletion('tenant-poor');

    expect(monitor.getJainIndex()).toBeLessThan(0.85);

    await expect(
      manager.acquireSlot({ agentId: 'agent-1', tenantId: 'tenant-rich' }),
    ).rejects.toThrow(LaneFairnessRejectionError);

    try {
      await manager.acquireSlot({ agentId: 'agent-1', tenantId: 'tenant-rich' });
    } catch (err) {
      expect(err).toBeInstanceOf(LaneFairnessRejectionError);
      expect((err as LaneFairnessRejectionError).code).toBe(LANE_REJECTED_FAIRNESS);
      expect((err as LaneFairnessRejectionError).statusCode).toBe(429);
      expect((err as LaneFairnessRejectionError).tenantId).toBe('tenant-rich');
    }

    const lane = manager.getLane('default');
    expect(lane!.totalRejected).toBeGreaterThanOrEqual(1);
  });

  it('allows low-share tenants to acquire while the highest-share tenant is throttled', async () => {
    const manager = new LaneManager(100, { fairnessMonitor: monitor });
    for (let i = 0; i < 50; i++) monitor.recordCompletion('tenant-rich');
    monitor.recordCompletion('tenant-poor');

    const laneName = await manager.acquireSlot({ agentId: 'agent-1', tenantId: 'tenant-poor' });
    expect(laneName).toBe('default');
    manager.releaseSlot(laneName);
  });

  it('records completions via releaseSlot when a fairness monitor is present', async () => {
    const manager = new LaneManager(100, { fairnessMonitor: monitor });
    const laneName = await manager.acquireSlot({ agentId: 'agent-1', tenantId: 'tenant-a' });
    await runWithTenant('tenant-a', async () => {
      manager.releaseSlot(laneName);
    });
    expect(monitor.getTenantShare('tenant-a')).toBe(1);
  });

  it('does not reject when fairness is above the threshold', async () => {
    const manager = new LaneManager(100, { fairnessMonitor: monitor });
    monitor.recordCompletion('tenant-a');
    monitor.recordCompletion('tenant-b');
    expect(monitor.getJainIndex()).toBe(1);

    const laneName = await manager.acquireSlot({ agentId: 'agent-1', tenantId: 'tenant-a' });
    expect(laneName).toBe('default');
    manager.releaseSlot(laneName);
  });
});
