# Contributing to Commander

We love contributions! Here's how to get started.

## Quick Start

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
pnpm install
cd packages/core
pnpm test              # Run all tests (node:test + vitest)
pnpm test:core         # Core package tests only
npx tsc --noEmit       # Type check
pnpm lint              # ESLint check
pnpm build:core        # Build the core package
```

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
3. Run `cd packages/core && npx tsx --test tests/*.test.ts` - all passing
4. Run `npx tsc --noEmit` - clean
5. Run `pnpm --filter @commander/sdk typecheck` - clean
6. Submit PR with description of changes

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
- `pnpm lint` — ESLint with no-console enforcement
- `pnpm test` — All tests passing (node:test + vitest)
- `pnpm build:core` — Core package builds successfully
- CI cross-platform matrix: Ubuntu, macOS, Windows × Node 20, 22

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
