# @commander/mcp-server

Publishable MCP (Model Context Protocol) server for Commander. Exposes Commander tools over line-delimited stdin/stdout JSON-RPC so any MCP client (Claude Desktop, Cursor, etc.) can call them.

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

By default the server registers:

- `execute_agent` — run a goal against the Commander runtime
- `list_models` — list models and tiers from the model router
- `route_task` — preview which tier a task would be routed to
- All built-in Commander tools returned by `createAllTools()`, with dangerous tools filtered out unless `--allow-dangerous-tools` is passed

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
