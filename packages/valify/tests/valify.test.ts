import valify, { string, number, boolean, literal, array, object, union, ValifyError } from '../src/valify.js';
import type { Infer } from '../src/valify.js';
import { describe, it, expect } from 'vitest';

// ==================== TYPE INFERENCE CHECKS ====================
// These are compile-time checks (type-level). If they compile, they pass.
const _str: Infer<ReturnType<typeof string>> = 'hello';
const _num: Infer<ReturnType<typeof number>> = 42;
const _bool: Infer<ReturnType<typeof boolean>> = true;
const _lit: Infer<ReturnType<typeof literal<'a'>>> = 'a';
const _arr: Infer<ReturnType<typeof array<ReturnType<typeof number>>>> = [1, 2];
const _obj: Infer<ReturnType<typeof object<{ name: ReturnType<typeof string>; age: ReturnType<typeof number> }>>> = { name: 'x', age: 1 };

// ==================== STRING ====================

describe('string()', () => {
  it('accepts valid strings', () => {
    const s = string().build();
    expect(s.parse('hello')).toBe('hello');
    expect(s.parse('')).toBe('');
  });

  it('rejects non-strings', () => {
    const s = string().build();
    expect(s.safeParse(123).success).toBe(false);
    expect(s.safeParse(null).success).toBe(false);
    expect(s.safeParse(undefined).success).toBe(false);
    expect(s.safeParse(true).success).toBe(false);
    expect(s.safeParse({}).success).toBe(false);
  });

  it('min length', () => {
    const s = string().min(3).build();
    expect(s.parse('abc')).toBe('abc');
    expect(s.parse('abcd')).toBe('abcd');
    expect(() => s.parse('ab')).toThrow();
  });

  it('max length', () => {
    const s = string().max(5).build();
    expect(s.parse('hello')).toBe('hello');
    expect(() => s.parse('toolong')).toThrow();
  });

  it('min + max', () => {
    const s = string().min(2).max(5).build();
    expect(s.parse('ab')).toBe('ab');
    expect(() => s.parse('a')).toThrow();
    expect(() => s.parse('abcdef')).toThrow();
  });

  it('regex', () => {
    const s = string().regex(/^[a-z]+$/).build();
    expect(s.parse('abc')).toBe('abc');
    expect(() => s.parse('ABC')).toThrow();
    expect(() => s.parse('abc123')).toThrow();
  });

  it('email', () => {
    const s = string().email().build();
    expect(s.parse('test@example.com')).toBe('test@example.com');
    expect(() => s.parse('not-an-email')).toThrow();
    expect(() => s.parse('@no-user.com')).toThrow();
  });

  it('url', () => {
    const s = string().url().build();
    expect(s.parse('https://example.com')).toBe('https://example.com');
    expect(() => s.parse('not-a-url')).toThrow();
  });

  it('uuid', () => {
    const s = string().uuid().build();
    expect(s.parse('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(() => s.parse('not-a-uuid')).toThrow();
  });
});

// ==================== NUMBER ====================

describe('number()', () => {
  it('accepts valid numbers', () => {
    const n = number().build();
    expect(n.parse(42)).toBe(42);
    expect(n.parse(0)).toBe(0);
    expect(n.parse(-3.14)).toBe(-3.14);
  });

  it('rejects NaN and non-numbers', () => {
    const n = number().build();
    expect(n.safeParse(NaN).success).toBe(false);
    expect(n.safeParse('42').success).toBe(false);
    expect(n.safeParse(null).success).toBe(false);
  });

  it('min', () => {
    const n = number().min(10).build();
    expect(n.parse(10)).toBe(10);
    expect(n.parse(11)).toBe(11);
    expect(() => n.parse(9)).toThrow();
  });

  it('max', () => {
    const n = number().max(100).build();
    expect(n.parse(100)).toBe(100);
    expect(() => n.parse(101)).toThrow();
  });

  it('integer', () => {
    const n = number().integer().build();
    expect(n.parse(5)).toBe(5);
    expect(() => n.parse(5.5)).toThrow();
  });

  it('positive', () => {
    const n = number().positive().build();
    expect(n.parse(1)).toBe(1);
    expect(() => n.parse(0)).toThrow();
    expect(() => n.parse(-1)).toThrow();
  });

  it('negative', () => {
    const n = number().negative().build();
    expect(n.parse(-1)).toBe(-1);
    expect(() => n.parse(0)).toThrow();
    expect(() => n.parse(1)).toThrow();
  });
});

// ==================== BOOLEAN ====================

describe('boolean()', () => {
  it('accepts true and false', () => {
    const b = boolean().build();
    expect(b.parse(true)).toBe(true);
    expect(b.parse(false)).toBe(false);
  });

  it('rejects non-booleans', () => {
    const b = boolean().build();
    expect(b.safeParse(1).success).toBe(false);
    expect(b.safeParse('true').success).toBe(false);
    expect(b.safeParse(null).success).toBe(false);
  });
});

// ==================== LITERAL ====================

describe('literal()', () => {
  it('accepts exact match', () => {
    expect(literal('hello').build().parse('hello')).toBe('hello');
    expect(literal(42).build().parse(42)).toBe(42);
    expect(literal(true).build().parse(true)).toBe(true);
  });

  it('rejects non-match', () => {
    expect(literal('hello').build().safeParse('world').success).toBe(false);
    expect(literal(42).build().safeParse(43).success).toBe(false);
    expect(literal(true).build().safeParse(false).success).toBe(false);
  });
});

// ==================== ARRAY ====================

describe('array()', () => {
  it('accepts valid arrays', () => {
    const a = array(number()).build();
    expect(a.parse([1, 2, 3])).toEqual([1, 2, 3]);
    expect(a.parse([])).toEqual([]);
  });

  it('rejects non-arrays', () => {
    const a = array(number()).build();
    expect(a.safeParse('not').success).toBe(false);
    expect(a.safeParse(42).success).toBe(false);
  });

  it('validates items', () => {
    const a = array(number()).build();
    const result = a.safeParse([1, 'two', 3]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error[0].path).toEqual([1]);
    }
  });

  it('min items', () => {
    const a = array(number()).min(2).build();
    expect(a.parse([1, 2])).toEqual([1, 2]);
    expect(() => a.parse([1])).toThrow();
  });

  it('max items', () => {
    const a = array(number()).max(2).build();
    expect(a.parse([1, 2])).toEqual([1, 2]);
    expect(() => a.parse([1, 2, 3])).toThrow();
  });
});

// ==================== OBJECT ====================

describe('object()', () => {
  const schema = object({
    name: string().min(1),
    age: number().min(0),
    email: string().email(),
  }).build();

  it('accepts valid objects', () => {
    const input = { name: 'Alice', age: 30, email: 'alice@example.com' };
    expect(schema.parse(input)).toEqual(input);
  });

  it('rejects non-objects', () => {
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse('string').success).toBe(false);
    expect(schema.safeParse([1, 2]).success).toBe(false);
  });

  it('reports errors with full paths', () => {
    const result = schema.safeParse({ name: '', age: -5, email: 'bad' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.map(e => e.path.join('.'));
      expect(paths).toContain('name');
      expect(paths).toContain('age');
      expect(paths).toContain('email');
    }
  });

  it('rejects unknown keys by default', () => {
    const result = schema.safeParse({ name: 'A', age: 1, email: 'a@b.com', extra: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.some(e => e.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('passthrough allows unknown keys', () => {
    const s = object({ name: string() }).passthrough().build();
    const result = s.safeParse({ name: 'A', extra: true });
    expect(result.success).toBe(true);
  });

  it('nested objects', () => {
    const s = object({
      user: object({
        name: string().min(1),
      }).build(),
    }).build();

    expect(s.parse({ user: { name: 'Alice' } })).toEqual({ user: { name: 'Alice' } });
    const result = s.safeParse({ user: { name: '' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error[0].path).toEqual(['user', 'name']);
    }
  });
});

// ==================== UNION ====================

describe('union()', () => {
  const s = union(string(), number()).build();

  it('accepts first member type', () => {
    expect(s.parse('hello')).toBe('hello');
  });

  it('accepts second member type', () => {
    expect(s.parse(42)).toBe(42);
  });

  it('rejects non-matching types', () => {
    expect(s.safeParse(true).success).toBe(false);
    expect(s.safeParse(null).success).toBe(false);
  });
});

// ==================== OPTIONAL / NULLABLE / DEFAULT ====================

describe('optional()', () => {
  it('accepts undefined', () => {
    const s = string().optional().build();
    expect(s.parse(undefined)).toBeUndefined();
  });

  it('still accepts valid values', () => {
    const s = string().optional().build();
    expect(s.parse('hello')).toBe('hello');
  });

  it('rejects invalid types', () => {
    const s = string().optional().build();
    expect(s.safeParse(123).success).toBe(false);
  });
});

describe('nullable()', () => {
  it('accepts null', () => {
    const s = string().nullable().build();
    expect(s.parse(null)).toBeNull();
  });

  it('still accepts valid values', () => {
    const s = string().nullable().build();
    expect(s.parse('hello')).toBe('hello');
  });
});

describe('default()', () => {
  it('uses default for undefined', () => {
    const s = string().default('fallback').build();
    expect(s.parse(undefined)).toBe('fallback');
  });

  it('does not use default for null', () => {
    const s = string().default('fallback').build();
    expect(s.safeParse(null).success).toBe(false);
  });
});

// ==================== REFINEMENT ====================

describe('refine()', () => {
  it('custom validation passes', () => {
    const s = string().refine(v => v.includes('@'), 'Must contain @').build();
    expect(s.parse('hello@world')).toBe('hello@world');
  });

  it('custom validation fails', () => {
    const s = string().refine(v => v.includes('@'), 'Must contain @').build();
    const result = s.safeParse('helloworld');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error[0].message).toBe('Must contain @');
      expect(result.error[0].code).toBe('custom');
    }
  });

  it('multiple refinements', () => {
    const s = number()
      .refine(v => v % 2 === 0, 'Must be even')
      .refine(v => v > 0, 'Must be positive')
      .build();

    expect(s.parse(4)).toBe(4);
    expect(() => s.parse(3)).toThrow();
    expect(() => s.parse(-2)).toThrow();
  });
});

// ==================== PARSE ERROR STRUCTURE ====================

describe('ValifyError', () => {
  it('includes formatted message', () => {
    const s = string().min(3).build();
    try {
      s.parse('ab');
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ValifyError);
      const err = e as ValifyError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.formatted).toContain('at least 3');
    }
  });

  it('nested object paths', () => {
    const s = object({
      a: object({
        b: object({
          c: number().positive().build(),
        }).build(),
      }).build(),
    }).build();

    const result = s.safeParse({ a: { b: { c: -1 } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error[0].path).toEqual(['a', 'b', 'c']);
    }
  });
});

// ==================== ASYNC PARSE ====================

describe('parseAsync()', () => {
  it('resolves for valid input', async () => {
    const s = string().min(1).build();
    const result = await s.parseAsync('hello');
    expect(result).toBe('hello');
  });

  it('throws for invalid input', async () => {
    const s = string().min(1).build();
    await expect(s.parseAsync('')).rejects.toThrow(ValifyError);
  });

  it('safeParseAsync returns result', async () => {
    const s = string().min(1).build();
    const ok = await s.safeParseAsync('hello');
    expect(ok.success).toBe(true);

    const fail = await s.safeParseAsync('');
    expect(fail.success).toBe(false);
  });

  it('works with async refinements', async () => {
    const s = string().refine(async (v) => {
      return new Promise(resolve => setTimeout(() => resolve(v.length > 0), 10));
    }, 'Must not be empty').build();

    const result = await s.parseAsync('hello');
    expect(result).toBe('hello');

    await expect(s.parseAsync('')).rejects.toThrow();
  });
});

// ==================== NAMESPACE IMPORT ====================

describe('valify namespace', () => {
  it('works via namespace', () => {
    const s = valify.string().min(1).build();
    expect(s.parse('hi')).toBe('hi');
  });
});

// ==================== COMPLEX INTEGRATION ====================

describe('complex integration', () => {
  const addressSchema = object({
    street: string().min(1),
    city: string().min(1),
    zip: string().regex(/^\d{5}$/).build(),
  }).build();

  const userSchema = object({
    id: string().uuid(),
    name: string().min(1).max(100),
    age: number().integer().positive().optional().build(),
    email: string().email(),
    active: boolean(),
    tags: array(string().min(1)).min(0).max(10).build(),
    role: union(literal('admin'), literal('user'), literal('moderator')).build(),
    address: addressSchema,
  }).build();

  it('accepts fully valid complex object', () => {
    const input = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Alice',
      age: 30,
      email: 'alice@example.com',
      active: true,
      tags: ['developer', 'admin'],
      role: 'admin' as const,
      address: { street: '123 Main St', city: 'Springfield', zip: '12345' },
    };
    expect(userSchema.parse(input)).toEqual(input);
  });

  it('rejects with correct nested paths', () => {
    const result = userSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Alice',
      email: 'alice@example.com',
      active: true,
      tags: [''],
      role: 'superadmin',
      address: { street: '', city: 'Springfield', zip: '12345' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.map(e => e.path.join('.'));
      expect(paths).toContain('tags.0');
      expect(paths).toContain('role');
      expect(paths).toContain('address.street');
    }
  });
});
