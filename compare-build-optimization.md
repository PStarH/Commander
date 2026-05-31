# TypeScript Monorepo Build Optimization — Comprehensive Analysis

> **Date:** July 2025  
> **Scope:** Performance, Developer Experience (DX), and CI/CD optimization for TypeScript monorepos  
> **Target:** Production-ready optimization roadmap with prioritized recommendations

---

## Table of Contents

1. [Angle 1: PERFORMANCE — Caching, Incremental Builds, Parallel Compilation](#angle-1-performance)
2. [Angle 2: DX — Developer Experience Improvements](#angle-2-dx)
3. [Angle 3: CI/CD — Pipeline Optimization](#angle-3-cicd)
4. [Unified Optimization Roadmap](#unified-optimization-roadmap)
5. [Tool Comparison Matrix](#tool-comparison-matrix)

---

## Angle 1: PERFORMANCE

### 1.1 Caching Strategies

#### Turborepo (Recommended for Most Projects)

Turborepo is the leading lightweight build system for JavaScript/TypeScript monorepos, written in Rust for maximum performance. It uses a **content-hash-based caching system** that hashes inputs (source files, environment variables, dependencies) to determine cache validity.

**How it works:**
- Every task result is cached based on a hash of all inputs (source files, env vars, dependencies, `turbo.json` config)
- If the hash matches a previous run, the cached output is replayed instantly — no computation needed
- Supports **Remote Caching** to share cache across your team and CI

**Best Practices (2025-2026):**
- Use `dependsOn: ["^build"]` to define correct task dependencies in `turbo.json`
- Configure `inputs` and `outputs` precisely to maximize cache hit rates
- Use `env` to track environment variable dependencies
- Enable remote caching for CI acceleration

**Configuration Example:**

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json", "package.json"],
      "outputs": ["dist/**", ".next/**"],
      "env": ["NODE_ENV"]
    },
    "test": {
      "dependsOn": ["build"],
      "inputs": ["src/**", "test/**"],
      "outputs": ["coverage/**"],
      "cache": true
    },
    "lint": {
      "inputs": ["src/**", ".eslintrc*"],
      "cache": true
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig*.json"],
      "outputs": [],
      "cache": true
    }
  }
}
```

**Remote Caching Setup (Vercel-hosted, free tier):**

```bash
# Install turbo globally or use npx/pnpm dlx
pnpm add -g turbo

# Authenticate with Vercel
turbo login

# Link your repo
turbo link
```

**Self-Hosted Remote Cache (API-compliant):**

```json
// turbo.json
{
  "remoteCache": {
    "signature": true
  }
}
```

```bash
# Login to self-hosted cache
turbo login --manual
# Provide: API URL, team name, token
```

**Artifact Integrity:** Turborepo supports HMAC-SHA256 signature verification on cached artifacts:

```json
{
  "remoteCache": {
    "signature": true
  }
}
```
Set `TURBO_REMOTE_CACHE_SIGNATURE_KEY` env var with your secret key.

#### Nx (Recommended for Enterprise / Complex Workspaces)

Nx provides a more feature-rich build system with powerful caching, affected analysis, and distributed task execution.

**How it works:**
- Hash-based caching similar to Turborepo but with more granular control
- **Affected analysis** — only runs tasks for projects that changed
- **Nx Cloud** provides remote caching + distributed task execution (DTE)

**Best Practices (2025-2026):**
- Use `inputs`/`outputs` in `project.json` or `nx.json` for precise cache control
- Enable **Nx Replay** (remote cache) for CI
- Use **Nx Agents** for distributed task execution across multiple machines
- Leverage **self-healing CI** to automatically retry flaky tasks

**Configuration Example:**

```json
// nx.json
{
  "namedInputs": {
    "default": ["{projectRoot}/**/*"],
    "production": [
      "!{projectRoot}/**/*.spec.ts",
      "!{projectRoot}/**/*.test.ts",
      "!{projectRoot}/**/__tests__/**"
    ]
  },
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["production", "^production"],
      "outputs": ["{workspaceRoot}/dist/{projectName}"],
      "cache": true
    },
    "test": {
      "dependsOn": ["build"],
      "inputs": ["default", "^production"],
      "cache": true
    }
  }
}
```

**Distributed Task Execution (Nx Agents):**

```yaml
# .github/workflows/ci.yml
- name: Run Nx CI
  run: npx nx-cloud start-agent
  env:
    NX_CLOUD_DISTRIBUTED_EXECUTION: true
    NX_CLOUD_DISTRIBUTED_EXECUTION_AGENT_COUNT: 3
    NX_CLOUD_ACCESS_TOKEN: ${{ secrets.NX_CLOUD_TOKEN }}
