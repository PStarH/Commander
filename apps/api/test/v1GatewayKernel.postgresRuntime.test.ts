import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/v1GatewayKernel.ts', import.meta.url), 'utf8');

describe('v1 gateway PostgreSQL runtime wiring', () => {
  it('uses the verified PostgreSQL pool factory for kernel boot', () => {
    assert.match(source, /createVerifiedPostgresPool/);
    assert.match(source, /from '@commander\/kernel'/);
    assert.doesNotMatch(source, /@commander\/postgres-runtime/);
    assert.doesNotMatch(source, /new\s+pg\.Pool\s*\(/);
  });
});
