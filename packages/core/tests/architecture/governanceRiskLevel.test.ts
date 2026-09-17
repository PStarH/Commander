import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ET-02 (`.internal/audit-2026-09-10/batchE-core-top.md`).
 *
 * `telosOrchestrator.analyzeTask` derives
 * `requiresApproval: riskLevel === 'CRITICAL' || riskLevel === 'HIGH'`. Every
 * entry path that constructed `contextData.governanceProfile` with the literal
 * `riskLevel: 'LOW'` therefore made `requiresApproval` permanently false and
 * the model router never scored risk — a hardcoded minimum risk for arbitrary
 * tasks, including destructive tool calls.
 *
 * Three primary entries were fixed first; the A2A server, the two CLI entries
 * and the showcase runner still carried the constant. This gate keeps the class
 * closed: no source file may construct a governance profile from a string
 * literal. The level must come from `assessGovernanceRiskLevel`.
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function collectTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...collectTypeScriptFiles(abs));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

/** Drop line and block comments so a documented example is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const GOVERNANCE_PROFILE = /governanceProfile\s*:\s*\{([^}]*)\}/gs;

describe('governance risk level is measured, never asserted (ET-02)', () => {
  it('no source file builds a governanceProfile with a hardcoded risk level', () => {
    const offenders: string[] = [];
    for (const file of collectTypeScriptFiles(SRC)) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      for (const match of source.matchAll(GOVERNANCE_PROFILE)) {
        if (/riskLevel\s*:\s*['"]/.test(match[1])) {
          offenders.push(`${relative(SRC, file)}: ${match[0].replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the entry paths derive the level through assessGovernanceRiskLevel', () => {
    const entries: Array<[string, number]> = [
      ['commanderCore.ts', 1],
      ['commander.ts', 1],
      ['agentLoop.ts', 1],
      ['mcp/a2aServer.ts', 1],
      ['cli/commands/core.ts', 2],
      ['showcase/showcaseRunner.ts', 1],
    ];
    for (const [relPath, minimum] of entries) {
      const source = readFileSync(join(SRC, relPath), 'utf-8');
      // The named import has no call parentheses, so this counts call sites.
      const calls = source.match(/assessGovernanceRiskLevel\(/g) ?? [];
      expect(
        calls.length,
        `${relPath} should call assessGovernanceRiskLevel`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });
});
