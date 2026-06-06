import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parsePolicyPack, detectCycles, analyzeConflicts } from '../../../src/atr/policy';

describe('Loader', () => {
  it('parses a simple allow rule', () => {
    const r = parsePolicyPack(`package t
      allow { input.tool.isReadOnly == true }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.rules.length, 1);
    assert.strictEqual(r.pack.rules[0].name, 'allow');
    assert.strictEqual(r.pack.rules[0].effect, 'allow');
  });

  it('parses deny_class with explicit class', () => {
    const r = parsePolicyPack(`package t
      deny_class = "deny_shell" { input.tool.category == "shell" }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.rules[0].effect, 'deny_class');
    assert.strictEqual(r.pack.rules[0].denyClass, 'deny_shell');
  });

  it('parses deny rule with comparison', () => {
    const r = parsePolicyPack(`package t
      deny { input.metrics.tokensUsedThisRun > 1000 }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.rules[0].effect, 'deny');
  });

  it('parses require_approval rule', () => {
    const r = parsePolicyPack(`package t
      require_approval { input.tool.destructive == true }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.rules[0].effect, 'require_approval');
  });

  it('parses default declarations', () => {
    const r = parsePolicyPack(`package t
      default allow = true
      default require_approval = false
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.defaults.allow, true);
    assert.strictEqual(r.pack.defaults.require_approval, false);
  });

  it('parses not/and/or', () => {
    const r = parsePolicyPack(`package t
      deny {
        not input.tool.isReadOnly
        input.tool.destructive == true
      }
      allow { input.tool.isReadOnly == true or input.tool.isIdempotent == true }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.rules.length, 2);
  });

  it('parses builtin calls', () => {
    const r = parsePolicyPack(`package t
      deny { b.b_path_matches_secret(input.action.args.path) }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.rules.length, 1);
  });

  it('parses list literals', () => {
    const r = parsePolicyPack(`package t
      deny { input.tool.name in ["a", "b", "c"] }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
  });

  it('handles comments', () => {
    const r = parsePolicyPack(`# comment line
      package t
      // also a comment
      allow { true }
    `, 'test', 1);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.pack.rules.length, 1);
  });
});

describe('Cycle detection', () => {
  it('detects no cycle in linear pack', () => {
    const r = parsePolicyPack(`package t
      a { input.x == 1 }
      b { input.y == 2 }
    `, 't', 1);
    const c = detectCycles(r.pack);
    assert.strictEqual(c.cycles.size, 0);
  });

  it('detects cycle when rules reference each other via data.policy', () => {
    const r = parsePolicyPack(`package t
      a { data.policy.b }
      b { data.policy.a }
    `, 't', 1);
    const c = detectCycles(r.pack);
    assert.ok(c.cycles.size > 0);
  });
});

describe('Conflict analyzer', () => {
  it('reports warning when allow and deny share literals', () => {
    const r = parsePolicyPack(`package t
      default allow = false
      allow { input.tool.destructive == true }
      deny { input.tool.destructive == true }
    `, 't', 1);
    const reports = analyzeConflicts(r.pack);
    assert.ok(reports.length > 0);
  });
});
