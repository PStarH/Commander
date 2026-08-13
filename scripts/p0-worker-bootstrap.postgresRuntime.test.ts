import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./p0-worker-bootstrap.ts', import.meta.url), 'utf8');

describe('P0 worker PostgreSQL runtime wiring', () => {
  it('uses the verified PostgreSQL pool factory for the CI worker bootstrap', () => {
    assert.match(source, /createVerifiedPostgresPool/);
    assert.doesNotMatch(source, /from 'pg'/);
    assert.doesNotMatch(source, /new Pool\(/);
  });
});
