import type {
  PolicyPackAst,
  PolicyRuleAst,
  PolicyExpr,
  PolicyBinOp,
  LiteralValue,
  ConflictReport,
} from './types';
import { analyzeConflicts } from './conflictAnalyzer';

export interface ParseResult {
  pack: PolicyPackAst;
  conflicts: ConflictReport[];
  errors: string[];
}

const KEYWORDS = new Set([
  'package',
  'import',
  'default',
  'true',
  'false',
  'null',
  'not',
  'and',
  'or',
  'in',
  'if',
]);

const EFFECT_KEYWORDS = new Set(['allow', 'deny', 'require_approval', 'deny_class']);

type Token =
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'bool'; value: boolean; pos: number }
  | { kind: 'punc'; value: string; pos: number }
  | { kind: 'eof'; pos: number };

function tokValue(t: Token): string | number | boolean | null {
  if (t.kind === 'eof') return null;
  return t.value;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const pos = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '=' && src[i + 1] === '=') {
      out.push({ kind: 'punc', value: '==', pos });
      i += 2;
      continue;
    }
    if (c === '!' && src[i + 1] === '=') {
      out.push({ kind: 'punc', value: '!=', pos });
      i += 2;
      continue;
    }
    if (c === '>' || c === '<') {
      if (src[i + 1] === '=') {
        out.push({ kind: 'punc', value: c + '=', pos });
        i += 2;
        continue;
      }
      out.push({ kind: 'punc', value: c, pos });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const next = src[j + 1];
          s += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error(`unterminated_string at ${pos}`);
      out.push({ kind: 'string', value: s, pos });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (c === '-') j++;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      const numStr = src.slice(i, j);
      const n = Number(numStr);
      if (Number.isNaN(n)) throw new Error(`invalid_number at ${pos}: ${numStr}`);
      out.push({ kind: 'number', value: n, pos });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const ident = src.slice(i, j);
      if (ident === 'true') out.push({ kind: 'bool', value: true, pos });
      else if (ident === 'false') out.push({ kind: 'bool', value: false, pos });
      else if (ident === 'null') out.push({ kind: 'ident', value: 'null', pos });
      else if (KEYWORDS.has(ident)) out.push({ kind: 'punc', value: ident, pos });
      else if (EFFECT_KEYWORDS.has(ident)) out.push({ kind: 'ident', value: ident, pos });
      else out.push({ kind: 'ident', value: ident, pos });
      i = j;
      continue;
    }
    if ('(){}[],.:=+-*/'.includes(c)) {
      out.push({ kind: 'punc', value: c, pos });
      i++;
      continue;
    }
    throw new Error(`unexpected_char at ${pos}: ${JSON.stringify(c)}`);
  }
  out.push({ kind: 'eof', pos: src.length });
  return out;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly errors: string[],
  ) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private advance(): Token {
    return this.tokens[this.pos++];
  }
  private match(kind: string, value?: string): boolean {
    const t = this.peek();
    if (t.kind !== kind) return false;
    if (value !== undefined && tokValue(t) !== value) return false;
    return true;
  }
  private expect(kind: string, value?: string): Token {
    const t = this.peek();
    if (t.kind !== kind || (value !== undefined && tokValue(t) !== value)) {
      this.errors.push(
        `parse_error at ${t.pos}: expected ${kind}${value ? `(${value})` : ''}, got ${t.kind}${value ? `(${tokValue(t)})` : ''}`,
      );
      throw new Error('parse_error');
    }
    return this.advance();
  }

  parse(): {
    rules: PolicyRuleAst[];
    defaults: { allow: boolean; require_approval: boolean };
    packageName: string;
  } {
    let packageName = 'atr.policy';
    const rules: PolicyRuleAst[] = [];
    const defaults = { allow: false, require_approval: false };

    while (!this.match('eof')) {
      const t = this.peek();
      if (t.kind === 'punc' && t.value === 'package') {
        this.advance();
        const parts: string[] = [];
        parts.push(String(tokValue(this.expect('ident')) ?? ''));
        while (this.match('punc', '.')) {
          this.advance();
          parts.push(String(tokValue(this.expect('ident')) ?? ''));
        }
        packageName = parts.join('.');
        continue;
      }
      if (t.kind === 'punc' && t.value === 'import') {
        this.advance();
        while (true) {
          const cur = this.peek();
          if (cur.kind === 'eof') break;
          if (cur.kind === 'punc' && (cur.value === 'package' || cur.value === 'default')) break;
          if (cur.kind === 'ident') {
            const next = this.tokens[this.pos + 1];
            if (next && next.kind === 'punc' && next.value === '{') break;
            if (next && next.kind === 'punc' && next.value === '=') break;
          }
          this.advance();
        }
        continue;
      }
      if (t.kind === 'punc' && t.value === 'default') {
        this.advance();
        const effTok = this.advance();
        const effVal = effTok.kind === 'eof' ? null : effTok.value;
        this.expect('punc', '=');
        const valTok = this.advance();
        const truthy =
          valTok.kind === 'bool' ? valTok.value : valTok.kind === 'punc' && valTok.value === 'true';
        if (effVal === 'allow') defaults.allow = Boolean(truthy);
        else if (effVal === 'require_approval') defaults.require_approval = Boolean(truthy);
        continue;
      }
      if (t.kind === 'ident') {
        const rule = this.parseRule();
        if (rule) rules.push(rule);
        continue;
      }
      this.advance();
    }
    return { rules, defaults, packageName };
  }

  private parseRule(): PolicyRuleAst | null {
    const nameTok = this.advance();
    const name = String(tokValue(nameTok) ?? '');

    let effect: PolicyRuleAst['effect'] | null = null;
    let denyClass: string | undefined;
    if (this.match('punc', '=')) {
      this.advance();
      const effTok = this.advance();
      if (name === 'deny_class') {
        effect = 'deny_class';
        denyClass =
          effTok.kind === 'string'
            ? effTok.value
            : effTok.kind === 'eof'
              ? ''
              : String(tokValue(effTok) ?? '');
      } else {
        const val = effTok.kind === 'eof' ? null : String(tokValue(effTok) ?? '');
        if (
          val === 'allow' ||
          val === 'deny' ||
          val === 'require_approval' ||
          val === 'deny_class'
        ) {
          effect = val;
        } else {
          this.errors.push(`unknown_effect at ${effTok.pos}: ${val}`);
          return null;
        }
      }
    } else if (name === 'deny_class') {
      effect = 'deny_class';
      const dcTok = this.peek();
      if (dcTok.kind === 'ident') {
        denyClass = String(tokValue(this.advance()) ?? '');
      } else if (dcTok.kind === 'string') {
        denyClass = String(tokValue(this.advance()) ?? '');
      } else {
        denyClass = 'deny_custom';
      }
    }

    this.expect('punc', '{');
    let body = this.parseExpr();
    while (!this.match('punc', '}') && !this.match('eof')) {
      const next = this.parseExpr();
      body = { kind: 'binary', op: 'and', left: body, right: next };
    }
    this.expect('punc', '}');

    if (this.match('punc', 'if')) {
      this.advance();
      this.expect('punc', '{');
      const _cond = this.parseExpr();
      this.expect('punc', '}');
    }

    if (effect === null) {
      if (name === 'allow' || name === 'deny' || name === 'require_approval') {
        effect = name;
      } else {
        effect = 'allow';
      }
    }

    return {
      id: `rule_${name}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      effect,
      denyClass: denyClass as PolicyRuleAst['denyClass'],
      body,
      priority: 50,
    };
  }

  private parseExpr(): PolicyExpr {
    return this.parseOr();
  }

  private parseOr(): PolicyExpr {
    let left = this.parseAnd();
    while (this.match('punc', 'or')) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): PolicyExpr {
    let left = this.parseNot();
    while (this.match('punc', 'and')) {
      this.advance();
      const right = this.parseNot();
      left = { kind: 'binary', op: 'and', left, right };
    }
    return left;
  }

  private parseNot(): PolicyExpr {
    if (this.match('punc', 'not')) {
      this.advance();
      return { kind: 'unary', op: 'not', arg: this.parseNot() };
    }
    return this.parseCmp();
  }

  private parseCmp(): PolicyExpr {
    let left = this.parseAdd();
    const ops: PolicyBinOp[] = ['==', '!=', '>', '<', '>=', '<=', 'in'];
    while (true) {
      const t = this.peek();
      if (t.kind === 'punc' && ops.includes(t.value as PolicyBinOp)) {
        this.advance();
        const right = this.parseAdd();
        left = { kind: 'binary', op: t.value as PolicyBinOp, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAdd(): PolicyExpr {
    return this.parsePostfix();
  }

  private parsePostfix(): PolicyExpr {
    let expr = this.parsePrimary();
    while (this.match('punc', '.')) {
      this.advance();
      const seg = String(tokValue(this.expect('ident')) ?? '');
      if (expr.kind === 'ref') {
        expr = { kind: 'ref', path: [...expr.path, seg] };
      } else {
        expr = { kind: 'ref', path: [(expr as unknown as { value: string }).value ?? '', seg] };
      }
    }
    return expr;
  }

  private parsePrimary(): PolicyExpr {
    const t = this.peek();
    if (t.kind === 'punc' && t.value === '(') {
      this.advance();
      const e = this.parseExpr();
      this.expect('punc', ')');
      return e;
    }
    if (t.kind === 'punc' && t.value === '[') {
      this.advance();
      const items: PolicyExpr[] = [];
      while (!this.match('punc', ']') && !this.match('eof')) {
        items.push(this.parseExpr());
        if (this.match('punc', ',')) this.advance();
      }
      this.expect('punc', ']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punc' && t.value === '{') {
      this.advance();
      const fields: { key: string; value: PolicyExpr }[] = [];
      while (!this.match('punc', '}') && !this.match('eof')) {
        const keyTok = this.advance();
        const key =
          keyTok.kind === 'string'
            ? keyTok.value
            : keyTok.kind === 'eof'
              ? ''
              : String(tokValue(keyTok) ?? '');
        this.expect('punc', ':');
        const value = this.parseExpr();
        fields.push({ key, value });
        if (this.match('punc', ',')) this.advance();
      }
      this.expect('punc', '}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') {
      this.advance();
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'number') {
      this.advance();
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'bool') {
      this.advance();
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'ident') {
      this.advance();
      if (t.value === 'null') return { kind: 'literal', value: null };
      if (this.match('punc', '(')) {
        this.advance();
        const args: PolicyExpr[] = [];
        while (!this.match('punc', ')') && !this.match('eof')) {
          args.push(this.parseExpr());
          if (this.match('punc', ',')) this.advance();
        }
        this.expect('punc', ')');
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'ref', path: [t.value] };
    }
    this.errors.push(`unexpected_token at ${t.pos}: ${(t as { value?: string }).value ?? t.kind}`);
    throw new Error('parse_error');
  }
}

export function parsePolicyPack(source: string, name: string, version: number): ParseResult {
  const tokens = tokenize(source);
  const errors: string[] = [];
  const parser = new Parser(tokens, errors);
  const parsed = parser.parse();
  const pack: PolicyPackAst = {
    name,
    version,
    rules: parsed.rules,
    defaults: parsed.defaults,
    raw: source,
    parsedAt: Date.now(),
  };
  const conflicts = analyzeConflicts(pack);
  return { pack, conflicts, errors };
}

export function denyClassFromString(s: string): LiteralValue {
  return s;
}
