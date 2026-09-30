import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecuteScriptTool } from '../src/tools/scriptTool';

test('vm fallback blocks console.log.constructor from reaching the host process', async () => {
  const previous = process.env.COMMANDER_ALLOW_EXEC_SCRIPT;
  process.env.COMMANDER_ALLOW_EXEC_SCRIPT = '1';
  try {
    const tool = new ExecuteScriptTool();
    const result = await tool.execute({
      script: `
        try {
          const p = console.log.constructor('return process')();
          console.log('ESCAPED:' + (p && p.pid));
        } catch (e) {
          console.log('BLOCKED');
        }
      `,
    });
    assert.equal(result.includes('ESCAPED:'), false);
    assert.equal(result.includes('BLOCKED'), true);
  } finally {
    if (previous === undefined) delete process.env.COMMANDER_ALLOW_EXEC_SCRIPT;
    else process.env.COMMANDER_ALLOW_EXEC_SCRIPT = previous;
  }
});
