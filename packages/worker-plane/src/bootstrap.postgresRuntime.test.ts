import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8');

describe('worker PostgreSQL runtime wiring', () => {
  it('uses the verified PostgreSQL pool factory for bootstrap', () => {
    assert.match(source, /createVerifiedPostgresPool/);
    assert.doesNotMatch(source, /new\s+PgPool\s*\(/);
  });
});
