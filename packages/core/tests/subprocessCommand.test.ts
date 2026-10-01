import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubprocessCommand } from '../src/plugins/pluginSandbox';

test('plugin subprocess args stay quoted when they contain command substitution', () => {
  const injected = '$' + '(id)';
  const command = buildSubprocessCommand({
    pluginId: 'demo.plugin',
    toolName: 'echo',
    args: { x: injected, y: "a'b" },
  });
  const output = execFileSync('sh', ['-c', command], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), {
    plugin: 'demo.plugin',
    tool: 'echo',
    args: { x: injected, y: "a'b" },
  });
});
