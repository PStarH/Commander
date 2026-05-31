# TypeScript Monorepo Build Optimization — Definitive Guide

> **Date:** July 2025  
> **Scope:** Performance, Developer Experience (DX), and CI/CD optimization for TypeScript monorepos  
> **Status:** Production-ready optimization roadmap with prioritized recommendations

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Angle 1: PERFORMANCE — Caching, Incremental Builds, Parallel Compilation](#angle-1-performance)
3. [Angle 2: DX — Developer Experience Improvements](#angle-2-dx)
4. [Angle 3: CI/CD — Pipeline Optimization](#angle-3-cicd)
5. [Unified Optimization Roadmap](#unified-optimization-roadmap)
6. [Tool Comparison Matrices](#tool-comparison-matrices)
7. [Decision Framework](#decision-framework)
8. [Key Metrics to Track](#key-metrics-to-track)

---

## Executive Summary

The 2025–2026 TypeScript monorepo optimization landscape has converged on a clear set of best practices:

1. **pnpm** is the default package manager for monorepos — fast, strict, workspace-native
2. **Turborepo** (or **Nx** for large/complex repos) provides caching and parallelization
3. **SWC/esbuild** for compilation, **tsc** for type checking — separated for maximum speed
4. **Biome** replaces ESLint + Prettier for dramatically faster linting (30× faster)
5. **Vite** is the dev server of choice with near-instant HMR across package boundaries
6. **GitHub Actions** with matrix strategies, test sharding, and artifact caching for CI
7. **Remote caching** (Vercel or self-hosted) is essential for CI performance

The combined approach yields **sub-second local feedback loops** and **sub-5-minute CI pipelines**, even for large monorepos with 50+ packages.

### Expected Performance Gains

| Metric | Before Optimization | After Phase 2 | After Phase 4 (Full) |
|--------|-------------------|---------------|---------------------|
| Full build (cold) | 10 min | 4 min | 4 min |
| Full build (warm) | 10 min | 2 min | 30 sec (cached) |
| Incremental build | 5 min | 1 min | 15 sec |
| CI pipeline (full) | 25 min | 15 min | 8 min |
| CI pipeline (incremental) | 25 min | 15 min | 2 min |
| Dev server startup | 30 sec | 5 sec | 5 sec |
| Type check (full) | 3 min | 1 min | 45 sec |

---

## Angle 1: PERFORMANCE

### 1.1 Caching Strategies

The monorepo build tooling landscape has matured significantly. Three dominant approaches exist:

| Tool | Language | Core Philosophy | Maturity |
|------|----------|----------------|----------|
| **Turborepo** | Rust | Lightweight, zero-config, cache-first | Production-ready (Vercel-backed) |
| **Nx** | TypeScript | Full-featured, plugin-driven, affected-based | Production-ready (Nrwl-backed) |
| **Lerna (with Nx)** | TypeScript | Legacy wrapper, now powered by Nx | Maintenance mode |

**Key insight for 2025–2026:** Lerna is now deprecated for new projects. Since Nx acquired Lerna, it powers Lerna under the hood via `@lerna/legacy-package-management`. **New projects should choose between Turborepo and Nx directly.** If publishing is a primary concern, consider **Changesets** as an alternative.

---

#### Turborepo (Recommended for Most Projects)

Turborepo uses a **content-hash-based caching system** that hashes inputs (source files, environment variables, dependencies) to determine cache validity.

**How it works:**
- Every task result is cached based on a hash of all inputs (source files, env vars, dependencies, `turbo.json` config)
- If the hash matches a previous run, the cached output is replayed instantly — no computation needed
- Supports **Remote Caching** to share cache across your team and CI
- Supports **Git Worktree cache sharing** — local caches are automatically shared between linked git worktrees

**Configuration (`turbo.json`):**

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [".env", ".env.*"],
  "globalEnv": ["NODE_ENV", "CI"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],           // Build dependencies first
      "inputs": ["src/**", "tsconfig.json", "package.json"],
      "outputs": ["dist/**", ".next/**"], // What to cache
      "env": ["NODE_ENV"]
    },
    "test": {
      "dependsOn": ["build"],
      "inputs": ["src/**", "test/**", "__tests__/**"],
      "outputs": ["coverage/**"],
      "cache": true
    },
    "lint": {
      "inputs": ["src/**", ".eslintrc.*"],
      "outputs": [],
      "cache": true
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig*.json"],
      "outputs": [],
      "cache": true
    },
    "dev": {
      "cache": false,  // Never cache dev servers
      "persistent": true
    }
  },
  "remoteCache": {
    "signature": true  // HMAC-SHA256 artifact integrity verification
  }
}
```

**Remote Caching setup:**

```bash
# Authenticate (Vercel default, or self-hosted)
npx turbo login
npx turbo link

# Self-hosted remote cache
turbo login --manual  # Provide: API URL, team name, token

# CI: Use TURBO_TOKEN and TURBO_TEAM env vars
TURBO_TOKEN=xxx TURBO_TEAM=my-team turbo build
```

Set `TURBO_REMOTE_CACHE_SIGNATURE_KEY` env var with your secret key for artifact integrity verification.

**Key strengths:**
- Zero-config adoption — uses existing `package.json` scripts
- Automatic task parallelization across all available cores
- Remote Cache sharing across team and CI (Vercel, self-hosted via Remote Cache API)
- Git worktree cache sharing (auto-detects linked worktrees)
- Filter API for surgical task execution: `turbo build --filter=@acme/web...`
- `turbo prune` for minimal Docker contexts

**Cache debugging:**

```bash
# See what would run (without executing)
turbo build --dry

# See detailed hash inputs/outputs
turbo build --dry --verbose

# Generate run summary for comparison
turbo build --summarize
```

**Limitations:**
- No built-in dependency graph visualization (use `turbo run build --dry` for insights)
- Limited plugin ecosystem compared to Nx
- No affected-based CI out of the box (relies on filter flags)
- Less granular project graph analysis than Nx
- No code generation or module boundary enforcement

---

#### Nx (Recommended for Enterprise / Complex Workspaces)

Nx provides a more comprehensive, opinionated build system with deeper project graph analysis. Better suited for large-scale monorepos (50+ packages).

**How it works:**
- Hash-based caching similar to Turborepo but with more granular control
- **Affected analysis** — only runs tasks for projects that changed since last commit
- **Nx Cloud** provides remote caching + distributed task execution (DTE) across multiple CI agents
- **Project Graph** — deep analysis of import relationships for precise dependency tracking

**Configuration (`nx.json`):**

```jsonc
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "sharedGlobals": ["{workspaceRoot}/tsconfig.base.json"],
    "production": [
      "default",
      "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)",
      "!{projectRoot}/tsconfig.spec.json",
      "!{projectRoot}/**/*.md"
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
    },
    "lint": {
      "inputs": [
        "{workspaceRoot}/.eslintrc.json",
        "{workspaceRoot}/tools/eslint-rules/**",
        "{projectRoot}/**/*.{ts,tsx,js,jsx}"
      ],
      "cache": true
    }
  },
  "defaultBase": "main",
  "tasksRunnerOptions": {
    "default": {
      "runner": "nx-cloud",
      "options": {
        "cacheableOperations": ["build", "test", "lint"],
        "accessToken": "xxx"
      }
    }
  }
}
```

**Key strengths:**
- Rich dependency graph analysis (source-code level, not just `package.json`)
- Affected commands: `nx affected --target=build --base=main`
- Comprehensive plugin ecosystem (React, Angular, Node, Next.js, etc.)
- Generators and executors for consistent code generation
- Nx Cloud for distributed task execution (DTE) — splits work across multiple CI agents
- Nx Console (VS Code extension) for GUI-based task running
- Module boundary enforcement via tags

**Limitations:**
- Heavier initial setup and steeper learning curve
- Nx Cloud requires paid plan for teams > 3
- Configuration can be verbose
- Overhead for small projects (< 5 packages)
- Vendor risk with Nx Cloud

---

#### Lerna (Legacy — Best for Package Publishing Only)

Lerna (now maintained by Nx) focuses on **package management and publishing** rather than build caching. Best paired with Nx or Turborepo for caching.

```jsonc
// lerna.json
{
  "$schema": "node_modules/lerna/schemas/lerna-schema.json",
  "version": "independent",
  "npmClient": "pnpm",
  "useNx": true,
  "command": {
    "version": {
      "conventionalCommits": true,
      "createRelease": "github"
    },
    "publish": {
      "registry": "https://registry.npmjs.org/"
    }
  }
}
```

**Verdict:** Do not use Lerna for new projects. If you're on Lerna, migrate to Nx with `nx init`.

---

### 1.2 Incremental Builds

#### TypeScript Project References

TypeScript's native project references are the foundation of incremental builds. They allow the compiler to understand inter-package dependencies and only recompile what changed.

**Root `tsconfig.json`:**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "composite": true,
    "incremental": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "tsBuildInfoFile": "./.tsbuildinfo",
    "skipLibCheck": true,
    "disableReferencedProjectLoad": true,
    "disableSourceOfProjectReferenceRedirect": true,
    "disableSolutionSearching": true
  },
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/utils" },
    { "path": "./packages/core" },
    { "path": "./apps/web" }
  ],
  "files": []
}
```

**Package `tsconfig.json` (e.g., `packages/core/tsconfig.json`):**

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "incremental": true,
    "declaration": true,
    "tsBuildInfoFile": "./.tsbuildinfo",
    "isolatedModules": true  // Required for SWC/esbuild compatibility
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.spec.ts"],
  "references": [
    { "path": "../shared" }
  ]
}
```

**Build command:**

```bash
# Build all projects respecting dependency order
tsc --build --verbose

# Build only changed projects (incremental)
tsc --build --incremental

# Force clean rebuild
tsc --build --clean
```

#### TypeScript 5.5+ Performance Features (2024–2025)

- **TypeScript 5.5:** Inferred type predicates, **isolated declarations** (enables parallel DTS emit)
- **TypeScript 5.6:** `--noUncheckedSideEffectImports` for faster module resolution
- **TypeScript 5.7+:** Up to 40% faster `--build` mode, better incremental compilation, improved project references error reporting

```jsonc
// Enable isolated declarations for faster builds
{
  "compilerOptions": {
    "isolatedDeclarations": true,
    "declaration": true,
    "declarationMap": true
  }
}
```

`isolatedDeclarations: true` enables libraries to emit `.d.ts` files independently without full type checking — critical for parallel builds.

#### TypeScript Batch Mode (Nx-specific)

Nx provides TypeScript batch mode which batches the compilation of multiple packages into a single `tsc` invocation, dramatically reducing overhead — **2–5× faster** than building each package individually.

```jsonc
// nx.json
{
  "targetDefaults": {
    "build": {
      "executor": "nx:run-commands",
      "options": {
        "command": "tsc --build --verbose",
        "cwd": "{workspaceRoot}"
      }
    }
  }
}
```

#### Type Checking Performance Tips

| Optimization | Impact | Effort |
|-------------|--------|--------|
| `skipLibCheck: true` | 30-50% faster | Trivial |
| `isolatedModules: true` | Enables parallel compilation | Trivial |
| `disableReferencedProjectLoad: true` | Faster IDE loading | Trivial |
| `disableSolutionSearching: true` | Faster IDE operations | Trivial |
| TypeScript project references | 40-60% faster incremental | Medium |
| SWC for emit + tsc for checking | 5-10× faster builds | Medium |
| `noEmit: true` for IDE checking | Reduces I/O | Trivial |
| Excluding test files from production config | 10-20% faster | Low |

---

### 1.3 Parallel Compilation

#### SWC (Speedy Web Compiler)

SWC is a Rust-based TypeScript/JavaScript compiler that's **20–70× faster** than `tsc` for pure compilation (not type checking).

**Configuration (`.swcrc`):**

```json
{
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "tsx": true,
      "decorators": true,
      "dynamicImport": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    },
    "target": "es2022",
    "loose": false,
    "externalHelpers": false,
    "keepClassNames": true
  },
  "module": {
    "type": "commonjs",
    "strict": true,
    "noInterop": false
  },
  "sourceMaps": true,
  "exclude": ["node_modules"]
}
```

#### esbuild

esbuild is a Go-based bundler/compiler optimized for bundling but also excellent for transpilation (**10–100× faster** than tsc).

```javascript
// build.mjs
import { build } from 'esbuild';
import { glob } from 'glob';

