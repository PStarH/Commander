import assert from 'node:assert/strict';
import test from 'node:test';
import { formattingBaseline } from './scannerFormattingBaseline.js';

test('uses formatted baseline only for an exact formatter-only change', async () => {
  const before = 'const count=1;';
  assert.equal(
    await formattingBaseline('sample.ts', before, 'const count = 1;\n'),
    'const count = 1;\n',
  );
  assert.equal(await formattingBaseline('sample.ts', before, 'const count = 2;\n'), before);
  assert.equal(await formattingBaseline('sample.ts', undefined, 'const count = 1;\n'), undefined);
});

test('keeps original evidence when historical syntax cannot be formatted', async () => {
  assert.equal(await formattingBaseline('sample.ts', 'const =;', 'const count = 1;\n'), 'const =;');
  assert.equal(await formattingBaseline('sample.sh', 'echo hi', 'echo bye'), 'echo hi');
});
