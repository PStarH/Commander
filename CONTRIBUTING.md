# Contributing to Commander

We love contributions! Here's how to get started.

## Quick Start

```bash
git clone https://github.com/sampan/commander.git
cd commander
pnpm install
cd packages/core
npx tsx --test tests/*.test.ts  # Run tests
npx tsc --noEmit                # Type check
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

## Pull Request Process

1. Fork the repo
2. Create a feature branch
3. Run `cd packages/core && npx tsx --test tests/*.test.ts` - all passing
4. Run `npx tsc --noEmit` - clean
5. Submit PR with description of changes

## Code Style

- TypeScript strict mode
- Descriptive variable names over comments
- Tests for new features
- Keep it simple

## Questions?

Open an issue or join the community.
