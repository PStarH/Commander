# Commander Examples

Runnable examples to help you get started with Commander.

## Prerequisites

```bash
git clone https://github.com/PStarH/Commander.git
cd Commander
pnpm install
# Set at least one API key
export OPENAI_API_KEY=sk-...
```

## Examples

| Example | Description | Run |
|---------|-------------|-----|
| `basic.ts` | Single-agent task — ask Commander a question | `npx tsx examples/basic.ts` |
| `streaming.ts` | Streaming mode — see agent reasoning in real-time | `npx tsx examples/streaming.ts` |
| `multi-agent.ts` | Debate topology — two agents debate a topic | `npx tsx examples/multi-agent.ts` |

## Running

```bash
# Basic single-agent task
npx tsx examples/basic.ts

# With streaming output
npx tsx examples/streaming.ts

# Multi-agent debate
npx tsx examples/multi-agent.ts
```

Each example will use whatever API key you have set (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.). Commander auto-detects your provider.