const entryPoints = await glob('packages/*/src/index.ts');

await build({
  entryPoints,
  bundle: false,  // Don't bundle, just transpile
  outdir: 'dist',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  splitting: false
});
```

#### tsup (Recommended for Libraries)

tsup wraps esbuild with `.d.ts` generation — the best of both worlds:

```typescript
// packages/ui/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/components/**/*.tsx'],
  format: ['cjs', 'esm'],
  dts: true,           // Generate .d.ts files
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ['react'],  // Don't bundle peer deps
});
```

#### Rspack

Rspack (by ByteDance) is a Rust-based webpack-compatible bundler — **5–10× faster** than Webpack with drop-in compatibility:

```javascript
// rspack.config.js
const path = require('path');

module.exports = {
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    library: { type: 'module' }
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    alias: {
      '@myorg/core': path.resolve(__dirname, '../core/src'),
    }
  },
  module: {
    rules: [{
      test: /\.tsx?$/,
      use: {
        loader: 'builtin:swc-loader',
        options: {
          jsc: { parser: { syntax: 'typescript', tsx: true } }
        }
      },
      exclude: /node_modules/
    }]
  },
  experiments: { outputModule: true }
};
```

#### Recommended Build Strategy

**Recommended split for libraries:**
- **Development:** Use SWC/esbuild for fast transpilation (skip type checking)
- **CI/Pre-commit:** Run full `tsc --noEmit` for type safety
- **Publishing:** Use tsup with DTS generation

```
packages/shared/
├── src/
│   └── index.ts
├── tsconfig.json          # composite: true
├── tsup.config.ts         # Library build config
└── package.json           # "build": "tsup", "typecheck": "tsc --noEmit"
```

```jsonc
// package.json (library)
{
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "check:watch": "tsc --noEmit --watch --preserveWatchOutput",
    "lint": "eslint src/",
    "dev": "tsup --watch"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.7.0"
  }
}
```

---

### 1.4 Performance Summary

| Strategy | Cold Build | Incremental Build | Memory Usage | Setup Complexity |
|----------|-----------|-------------------|-------------|-----------------|
| `tsc --build` (Project Refs) | Slow (100%) | Medium (30-50%) | High | Low |
| SWC + tsc --noEmit | Very Fast (20%) | Very Fast (5-10%) | Low | Medium |
| esbuild | Very Fast (15%) | Very Fast (3-5%) | Low | Medium |
| Rspack | Fast (15%) | Fast (5-8%) | Medium | Medium |
| Turborepo + tsc | Fast (cached: 0%) | Fast (cached: 0%) | Medium | Low |
| Nx + tsc | Fast (cached: 0%) | Fast (cached: 0%) | Medium-High | High |

---

## Angle 2: DX

### 2.1 Hot Reload & Fast Development

#### Vite as the Primary Dev Server

Vite has become the de facto standard for frontend development in monorepos. Its native ESM approach provides instant startup regardless of project size.

```typescript
// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';  // SWC-based for fast refresh
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),  // Resolves TypeScript path aliases
  ],
  resolve: {
    alias: {
      '@repo/ui': path.resolve(__dirname, '../../packages/ui/src'),
      '@repo/utils': path.resolve(__dirname, '../../packages/utils/src'),
    },
  },
  server: {
    watch: {
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      usePolling: false,  // Use native fs events
    },
    hmr: { overlay: true },
  },
  optimizeDeps: {
    include: ['@repo/ui', '@repo/core'],     // Pre-bundle for fast cold start
    exclude: ['@repo/ui'],                    // Serve from source for HMR
  },
  build: {
    target: 'esnext',
    rollupOptions: { external: [] },
  },
});
```

**Key Vite 6/7 monorepo optimizations:**
- **Rolldown** (Rust-based) replaces Rollup for faster builds
- **Environment API** for fine-grained module handling
- **Dependency pre-bundling** with automatic cache in `node_modules/.vite`

#### "Source" Condition Pattern for Cross-Package HMR

For HMR to work across package boundaries, apps should import from package source during development. This is achieved via the `"source"` export condition:

```jsonc
// packages/ui/package.json
{
  "name": "@repo/ui",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "source": "./src/index.ts",     // Used by Vite in dev mode
      "import": "./dist/index.mjs",   // Used in production ESM
      "require": "./dist/index.cjs",  // Used in production CJS
      "types": "./dist/index.d.ts"
    }
  }
}
```

```typescript
// Vite config — force source serving for certain packages
export default defineConfig({
  resolve: {
    conditions: ['development', 'source'],  // Prioritize source during dev
  },
});
```

#### Next.js 15+ with Turbopack

```javascript
// next.config.js
const nextConfig = {
  transpilePackages: ['@repo/ui', '@repo/core'],
  turbo: {
    rules: {
      '*.svg': { loaders: ['@svgr/webpack'], as: '*.js' },
    },
    resolveAlias: {
      '@repo/ui': '../packages/ui/src',
    },
  },
};

