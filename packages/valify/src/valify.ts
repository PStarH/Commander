import {
  StringSchema,
  NumberSchema,
  BooleanSchema,
  LiteralSchema,
  ArraySchema,
  ObjectSchema,
  UnionSchema,
} from './schemas.js';
import type { ValifySchema, Infer, ParseResult, SafeParseReturnType } from './types.js';
import { ValifyError, ValifyIssue } from './errors.js';

// ==================== FACTORY FUNCTIONS ====================

function string(): StringSchema {
  return new StringSchema();
}

function number(): NumberSchema {
  return new NumberSchema();
}

function boolean(): BooleanSchema {
  return new BooleanSchema();
}

function literal<T extends string | number | boolean>(value: T): LiteralSchema<T> {
  return new LiteralSchema<T>(value);
}

function array<T>(itemSchema: ValifySchema<T>): ArraySchema<T> {
  return new ArraySchema<T>(itemSchema);
}

function object<S extends Record<string, ValifySchema<any>>>(shape: S): ObjectSchema<S> {
  return new ObjectSchema<S>(shape);
}

function union<T extends ValifySchema<any>[]>(...schemas: T): UnionSchema<Infer<T[number]>> {
  return new UnionSchema<Infer<T[number]>>(schemas);
}

// ==================== NAMESPACE ====================

const valify = {
  string,
  number,
  boolean,
  literal,
  array,
  object,
  union,
  ValifyError,
};

export default valify;
export { string, number, boolean, literal, array, object, union, ValifyError };

export type { ValifySchema, Infer, ParseResult, SafeParseReturnType, ValifyIssue };
