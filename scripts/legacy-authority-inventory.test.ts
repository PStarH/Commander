import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInventory } from './legacy-authority-inventory.js';

describe('legacy-authority-inventory', () => {
  it('produces a stable sorted inventory', () => {
    const result = buildInventory();
    const paths = result.entries.map((e) => e.path);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(paths, sorted);
  });

  it('classifies canonical V2 authorities', () => {
    const result = buildInventory();
    const canonical = result.entries.filter((e) => e.authorityKind === 'canonical');
    assert.ok(canonical.length >= 4, `expected at least 4 canonical authorities, got ${canonical.length}`);
    const paths = new Set(canonical.map((e) => e.path));
    assert.ok(paths.has('apps/api/src/v1GatewayEndpoints.ts'));
    assert.ok(paths.has('apps/api/src/actionGatewayEndpoints.ts'));
  });

  it('classifies known write-capable legacy authorities', () => {
    const result = buildInventory();
    const writePaths = new Set(
      result.entries
        .filter((e) => e.authorityKind === 'write-capable-legacy')
        .map((e) => e.path),
    );
    assert.ok(writePaths.has('apps/api/src/sharedRuntime.ts'));
    assert.ok(writePaths.has('apps/api/src/agentRuntimeRegistry.ts'));
    assert.ok(writePaths.has('apps/api/src/orchestratorEndpoints.ts'));
    assert.ok(writePaths.has('packages/core/src/cliEntry.ts'));
    assert.ok(writePaths.has('packages/mcp-server/src/stdioServer.ts'));
  });

  it('classifies temporary gates modules', () => {
    const result = buildInventory();
    const gatePaths = new Set(
      result.entries
        .filter((e) => e.authorityKind === 'temporary-gate')
        .map((e) => e.path),
    );
    assert.ok(gatePaths.has('apps/api/src/legacyExecutionGuard.ts'));
    assert.ok(gatePaths.has('scripts/architecture-gate.ts'));
    assert.ok(gatePaths.has('scripts/legacy-authority-inventory.ts'));
  });

  it('reports no new write-capable legacy authorities against the fixture', () => {
    const result = buildInventory();
    if (!result.passed) {
      const unexpected = result.newWriteAuthorities.map((e) => e.path).join(', ');
      assert.fail(`New write-capable legacy authorities detected: ${unexpected}`);
    }
  });

  it('includes callers metadata for known authorities', () => {
    const result = buildInventory();
    const sharedRuntime = result.entries.find((e) => e.path === 'apps/api/src/sharedRuntime.ts');
    assert.ok(sharedRuntime, 'sharedRuntime should be in inventory');
    assert.ok(Array.isArray(sharedRuntime!.callers));
  });
});
