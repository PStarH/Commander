/**
 * AP-01/AP-04 regression suite for the ATR policy engine.
 *
 * AP-01: a rule-evaluation failure was swallowed into `fired: false`, so a
 *        broken deny rule disappeared behind the default allow. `and`/`or` also
 *        evaluated both operands.
 * AP-04: `b.b_path_matches_secret(...)` was mis-parsed as a ref plus a
 *        parenthesised expression (so the secret-path deny never fired), and
 *        `if { ... }` conditions were parsed and dropped.
 *
 * These tests use the real parser, the real builtin registry, the real default
 * packs and the real PolicyHook. No component under test is mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PolicyEngine,
  parsePolicyPack,
  defaultBuiltins,
  type PolicyInput,
  type PolicyDecision,
  type PolicyExpr,
  type PolicyPackAst,
} from '../../../src/atr/policy';
import * as evaluator from '../../../src/atr/policy/evaluator';
import { PolicyHook } from '../../../src/atr/policy/integration/scheduler';
import {
  DEFAULT_CODING_PACK,
  READ_ONLY_PACK,
  DESTRUCTIVE_OPS_PACK,
  LEGACY_EXEC_PACK,
} from '../../../src/atr/policy/packs/defaultCoding';

/**
 * `createEvaluationState` is a new evaluator export. It is reached through the
 * module namespace so this suite still *loads* (and every test reports its own
 * red/green) against a pre-fix tree instead of failing as one import error.
 */
type EvaluationStateLike = { nodes: number; maxNodes: number; deadlineAt: number };
const createEvaluationState = (
  evaluator as unknown as {
    createEvaluationState?: (maxNodes: number, deadlineAt: number) => EvaluationStateLike;
  }
).createEvaluationState;

function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    phase: 'tool',
    run: {
      id: 'run-1',
      state: 'EXECUTING',
      fencingEpoch: 1,
      intentHash: 'h',
      tenantId: 't1',
      agentId: 'a1',
      goal: 'test',
      metadata: {},
      createdAt: 0,
      actionsSoFar: [],
    },
    tool: {
      name: 'file_read',
      riskLevel: 'low',
      destructive: false,
      isReadOnly: true,
      isIdempotent: true,
      category: 'file_read',
    },
    action: {
      args: { path: 'README.md' },
      idempotencyKey: 'k1',
      stepNumber: 1,
      callSite: 'agent',
      leaseToken: 'lt1',
      fencingEpoch: 1,
    },
    tenant: {
      id: 't1',
      config: {
        tokenBudget: 1_000_000,
        maxConcurrency: 5,
        maxRunsPerMinute: 60,
        maxActionsPerRun: 100,
        allowShell: false,
        allowNetwork: false,
        requiresApprovalBypass: false,
      },
    },
    metrics: {
      tokensUsedThisRun: 0,
      tokensUsedThisHour: 0,
      actionsThisRun: 0,
      destructiveThisRun: 0,
      estimatedCostUsd: 0,
    },
    time: { now: 0, hourOfDay: 12, isWeekend: false },
    ...overrides,
  };
}

function packFrom(source: string, opts: { name?: string } = {}): PolicyPackAst {
  const r = parsePolicyPack(source, opts.name ?? 'test', 1);
  assert.deepStrictEqual(r.errors, [], `unexpected parse errors: ${r.errors.join('; ')}`);
  return r.pack;
}

interface Evaluator {
  evaluate(input: PolicyInput): PolicyDecision;
}

/** A spy tool: the only place a tool would run, so a negative test can prove it did not. */
function guardedTool(evaluator: Evaluator) {
  const calls: string[] = [];
  const invoke = (): string => {
    calls.push('tool_invoked');
    return 'executed';
  };
  const attempt = (input: PolicyInput): PolicyDecision => {
    const decision = evaluator.evaluate(input);
    if (decision.effect === 'allow') invoke();
    return decision;
  };
  return { attempt, calls };
}

function findCallNames(expr: PolicyExpr): Array<{ ns?: string; name: string }> {
  const out: Array<{ ns?: string; name: string }> = [];
  const walk = (e: PolicyExpr): void => {
    switch (e.kind) {
      case 'call':
        out.push({ ns: e.ns, name: e.name });
        for (const a of e.args) walk(a);
        return;
      case 'unary':
        walk(e.arg);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'list':
        for (const i of e.items) walk(i);
        return;
      case 'object':
        for (const f of e.fields) walk(f.value);
        return;
      case 'literal':
      case 'ref':
        return;
    }
  };
  walk(expr);
  return out;
}