```

#### Lerna (Best for Package Publishing)

Lerna (now maintained by Nx) focuses on **package management and publishing** rather than build caching. It's best paired with Nx or Turborepo for caching.

**Best Practices:**
- Use Lerna v7+ with Nx integration for caching
- Use `lerna run` with `--parallel` or `--stream` for task execution
- Use `lerna version` and `lerna publish` for version management
- Consider **Changesets** as an alternative for version management

**Configuration Example:**

```json
// lerna.json
{
  "$schema": "node_modules/lerna/schemas/lerna-schema.json",
  "version": "independent",
  "npmClient": "pnpm",
  "packages": ["packages/*", "apps/*"],
  "command": {
    "run": {
      "stream": true,
      "concurrency": 4
    },
    "version": {
      "conventionalCommits": true,
      "message": "chore(release): version packages"
    }
  }
}
```

### 1.2 Incremental Builds

**TypeScript Project References** are the foundation of incremental builds in TypeScript monorepos:

```json
// Root tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "references": [
    { "path": "packages/utils" },
    { "path": "packages/core" },
    { "path": "packages/ui" },
    { "path": "apps/web" }
  ]
}
```

```json
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [
    { "path": "../utils" }
  ]
}
```

**Incremental tsc with `--build` flag:**

```bash
# Only recompiles changed files and their dependents
tsc --build --incremental

# Force clean rebuild
tsc --build --clean
```

**SWC / esbuild for Non-Type-Checked Compilation:**

For projects where type-checking is separated from compilation, SWC and esbuild provide dramatically faster builds:

```json
// .swcrc
{
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "decorators": true,
      "dynamicImport": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    },
    "target": "es2020",
    "loose": true
  },
  "module": {
    "type": "commonjs",
    "strict": true,
    "noInterop": false
  }
}
```

**Build with SWC:**

```bash
# Single package
swc src -d dist --config-file .swcrc

# All packages in monorepo
turbo run build --filter='./packages/*'
```

### 1.3 Parallel Compilation

**Turborepo** automatically parallelizes tasks across all available CPU cores based on the task graph. No configuration needed — it builds the DAG and schedules accordingly.

**Nx** provides similar parallelization with additional control:

```json
// nx.json
{
  "parallel": 3,
  "tasksRunnerOptions": {
    "default": {
      "runner": "nx/tasks-runners/default",
      "options": {
        "cacheDirectory": ".nx/cache",
        "parallel": 3
      }
    }
  }
}
```

**Manual Parallelization with pnpm workspaces:**

```bash
# Run build across all packages in parallel
pnpm -r --parallel run build

# Run build with dependency ordering (respects dependency graph)
pnpm -r run build

# Filter to specific packages
pnpm --filter @repo/core --filter @repo/ui run build
```

**TypeScript Batch Mode (tsc --build):**

TypeScript 5.x improved batch mode for faster incremental compilation across project references:

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "composite": true,
    "tsBuildInfoFile": "./node_modules/.cache/tsconfig.tsbuildinfo"
  }
}
```

### 1.4 Trade-offs and Limitations