module.exports = nextConfig;
```

```bash
# Use Turbopack for dev mode (10× faster than Webpack)
next dev --turbopack
```

#### pnpm Workspace Protocol

```jsonc
// apps/web/package.json
{
  "dependencies": {
    "@repo/ui": "workspace:*",       // Always latest local version
    "@repo/utils": "workspace:^"     // Respect semver range
  }
}
```

### 2.2 Type Checking Optimization

#### Separate Type Checking from Compilation

**Strategy:** Use SWC/esbuild for fast builds, run TypeScript type checking separately.

```jsonc
// packages/core/tsconfig.json — type-check-only config
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false,
    "incremental": true,
    "skipLibCheck": true,
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

#### Split tsconfig for IDE vs. Build

```jsonc
// tsconfig.ide.json (used by VS Code — includes all packages)
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "composite": false,       // Don't use composite for IDE
    "incremental": true,
    "skipLibCheck": true
  },
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/utils" },
    { "path": "./packages/core" }
  ]
}
```

```jsonc
// tsconfig.build.json (used by tsc --build — strict, composite)
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "declaration": true,
    "declarationMap": true
  },
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/utils" },
    { "path": "./packages/core" }
  ]
}
```

### 2.3 IDE Integration & Support

#### VS Code Workspace Configuration