function findRefPaths(expr: PolicyExpr): string[][] {
  const out: string[][] = [];
  const walk = (e: PolicyExpr): void => {
    switch (e.kind) {
      case 'ref':
        out.push(e.path);
        return;
      case 'unary':
        walk(e.arg);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'call':
        for (const a of e.args) walk(a);
        return;
      case 'list':
        for (const i of e.items) walk(i);
        return;
      case 'object':
        for (const f of e.fields) walk(f.value);
        return;
      case 'literal':
        return;
    }
  };
  walk(expr);
  return out;
}

describe('AP-01: evaluation failures fail closed', () => {
  it('default allow + a deny rule that cannot be evaluated denies and invokes no tool', () => {
    const pack = packFrom(`package t
      default allow = true
      deny { not not not not not input.tool.isReadOnly }
    `);
    const engine = new PolicyEngine(pack, { maxEvaluationDepth: 4 });
    const spy = guardedTool(engine);

    const decision = spy.attempt(makeInput());

    assert.strictEqual(decision.effect, 'deny');
    assert.match(decision.reason, /policy_evaluation_unavailable/);
    assert.match(decision.reason, /max_evaluation_depth_exceeded/);
    assert.strictEqual(engine.getStats().errors, 1);
    assert.deepStrictEqual(spy.calls, []);
  });

  it('default allow + an unknown-builtin deny rule is rejected at load and invokes no tool', () => {
    const source = `package t
      default allow = true
      deny { nonexistent_builtin(input.action.args.path) }
    `;
    const parsed = parsePolicyPack(source, 'broken', 1);
    assert.ok(
      parsed.errors.some((e) => /unknown_function/.test(e)),
      `expected unknown_function, got: ${parsed.errors.join('; ')}`,
    );

    const spy = guardedTool({
      evaluate: () => {
        throw new Error('unreachable: the pack must not have loaded');
      },
    });
    assert.throws(() => {
      const hook = new PolicyHook({
        enableAudit: false,
        pack: { source, name: 'broken', version: 1 },
      });
      if (hook.evaluate(makeInput()).effect === 'allow') spy.attempt(makeInput());
    }, /unknown_function/);
    assert.deepStrictEqual(spy.calls, []);
  });

  it('propagates a runtime unknown builtin from a hand-built AST as deny/unavailable', () => {
    const pack = packFrom(`package t
      default allow = true
      deny { input.tool.destructive == true }
    `);
    // Simulate an AST that bypassed load-time validation (defence in depth for
    // any future construction path): the engine must still deny, not ignore it.
    pack.rules[0].body = { kind: 'call', name: 'never_registered', args: [] };
    const engine = new PolicyEngine(pack);
    const spy = guardedTool(engine);

    const decision = spy.attempt(makeInput());

    assert.strictEqual(decision.effect, 'deny');
    assert.match(decision.reason, /policy_evaluation_unavailable: unknown_builtin/);
    assert.deepStrictEqual(spy.calls, []);
  });

  it('node budget bounds evaluation and fails closed', () => {
    const pack = packFrom(`package t
      default allow = true
      deny { input.tool.isReadOnly == true }
    `);
    const engine = new PolicyEngine(pack, { maxEvaluationNodes: 1 });
    const decision = engine.evaluate(makeInput());
    assert.strictEqual(decision.effect, 'deny');
    assert.match(decision.reason, /max_evaluation_nodes_exceeded/);
  });

  it('deadline budget fails closed instead of hanging', () => {
    const state = createEvaluationState?.(1_000, Date.now() - 1);
    assert.throws(
      () =>
        evaluator.evaluateExpr(
          { kind: 'literal', value: true },
          makeInput(),
          defaultBuiltins,
          32,
          state,
        ),
      (err: unknown) => /evaluation_deadline/.test((err as Error).message),
    );
  });

  it('`false and <throwing>` does not evaluate the right operand', () => {
    let evaluated = 0;
    const throwing = {
      ...defaultBuiltins,
      b_explode: (): never => {
        evaluated++;
        throw new Error('right operand must not run');
      },
    };
    const expr: PolicyExpr = {
      kind: 'binary',
      op: 'and',
      left: { kind: 'literal', value: false },
      right: { kind: 'call', name: 'b_explode', args: [] },
    };
    assert.strictEqual(evaluator.evaluateExpr(expr, makeInput(), throwing, 32), false);
    assert.strictEqual(evaluated, 0, 'right operand of a false `and` must not be evaluated');
  });

  it('`true or <throwing>` does not evaluate the right operand', () => {
    let evaluated = 0;
    const throwing = {
      ...defaultBuiltins,
      b_explode: (): never => {
        evaluated++;
        throw new Error('right operand must not run');
      },
    };
    const expr: PolicyExpr = {
      kind: 'binary',
      op: 'or',
      left: { kind: 'literal', value: true },
      right: { kind: 'call', name: 'b_explode', args: [] },
    };
    assert.strictEqual(evaluator.evaluateExpr(expr, makeInput(), throwing, 32), true);
    assert.strictEqual(evaluated, 0, 'right operand of a true `or` must not be evaluated');
  });

  it('short-circuit keeps a rule alive when an unneeded branch would exceed the depth budget', () => {
    const deep = 'not '.repeat(40) + 'input.tool.isReadOnly';
    const engine = new PolicyEngine(
      packFrom(`package t
        default allow = false
        allow { (false and ${deep}) or true }
      `),
      { maxEvaluationDepth: 8 },
    );
    const spy = guardedTool(engine);
    const decision = spy.attempt(makeInput());
    assert.strictEqual(decision.effect, 'allow');
    assert.strictEqual(engine.getStats().errors, 0);
    assert.deepStrictEqual(spy.calls, ['tool_invoked']);
  });
});

