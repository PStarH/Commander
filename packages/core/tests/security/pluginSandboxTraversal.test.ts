/**
 * AUDIT-R5F1/F2: plugin permission path matching must canonicalize traversal,
 * and sandbox fetch must not follow redirects.
 */
import { test, describe } from 'vitest';
import * as assert from 'node:assert/strict';
import { PluginPermissionEnforcer } from '../../src/security/pluginPermissions.js';

function enforcerWithRead(patterns: string[]): PluginPermissionEnforcer {
  return new PluginPermissionEnforcer('test-plugin', {
    filesystem: { read: patterns, write: [] },
    network: { allowedDomains: [], allowedPorts: [] },
    process: false,
    env: [],
    hooks: [],
    tools: [],
    hostModuleImport: false,
  });
}

describe('plugin path traversal (AUDIT-R5F1)', () => {
  test('/workspace/** grant does not admit /workspace/../../etc/passwd', () => {
    const e = enforcerWithRead(['/workspace/**']);
    const check = e.checkFileRead('/workspace/../../etc/passwd');
    // FAILING before the fix: startsWith('/workspace/') passed.
    assert.equal(check.allowed, false);
  });

  test('legitimate path inside the grant still passes', () => {
    const e = enforcerWithRead(['/workspace/**']);
    assert.equal(e.checkFileRead('/workspace/project/file.ts').allowed, true);
  });

  test('exact-match grant still passes', () => {
    const e = enforcerWithRead(['/workspace/config.json']);
    assert.equal(e.checkFileRead('/workspace/config.json').allowed, true);
  });

  test('normalized path that lands outside the grant is denied', () => {
    const e = enforcerWithRead(['/workspace/**']);
    assert.equal(e.checkFileRead('/workspace/sub/../..//etc/shadow').allowed, false);
  });
});
