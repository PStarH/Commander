import type { ValifySchema, ValifySchemaDef, ParseResult } from './types.js';
import { ValifyError, ValifyIssue, createIssue, prependPath } from './errors.js';

// ==================== CORE VALIDATION ENGINE ====================

function runSync<T>(def: ValifySchemaDef<T>, input: unknown): { value: T; issues: ValifyIssue[] } {
  const issues: ValifyIssue[] = [];
  const path: (string | number)[] = [];

  // Apply default for undefined
  if (input === undefined && def._hasDefault) {
    input = def._default;
  }

  // Optional: accept undefined
  if (input === undefined) {
    if (def._optional) return { value: undefined as T, issues };
    issues.push(createIssue(path, 'Required', 'required'));
    return { value: undefined as T, issues };
  }

  // Nullable: accept null
  if (input === null) {
    if (def._nullable) return { value: null as T, issues };
    issues.push(createIssue(path, 'Cannot be null', 'not_nullable'));
    return { value: null as T, issues };
  }

  // Type-specific validation (returns validated value or appends issues)
  const validated = validateByType(def, input, path, issues);
  if (issues.length > 0) return { value: validated, issues };

  // Refinements
  for (const ref of def._refines) {
    const result = ref.fn(validated);
    if (typeof (result as any)?.then === 'function') {
      throw new Error('Use parseAsync/safeParseAsync for async refinements');
    }
    if (!result) issues.push(createIssue(path, ref.message, 'custom'));
  }

  return { value: validated, issues };
}

async function runAsync<T>(
  def: ValifySchemaDef<T>,
  input: unknown,
): Promise<{ value: T; issues: ValifyIssue[] }> {
  const issues: ValifyIssue[] = [];
  const path: (string | number)[] = [];

  if (input === undefined && def._hasDefault) input = def._default;

  if (input === undefined) {
    if (def._optional) return { value: undefined as T, issues };
    issues.push(createIssue(path, 'Required', 'required'));
    return { value: undefined as T, issues };
  }

  if (input === null) {
    if (def._nullable) return { value: null as T, issues };
    issues.push(createIssue(path, 'Cannot be null', 'not_nullable'));
    return { value: null as T, issues };
  }

  const validated = validateByType(def, input, path, issues);
  if (issues.length > 0) return { value: validated, issues };

  for (const ref of def._refines) {
    const ok = await ref.fn(validated);
    if (!ok) issues.push(createIssue(path, ref.message, 'custom'));
  }

  return { value: validated, issues };
}

// ==================== TYPE-SPECIFIC VALIDATION ====================

interface StringMeta {
  minLength?: number;
  maxLength?: number;
  regex?: RegExp;
  email?: boolean;
  url?: boolean;
  uuid?: boolean;
}

interface NumberMeta {
  min?: number;
  max?: number;
  integer?: boolean;
  positive?: boolean;
  negative?: boolean;
}

interface ArrayMeta<T> {
  itemSchema?: ValifySchema<T>;
  minItems?: number;
  maxItems?: number;
}

interface ObjectMeta<S> {
  shape: S;
  passthrough: boolean;
}

interface LiteralMeta<T> {
  value: T;
}

interface UnionMeta {
  schemas: ValifySchema<any>[];
}