| Tool | Pros | Cons |
|------|------|------|
| **Turborepo** | Lightweight, zero-config caching, fast adoption, free remote cache via Vercel | Less built-in tooling than Nx, fewer generators/schematics |
| **Nx** | Rich ecosystem, affected analysis, DTE, strong plugin system | Heavier footprint, steeper learning curve, Nx Cloud costs for large teams |
| **Lerna** | Excellent package publishing, conventional commits integration | Requires Nx/Turbo for caching, limited build optimization alone |
| **pnpm** | Fast install, strict dependency resolution, workspace protocol | No built-in task caching (needs Turborepo/Nx) |

**Key Limitations:**
- **Cache invalidation sensitivity**: Over-broad cache keys waste compute; over-narrow keys miss cache hits
- **Environment variable sensitivity**: All env vars must be tracked to avoid stale cache
- **First-run penalty**: Cold caches provide no benefit; remote cache adds network overhead
- **Memory overhead**: Large monorepos with many parallel tasks can consume significant memory

---

## Angle 2: DX (Developer Experience)

### 2.1 Hot Reload / Fast Refresh

**Vite + TypeScript Monorepo:**

Vite provides near-instant HMR regardless of project size:

```typescript
// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@repo/ui': path.resolve(__dirname, '../../packages/ui/src'),
      '@repo/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
  server: {
    watch: {
      ignored: ['**/node_modules/**', '**/dist/**'],
    },
  },
  optimizeDeps: {
    include: ['@repo/ui', '@repo/core'],
  },
});
```

**Next.js with Monorepo Support:**

```javascript
// apps/web/next.config.js
const path = require('path');

module.exports = {
  transpilePackages: ['@repo/ui', '@repo/core'],
  webpack: (config, { isServer }) => {
    // Watch shared packages for changes
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        '**/node_modules/**',
        '!**/packages/ui/**',
        '!**/packages/core/**',
      ],
    };
    return config;
  },
};
```

**Turbopack (Next.js 15+):**

```bash
# Use Turbopack for dev mode (10x faster than Webpack)
next dev --turbopack
```

### 2.2 Type Checking Speed

**Separate Type Checking from Compilation:**

Use SWC/esbuild for compilation and run TypeScript in `--noEmit` mode for type checking:

```json
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,           // Type-check only, don't emit
    "composite": false,       // Disable for type-check-only mode
    "incremental": true,
    "tsBuildInfoFile": "./node_modules/.cache/typecheck.tsbuildinfo"
  }
}
```

```bash
# Type check all packages in parallel
turbo run typecheck

# Type check with watch mode
tsc --noEmit --watch --incremental
```

**TypeScript 5.x Performance Tips:**

```json
// tsconfig.base.json
{
  "compilerOptions": {
    // Performance optimizations
    "composite": true,
    "incremental": true,
    "skipLibCheck": true,           // Skip checking .d.ts files
    "disableReferencedProjectLoad": true,
    "disableSourceOfProjectReferenceRedirect": true,
    "disableSolutionSearching": true,
    "customConditions": ["development"],
    
    // Strictness (trade-off: stricter = slower)
    "strict": true,
    "noUncheckedIndexedAccess": false  // Disable for perf if needed
  }
}
```

**IDE-Level Type Checking Optimization (VS Code):**

```json
// .vscode/settings.json
{
  // Disable automatic type checking for large workspaces
  "typescript.tsserver.watchOptions": {
    "watchFile": "useFsEvents",
    "watchDirectory": "useFsEvents",
    "fallbackPolling": "dynamicPriority"
  },
  
  // Use project references for type checking
  "typescript.tsdk": "node_modules/typescript/lib",
  
  // Limit tsserver memory
  "typescript.tsserver.maxTsServerMemory": 8192,
  
  // Exclude large directories from file watching
  "files.watcherExclude": {
    "**/node_modules/**": true,
    "**/dist/**": true,
    "**/.turbo/**": true,
    "**/coverage/**": true
  },
  
  // Use incremental project loading
  "typescript.tsserver.pluginPaths": []
}
```