```jsonc
// .vscode/settings.json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,

  // Performance
  "typescript.tsserver.maxTsServerMemory": 8192,
  "typescript.tsserver.log": "verbose",
  "typescript.tsserver.nodeOptions": ["--max-old-space-size=8192"],

  // Monorepo-aware settings
  "typescript.preferences.includePackageJsonAutoImports": "on",
  "typescript.suggest.autoImports": true,
  "typescript.updateImportsOnFileMove.enabled": "always",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit",
    "source.organizeImports": "explicit"
  },

  // File watching
  "typescript.tsserver.watchOptions": {
    "watchFile": "useFsEvents",
    "watchDirectory": "useFsEvents",
    "fallbackPolling": "dynamicPriority"
  },
  "files.watcherExclude": {
    "**/node_modules/**": true,
    "**/dist/**": true,
    "**/.turbo/**": true,
    "**/.nx/**": true,
    "**/coverage/**": true
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/.turbo": true,
    "**/pnpm-lock.yaml": true
  }
}
```

#### VS Code Multi-Root Workspace (for large monorepos)

```jsonc
// monorepo.code-workspace
{
  "folders": [
    { "path": "." },
    { "path": "packages/core" },
    { "path": "packages/ui" },
    { "path": "apps/web" },
    { "path": "apps/api" }
  ],
  "settings": {
    "typescript.tsdk": "node_modules/typescript/lib"
  },
  "extensions": {
    "recommendations": [
      "dbaeumer.vscode-eslint",
      "esbenp.prettier-vscode",
      "bradlc.vscode-tailwindcss",
      "nrwl.angular-console",
      "vue.volar",
      "ms-vscode.vscode-typescript-next"
    ]
  }
}
```