function validateByType<T>(
  def: ValifySchemaDef<T>,
  input: unknown,
  path: (string | number)[],
  issues: ValifyIssue[],
): T {
  const m = (def as any).__meta;

  switch (def._type) {
    case 'string': {
      if (typeof input !== 'string') {
        issues.push(createIssue(path, 'Expected string', 'invalid_type'));
        return input as T;
      }
      const meta = m as StringMeta | undefined;
      if (meta) {
        if (meta.minLength !== undefined && input.length < meta.minLength)
          issues.push(
            createIssue(path, `String must be at least ${meta.minLength} characters`, 'too_small'),
          );
        if (meta.maxLength !== undefined && input.length > meta.maxLength)
          issues.push(
            createIssue(path, `String must be at most ${meta.maxLength} characters`, 'too_big'),
          );
        if (meta.regex && !meta.regex.test(input))
          issues.push(
            createIssue(path, `String does not match pattern ${meta.regex}`, 'invalid_string'),
          );
        if (meta.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input))
          issues.push(createIssue(path, 'Invalid email', 'invalid_email'));
        if (meta.url) {
          try { new URL(input); } catch (err) {
            console.warn('[Catch]', err);
            issues.push(createIssue(path, 'Invalid URL', 'invalid_url'));
          }
        }
        if (
          meta.uuid &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
        )
          issues.push(createIssue(path, 'Invalid UUID', 'invalid_uuid'));
      }
      return input as T;
    }

    case 'number': {
      if (typeof input !== 'number' || Number.isNaN(input)) {
        issues.push(createIssue(path, 'Expected number', 'invalid_type'));
        return input as T;
      }
      const meta = m as NumberMeta | undefined;
      if (meta) {
        if (meta.min !== undefined && input < meta.min)
          issues.push(createIssue(path, `Number must be at least ${meta.min}`, 'too_small'));
        if (meta.max !== undefined && input > meta.max)
          issues.push(createIssue(path, `Number must be at most ${meta.max}`, 'too_big'));
        if (meta.integer && !Number.isInteger(input))
          issues.push(createIssue(path, 'Expected integer', 'invalid_type'));
        if (meta.positive && input <= 0)
          issues.push(createIssue(path, 'Number must be positive', 'too_small'));
        if (meta.negative && input >= 0)
          issues.push(createIssue(path, 'Number must be negative', 'too_big'));
      }
      return input as T;
    }

    case 'boolean': {
      if (typeof input !== 'boolean') {
        issues.push(createIssue(path, 'Expected boolean', 'invalid_type'));
      }
      return input as T;
    }

    case 'literal': {
      const meta = m as LiteralMeta<any>;
      if (input !== meta.value) {
        issues.push(
          createIssue(path, `Expected literal ${JSON.stringify(meta.value)}`, 'invalid_literal'),
        );
      }
      return input as T;
    }

    case 'array': {
      if (!Array.isArray(input)) {
        issues.push(createIssue(path, 'Expected array', 'invalid_type'));
        return input as T;
      }
      const meta = m as ArrayMeta<any> | undefined;
      if (meta) {
        if (meta.minItems !== undefined && input.length < meta.minItems)
          issues.push(
            createIssue(path, `Array must have at least ${meta.minItems} items`, 'too_small'),
          );
        if (meta.maxItems !== undefined && input.length > meta.maxItems)
          issues.push(
            createIssue(path, `Array must have at most ${meta.maxItems} items`, 'too_big'),
          );
        if (meta.itemSchema) {
          for (let i = 0; i < input.length; i++) {
            const r = syncParse(meta.itemSchema, input[i]);
            if (!r.success) {
              issues.push(...prependPath(r.error, i));
            }
          }
        }
      }
      return input as T;
    }

    case 'object': {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        issues.push(createIssue(path, 'Expected object', 'invalid_type'));
        return input as T;
      }
      const meta = m as ObjectMeta<Record<string, ValifySchema<any>>>;
      const obj = input as Record<string, unknown>;
      if (meta) {
        if (!meta.passthrough) {
          for (const key of Object.keys(obj)) {
            if (!(key in meta.shape)) {
              issues.push(createIssue([...path, key], 'Unknown key', 'unrecognized_keys'));
            }
          }
        }
        for (const [key, fieldSchema] of Object.entries(meta.shape)) {
          const r = syncParse(fieldSchema, obj[key]);
          if (!r.success) {
            issues.push(...prependPath(r.error, key));
          }
        }
      }
      return input as T;
    }

    case 'union': {
      const meta = m as UnionMeta;
      if (meta) {
        let matched = false;
        for (const s of meta.schemas) {
          const r = syncParse(s, input);
          if (r.success) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          issues.push(createIssue(path, 'No union member matched', 'invalid_union'));
        }
      }
      return input as T;
    }

    default:
      issues.push(createIssue(path, `Unknown schema type: ${def._type}`, 'unknown'));
      return input as T;
  }
}

function syncParse<T>(schema: ValifySchema<T>, input: unknown): ParseResult<T> {
  const { value, issues } = runSync(schema._def, input);
  if (issues.length > 0) return { success: false, error: issues };
  return { success: true, data: value };
}

// ==================== ATTACH METHODS ====================

function createSchema<T>(def: ValifySchemaDef<T>): ValifySchema<T> {
  const schema: ValifySchema<T> = {
    _def: def,
    parse(input: unknown): T {
      const { value, issues } = runSync(def, input);
      if (issues.length > 0) throw new ValifyError(issues);
      return value;
    },
    safeParse(input: unknown): ParseResult<T> {
      const { value, issues } = runSync(def, input);
      if (issues.length > 0) return { success: false, error: issues };
      return { success: true, data: value };
    },
    async parseAsync(input: unknown): Promise<T> {
      const { value, issues } = await runAsync(def, input);
      if (issues.length > 0) throw new ValifyError(issues);
      return value;
    },
    async safeParseAsync(input: unknown): Promise<ParseResult<T>> {
      const { value, issues } = await runAsync(def, input);
      if (issues.length > 0) return { success: false, error: issues };
      return { success: true, data: value };
    },
  };
  return schema;
}

