# Commander Python SDK

[![PyPI](https://img.shields.io/pypi/v/commander-ai)](https://pypi.org/project/commander-ai/)
[![Python](https://img.shields.io/pypi/pyversions/commander-ai)](https://pypi.org/project/commander-ai/)
[![License](https://img.shields.io/pypi/l/commander-ai)](LICENSE)

Python SDK for [Commander](https://github.com/PStarH/Commander) - multi-agent orchestration via HTTP.

```
pip install commander-ai
```

## Quick Start

```python
import asyncio
from commander import CommanderClient

async def main():
    async with CommanderClient(
        api_key="cmd-...",
        base_url="http://localhost:3001",
    ) as client:
        # Zero-cost planning
        plan = await client.plan("audit repository for security vulnerabilities")
        print(f"Topology: {plan.topology}")
        print(f"Budget: ${plan.estimate.cost_budget_usd:.2f}")

        # Execute
        result = await client.run("list all Python files")
        print(f"Status: {result.status}")

asyncio.run(main())
```

## API

| Method | Description |
|--------|-------------|
| `client.run(prompt, ...)` | Execute an agent task |
| `client.plan(task, ...)` | Zero-cost deliberation (no LLM call) |
| `client.stream(session_id)` | SSE event stream for a running session |
| `client.memory_write(content, ...)` | Write to memory |
| `client.memory_query(...)` | Query memory |
| `client.memory_stats()` | Memory statistics |
| `client.health()` | Liveness probe |
| `client.health_detailed()` | Detailed component health |
| `client.system_status()` | System status |
| `client.metrics()` | OpenMetrics text |

## Streaming

```python
async for event in client.stream(session_id):
    if event.event == "output.delta":
        print(event.data["content"], end="", flush=True)
    elif event.event == "agent.status":
        print(f"\n[{event.data['status']}]")
    elif event.event == "tool_call.started":
        print(f"\n[Tool: {event.data['toolName']}]")
```

Event types: `output.delta`, `output.completed`, `agent.status`, `reasoning.delta`, `tool_call.started/completed/delta/timeout/retry/blocked`, `error.occurred`, `state.sync`, `cost.update`, `compensation.update`.

## Sync Wrapper

For scripts and non-async contexts:

```python
from commander import CommanderClientSync

client = CommanderClientSync(api_key="cmd-...", base_url="http://localhost:3001")
result = client.run("analyze this")
client.close()
```

Not for Jupyter/notebooks — use `CommanderClient` with `asyncio` there.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMMANDER_API_KEY` | — | API key for Bearer auth |
| — | `http://localhost:3001` | Commander server base URL |

## Architecture

```
Python SDK → HTTP → Commander Server → Runtime
```

The SDK is a thin `httpx` client — no Python-side runtime porting.

## Development

```bash
git clone https://github.com/PStarH/Commander.git
cd packages/python-sdk
pip install -e ".[dev]"
python -m pytest tests/ -v
```

## License

MIT
