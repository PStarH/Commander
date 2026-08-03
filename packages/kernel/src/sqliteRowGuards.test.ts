import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EFFECT_STATES,
  reqEnum,
  reqInteger,
  reqJsonArray,
  reqJsonObject,
  reqOptionalInteger,
  reqOptionalJsonObject,
  reqOptionalString,
  reqString,
  reqStringArray,
  SqliteRowValidationError,
  STEP_STATES,
  TIMER_STATES,
  TIMER_TYPES,
} from './sqliteRowGuards.js';

describe('sqliteRowGuards', () => {
  const table = 'test_table';

  describe('reqString', () => {
    it('returns a string value', () => {
      assert.equal(reqString(table, { name: 'hello' }, 'name'), 'hello');
    });

    it('throws when the value is not a string', () => {
      assert.throws(
        () => reqString(table, { name: 42 }, 'name'),
        (err) => err instanceof SqliteRowValidationError && err.field === 'name',
      );
    });

    it('throws when the value is null or undefined', () => {
      assert.throws(() => reqString(table, { name: null }, 'name'));
      assert.throws(() => reqString(table, {}, 'name'));
    });
  });

  describe('reqOptionalString', () => {
    it('returns a string value', () => {
      assert.equal(reqOptionalString(table, { name: 'hello' }, 'name'), 'hello');
    });

    it('returns undefined for null or undefined', () => {
      assert.equal(reqOptionalString(table, { name: null }, 'name'), undefined);
      assert.equal(reqOptionalString(table, {}, 'name'), undefined);
    });

    it('throws when the value is a non-string', () => {
      assert.throws(() => reqOptionalString(table, { name: 42 }, 'name'));
    });
  });

  describe('reqInteger', () => {
    it('returns an integer from a number', () => {
      assert.equal(reqInteger(table, { count: 7 }, 'count'), 7);
    });

    it('returns an integer from a numeric string', () => {
      assert.equal(reqInteger(table, { count: '42' }, 'count'), 42);
    });

    it('returns an integer from a bigint', () => {
      assert.equal(reqInteger(table, { count: BigInt(9) }, 'count'), 9);
    });

    it('throws for a float', () => {
      assert.throws(() => reqInteger(table, { count: 3.14 }, 'count'));
    });

    it('throws for a non-numeric string', () => {
      assert.throws(() => reqInteger(table, { count: 'abc' }, 'count'));
    });

    it('throws for a float string', () => {
      assert.throws(() => reqInteger(table, { count: '3.14' }, 'count'));
    });

    it('parses an integer from a string with whitespace', () => {
      assert.equal(reqInteger(table, { count: '  42  ' }, 'count'), 42);
    });

    it('throws for an empty string', () => {
      assert.throws(() => reqInteger(table, { count: '   ' }, 'count'));
    });

    it('throws for null, undefined, boolean, or object', () => {
      assert.throws(() => reqInteger(table, { count: null }, 'count'));
      assert.throws(() => reqInteger(table, {}, 'count'));
      assert.throws(() => reqInteger(table, { count: true }, 'count'));
      assert.throws(() => reqInteger(table, { count: {} }, 'count'));
    });

    it('throws for NaN or Infinity', () => {
      assert.throws(() => reqInteger(table, { count: NaN }, 'count'));
      assert.throws(() => reqInteger(table, { count: Infinity }, 'count'));
    });
  });

  describe('reqOptionalInteger', () => {
    it('returns an integer when present', () => {
      assert.equal(reqOptionalInteger(table, { count: 5 }, 'count'), 5);
    });

    it('returns an integer from a numeric string', () => {
      assert.equal(reqOptionalInteger(table, { count: '99' }, 'count'), 99);
    });

    it('returns undefined for null or undefined', () => {
      assert.equal(reqOptionalInteger(table, { count: null }, 'count'), undefined);
      assert.equal(reqOptionalInteger(table, {}, 'count'), undefined);
    });

    it('throws for a float', () => {
      assert.throws(() => reqOptionalInteger(table, { count: 2.5 }, 'count'));
    });
  });

  describe('reqJsonObject', () => {
    it('returns a parsed JSON object from a string', () => {
      assert.deepEqual(reqJsonObject(table, { meta: '{"a":1}' }, 'meta'), { a: 1 });
    });

    it('returns an object value as-is', () => {
      assert.deepEqual(reqJsonObject(table, { meta: { a: 1 } }, 'meta'), { a: 1 });
    });

    it('throws for a JSON array string', () => {
      assert.throws(() => reqJsonObject(table, { meta: '[1,2]' }, 'meta'));
    });

    it('throws for a malformed JSON string', () => {
      assert.throws(() => reqJsonObject(table, { meta: '{invalid' }, 'meta'));
    });

    it('throws for null, undefined, or a number', () => {
      assert.throws(() => reqJsonObject(table, { meta: null }, 'meta'));
      assert.throws(() => reqJsonObject(table, {}, 'meta'));
      assert.throws(() => reqJsonObject(table, { meta: 123 }, 'meta'));
    });
  });

  describe('reqOptionalJsonObject', () => {
    it('returns a parsed object when present', () => {
      assert.deepEqual(reqOptionalJsonObject(table, { meta: '{"a":1}' }, 'meta'), { a: 1 });
    });

    it('returns undefined for null or undefined', () => {
      assert.equal(reqOptionalJsonObject(table, { meta: null }, 'meta'), undefined);
      assert.equal(reqOptionalJsonObject(table, {}, 'meta'), undefined);
    });

    it('throws for an array', () => {
      assert.throws(() => reqOptionalJsonObject(table, { meta: '[1]' }, 'meta'));
    });
  });

  describe('reqJsonArray', () => {
    it('returns a parsed numeric array', () => {
      assert.deepEqual(reqJsonArray<number>(table, { values: '[1,2,3]' }, 'values'), [1, 2, 3]);
    });

    it('returns an array value as-is', () => {
      assert.deepEqual(reqJsonArray<string>(table, { values: ['a', 'b'] }, 'values'), ['a', 'b']);
    });

    it('throws when the value is not an array', () => {
      assert.throws(() => reqJsonArray(table, { values: '{"a":1}' }, 'values'));
    });

    it('throws for a malformed JSON string', () => {
      assert.throws(() => reqJsonArray(table, { values: '[1,2' }, 'values'));
    });
  });

  describe('reqStringArray', () => {
    it('returns a parsed string array', () => {
      assert.deepEqual(reqStringArray(table, { deps: '["a","b"]' }, 'deps'), ['a', 'b']);
    });

    it('returns an empty array', () => {
      assert.deepEqual(reqStringArray(table, { deps: '[]' }, 'deps'), []);
    });

    it('throws when an element is not a string', () => {
      assert.throws(() => reqStringArray(table, { deps: '["a",1]' }, 'deps'));
    });

    it('throws when the value is not an array', () => {
      assert.throws(() => reqStringArray(table, { deps: '{"a":1}' }, 'deps'));
    });
  });

  describe('reqEnum', () => {
    it('returns a valid enum value', () => {
      assert.equal(reqEnum(table, { state: 'PENDING' }, 'state', STEP_STATES), 'PENDING');
      assert.equal(reqEnum(table, { state: 'COMPLETED' }, 'state', EFFECT_STATES), 'COMPLETED');
      assert.equal(reqEnum(table, { type: 'STEP_DEADLINE' }, 'type', TIMER_TYPES), 'STEP_DEADLINE');
      assert.equal(reqEnum(table, { state: 'CANCELLED' }, 'state', TIMER_STATES), 'CANCELLED');
    });

    it('throws for an invalid enum value', () => {
      assert.throws(() => reqEnum(table, { state: 'GONE' }, 'state', STEP_STATES));
    });

    it('throws for a valid-looking string not in the allowed list', () => {
      assert.throws(() => reqEnum(table, { state: 'PENDING' }, 'state', EFFECT_STATES));
    });

    it('throws for a non-string enum value', () => {
      assert.throws(() => reqEnum(table, { state: 123 }, 'state', STEP_STATES));
    });
  });

  describe('SqliteRowValidationError', () => {
    it('exposes table, field, and reason', () => {
      const err = new SqliteRowValidationError('my_table', 'my_field', 'bad');
      assert.equal(err.table, 'my_table');
      assert.equal(err.field, 'my_field');
      assert.equal(err.reason, 'bad');
      assert.equal(err.name, 'SqliteRowValidationError');
      assert.ok(err.message.includes('my_table'));
      assert.ok(err.message.includes('my_field'));
      assert.ok(err.message.includes('bad'));
    });
  });
});