### 2.3 IDE Support

**VS Code Multi-Root Workspace Configuration:**

```json
// monorepo.code-workspace
{
  "folders": [
    { "path": "." },
    { "path": "packages/core" },
    { "path": "packages/ui" },
    { "path": "apps/web" },
    { "path": "apps/docs" }
  ],
  "settings": {
    "typescript.tsserver.log": "verbose",
    "typescript.preferences.includePackageJsonAutoImports": "on",
    "editor.codeActionsOnSave": {
      "source.fixAll.eslint": "explicit",
      "source.organizeImports": "explicit"
    }
  },
  "extensions": {
    "recommendations": [
      "dbaeumer.vscode-eslint",
      "esbenp.prettier-vscode",
      "bradlc.vscode-tailwindcss",
      "ms-vscode.vscode-typescript-next"
    ]
  }
}
```

**Nx Console (VS Code Extension):**

- Provides GUI for running Nx commands
- Shows project graph visualization
- Integrates with VS Code's command palette
- Supports generators and executors

**Turborepo IDE Extension:**

- Shows task graph visualization
- Displays cache hit/miss information
- Integrates with VS Code's integrated terminal

### 2.4 Workspace Watch Mode

**Turborepo Watch:**

```bash
# Watch for changes and re-run affected tasks
turbo watch build test --filter='./packages/*'
```

**Nx Watch:**

```bash
# Watch for changes and re-run affected tasks
nx watch --projects=@repo/core -- nx run @repo/core:test
```

**Concurrently + Turborepo:**

```json
// package.json (root)
{
  "scripts": {
    "dev": "concurrently \"turbo run dev\" \"turbo run typecheck --watch\"",
    "dev:web": "turbo run dev --filter=web",
    "dev:packages": "turbo run dev --filter='./packages/*'"
  }
}
```

### 2.5 Trade-offs and Limitations

| Approach | Pros | Cons |
|----------|------|------|
| **Vite HMR** | Near-instant, framework-agnostic, excellent DX | Requires build tool migration, some plugin ecosystem gaps |
| **Turbopack** | 10x faster than Webpack, integrated with Next.js | Next.js-specific, still maturing |
| **SWC compilation** | 20-70x faster than tsc for compilation | No type checking, separate tool needed |
| **TypeScript project references** | Native TS support, incremental builds | Complex configuration, manual maintenance |
| **IDE optimizations** | Immediate developer impact | Team-wide adoption required |

**Key Limitations:**
- **VS Code memory**: Large monorepos can exhaust tsserver memory (8GB+ recommended)
- **Type checking bottleneck**: Even with SWC compilation, CI must run tsc for type safety
- **Cross-package debugging**: Source maps across package boundaries can be unreliable
- **HMR scope**: HMR only works within a single dev server; cross-package HMR requires manual setup

---

## Angle 3: CI/CD

### 3.1 Pipeline Architecture

**GitHub Actions + Turborepo (Recommended for Most Teams):**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ secrets.TURBO_TEAM }}

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2  # For turborepo's affected analysis

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      # Turborepo handles caching and parallelization
      - name: Build
        run: pnpm turbo build --filter=...[origin/main]

      - name: Type Check
        run: pnpm turbo typecheck --filter=...[origin/main]

      - name: Lint
        run: pnpm turbo lint --filter=...[origin/main]

      - name: Test
        run: pnpm turbo test --filter=...[origin/main]

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: |
            apps/*/dist
            packages/*/dist
          retention-days: 7