### 2.4 Linting & Formatting

#### ESLint Flat Config for Monorepos

```javascript
// eslint.config.js (root)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    rules: {
      'import/no-restricted-paths': ['error', {
        zones: [
          { target: './apps/web', from: './apps/api' },
          { target: './packages', from: './apps' },
        ],
      }],
    },
  },
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'] }
);
```

#### ESLint Module Boundaries (Nx)

```jsonc
// nx.json — tag-based boundary rules
{
  "projects": {
    "ui": { "tags": ["scope:shared", "type:ui"] },
    "utils": { "tags": ["scope:shared", "type:util"] },
    "web": { "tags": ["scope:app", "type:app"] },
    "api": { "tags": ["scope:app", "type:app"] }
  }
}
```

```jsonc
// .eslintrc.json — boundary enforcement
{
  "rules": {
    "@nx/enforce-module-boundaries": ["error", {
      "depConstraints": [
        { "sourceTag": "scope:shared", "onlyDependOnLibsWithTags": ["scope:shared"] },
        { "sourceTag": "scope:app", "onlyDependOnLibsWithTags": ["scope:shared", "scope:app"] },
        { "sourceTag": "type:app", "bannedExternalImports": ["@repo/*"] }
      ]
    }]
  }
}
```

#### Biome — The ESLint + Prettier Replacement (2025+)

Biome is a unified Rust-based tool that replaces both ESLint and Prettier:

```jsonc
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedImports": "warn",
        "noUnusedVariables": "warn"
      },
      "suspicious": { "noExplicitAny": "warn" }
    }
  }
}
```

**Performance Comparison (10k files):**

| Tool | Lint Speed | Format Speed |
|------|-----------|-------------|
| ESLint + Prettier | ~45s | ~12s |
| **Biome** | **~1.5s** | **~0.3s** |
| oxlint | ~0.8s | N/A (lint only) |

### 2.5 DX Trade-offs

| Approach | Setup Effort | HMR Speed | Type Check Speed | IDE Support |
|----------|-------------|-----------|-----------------|-------------|
| Vite + SWC | Low | Excellent | Good (separate) | Excellent |
| Next.js + Turbopack | Medium | Excellent | Good | Excellent |
| Webpack 5 (Module Fed.) | High | Good | Slow | Good |
| Biome (lint+format) | Low | N/A | N/A | Good |
| TypeScript project refs | Medium | N/A | Excellent | Excellent |

**Key Limitations:**
- VS Code memory: Large monorepos can exhaust tsserver memory (8GB+ recommended)
- Type checking bottleneck: Even with SWC compilation, CI must run `tsc` for type safety
- Cross-package debugging: Source maps across package boundaries can be unreliable
- HMR scope: HMR only works within a single dev server; cross-package HMR requires source imports + aliases

---

## Angle 3: CI/CD

### 3.1 Pipeline Architecture

#### GitHub Actions + Turborepo (Recommended for Most Teams)

```yaml
# .github/workflows/ci.yml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

# Cancel in-progress runs for the same branch
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
  TURBO_CACHE: read-write
  NODE_VERSION: '22'

jobs:
  # ──────────────────────────────────────────────────
  # Stage 1: Fast feedback (lint, typecheck)
  # ──────────────────────────────────────────────────
  quality:
    name: Quality Gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2  # For turbo diff-based filtering

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Lint changed packages
        run: pnpm turbo lint --filter=...[HEAD^] --continue

      - name: Type check changed packages
        run: pnpm turbo typecheck --filter=...[HEAD^] --continue

  # ──────────────────────────────────────────────────
  # Stage 2: Build (with remote cache)
  # ──────────────────────────────────────────────────
  build:
    name: Build
    needs: quality
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Build changed packages and dependents
        run: pnpm turbo build --filter=...[HEAD^] --filter=./apps/\*\*

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: |
            packages/*/dist
            apps/*/dist
          retention-days: 1

  # ──────────────────────────────────────────────────
  # Stage 3: Test (matrix + sharding)
  # ──────────────────────────────────────────────────
  test:
    name: Test (Node ${{ matrix.node-version }} / Shard ${{ matrix.shard }})
    needs: build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: [20, 22]
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          name: build-output

      - name: Run tests (shard ${{ matrix.shard }}/4)
        run: |
          pnpm turbo test --filter=...[HEAD^] \
            -- --shard=${{ matrix.shard }}/4

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-${{ matrix.node-version }}-${{ matrix.shard }}
          path: |
            **/coverage
            **/test-results

  # ──────────────────────────────────────────────────
  # Stage 4: E2E (affected only, sharded)
  # ──────────────────────────────────────────────────
  e2e:
    name: E2E Tests
    needs: build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Download build artifacts
        uses: actions/download-artifact@v4
        with:
          name: build-output

      - name: Run E2E tests (shard ${{ matrix.shard }}/3)
        run: npx playwright test --shard=${{ matrix.shard }}/3

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: e2e-results-${{ matrix.shard }}
          path: test-results
```

