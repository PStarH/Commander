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

| Flag                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `--name <name>`           | Server name advertised during MCP initialization       |
| `--version <version>`     | Server version advertised during MCP initialization    |
| `--model-router-only`     | Only register model-router tools in local runtime mode |
| `--allow-dangerous-tools` | Expose dangerous local tools in local runtime mode     |
| `--help`                  | Show help                                              |

### Programmatic

```typescript
import { createStdioMcpServer, startStdioServer } from '@commander/mcp-server';

const { server, status } = createStdioMcpServer(); // governed Action Gateway surface
console.log(`Exposing ${status.tools.length} tools`);

// Or explicitly enable the local Commander runtime for development:
const { stop } = startStdioServer({ localRuntime: true, modelRouterOnly: false });
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

By default the server registers only governed Action Gateway tools:

- `commander_action_simulate` — preview a governed action
- `commander_action_propose` — submit a governed action for policy and approval
- `commander_action_get` — retrieve a governed action
- `commander_action_evidence` — retrieve a terminal action's evidence bundle

Clients submit a registered `action` and its `args`; the server derives the
tool, effect type, destination, provenance, and idempotency key. Approval,
rejection, and reconciliation remain human-only API operations.

Set `COMMANDER_MCP_LOCAL_RUNTIME=1` (or `localRuntime: true` programmatically)
to expose the local model-router and Commander tool surface for development.

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
