import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import type { AgentExecutionContext } from '../../src/runtime/types';
import { runWithTenant, tenantPathSegment } from '../../src/runtime/tenantContext';
import { MemoryListTool, MemoryRecallTool, MemoryStoreTool } from '../../src/tools/persistenceTool';
import { MemoryResourceTool } from '../../src/tools/resourceTools';

const memoryDir = path.join(process.cwd(), '.commander_memory');
const tenantIds: string[] = [];
const externalDirs: string[] = [];

function context(tenantId: string): AgentExecutionContext {
  return {
    agentId: `agent-${tenantId}`,
    projectId: 'security-test',
    goal: 'verify tenant-scoped memory',
    tenantId,
    contextData: {},
    availableTools: ['memory'],
    maxSteps: 1,
    tokenBudget: 1000,
  };
}

afterEach(async () => {
  await Promise.all(
    tenantIds.splice(0).map((tenantId) =>
      fs.rm(path.join(memoryDir, tenantPathSegment(tenantId)), {
        recursive: true,
        force: true,
      }),
    ),
  );
  await Promise.all(
    externalDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function expectNamespaceLinkRejected(tenantId: string, targetDir: string): Promise<void> {
  const tenantRoot = path.join(memoryDir, tenantPathSegment(tenantId));
  const namespaceDir = path.join(tenantRoot, 'default');
  await fs.mkdir(tenantRoot, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(targetDir, 'victim.json'),
    JSON.stringify({ key: 'victim', value: 'target-secret', timestamp: new Date(0).toISOString() }),
  );
  await fs.symlink(targetDir, namespaceDir, process.platform === 'win32' ? 'junction' : 'dir');
  const before = (await fs.readdir(targetDir)).sort();

  const outcomes = await Promise.allSettled([
    runWithTenant(tenantId, () =>
      new MemoryStoreTool().execute(
        { key: 'attacker-write', value: 'must-not-land' },
        context(tenantId),
      ),
    ),
    runWithTenant(tenantId, () =>
      new MemoryRecallTool().execute({ key: 'victim' }, context(tenantId)),
    ),
    runWithTenant(tenantId, () => new MemoryListTool().execute({}, context(tenantId))),
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      expect(String(outcome.reason)).toMatch(/symbolic link|reparse point|unsafe memory path/i);
    }
  }

  expect((await fs.readdir(targetDir)).sort()).toEqual(before);
  await expect(fs.access(path.join(targetDir, 'attacker-write.json'))).rejects.toThrow();
}

describe('agent-facing memory tenant isolation', () => {
  it('keeps same-tenant store/recall behavior and hides another tenant at the same key', async () => {
    const suffix = randomUUID().slice(0, 8);
    const tenantA = `memory-a-${suffix}`;
    const tenantB = `memory-b-${suffix}`;
    tenantIds.push(tenantA, tenantB);
    const tool = new MemoryResourceTool();

    await runWithTenant(tenantA, () =>
      tool.execute(
        { action: 'store', key: 'shared-key', value: 'tenant-a-secret', tenantId: tenantB },
        context(tenantA),
      ),
    );
    await runWithTenant(tenantB, () =>
      tool.execute(
        { action: 'store', key: 'shared-key', value: 'tenant-b-value' },
        context(tenantB),
      ),
    );

    const recalledA = await runWithTenant(tenantA, () =>
      tool.execute({ action: 'recall', key: 'shared-key' }, context(tenantA)),
    );
    const recalledB = await runWithTenant(tenantB, () =>
      tool.execute({ action: 'recall', key: 'shared-key' }, context(tenantB)),
    );

    expect(recalledA).toContain('tenant-a-secret');
    expect(recalledA).not.toContain('tenant-b-value');
    expect(recalledB).toContain('tenant-b-value');
    expect(recalledB).not.toContain('tenant-a-secret');
  });

  it('fails closed when authenticated context is missing or mismatches the active tenant', async () => {
    const suffix = randomUUID().slice(0, 8);
    const tenantA = `memory-a-${suffix}`;
    const tenantB = `memory-b-${suffix}`;
    tenantIds.push(tenantA, tenantB);
    const recall = new MemoryRecallTool();

    await expect(runWithTenant(tenantA, () => recall.execute({ key: 'anything' }))).rejects.toThrow(
      /Authenticated tenant is required/,
    );
    await expect(
      runWithTenant(tenantA, () => recall.execute({ key: 'anything' }, context(tenantB))),
    ).rejects.toThrow(/Cross-tenant access blocked/);
  });

  it('rejects namespace traversal before touching tenant storage', async () => {
    const tenant = `memory-${randomUUID().slice(0, 8)}`;
    tenantIds.push(tenant);
    const tool = new MemoryResourceTool();

    const result = await runWithTenant(tenant, () =>
      tool.execute(
        { action: 'store', key: 'escape', value: 'nope', namespace: '../other-tenant' },
        context(tenant),
      ),
    );
    expect(result).toMatch(/Invalid memory namespace/);
  });

  it('rejects a tenant namespace symlink into another tenant', async () => {
    const suffix = randomUUID().slice(0, 8);
    const tenantA = `memory-a-${suffix}`;
    const tenantB = `memory-b-${suffix}`;
    tenantIds.push(tenantA, tenantB);
    const tenantBDefault = path.join(memoryDir, tenantPathSegment(tenantB), 'default');

    await expectNamespaceLinkRejected(tenantA, tenantBDefault);
  });

  it('rejects a tenant namespace symlink into an external directory', async () => {
    const tenant = `memory-${randomUUID().slice(0, 8)}`;
    tenantIds.push(tenant);
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-memory-external-'));
    externalDirs.push(external);

    await expectNamespaceLinkRejected(tenant, external);
  });

  it('rejects a direct-key read through a hard link to another tenant', async () => {
    const suffix = randomUUID().slice(0, 8);
    const tenantA = `memory-a-${suffix}`;
    const tenantB = `memory-b-${suffix}`;
    tenantIds.push(tenantA, tenantB);
    const tenantADefault = path.join(memoryDir, tenantPathSegment(tenantA), 'default');
    const tenantBDefault = path.join(memoryDir, tenantPathSegment(tenantB), 'default');
    await fs.mkdir(tenantADefault, { recursive: true });
    await fs.mkdir(tenantBDefault, { recursive: true });
    const target = path.join(tenantBDefault, 'victim.json');
    await fs.writeFile(
      target,
      JSON.stringify({
        key: 'victim',
        value: 'tenant-b-secret',
        timestamp: new Date(0).toISOString(),
      }),
    );
    await fs.link(target, path.join(tenantADefault, 'victim.json'));

    await expect(
      runWithTenant(tenantA, () =>
        new MemoryRecallTool().execute({ key: 'victim' }, context(tenantA)),
      ),
    ).rejects.toThrow(/hard link|unsafe memory path/i);
    expect(await fs.readFile(target, 'utf-8')).toContain('tenant-b-secret');
  });

  it('rejects a search through a hard link to an external memory file', async () => {
    const tenant = `memory-${randomUUID().slice(0, 8)}`;
    tenantIds.push(tenant);
    const tenantDefault = path.join(memoryDir, tenantPathSegment(tenant), 'default');
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-memory-hardlink-'));
    externalDirs.push(external);
    await fs.mkdir(tenantDefault, { recursive: true });
    const target = path.join(external, 'external.json');
    await fs.writeFile(
      target,
      JSON.stringify({
        key: 'outside',
        value: 'external-secret',
        timestamp: new Date(0).toISOString(),
      }),
    );
    await fs.link(target, path.join(tenantDefault, 'outside.json'));

    await expect(
      runWithTenant(tenant, () =>
        new MemoryRecallTool().execute({ search: 'external-secret' }, context(tenant)),
      ),
    ).rejects.toThrow(/hard link|unsafe memory path/i);
    expect(await fs.readFile(target, 'utf-8')).toContain('external-secret');
  });
});