**Pipeline visualization:**

```
┌──────────────────────────────────────────────────────┐
│                    PR / Push                          │
└──────────┬───────────────────────────────────────────┘
           │
    ┌──────▼──────┐
    │   QUALITY   │  ← Lint + TypeCheck (~30s)
    │  (parallel) │     Only changed packages
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │    BUILD    │  ← All packages (cached, ~2min)
    │  (cached)   │     Upload artifacts
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │    TEST     │  ← 4× parallel shards × 2 Node versions
    │  (sharded)  │     Download build artifacts
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │     E2E     │  ← 3× parallel shards
    │  (atomized) │     Download build artifacts
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │    MERGE    │  ← All checks pass
    └─────────────┘
```

#### GitHub Actions + Nx (Enterprise Scale)

```yaml
# .github/workflows/nx-ci.yml
name: Nx CI

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
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Affected lint
        run: pnpm nx affected --target=lint --parallel=3

      - name: Affected test
        run: pnpm nx affected --target=test --parallel=3

      - name: Affected build
        run: pnpm nx affected --target=build --parallel=3

  # Distributed Task Execution with Nx Agents
  agent1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: npx nx-cloud start-agent

  agent2:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: npx nx-cloud start-agent
```

### 3.2 Artifact Caching Strategies

#### Multi-Layer Caching

```yaml
steps:
  # Layer 1: pnpm store cache
  - name: Cache pnpm store
    uses: actions/cache@v4
    with:
      path: ~/.local/share/pnpm/store/v10
      key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}
      restore-keys: |
        ${{ runner.os }}-pnpm-store-

  # Layer 2: TypeScript build info
  - name: Cache TypeScript build info
    uses: actions/cache@v4
    with:
      path: packages/**/.tsbuildinfo
      key: ${{ runner.os }}-tsc-${{ github.sha }}
      restore-keys: |
        ${{ runner.os }}-tsc-

  # Layer 3: Turborepo cache
  - name: Cache Turborepo
    uses: actions/cache@v4
    with:
      path: .turbo
      key: ${{ runner.os }}-turbo-${{ github.sha }}
      restore-keys: |
        ${{ runner.os }}-turbo-
```

### 3.3 Test Sharding

#### Vitest Sharding

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false, isolate: true },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    // Shard support: --shard=1/4
  },
});
```

#### Playwright Sharding

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Shard support via CLI: --shard=1/4
});
```

### 3.4 Other CI Platform Optimizations

#### GitLab CI

```yaml
# .gitlab-ci.yml
variables:
  TURBO_TOKEN: $TURBO_TOKEN
  TURBO_TEAM: $TURBO_TEAM

cache:
  key:
    files: [pnpm-lock.yaml]
  paths:
    - node_modules/
    - .turbo/cache/

stages: [quality, build, test]

lint:
  stage: quality
  script:
    - pnpm turbo lint --filter=[${CI_MERGE_REQUEST_DIFF_BASE_SHA}...HEAD]

build:
  stage: build
  script: [pnpm turbo build]
  artifacts:
    paths: ["**/dist"]
    expire_in: 1 hour

test:
  stage: test
  parallel: 4
  script: [pnpm turbo test]
```

#### CircleCI with Test Splitting

```yaml
# .circleci/config.yml
version: 2.1
orbs:
  node: circleci/node@5

jobs:
  test:
    docker:
      - image: cimg/node:20.11
    parallelism: 4
    steps:
      - checkout
      - node/install-packages:
          pkg-manager: pnpm
      - run:
          name: Run sharded tests
          command: |
            TESTS=$(circleci tests glob "**/*.test.ts" | circleci tests split --split-by=timings)
            echo "$TESTS" | xargs pnpm vitest run
      - store_test_results:
          path: test-results
```

### 3.5 Docker Optimization for Deployments

