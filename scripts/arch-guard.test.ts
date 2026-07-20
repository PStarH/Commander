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
  sourcePath?: string;
}

interface FixtureOptions {
  packages: Record<string, FixturePackage>;
  rootFiles?: Record<string, string>;
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
      const sourcePath = pkg.sourcePath ?? 'index.ts';
      writeFileSync(join(packageDir, 'src', sourcePath), pkg.source ?? 'export {}\n');
    }
    for (const [file, contents] of Object.entries(options.rootFiles ?? {})) {
      writeFileSync(join(root, file), contents);
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

test('rejects a reintroduced orchestration package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      orchestration: { name: '@commander/orchestration' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects a reintroduced security package role', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      security: { name: '@commander/security' },
    },
  });
  assert.throws(() => runGuard(root), /forbidden package/i);
});

test('rejects imports of deleted control-plane package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      kernel: {
        name: '@commander/kernel',
        deps: { '@commander/contracts': 'workspace:*' },
        source: "import '@commander/control-plane';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /deleted package/i);
});

test('rejects root package.json references to deleted packages', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
    },
    rootFiles: {
      'package.json': JSON.stringify({
        name: 'commander-monorepo',
        dependencies: {
          '@commander/orchestration': 'workspace:*',
        },
      }),
    },
  });
  assert.throws(() => runGuard(root), /deleted package/i);
});

test('rejects worker-plane core imports outside configured bridge files', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      core: { name: '@commander/core', deps: { '@commander/contracts': 'workspace:*' } },
      'worker-plane': {
        name: '@commander/worker-plane',
        deps: {
          '@commander/contracts': 'workspace:*',
          '@commander/core': 'workspace:*',
        },
        sourcePath: 'rogueBridge.ts',
        source: "import '@commander/core';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /illegal source dependency/i);
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

test('rejects reintroduced operations package (ghost plane banned)', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      kernel: {
        name: '@commander/kernel',
        deps: { '@commander/contracts': 'workspace:*' },
      },
      operations: {
        name: '@commander/operations',
        deps: {
          '@commander/kernel': 'workspace:*',
          '@commander/contracts': 'workspace:*',
        },
      },
    },
  });
  assert.throws(
    () => runGuard(root),
    /no dependency policy exists for workspace package @commander\/operations/i,
  );
});

test('rejects imports of deleted operations package', () => {
  const root = fixture({
    packages: {
      contracts: { name: '@commander/contracts' },
      kernel: {
        name: '@commander/kernel',
        deps: { '@commander/contracts': 'workspace:*' },
        source: "import '@commander/operations';\n",
      },
    },
  });
  assert.throws(() => runGuard(root), /deleted package/i);
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
