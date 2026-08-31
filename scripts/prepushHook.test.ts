import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('resolves the pre-push repository root through Git rather than GIT_DIR internals', () => {
  const source = readFileSync('scripts/prepushHook.ts', 'utf8');

  assert.match(source, /git', \['rev-parse', '--show-toplevel'\]/);
  assert.doesNotMatch(source, /process\.env\.GIT_DIR/);
});
