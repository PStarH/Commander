import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TenantWorkCoordinatorRegistry, resetTenantWorkCoordinatorRegistry, getTenantWorkCoordinatorRegistry } from '../../src/ultimate/tenantWorkCoordinatorRegistry';

describe('TenantWorkCoordinatorRegistry — GAP-M2.5 multi-tenant isolation', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twregistry-'));
    resetTenantWorkCoordinatorRegistry();
  });
  afterEach(() => {
    resetTenantWorkCoordinatorRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two tenants have isolated work queues (no cross-visibility)', () => {
    const reg = new TenantWorkCoordinatorRegistry(tmpDir);
    const coordA = reg.getWorkCoordinator('tenant-A');
    const coordB = reg.getWorkCoordinator('tenant-B');
    coordA.enqueue([
      { runId: 'r1', parentNodeId: 'p1', goal: 'A1', tools: [] },
      { runId: 'r1', parentNodeId: 'p2', goal: 'A2', tools: [] },
      { runId: 'r1', parentNodeId: 'p3', goal: 'A3', tools: [] },
    ]);
    coordB.enqueue([
      { runId: 'r1', parentNodeId: 'q1', goal: 'B1', tools: [] },
      { runId: 'r1', parentNodeId: 'q2', goal: 'B2', tools: [] },
      { runId: 'r1', parentNodeId: 'q3', goal: 'B3', tools: [] },
      { runId: 'r1', parentNodeId: 'q4', goal: 'B4', tools: [] },
      { runId: 'r1', parentNodeId: 'q5', goal: 'B5', tools: [] },
    ]);
    expect(coordA.list()).toHaveLength(3);
    expect(coordB.list()).toHaveLength(5);
    const aGoals = coordA.list().map(i => i.goal).sort();
    const bGoals = coordB.list().map(i => i.goal).sort();
    expect(aGoals).toEqual(['A1', 'A2', 'A3']);
    expect(bGoals).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
    expect(reg.size()).toBe(2);
    reg.closeAll();
  });

  it('same runId is allowed across tenants (no conflict)', () => {
    const reg = new TenantWorkCoordinatorRegistry(tmpDir);
    const coordA = reg.getWorkCoordinator('tenant-A');
    const coordB = reg.getWorkCoordinator('tenant-B');
    coordA.enqueue([{ runId: 'shared-run-id', parentNodeId: 'p1', goal: 'A', tools: [] }]);
    coordB.enqueue([{ runId: 'shared-run-id', parentNodeId: 'p1', goal: 'B', tools: [] }]);
    expect(coordA.list({ runId: 'shared-run-id' })[0].goal).toBe('A');
    expect(coordB.list({ runId: 'shared-run-id' })[0].goal).toBe('B');
    reg.closeAll();
  });

  it('tenant A crash does not affect tenant B', () => {
    const reg = new TenantWorkCoordinatorRegistry(tmpDir);
    const coordA = reg.getWorkCoordinator('tenant-A');
    const coordB = reg.getWorkCoordinator('tenant-B');
    coordA.enqueue([{ runId: 'r1', parentNodeId: 'p1', goal: 'A1', tools: [] }]);
    coordB.enqueue([{ runId: 'r1', parentNodeId: 'p1', goal: 'B1', tools: [] }]);
    coordB.enqueue([{ runId: 'r1', parentNodeId: 'p2', goal: 'B2', tools: [] }]);
    const claimedA = coordA.claim('agent-A', { runId: 'r1' });
    expect(claimedA).not.toBeNull();
    const claimB1 = coordB.claim('agent-B', { runId: 'r1' });
    const claimB2 = coordB.claim('agent-B', { runId: 'r1' });
    expect(claimB1).not.toBeNull();
    expect(claimB2).not.toBeNull();
    const statusB = coordB.getTeamStatus('r1');
    expect(statusB.total).toBe(2);
    expect(statusB.claimed).toBe(2);
    reg.closeAll();
  });

  it('lazy initialization: no files created until first getWorkCoordinator call', () => {
    const reg = new TenantWorkCoordinatorRegistry(tmpDir);
    const dirBefore = fs.readdirSync(tmpDir);
    expect(dirBefore).toEqual([]);
    reg.getWorkCoordinator('lazy-tenant');
    const dirAfter = fs.readdirSync(tmpDir);
    expect(dirAfter.length).toBe(1);
    expect(dirAfter[0]).toMatch(/^tenant_lazy-tenant$/);
    reg.closeAll();
  });

  it('getTenantWorkCoordinatorRegistry facade returns singleton (or rebuilds on basePath change)', () => {
    const r1 = getTenantWorkCoordinatorRegistry(tmpDir);
    const r2 = getTenantWorkCoordinatorRegistry();
    expect(r1).toBe(r2);
    const r3 = getTenantWorkCoordinatorRegistry(path.join(tmpDir, 'other'));
    expect(r3).not.toBe(r1);
    expect(r3.size()).toBe(0);
    r3.closeAll();
  });

  it('listTenants returns the tenants that have been initialized', () => {
    const reg = new TenantWorkCoordinatorRegistry(tmpDir);
    reg.getWorkCoordinator('alpha');
    reg.getWorkCoordinator('beta');
    reg.getWorkCoordinator('gamma');
    expect(reg.listTenants().sort()).toEqual(['alpha', 'beta', 'gamma']);
    reg.closeAll();
  });
});