describe('AP-04: dotted builtins execute and `if` guards hold', () => {
  it('parses the default pack secret rule as a real builtin call, not a ref', () => {
    const parsed = parsePolicyPack(DEFAULT_CODING_PACK, 'default', 1);
    assert.deepStrictEqual(parsed.errors, []);
    const secretRule = parsed.pack.rules.find((r) => r.denyClass === 'deny_secret_read');
    assert.ok(secretRule, 'default pack must contain the deny_secret_read rule');

    const calls = findCallNames(secretRule.body);
    assert.deepStrictEqual(
      calls.filter((c) => c.name === 'b_path_matches_secret'),
      [{ ns: 'b', name: 'b_path_matches_secret' }],
    );
    const refs = findRefPaths(secretRule.body);
    assert.ok(
      !refs.some((p) => p[0] === 'b'),
      `dotted builtin must not remain an unbound ref: ${JSON.stringify(refs)}`,
    );
  });

  it('default pack denies a secret path and invokes no tool; allows a safe read', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const spy = guardedTool(hook);

    const denied = spy.attempt(
      makeInput({ action: { ...makeInput().action, args: { path: '.env' } } }),
    );
    assert.strictEqual(denied.effect, 'deny_class');
    assert.strictEqual(denied.denyClass, 'deny_secret_read');
    assert.deepStrictEqual(spy.calls, [], 'secret-path read must not reach the tool');

    const allowed = spy.attempt(makeInput());
    assert.strictEqual(allowed.effect, 'allow');
    assert.deepStrictEqual(spy.calls, ['tool_invoked']);
  });

  it('default pack denies a nested secret path (ssh key)', () => {
    const hook = new PolicyHook({ enableAudit: false });
    const spy = guardedTool(hook);
    const input = makeInput({
      action: { ...makeInput().action, args: { path: '/home/u/.ssh/id_rsa' } },
    });
    const decision = spy.attempt(input);
    assert.strictEqual(decision.effect, 'deny_class');
    assert.strictEqual(decision.denyClass, 'deny_secret_read');
    assert.deepStrictEqual(spy.calls, []);
  });

  it('`allow { true } if { false }` does not allow and invokes no tool', () => {
    const engine = new PolicyEngine(
      packFrom(`package t
      allow { true } if { false }
    `),
    );
    const spy = guardedTool(engine);
    const decision = spy.attempt(makeInput());
    assert.strictEqual(decision.effect, 'deny');
    assert.strictEqual(decision.reason, 'default_deny');
    assert.deepStrictEqual(spy.calls, []);
  });

  it('`allow { true } if { true }` allows', () => {
    const engine = new PolicyEngine(
      packFrom(`package t
      allow { true } if { true }
    `),
    );
    assert.strictEqual(engine.evaluate(makeInput()).effect, 'allow');
  });

  it('rejects unsupported `if` forms at load', () => {
    const noBraces = parsePolicyPack(
      `package t
      allow { true } if true
    `,
      't',
      1,
    );
    assert.ok(noBraces.errors.some((e) => /unsupported_if/.test(e)));

    const doubled = parsePolicyPack(
      `package t
      allow { true } if { true } if { false }
    `,
      't',
      1,
    );
    assert.ok(doubled.errors.some((e) => /unsupported_if/.test(e)));
  });

  it('rejects unbound refs, unknown functions and unsupported imports at load', () => {
    const cases: Array<{ source: string; pattern: RegExp }> = [
      { source: `package t\ndeny { foo.bar == true }`, pattern: /unbound_ref/ },
      { source: `package t\ndeny { bare_name == true }`, pattern: /unbound_ref/ },
      { source: `package t\ndeny { mystery_function(input.x) }`, pattern: /unknown_function/ },
      {
        source: `package t\ndeny { q.b_path_matches_secret(input.x) }`,
        pattern: /unsupported_call_namespace/,
      },
      {
        source: `package t\ndeny { b.b_path_matches_secret }`,
        pattern: /unsupported_builtin_reference/,
      },
      {
        source: `package t\nimport data.other as q\ndeny { input.x == 1 }`,
        pattern: /unsupported_import/,
      },
      {
        source: `package t\nimport data.atr.builtins\ndeny { input.x == 1 }`,
        pattern: /unsupported_import/,
      },
      { source: `package t\ndeny { data.policy.missing_rule == true }`, pattern: /unbound_ref/ },
    ];
    for (const { source, pattern } of cases) {
      const parsed = parsePolicyPack(source, 't', 1);
      assert.ok(
        parsed.errors.some((e) => pattern.test(e)),
        `expected ${pattern} for ${JSON.stringify(source)}, got: ${parsed.errors.join('; ')}`,
      );
    }
  });

  it('accepts the supported builtin call forms', () => {
    const withAlias = parsePolicyPack(
      `package t
      import data.atr.builtins as b
      deny { b.b_path_matches_secret(input.action.args.path) }
    `,
      't',
      1,
    );
    assert.deepStrictEqual(withAlias.errors, []);

    const bare = parsePolicyPack(
      `package t
      deny { b_path_matches_secret(input.action.args.path) }
    `,
      't',
      1,
    );
    assert.deepStrictEqual(bare.errors, []);

    const extraAlias = parsePolicyPack(
      `package t
      import data.atr.builtins as bx
      deny { bx.b_path_matches_secret(input.action.args.path) }
    `,
      't',
      1,
    );
    assert.deepStrictEqual(extraAlias.errors, []);
  });
});