```

**GitHub Actions + Nx (Enterprise Scale):**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

env:
  NX_CLOUD_ACCESS_TOKEN: ${{ secrets.NX_CLOUD_TOKEN }}

jobs:
  main:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for affected analysis

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      # Nx Affected: only run tasks for changed projects
      - name: Affected - Build
        run: npx nx affected -t build --parallel=3

      - name: Affected - Test
        run: npx nx affected -t test --parallel=3

      - name: Affected - Lint
        run: npx nx affected -t lint --parallel=3

  # Distributed Task Execution with Nx Agents
  distributed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - name: Run Nx CI with DTE
        run: |
          npx nx-cloud start-ci-run \
            --distribute-on="3 linux-medium-js" \
            --with-envs="NX_CLOUD_DISTRIBUTED_EXECUTION=true"
        env:
          NX_CLOUD_DISTRIBUTED_EXECUTION: true
```

### 3.2 Matrix Builds

**Multi-Version/Platform Testing:**

```yaml
# .github/workflows/matrix.yml
name: Matrix Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node-version: [18, 20, 22]
        shard: [1, 2, 3, 4]

    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Test (Shard ${{ matrix.shard }}/4)
        run: pnpm turbo test --shard=${{ matrix.shard }}/4

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-${{ matrix.os }}-node${{ matrix.node-version }}-shard${{ matrix.shard }}
          path: coverage/
```

**Selective Package Testing (Nx Affected):**

```yaml
- name: Detect affected packages
  id: affected
  run: |
    PACKAGES=$(npx nx show projects --type=app --affected --base=origin/main --head=HEAD)
    echo "packages=$PACKAGES" >> $GITHUB_OUTPUT

- name: Test affected apps only
  run: |
    for pkg in ${{ steps.affected.outputs.packages }}; do
      npx nx test $pkg
    done
```

### 3.3 Artifact Caching

**GitHub Actions Cache (Built-in):**

```yaml
- name: Cache turbo build artifacts
  uses: actions/cache@v4
  with:
    path: |
      .turbo/cache
      node_modules/.cache/turbo
    key: turbo-${{ runner.os }}-${{ hashFiles('**/turbo.json', '**/pnpm-lock.yaml') }}
    restore-keys: |
      turbo-${{ runner.os }}-
```

**GitHub Actions Cache + Turborepo Remote Cache (Best Combination):**

```yaml
# Local cache for fast restores
- name: Cache node_modules
  uses: actions/cache@v4
  with:
    path: node_modules
    key: deps-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml') }}

# Remote cache for cross-CI shared results
- name: Build
  run: pnpm turbo build
  env:
    TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
    TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
```

**Nx Cloud Remote Cache:**

```yaml
- name: Setup Nx Cloud
  uses: nrwl/nx-set-shas@v4
  
- name: Run affected commands
  run: |
    npx nx affected -t build test lint
  env:
    NX_CLOUD_ACCESS_TOKEN: ${{ secrets.NX_CLOUD_TOKEN }}
```

### 3.4 Test Sharding

**Turborepo Test Sharding:**

```json
// turbo.json
{
  "tasks": {
    "test": {
      "dependsOn": ["build"],
      "inputs": ["src/**", "test/**"],
      "outputs": ["coverage/**"],
      "cache": true
    }
  }
}
```

```bash
# Run specific package tests
pnpm turbo test --filter=@repo/core

# Run tests for changed packages only
pnpm turbo test --filter=...[origin/main]
```

