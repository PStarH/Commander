# Contributing to Commander

We love contributions! Here's how to get started.

## Quick Start

### 5-minute Setup Verification

Run these commands to verify your development environment is ready:

```bash
# 1. Clone and install
git clone https://github.com/PStarH/Commander.git
cd Commander
pnpm install

# 2. Verify the CLI works (no API key needed)
npx tsx packages/core/src/cli.ts status
# Expected: shows system status with runtime ready

# 3. Run core unit tests (fast, <30s, no API key needed)
cd packages/core && npx vitest run --no-cache tests/ultimate/deliberation.test.ts
# Expected: all tests pass

# 4. Full test suite (~90s)
pnpm test

# 5. Type check
cd packages/core && npx tsc --noEmit

# 6. Build
cd packages/core && pnpm build
```

**Troubleshooting:**

- `pnpm install` fails → ensure you have Node >=18 and pnpm >=9 (`node --version && pnpm --version`)
- `better-sqlite3` errors → run `pnpm rebuild better-sqlite3` (optional dependency, tests will skip if missing)
- No API key? → The CLI status command and most unit tests work without one. Only integration tests require a key.

## Test Categories

Tests are categorized by their dependencies and runtime:

| Category        | Command                                                | Runtime | API Key Needed? | Description                                            |
| --------------- | ------------------------------------------------------ | ------- | --------------- | ------------------------------------------------------ |
| **Unit**        | `pnpm --filter @commander/core test:quick`             | <30s    | No              | Core logic, deliberation, topology, quality gates      |
| **Core**        | `pnpm --filter @commander/core test`                   | ~90s    | No              | All core tests (unit + runtime, including adversarial) |
| **Full**        | `cd packages/core && npx vitest run --no-cache`        | ~80s    | No              | All vitest tests (143 files, 2400+ tests)              |
| **Integration** | `pnpm --filter @commander/core test:node:pathsec`      | ~30s    | No              | Security path scanning tests                           |
| **Adversarial** | `pnpm --filter @commander/core test:security`          | ~10s    | No              | Security adversarial tests (33 tests)                  |
| **E2E**         | `cd packages/core && npx tsx --test tests/e2e.test.ts` | varies  | Yes             | End-to-end tests with real LLM calls                   |

### Running Specific Categories

```bash
# Quick unit tests (what you want during development)
cd packages/core && pnpm test:quick

# Full core test suite
pnpm --filter @commander/core test

# Type check only
cd packages/core && npx tsc --noEmit

# API app tests
pnpm --filter @commander/api test
```

## Versioning

Commander follows [Semantic Versioning](https://semver.org/):

- **Major** (1.x): Breaking changes to public API or CLI interface
- **Minor** (0.x): New features, topology additions, provider support
- **Patch** (0.x): Bug fixes, performance improvements, documentation

The core packages (`@commander/core`, `@commander/sdk`) are versioned independently from the apps (`@commander/api`, `@commander/web`). The monorepo root version tracks the core package.

## What We Need Help With

### 🎯 High Priority

- **Channel adapters**: WhatsApp, Telegram, Discord, Slack integrations
- **Tool improvements**: Better web search, PDF parsing, image analysis
- **Documentation**: Tutorials, API docs, example projects

### 🧪 Testing

- **More benchmarks**: Run Commander on your own datasets
- **Integration tests**: End-to-end workflows with real LLM APIs
- **Performance profiling**: Find and fix bottlenecks

### 🌐 Community

- **Translations**: README and docs in other languages
- **Showcases**: Build something cool with Commander and share it
- **Tutorials**: Video tutorials, blog posts, example repos

## Contributor License Agreement

By submitting a pull request, you grant the project license to use your contribution under the MIT license. You represent that you own the rights to your contribution.

## Pull Request Process

1. Fork the repo
2. Create a feature branch
3. Run `cd packages/core && pnpm test` - all 2400+ tests passing (2 benchmark timing threshold tests may flake on slow CI runners; they are pre-existing and unrelated to your changes)
4. Run `npx tsc --noEmit` - clean
5. Run `pnpm --filter @commander/sdk typecheck` - clean
6. Run `pnpm format:check` - clean (broader scope: `packages/**`, `apps/**`, `scripts/**`)
7. Submit PR with description of changes

## Code Style

- TypeScript strict mode
- Descriptive variable names over comments
- Tests for new features
- Keep it simple

## Development Workflow

### Branch Strategy

1. Fork the repository
2. Create a feature branch from `main`: `git checkout -b feat/your-feature`
3. Make your changes with conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
4. Push and create a PR against `main`

### Quality Gates (all must pass before merge)

- `pnpm typecheck` — TypeScript strict mode, zero errors
- `pnpm lint` — ESLint with no-console enforcement + `pnpm format:check`
- `pnpm test` — All tests passing (node:test + vitest)
- `pnpm build:core` — Core package builds successfully
- `pnpm format:check` — Prettier clean across `packages/**`, `apps/**`, `scripts/**`
- **Local git hooks** — pre-commit (security gating) and pre-push (Prettier
  baseline) automatically enforce security + style on each `git commit` / `git push`.
  Install via `bash scripts/install-hooks.sh`.
- CI cross-platform matrix: Ubuntu, macOS, Windows × Node 20, 22

### Local Git Hooks (D3 hardening-sprint)

The repository ships two layered git hooks installed via `bash scripts/install-hooks.sh`:

- **`.githooks/pre-commit`** → `scripts/precommitHook.ts` — Security gate:
  SupplyChainScanner inline-blocklist mirror + ExecPolicy vitest smoke. Bypass
  with `COMMANDER_SKIP_PRECOMMIT=1` (logged). Purpose: block malware-class
  content from local commits with high certainty, low noise.
- **`.githooks/pre-push`** → `scripts/prepushHook.ts` — Style gate:
  `pnpm exec prettier --check` across the development surface
  (`packages/core/src`, `packages/core/tests`, `apps/api/src`, `apps/web/src`,
  `scripts`). Bypass with `COMMANDER_SKIP_PREPUSH=1` (logged). Purpose: catch
  Prettier drift before remote CI rejects it.

Both hooks exit non-zero on failure, blocking their respective git phases.
They share a common bash wrapper pattern (PATH-export per commit 4fd97dea7
so pnpm-resolved binaries don't fall back to network fetch). The push-side
check is intentionally broader than the source-only `format:check` script
to close the cross-file reflow gap that allowed commit 765b41430's style
bypass to ship.

### Adding New Tests

Tests use two runners:

- **node:test** for most tests in `packages/core/tests/` — use `describe`/`it` from `node:test` and `assert` from `node:assert`
- **Vitest** for runtime tests in `packages/core/tests/runtime/` — use `describe`/`it`/`expect` from `vitest`

When adding a new source module, add a corresponding test file following the naming convention: `src/foo.ts` → `tests/foo.test.ts`.

### Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system architecture overview.

## Community

- **GitHub Discussions**: Ask questions, share ideas, show what you've built
- **Issues**: Report bugs or request features using the issue templates
- **Security**: Report vulnerabilities privately per [SECURITY.md](SECURITY.md) — never through public issues

## Questions?

Open an issue or start a discussion on GitHub.
