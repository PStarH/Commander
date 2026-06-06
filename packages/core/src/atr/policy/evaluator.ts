import type { PolicyExpr, PolicyInput, LiteralValue, BuiltinRegistry } from './types';

export function evaluateExpr(
  expr: PolicyExpr,
  input: PolicyInput,
  builtins: BuiltinRegistry,
  maxDepth: number,
): LiteralValue {
  if (maxDepth <= 0) {
    throw new Error('max_evaluation_depth_exceeded');
  }
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'ref': {
      const val = resolveRef(expr.path, input);
      return val;
    }
    case 'call': {
      const fn = builtins[expr.name];
      if (!fn) {
        throw new Error(`unknown_builtin: ${expr.name}`);
      }
      const args = expr.args.map((a) => evaluateExpr(a, input, builtins, maxDepth - 1));
      return fn(args);
    }
    case 'unary': {
      if (expr.op === 'not') {
        const v = evaluateExpr(expr.arg, input, builtins, maxDepth - 1);
        return !v;
      }
      throw new Error('unsupported_unary');
    }
    case 'binary': {
      const l = evaluateExpr(expr.left, input, builtins, maxDepth - 1);
      const r = evaluateExpr(expr.right, input, builtins, maxDepth - 1);
      return applyBinary(expr.op, l, r);
    }
    case 'list':
      return expr.items.map((i) => evaluateExpr(i, input, builtins, maxDepth - 1));
    case 'object': {
      const out: Record<string, LiteralValue> = {};
      for (const f of expr.fields) {
        out[f.key] = evaluateExpr(f.value, input, builtins, maxDepth - 1);
      }
      return out;
    }
  }
}

function resolveRef(path: string[], input: PolicyInput): LiteralValue {
  const startIdx = path[0] === 'input' ? 1 : 0;
  let cur: unknown = input as unknown;
  for (let i = startIdx; i < path.length; i++) {
    const seg = path[i];
    if (cur === null || cur === undefined) return null;
    if (typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === undefined) return null;
  if (cur === null) return null;
  if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return cur;
  if (Array.isArray(cur)) return cur as LiteralValue;
  if (typeof cur === 'object') return cur as LiteralValue;
  return null;
}

function applyBinary(op: string, l: LiteralValue, r: LiteralValue): LiteralValue {
  switch (op) {
    case '==':
      return deepEqual(l, r);
    case '!=':
      return !deepEqual(l, r);
    case '>':
      return numericCompare(l, r) > 0;
    case '<':
      return numericCompare(l, r) < 0;
    case '>=':
      return numericCompare(l, r) >= 0;
    case '<=':
      return numericCompare(l, r) <= 0;
    case 'in':
      return containsValue(r, l);
    case 'and':
      return Boolean(l) && Boolean(r);
    case 'or':
      return Boolean(l) || Boolean(r);
    default:
      throw new Error(`unsupported_binary: ${op}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (!deepEqual((a as Record<string, unknown>)[ak[i]], (b as Record<string, unknown>)[bk[i]])) return false;
    }
    return true;
  }
  return false;
}

function numericCompare(a: LiteralValue, b: LiteralValue): number {
  const an = typeof a === 'number' ? a : Number(a);
  const bn = typeof b === 'number' ? b : Number(b);
  if (Number.isNaN(an) || Number.isNaN(bn)) return 0;
  return an - bn;
}

function containsValue(haystack: LiteralValue, needle: LiteralValue): boolean {
  if (Array.isArray(haystack)) {
    return haystack.some((h) => deepEqual(h, needle));
  }
  if (typeof haystack === 'string' && typeof needle === 'string') {
    return haystack.includes(needle);
  }
  return false;
}