**Vitest Sharding (Built-in):**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shard across CI runners
    shard: {
      index: parseInt(process.env.VITEST_SHARD_INDEX || '1'),
      total: parseInt(process.env.VITEST_SHARD_TOTAL || '1'),
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
```

```yaml
# GitHub Actions sharding
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - name: Run tests
    run: |
      VITEST_SHARD_INDEX=${{ matrix.shard }} \
      VITEST_SHARD_TOTAL=4 \
      pnpm vitest run --reporter=json
```

**Playwright Sharding (Built-in):**

```yaml
strategy:
  matrix:
    shard: [1/4, 2/4, 3/4, 4/4]
steps:
  - name: Run E2E tests
    run: npx playwright test --shard=${{ matrix.shard }}
```

### 3.5 Pipeline Optimization Strategies

**1. Dependency Graph-Aware CI:**

```yaml
# Only install and build what's needed
- name: Install
  run: pnpm install --frozen-lockfile

- name: Build affected packages
  run: pnpm turbo build --filter=...[origin/main]

- name: Test affected packages  
  run: pnpm turbo test --filter=...[origin/main]
```

**2. Split CI into Fast/Slow Tracks:**

```yaml
jobs:
  # Fast track: lint + typecheck (runs always)
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo lint typecheck

  # Slow track: build + test (only on main/PR)
  slow:
    needs: fast
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo build test
```

**3. Smart Rebuild with Change Detection:**

```yaml
- name: Check if packages changed
  id: check
  uses: dorny/paths-filter@v3
  with:
    filters: |
      core:
        - 'packages/core/**'
      ui:
        - 'packages/ui/**'
      web:
        - 'apps/web/**'
        - 'packages/core/**'
        - 'packages/ui/**'

- name: Build core
  if: steps.check.outputs.core == 'true'
  run: pnpm turbo build --filter=@repo/core

- name: Build web
  if: steps.check.outputs.web == 'true'
  run: pnpm turbo build --filter=web
```

**4. Docker Layer Caching for Monorepo Deploys:**

```dockerfile
# Dockerfile
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies (cached layer)
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# Build (only if deps change)
FROM deps AS build
COPY . .
RUN pnpm turbo build --filter=web...

# Production image
FROM node:22-slim AS production
WORKDIR /app
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### 3.6 Trade-offs and Limitations

| Strategy | Pros | Cons |
|----------|------|------|
| **Turborepo remote cache** | Zero-config, free tier, fast | Vercel lock-in concerns, cache invalidation complexity |
| **Nx Cloud DTE** | True distributed execution, agent-based | Paid service, additional infrastructure |
| **Matrix builds** | Cross-platform/version coverage | Exponential job count, longer wall-clock time |
| **Test sharding** | Parallelizes tests across runners | Requires shard-aware test runner, result merging |
| **Affected analysis** | Only builds/tests what changed | Requires accurate dependency graph, full git history |

**Key Limitations:**
- **Cache poisoning risk**: Incorrect cache keys can serve stale results
- **Cold start penalty**: First CI run after cache clear is slow
- **Matrix explosion**: Many combinations = expensive CI minutes
- **Cross-shard dependencies**: Some tests depend on others; sharding can break this
- **Artifact size limits**: GitHub Actions has 10GB artifact storage limit per repo

---

## Unified Optimization Roadmap

### Phase 1: Foundation (Week 1-2) — Quick Wins

**Priority: HIGH | Effort: LOW | Impact: HIGH**

1. **Migrate to pnpm workspaces** (if not already)
   - Strict dependency resolution prevents phantom dependencies
   - Workspace protocol (`workspace:*`) for local packages
   - 2-3x faster installs than npm/yarn

2. **Add Turborepo** as the task runner
   - Zero-config setup with existing `package.json` scripts
   - Immediate local caching benefits
   - Free remote caching via Vercel

3. **Configure `turbo.json` with correct task dependencies**
   - `build` depends on `^build` (upstream packages)
   - `test` depends on `build`
   - `lint` runs independently
   - `typecheck` depends on `^build`

```json
// Quick-start turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"], "outputs": ["coverage/**"] },
    "lint": { "outputs": [] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

4. **Enable remote caching**
   - `turbo login` + `turbo link` for Vercel remote cache
   - Add `TURBO_TOKEN` and `TURBO_TEAM` to CI secrets

### Phase 2: Developer Experience (Week 2-3)

**Priority: HIGH | Effort: MEDIUM | Impact: MEDIUM-HIGH**

5. **Configure TypeScript project references**
   - Set `composite: true` and `incremental: true` in base tsconfig
   - Add project references between packages
   - Use `tsc --build --incremental` for type checking

6. **Separate compilation from type checking**
   - Use SWC/esbuild for compilation (20-70x faster)
   - Run `tsc --noEmit` for type checking separately
   - Configure turbo tasks accordingly

7. **Optimize IDE performance**
   - Add `.vscode/settings.json` with tsserver optimizations
   - Exclude build artifacts from file watching
   - Set appropriate memory limits for TypeScript server

8. **Set up fast dev loop**
   - Vite for frontend dev servers with HMR
   - `turbo watch` for cross-package rebuild on changes
   - Configure package source aliases for live development

### Phase 3: CI/CD Optimization (Week 3-4)

**Priority: MEDIUM-High | Effort: MEDIUM | Impact: HIGH**

9. **Configure CI pipeline with Turborepo**
   - Use `--filter=...[origin/main]` for affected-only builds
   - Enable remote caching in CI
   - Cache `node_modules` with GitHub Actions cache

10. **Implement test sharding**
    - Vitest: Use built-in shard option
    - Playwright: Use `--shard` flag
    - Split by package boundaries where possible

11. **Add matrix builds for critical paths**
    - Test on Node 18, 20, 22
    - Test on Ubuntu, macOS (skip Windows unless required)
    - Use `fail-fast: false` to get all results

12. **Split CI into fast/slow tracks**
    - Fast: lint + typecheck (blocks PR merge)
    - Slow: build + test (can be async)

### Phase 4: Enterprise Scale (Week 4-6)

**Priority: MEDIUM | Effort: HIGH | Impact: HIGH (at scale)**

13. **Consider Nx for complex workspaces** (50+ packages)
    - Affected analysis for precise CI targets
    - Nx Agents for distributed task execution
    - Self-healing CI for flaky task retry
    - Module boundary enforcement

14. **Implement change detection in CI**
    - `dorny/paths-filter` for package-level change detection
    - Conditional job execution based on changed packages
    - Smart artifact uploads/downloads

15. **Docker optimization for deployments**
    - Multi-stage builds with dependency caching
    - Turborepo `turbo prune` for minimal Docker context
    - Layer caching for frequently unchanged layers

16. **Cost optimization**
    - Monitor CI minutes usage
    - Use spot instances for distributed tasks
    - Implement CI cost dashboards

```bash
# Turbo prune creates a minimal subset for Docker
turbo prune web --docker
# Creates ./out/ directory with only web + its dependencies
```

### Phase 5: Advanced Optimization (Ongoing)

**Priority: LOW-MEDIUM | Effort: HIGH | Impact: MEDIUM**

17. **Custom caching strategies**
    - Cache Rust/WASM build artifacts separately
    - Cache prisma/protobuf generated code
    - Cache storybook builds

18. **Performance monitoring**
    - Track build times over time
    - Monitor cache hit rates
    - Alert on performance regressions

19. **Gradual migration to newer tools**
    - Evaluate Rspack as Webpack replacement
    - Test Vite 6+ with monorepo improvements
    - Prototype with Biome for linting/formatting (replaces ESLint + Prettier)

---

## Tool Comparison Matrix

### Build Orchestration

| Feature | Turborepo | Nx | Lerna + Nx |
|---------|-----------|-----|------------|
| **Setup Complexity** | ⭐ Very Low | ⭐⭐ Medium | ⭐⭐⭐ High |
| **Local Caching** | ✅ Yes | ✅ Yes | ✅ (via Nx) |
| **Remote Caching** | ✅ Free (Vercel) | ✅ Nx Cloud (paid) | ✅ (via Nx) |
| **Affected Analysis** | ✅ `--filter` | ✅ `affected` | ✅ (via Nx) |
| **Distributed Execution** | ❌ No | ✅ Nx Agents | ✅ (via Nx) |
| **Code Generation** | ❌ No | ✅ Generators | ✅ (via Nx) |
| **Module Boundaries** | ❌ No | ✅ Enforceable | ✅ (via Nx) |
| **Bundle Size** | ~5MB | ~30MB | ~50MB |
| **Best For** | Small-Medium teams | Medium-Large enterprises | Package publishing |

### Compilation Tools

| Feature | tsc | SWC | esbuild | Babel |
|---------|-----|-----|---------|-------|
| **Type Checking** | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Speed** | 1x (baseline) | 20-70x | 10-100x | 5-20x |
| **TypeScript Config** | tsconfig.json | .swcrc | CLI flags | babel.config |
| **Decorators** | ✅ Native | ✅ Experimental | ❌ No | ✅ Plugin |
| **Declaration Files** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Incremental** | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Best For** | Type checking | Build pipeline | Server-side | Legacy compat |

### Test Sharding

| Feature | Vitest | Jest | Playwright | Cypress |
|---------|--------|------|------------|---------|
| **Built-in Sharding** | ✅ Yes | ❌ Manual | ✅ Yes | ❌ Manual |
| **Parallel Within Shard** | ✅ Threads | ✅ Workers | ✅ Workers | ❌ Serial |
| **Monorepo Awareness** | ✅ Workspace | ⚠️ Limited | ⚠️ Limited | ⚠️ Limited |
| **Cache Integration** | ✅ Turbo/Nx | ✅ Turbo/Nx | ⚠️ Limited | ⚠️ Limited |
| **Coverage Merging** | ⚠️ Manual | ⚠️ Manual | N/A | N/A |

### CI Platforms

| Feature | GitHub Actions | GitLab CI | CircleCI | Nx Cloud |
|---------|---------------|-----------|----------|----------|
| **Free Tier** | 2000 min/mo | 400 min/mo | 6000 min/mo | Limited |
| **Matrix Builds** | ✅ Native | ✅ Native | ✅ Native | N/A |
| **Remote Cache** | ⚠️ Manual setup | ⚠️ Manual setup | ⚠️ Manual setup | ✅ Native |
| **DTE** | ❌ No | ❌ No | ❌ No | ✅ Native |
| **Self-hosted Runners** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |

---

## Summary of Recommendations

### For Small Teams (1-5 developers)
1. **pnpm + Turborepo** for the simplest, fastest setup
2. **SWC/esbuild** for compilation, `tsc --noEmit` for type checking
3. **Vite** for frontend dev servers
4. **GitHub Actions** with Turborepo remote cache

### For Medium Teams (5-20 developers)
1. **pnpm + Turborepo** (or Nx if you need generators/enforcement)
2. **TypeScript project references** + incremental builds
3. **Test sharding** with Vitest/Playwright
4. **Split CI** into fast (lint/typecheck) and slow (build/test) tracks

### For Large Teams (20+ developers)
1. **Nx + Nx Cloud** for affected analysis, DTE, and self-healing CI
2. **Full TypeScript project references** with incremental builds
3. **Matrix builds** across Node versions and platforms
4. **Module boundary enforcement** with Nx tags
5. **Docker-optimized deployments** with Turborepo prune
6. **Custom CI orchestration** with change detection and conditional execution

---

## Key Metrics to Track

| Metric | Target | Tool |
|--------|--------|------|
| **Local build time** | < 30s for affected packages | `time turbo build` |
| **CI build time** | < 5 min for PR validation | GitHub Actions |
| **Cache hit rate** | > 80% in CI | Turborepo/Nx dashboard |
| **Type check time** | < 10s for single package | `time tsc --noEmit` |
| **Dev server start** | < 3s | Vite/Turbopack |
| **HMR update** | < 100ms | Vite |
| **CI cost** | < $500/month per team | GitHub billing |

---

*Generated: July 2025 | Last Updated: July 2025*