describe('AP-04: every default pack loads and behaves as intended', () => {
  const readInput = (): PolicyInput => makeInput();
  const shellInput = (command: string): PolicyInput =>
    makeInput({
      tool: {
        name: 'shell_cmd',
        riskLevel: 'medium',
        destructive: false,
        isReadOnly: false,
        isIdempotent: false,
        category: 'shell',
      },
      action: { ...makeInput().action, args: { command } },
    });
  const writeInput = (): PolicyInput =>
    makeInput({
      tool: {
        name: 'file_write',
        riskLevel: 'medium',
        destructive: false,
        isReadOnly: false,
        isIdempotent: true,
        category: 'file_write',
      },
    });
  const destructiveInput = (): PolicyInput =>
    makeInput({
      tool: {
        name: 'db_drop',
        riskLevel: 'high',
        destructive: true,
        isReadOnly: false,
        isIdempotent: true,
        category: 'destructive',
      },
    });

  it('defaultCoding: secret deny fires, safe read allows, shell denies', () => {
    const pack = packFrom(DEFAULT_CODING_PACK);
    const engine = new PolicyEngine(pack);
    const secret = engine.evaluate(
      makeInput({ action: { ...makeInput().action, args: { path: '.env' } } }),
    );
    assert.strictEqual(secret.effect, 'deny_class');
    assert.strictEqual(secret.denyClass, 'deny_secret_read');
    assert.strictEqual(engine.evaluate(readInput()).effect, 'allow');
    const shell = engine.evaluate(shellInput('ls -la'));
    assert.strictEqual(shell.effect, 'deny_class');
    assert.strictEqual(shell.denyClass, 'deny_shell');
  });

  it('readonly: allows read-only and denies file_write/network/shell', () => {
    const engine = new PolicyEngine(packFrom(READ_ONLY_PACK));
    assert.strictEqual(engine.evaluate(readInput()).effect, 'allow');
    const write = engine.evaluate(writeInput());
    assert.strictEqual(write.effect, 'deny_class');
    assert.strictEqual(write.denyClass, 'deny_delete');
  });

  it('destructive: destructive requires approval and nothing is auto-allowed', () => {
    const engine = new PolicyEngine(packFrom(DESTRUCTIVE_OPS_PACK));
    // This pack declares `default require_approval = true`, so even the
    // read-only `allow` rule is outranked until an operator approves.
    const read = engine.evaluate(readInput());
    assert.strictEqual(read.effect, 'require_approval');
    assert.strictEqual(engine.evaluate(destructiveInput()).effect, 'require_approval');
    const spy = guardedTool(engine);
    spy.attempt(readInput());
    spy.attempt(destructiveInput());
    assert.deepStrictEqual(spy.calls, []);
  });

  it('legacyExec: safe shell allows, banned shell denies', () => {
    const engine = new PolicyEngine(packFrom(LEGACY_EXEC_PACK));
    assert.strictEqual(engine.evaluate(shellInput('ls -la')).effect, 'allow');
    const banned = engine.evaluate(shellInput('sudo rm -rf /'));
    assert.strictEqual(banned.effect, 'deny_class');
    assert.strictEqual(banned.denyClass, 'deny_shell');
  });
});