// ==================== CHAINABLE BUILDER BASE ====================

abstract class SchemaBuilder<T, Meta = {}> {
  protected _def: ValifySchemaDef<T>;

  constructor(type: string, meta: Meta) {
    this._def = {
      _type: type,
      _output: undefined as unknown as T,
      _optional: false,
      _nullable: false,
      _hasDefault: false,
      _refines: [],
      _coerce: false,
    } as ValifySchemaDef<T>;
    (this._def as any).__meta = meta;
  }

  optional(): this & ValifySchema<T | undefined> {
    this._def._optional = true;
    return this as any;
  }

  nullable(): this & ValifySchema<T | null> {
    this._def._nullable = true;
    return this as any;
  }

  default(value: T): this {
    this._def._default = value;
    this._def._hasDefault = true;
    this._def._optional = true;
    return this;
  }

  refine(fn: (val: T) => boolean | Promise<boolean>, message: string): this {
    this._def._refines.push({ fn, message });
    return this;
  }

  build(): ValifySchema<T> {
    return createSchema({ ...this._def });
  }
}

// ==================== STRING SCHEMA ====================

class StringSchema extends SchemaBuilder<string, StringMeta> {
  constructor() {
    super('string', {});
  }

  min(n: number): this {
    (this._def as any).__meta.minLength = n;
    return this;
  }
  max(n: number): this {
    (this._def as any).__meta.maxLength = n;
    return this;
  }
  regex(r: RegExp): this {
    (this._def as any).__meta.regex = r;
    return this;
  }
  email(): this {
    (this._def as any).__meta.email = true;
    return this;
  }
  url(): this {
    (this._def as any).__meta.url = true;
    return this;
  }
  uuid(): this {
    (this._def as any).__meta.uuid = true;
    return this;
  }
}

// ==================== NUMBER SCHEMA ====================

class NumberSchema extends SchemaBuilder<number, NumberMeta> {
  constructor() {
    super('number', {});
  }

  min(n: number): this {
    (this._def as any).__meta.min = n;
    return this;
  }
  max(n: number): this {
    (this._def as any).__meta.max = n;
    return this;
  }
  integer(): this {
    (this._def as any).__meta.integer = true;
    return this;
  }
  positive(): this {
    (this._def as any).__meta.positive = true;
    return this;
  }
  negative(): this {
    (this._def as any).__meta.negative = true;
    return this;
  }
}

// ==================== BOOLEAN SCHEMA ====================

class BooleanSchema extends SchemaBuilder<boolean, {}> {
  constructor() {
    super('boolean', {});
  }
}

// ==================== LITERAL SCHEMA ====================

class LiteralSchema<T extends string | number | boolean> extends SchemaBuilder<T, { value: T }> {
  constructor(value: T) {
    super('literal', { value });
  }
}

// ==================== ARRAY SCHEMA ====================

class ArraySchema<T> extends SchemaBuilder<T[], ArrayMeta<T>> {
  constructor(itemSchema: ValifySchema<T>) {
    super('array', { itemSchema });
  }

  min(n: number): this {
    (this._def as any).__meta.minItems = n;
    return this;
  }
  max(n: number): this {
    (this._def as any).__meta.maxItems = n;
    return this;
  }
}

// ==================== OBJECT SCHEMA ====================

type ShapeOutput<S extends Record<string, ValifySchema<any>>> = {
  [K in keyof S]: S[K] extends ValifySchema<infer U> ? U : never;
};

class ObjectSchema<S extends Record<string, ValifySchema<any>>> extends SchemaBuilder<
  ShapeOutput<S>,
  ObjectMeta<S>
> {
  constructor(shape: S) {
    super('object', { shape, passthrough: false });
  }

  passthrough(): this {
    (this._def as any).__meta.passthrough = true;
    return this;
  }
}

// ==================== UNION SCHEMA ====================

class UnionSchema<T> extends SchemaBuilder<T, UnionMeta> {
  constructor(schemas: ValifySchema<any>[]) {
    super('union', { schemas });
  }
}

// ==================== PUBLIC API ====================

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
function union<T extends ValifySchema<any>[]>(...schemas: T): UnionSchema<any> {
  return new UnionSchema(schemas);
}

export {
  string,
  number,
  boolean,
  literal,
  array,
  object,
  union,
  StringSchema,
  NumberSchema,
  BooleanSchema,
  LiteralSchema,
  ArraySchema,
  ObjectSchema,
  UnionSchema,
};
