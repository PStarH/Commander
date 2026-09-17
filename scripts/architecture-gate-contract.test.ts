/**
 * LM-18 / MOD-02 contract test for the Architecture V2 gate.
 *
 * The gate's import check used to be a single regex requiring the specifier to
 * be *exactly* a forbidden string, so a real subpath import —
 * `import '@commander/core/runtime/agentRuntime'` — passed even though
 * `@commander/core/runtime` is on the forbidden list. It also matched prose in
 * comments, reporting a violation for a comment that merely *mentioned* an
 * import.
 *
 * Each case builds a throwaway project (config + source) and runs the real gate
 * against it, so the test exercises the shipped script rather than a copy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const gateScript = path.join(repoRoot, 'scripts/architecture-gate.ts');

const CONFIG = {
  v2Packages: ['packages/kernel'],
  forbiddenCoreImports: ['@commander/core', '@commander/core/runtime', '@commander/core/security'],
  v2ImportExceptions: [],
  api: { path: 'apps/api/src', legacyImportExceptions: [], unversionedRouteExceptions: [] },
  authorityExceptions: [],
};

/** Build a throwaway project and return the gate's combined output. */
function runGate(source: string): { status: number; output: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-gate-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'packages/kernel/src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'apps/api/src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'scripts/architecture-gate.config.json'),
      JSON.stringify(CONFIG, null, 2),
    );
    fs.writeFileSync(path.join(tmp, 'packages/kernel/src/subject.ts'), source);

    try {
      const output = execFileSync(path.join(repoRoot, 'node_modules/.bin/tsx'), [gateScript], {
        cwd: tmp,
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return { status: 0, output };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('LM-18: architecture gate resolves real module specifiers', () => {
  it('fails on an exact forbidden import', () => {
    const { status, output } = runGate(
      `import { x } from '@commander/core';\nexport const y = x;\n`,
    );
    assert.equal(status, 1, output);
    assert.match(output, /imports forbidden @commander\/core modules/);
  });

  it('fails on a DEEP subpath of a forbidden module (previously missed)', () => {
    const { status, output } = runGate(
      `import { AgentRuntime } from '@commander/core/runtime/agentRuntime';\nexport const r = AgentRuntime;\n`,
    );
    assert.equal(status, 1, `deep subpath import must be rejected\n${output}`);
    assert.match(output, /@commander\/core\/runtime/);
  });

  it('fails on a re-export from a forbidden module', () => {
    const { status, output } = runGate(
      `export { redact } from '@commander/core/security/secrets';\n`,
    );
    assert.equal(status, 1, `re-export must be rejected\n${output}`);
    assert.match(output, /@commander\/core\/security/);
  });

  it('fails on a literal require() of a forbidden module', () => {
    const { status, output } = runGate(
      `const core = require('@commander/core/runtime/tenantContext');\nexport const t = core;\n`,
    );
    assert.equal(status, 1, `literal require must be rejected\n${output}`);
    assert.match(output, /@commander\/core\/runtime/);
  });

  it('fails on a literal dynamic import() of a forbidden module', () => {
    const { status, output } = runGate(
      `export async function load() {\n  return await import('@commander/core/observability');\n}\n`,
    );
    assert.equal(status, 1, `literal dynamic import must be rejected\n${output}`);
    assert.match(output, /@commander\/core/);
  });

  it('passes on a near-miss package name (no bare string prefix matching)', () => {
    const { status, output } = runGate(
      `import { x } from '@commander/core-extra';\nexport const y = x;\n`,
    );
    assert.equal(status, 0, `@commander/core-extra must NOT match @commander/core\n${output}`);
  });

  it('passes when a forbidden import appears only in a comment', () => {
    const { status, output } = runGate(
      `// Historically this file did: import { AgentRuntime } from '@commander/core/runtime/agentRuntime';\n` +
        `/** And the doc block also mentions from '@commander/core' */\nexport const y = 1;\n`,
    );
    assert.equal(status, 0, `prose mentioning an import is not a violation\n${output}`);
  });

  it('passes when a forbidden specifier appears only in a string literal', () => {
    const { status, output } = runGate(
      `export const DOC = "import { x } from '@commander/core'";\nexport const y = 1;\n`,
    );
    assert.equal(status, 0, `a string literal is not an import\n${output}`);
  });

  it('passes on a clean file that imports only node builtins', () => {
    const { status, output } = runGate(
      `import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n`,
    );
    assert.equal(status, 0, output);
  });
});