```dockerfile
# Multi-stage build with dependency caching
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# Layer 1: Install dependencies (cached)
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/ui/package.json ./packages/ui/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile

# Layer 2: Build (only if deps change)
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

**Using `turbo prune` for minimal Docker context:**

```bash
# Creates ./out/ directory with only web + its dependencies
turbo prune web --docker
```

### 3.6 CI/CD Performance Benchmarks

| Strategy | Before | After | Improvement |
|----------|--------|-------|-------------|
| Full rebuild (no caching) | 15-25 min | — | Baseline |
| Turborepo remote cache hit | 15-25 min | 2-4 min | 80-85% |
| Nx affected (small change) | 15-25 min | 3-6 min | 70-80% |
| Test sharding (4 shards) | 8 min | 2.5 min | ~70% |
| Parallel lint + typecheck | 6 min (serial) | 2.5 min | ~60% |
| Artifact caching | 5 min | 1 min | ~80% |

### 3.7 CI/CD Trade-offs

| Strategy | Pros | Cons |
|----------|------|------|
| Turborepo remote cache | Zero-config, free tier, fast | Vercel lock-in concerns, cache invalidation complexity |
| Nx Cloud DTE | True distributed execution, agent-based | Paid service, additional infrastructure |
| Matrix builds | Cross-platform/version coverage | Exponential job count, longer wall-clock time |
| Test sharding | Parallelizes tests across runners | Requires shard-aware test runner, result merging |
| Affected analysis | Only builds/tests what changed | Requires accurate dependency graph, full git history |

---

## Unified Optimization Roadmap

### Phase 1: Foundation (Week 1–2) — High Impact, Low Effort

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 🔴 P0 | **Adopt pnpm workspaces** with `workspace:*` protocol | Medium | Low |
| 🔴 P0 | **Enable Turborepo** for task orchestration | Very High | Low-Med |
| 🔴 P0 | **Configure `turbo.json`** with correct task pipeline | High | Medium |
| 🔴 P0 | **Enable `skipLibCheck: true`** in all tsconfig.json files | High | Trivial |
| 🟡 P1 | **Enable Remote Caching** (Vercel or self-hosted) | Very High | Low |
| 🟡 P1 | **Configure `--frozen-lockfile`** in CI | High | Low |

**Quick-start `turbo.json`:**

```jsonc
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

### Phase 2: Build Performance (Week 3–4) — High Impact, Medium Effort

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 🔴 P0 | **Use tsup/SWC** for library compilation (keep tsc for type checking only) | High | Medium |
| 🟡 P1 | **Enable TypeScript `isolatedDeclarations`** | Medium | Low |
| 🟡 P1 | **Configure TypeScript project references** | High | Medium |
| 🟡 P1 | **Optimize IDE settings** — `.vscode/settings.json` with tsserver tuning | Medium | Low |
| 🟢 P2 | **Enable TypeScript batch mode** (if using Nx) | Medium | Low |
| 🟢 P2 | **Split tsconfig** into `tsconfig.ide.json` + `tsconfig.build.json` | Medium | Low |

### Phase 3: DX Optimization (Week 5–6) — Medium Impact, Medium Effort

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 🟡 P1 | **Set up Vite** for app dev servers with monorepo aliases + source imports | High | Medium |
| 🟡 P1 | **Configure ESLint flat config** with module boundary enforcement | Medium | Medium |
| 🟡 P1 | **Evaluate Biome** as ESLint + Prettier replacement | Medium | Low |
| 🟢 P2 | **Install Nx Console** / VS Code workspace settings | Low | Low |
| 🟢 P2 | **Enable Vitest workspace mode** for cross-package test discovery | Medium | Low |

### Phase 4: CI/CD Optimization (Week 7–8) — High Impact, High Effort

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 🔴 P0 | **Implement affected-based CI** (only build/test changed packages) | Very High | Medium |
| 🔴 P0 | **Enable build artifact caching** (dependency + build cache) | Very High | Medium |
| 🟡 P1 | **Add test sharding** (4× for unit, 3× for E2E) | High | Medium |
| 🟡 P1 | **Stage pipeline**: lint → typecheck → build → test → E2E | Medium | Medium |
| 🟡 P1 | **Add concurrency control** to cancel redundant CI runs | Medium | Low |
| 🟢 P2 | **Implement Nx Cloud DTE** (if using Nx at scale) | High | Medium |

### Phase 5: Advanced Optimization (Month 3+) — Medium Impact, High Effort

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| 🟢 P2 | **Self-hosted remote cache** (for data sovereignty) | Medium | High |
| 🟢 P2 | **Nx Agents** for distributed CI execution | High | High |
| 🟢 P2 | **Docker optimization** with multi-stage builds + `turbo prune` | Medium | Medium |
| 🟢 P3 | **Evaluate Rspack** as Webpack replacement | Medium | Medium |
| 🟢 P3 | **Module Federation** for micro-frontend builds | Medium | Very High |
| ⚪ P4 | **Turborepo Git Worktree cache sharing** | Low | Zero (auto) |

---

## Tool Comparison Matrices

### Build Orchestration

| Feature | Turborepo | Nx | Lerna + Nx |
|---------|-----------|-----|------------|
| **Setup Complexity** | ⭐ Very Low | ⭐⭐ Medium | ⭐⭐⭐ High |
| **Local Caching** | ✅ Yes | ✅ Yes | ✅ (via Nx) |
| **Remote Caching** | ✅ Free (Vercel) | ✅ Nx Cloud (paid) | ✅ (via Nx) |
| **Affected Analysis** | ✅ `--filter` | ✅ `affected` | ✅ (via Nx) |
| **Distributed Execution** | ❌ No | ✅ Nx Agents | ✅ (via Nx) |
| **Code Generation** | ⚠️ Basic | ✅ Generators | ✅ (via Nx) |
| **Module Boundaries** | ❌ No | ✅ Enforceable | ✅ (via Nx) |
| **Plugin Ecosystem** | Minimal | Rich | Minimal |
| **Package Publishing** | Manual/Changesets | Nx Release | Excellent |
| **Best For** | Small-Medium teams | Medium-Large enterprises | Package publishing |

