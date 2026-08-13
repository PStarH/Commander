import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./repositoryFactory.ts', import.meta.url), 'utf8');

describe('kernel PostgreSQL runtime wiring', () => {
  it('uses the verified PostgreSQL pool factory for the postgres backend', () => {
    assert.match(source, /from '\.\/postgresRuntime\.js'/);
    assert.doesNotMatch(source, /new\s+Pool\s*\(/);
  });
});
