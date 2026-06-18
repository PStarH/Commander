import type { PolicyPackAst, PolicyRuleAst, ConflictReport } from './types';

export interface CycleResult {
  cycles: Set<string>;
  edges: Map<string, Set<string>>;
}

export function detectCycles(pack: PolicyPackAst): CycleResult {
  const ruleNames = new Set(pack.rules.map((r) => r.name));
  const edges = new Map<string, Set<string>>();
  for (const rule of pack.rules) edges.set(rule.name, new Set());
  for (const rule of pack.rules) {
    const refs = collectRuleRefs(rule);
    for (const ref of refs) {
      if (ref === rule.name) continue;
      if (!ruleNames.has(ref)) continue;
      edges.get(rule.name)!.add(ref);
    }
  }

  const cycles = new Set<string>();
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const name of ruleNames) color.set(name, WHITE);
  const stackPath: string[] = [];

  function dfs(node: string): void {
    color.set(node, GRAY);
    stackPath.push(node);
    for (const next of edges.get(node) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        const idx = stackPath.indexOf(next);
        if (idx >= 0) {
          for (let i = idx; i < stackPath.length; i++) cycles.add(stackPath[i]);
        }
      } else if (c === WHITE) {
        dfs(next);
      }
    }
    stackPath.pop();
    color.set(node, BLACK);
  }

  for (const name of ruleNames) {
    if (color.get(name) === WHITE) dfs(name);
  }

  return { cycles, edges };
}

function collectRuleRefs(rule: PolicyRuleAst): string[] {
  const refs: string[] = [];
  walk(rule.body, (e) => {
    if (e.kind === 'ref' && e.path.length >= 2 && e.path[0] === 'data' && e.path[1] === 'policy') {
      refs.push(e.path[2]);
    }
  });
  return refs;
}

function walk(
  expr: import('./types').PolicyExpr,
  visit: (e: import('./types').PolicyExpr) => void,
): void {
  visit(expr);
  switch (expr.kind) {
    case 'unary':
      walk(expr.arg, visit);
      break;
    case 'binary':
      walk(expr.left, visit);
      walk(expr.right, visit);
      break;
    case 'call':
      for (const a of expr.args) walk(a, visit);
      break;
    case 'list':
      for (const i of expr.items) walk(i, visit);
      break;
    case 'object':
      for (const f of expr.fields) walk(f.value, visit);
      break;
    case 'literal':
    case 'ref':
      break;
  }
}

export function analyzeConflicts(pack: PolicyPackAst): ConflictReport[] {
  const reports: ConflictReport[] = [];
  const cycleResult = detectCycles(pack);
  for (const ruleName of cycleResult.cycles) {
    reports.push({
      severity: 'critical',
      ruleA: ruleName,
      ruleB: ruleName,
      reason: `cycle detected: rule ${ruleName} is part of a circular dependency`,
    });
  }
  const allows = pack.rules.filter((r) => r.effect === 'allow');
  const denies = pack.rules.filter((r) => r.effect === 'deny' || r.effect === 'require_approval');

  for (const a of allows) {
    for (const d of denies) {
      const overlap = estimateOverlap(a, d);
      if (overlap > 0) {
        reports.push({
          severity: overlap === 1 ? 'critical' : 'warning',
          ruleA: a.name,
          ruleB: d.name,
          reason: `allow rule may coexist with deny/require_approval rule for the same input space (overlap=${(overlap * 100).toFixed(0)}%)`,
          inputsAffected: overlap,
        });
      }
    }
  }

  const denyClasses = pack.rules.filter((r) => r.effect === 'deny_class');
  for (const dc of denyClasses) {
    for (const a of allows) {
      reports.push({
        severity: 'info',
        ruleA: dc.name,
        ruleB: a.name,
        reason: `deny_class "${dc.denyClass}" takes precedence over allow rule`,
      });
    }
  }

  return reports;
}

function estimateOverlap(a: PolicyRuleAst, b: PolicyRuleAst): number {
  const aRefs = collectLiterals(a.body);
  const bRefs = collectLiterals(b.body);
  let shared = 0;
  for (const r of aRefs) {
    if (bRefs.has(r)) shared++;
  }
  const total = aRefs.size + bRefs.size;
  if (total === 0) return 0;
  return Math.min(1, (shared * 2) / total);
}

function collectLiterals(expr: import('./types').PolicyExpr): Set<string> {
  const out = new Set<string>();
  walk(expr, (e) => {
    if (e.kind === 'literal' && typeof e.value === 'string') {
      out.add(`lit:${e.value}`);
    }
    if (e.kind === 'ref') {
      out.add(`ref:${e.path.join('.')}`);
    }
  });
  return out;
}
