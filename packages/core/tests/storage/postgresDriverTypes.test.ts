/**
 * PostgreSQL column type mapping.
 *
 * Numbers must map to DOUBLE PRECISION. PostgreSQL REAL is single precision, so
 * integer values beyond 2^24 (and epoch-millisecond timestamps) silently rounded
 * on write, which broke equality/CAS predicates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sqlTypeForColumn } from '../../src/storage/postgresDriver';

describe('sqlTypeForColumn', () => {
  it('maps numbers to DOUBLE PRECISION so JavaScript numbers round-trip exactly', () => {
    assert.equal(sqlTypeForColumn('number'), 'DOUBLE PRECISION');
  });

  it('keeps the string/boolean mappings', () => {
    assert.equal(sqlTypeForColumn('string'), 'TEXT');
    assert.equal(sqlTypeForColumn('boolean'), 'BOOLEAN');
  });
});
