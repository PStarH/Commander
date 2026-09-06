# @commander/mcp-server

Publishable MCP (Model Context Protocol) server for Commander. Exposes Commander tools over line-delimited stdin/stdout JSON-RPC so any MCP client (Claude Desktop, Cursor, etc.) can call them.

> **Alpha / non-production-ready:** the default tools call a configured
> Commander Action Gateway and can initiate governed state changes. Review
> [PRIVACY.md](../../PRIVACY.md), use a scoped API key, and keep the local
> development surface disabled outside an isolated evaluation.

## Installation

```bash
pnpm add @commander/mcp-server
# or
npm install @commander/mcp-server
```

## Usage

### As a CLI

The package installs a `commander-mcp-server` binary:

```bash
COMMANDER_ACTION_GATEWAY_URL=https://commander.example \
COMMANDER_API_KEY=... \
commander-mcp-server
```

Options:

| Flag                      | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `--name <name>`           | Server name advertised during MCP initialization        |
| `--version <version>`     | Server version advertised during MCP initialization     |
| `--model-router-only`     | Only register the lightweight model-router tools        |
| `--allow-dangerous-tools` | Expose dangerous built-in tools such as `shell_execute` |
| `--help`                  | Show help                                               |

### Programmatic

```typescript
import { createStdioMcpServer, startStdioServer } from '@commander/mcp-server';

const { server, status } = createStdioMcpServer();
console.log(`Exposing ${status.tools.length} tools`);

// Or start reading from process.stdin automatically:
const { stop } = startStdioServer({ modelRouterOnly: false });
```

### Wiring into an MCP client config

```json
{
  "mcpServers": {
    "commander": {
      "command": "commander-mcp-server",
      "args": []
    }
  }
}
```

## Tools

By default the server registers eight Action Gateway tools:

- `commander_action_simulate`
- `commander_action_propose`
- `commander_action_get`
- `commander_action_approve`
- `commander_action_compensation_request`
- `commander_action_compensation_approve`
- `commander_action_reconcile`
- `commander_action_evidence`

Set `COMMANDER_ACTION_GATEWAY_URL` to make these tools callable. Without it,
calls fail closed with `ACTION_GATEWAY_REQUIRED`; no local or in-memory write
fallback is used.

For local development only, `COMMANDER_MCP_LOCAL_RUNTIME=1` exposes
`execute_agent`, `list_models`, `route_task`, and the built-in Commander tools.
That `execute_agent` surface currently returns a simulated result and does not
call an LLM provider. `--model-router-only` narrows this development surface to
the three model-router tools. `--allow-dangerous-tools` additionally requires a
configured Action Gateway.

## HTTP API (when used inside `@commander/api`)

The `@commander/api` package mounts the MCP router at `/mcp` and exposes:

- `POST /mcp` — JSON-RPC 2.0 endpoint
- `GET /.well-known/mcp` — capability discovery
- `GET /mcp/status` — server status and tool inventory
- `POST /mcp/discover` — discover an external MCP server

## Development

```bash
# Build
pnpm run build

# Test
pnpm run test

# Publish
pnpm run prepublishOnly
```

## License

MIT