### Compilation Tools

| Feature | tsc | SWC | esbuild | tsup | Rspack |
|---------|-----|-----|---------|------|--------|
| **Type Checking** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Speed (vs tsc)** | 1× | 20-70× | 10-100× | 10-100× | 5-10× |
| **Declaration Files** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes | ❌ No |
| **Incremental** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **Decorators** | ✅ Native | ✅ Yes | ❌ No | Via SWC | Via SWC |
| **Best For** | Type checking | Build pipeline | Server-side | Library bundling | Webpack replacement |

### Linting / Formatting

| Tool | Speed (10k files) | Lint | Format | TypeScript | Config |
|------|-------------------|------|--------|-----------|--------|
| ESLint + Prettier | ~57s | ✅ | ✅ | ✅ | Complex |
| **Biome** | **~1.8s** | ✅ | ✅ | ✅ | Simple |
| oxlint | ~0.8s | ✅ | ❌ | ✅ | Simple |

### Package Managers

| Tool | Install Speed | Workspace | Hoisting | Disk Usage |
|------|--------------|-----------|----------|-----------|
| **pnpm** | Fast | Native | Strict | Efficient |
| yarn berry | Fast | Native | Configurable | Efficient |
| npm | Slow | Native | Aggressive | High |
| bun | Very Fast | Native | Strict | Medium |

### CI Platforms

| Feature | GitHub Actions | GitLab CI | CircleCI | Nx Cloud |
|---------|---------------|-----------|----------|----------|
| **Free Tier** | 2000 min/mo | 400 min/mo | 6000 min/mo | Limited |
| **Matrix Builds** | ✅ Native | ✅ Native | ✅ Native | N/A |
| **Remote Cache** | ⚠️ Manual | ⚠️ Manual | ⚠️ Manual | ✅ Native |
| **DTE** | ❌ No | ❌ No | ❌ No | ✅ Native |

---

## Decision Framework

### Decision Tree

```
Are you starting a new monorepo?
├── YES → Do you need generators/plugins?
│   ├── YES → Use Nx (with Nx Cloud for CI)
│   └── NO → Use Turborepo (simpler, faster adoption)
│
└── NO (existing monorepo)
    ├── Are you on Lerna? → Migrate to Nx (`nx init`)
    ├── Are you on yarn/npm workspaces? → Add Turborepo first
    └── Are you on Nx already? → Enable Nx Cloud + DTE

For all setups, additionally:
├── Libraries → Use tsup/SWC for compilation
├── Apps → Use Vite for dev and build
├── Testing → Use Vitest with workspace mode
├── Linting → Evaluate Biome (30× faster than ESLint + Prettier)
└── CI → Implement affected-based + sharded pipeline
```

### Recommended Stack by Team Size

#### Solo / Small Team (1–5 developers)

```
pnpm + Turborepo + SWC + Vite + Biome
```

- Minimal overhead, fast feedback, easy to understand
- Free remote caching via Vercel
- Sub-second linting with Biome

#### Medium Team (5–20 developers)

```
pnpm + Turborepo (or Nx) + TypeScript Project Refs + Biome + GitHub Actions Matrix
```

- Remote caching for CI, affected builds, test sharding
- Split CI into fast (lint/typecheck) and slow (build/test) tracks
- Source imports for cross-package HMR

#### Large Team / Enterprise (20+ developers)

```
pnpm + Nx + Nx Cloud + TypeScript Project Refs + Biome + Nx Agents
```

- DTE for distributed CI, module boundary enforcement
- Affected analysis for precise CI targets
- Self-healing CI for flaky task retry
- Docker-optimized deployments with `turbo prune`

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
| **Lint time (full repo)** | < 3s | Biome |
| **CI cost** | < $500/month per team | GitHub billing |

---

## References

- [Turborepo Documentation](https://turborepo.dev/docs) — Caching, task running, filtering
- [Nx Documentation](https://nx.dev/getting-started/intro) — Mental model, caching, CI setup, DTE
- [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)
- [Vite Build Guide](https://vite.dev/guide/build.html) — Rolldown, multi-page, optimization
- [tsup Documentation](https://tsup.egoist.dev/) — Library bundling with DTS
- [SWC Documentation](https://swc.rs/docs/configuration) — Rust-based compilation
- [Biome Documentation](https://biomejs.dev/) — Unified linting and formatting
- [Vitest Workspace Mode](https://vitest.dev/guide/workspace.html) — Multi-package test discovery

---

*Generated: July 2025 | Unified from 3 parallel research streams | Next review: January 2026*
