import assert from 'node:assert/strict';
import test from 'node:test';

const helperModule = './precommitPatch.js';

test('extracts only added content from a staged unified diff', async () => {
  const helper = await import(helperModule).catch(() => undefined);
  assert.ok(helper, 'precommit patch helper must exist');

  const patch = [
    'diff --git a/packages/example.ts b/packages/example.ts',
    'index 111111111..222222222 100644',
    '--- a/packages/example.ts',
    '+++ b/packages/example.ts',
    '@@ -1,2 +1,3 @@',
    '-const removed = true;',
    "+const added = 'safe';",
    '++++ banner',
    '+const replacement = true;',
    '+++ b/intentional-content',
  ].join('\n');

  assert.equal(
    helper.addedContentFromUnifiedDiff(patch),
    "const added = 'safe';\n+++ banner\nconst replacement = true;\n++ b/intentional-content",
  );
});
