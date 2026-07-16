import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('./arch-guard.sh', import.meta.url));

interface FixturePackage {
  name: string;
  deps?: Record<string, string>;
  source?: string;
}

interface FixtureOptions {
  packages: Record<string, FixturePackage>;
}

function fixture(options: FixtureOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'commander-arch-guard-'));
  try {
    for (const [directory, pkg] of Object.entries(options.packages)) {
      const packageDir = join(root, 'packages', directory);
      mkdirSync(join(packageDir, 'src'), { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: pkg.name,
          version: '0.0.0',
          dependencies: pkg.deps ?? {},
        }),
      );
      writeFileSync(join(packageDir, 'src', 'index.ts'), pkg.source ?? 'export {}\n');
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runGuard(root: string): string {
  try {
    return execFileSync('bash', [SCRIPT], {
      env: { ...process.env, COMMANDER_ARCH_ROOT: root },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('passes the minimal allowed package graph', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      kernel: {
        name: '@commander/kernel',
        deps: { '@commander/contracts': 'workspace:*' },
      },
    },
  });
  assert.doesNotThrow(() => runGuard(root));
});

test('rejects a new orchestrator package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      orchestrator: { name: '@commander/orchestrator' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects a reintroduced control-plane package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      'control-plane': { name: '@commander/control-plane' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects kernel importing core', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      kernel: {
        name: '@commander/kernel',
        deps: { '@commander/core': 'workspace:*' },
        source: "import '@commander/core';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /kernel.*core|illegal.*dependency/i);
});

test('rejects contracts importing an implementation package', () => {
  const root = fixture({
    packages: {
      contracts: {
        name: '@commander/contracts',
        deps: { '@commander/kernel': 'workspace:*' },
        source: "import '@commander/kernel';\n",
      },
      kernel: { name: '@commander/kernel' },
    },
  });
  assert.throws(() => runGuard(root), /contracts.*leaf|illegal.*dependency/i);
});

test('rejects a cycle in internal package dependencies', () => {
  const root = fixture({
    packages: {
      contracts: {
        name: '@commander/contracts',
        deps: { '@commander/kernel': 'workspace:*' },
      },
      kernel: {
        name: '@commander/kernel',
        deps: { '@commander/contracts': 'workspace:*' },
      },
    },
  });
  assert.throws(() => runGuard(root), /cycle/i);
});

test('rejects a relative import that escapes its package boundary', () => {
  const root = fixture({
    packages: {
      contracts: {
        name: '@commander/contracts',
        source: "import '../../kernel/src/index.js';\n",
      },
      kernel: { name: '@commander/kernel' },
    },
  });
  assert.throws(() => runGuard(root), /relative import escapes package boundary/i);
});
