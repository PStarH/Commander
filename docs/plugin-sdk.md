# Commander Plugin SDK

Build tools, skills, and hooks for the Commander agent platform.

## Quick Start

### 1. Create a Plugin

```bash
mkdir my-plugin && cd my-plugin
npm init -y
npm install @commander/plugin-sdk
```

Create `index.js`:

```javascript
const { createPlugin, defineTool, schema, stringProperty } = require('@commander/plugin-sdk');

module.exports = createPlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',

  async register(api) {
    api.registerTool(defineTool({
      name: 'hello',
      description: 'Say hello to someone',
      inputSchema: schema({
        name: stringProperty('Name to greet', { default: 'World' }),
      }),
      async execute(args) {
        return `Hello, ${args.name}!`;
      },
      isReadOnly: true,
    }));
  },
});
```

Create `commander.plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A cool plugin",
  "main": "index.js"
}
```

### 2. Install the Plugin

```bash
# From local directory
commander plugin install ./my-plugin

# From npm
commander plugin install @scope/commander-plugin-name

# From git
commander plugin install github:user/repo
```

### 3. Use It

The tool is now available to the LLM. When you ask Commander to "say hello to Alice", it will use your `hello` tool.

---

## Plugin Types

Commander supports three types of extensions:

### 1. Tools (Code Plugins)
The most powerful extension type. Tools are functions the LLM can invoke to perform actions.

**Use cases:** API integrations, data processing, file format support, external service connectors.

### 2. Skills (Prompt Plugins)
Markdown files that teach the agent how to perform specific tasks. No code required.

**Use cases:** Workflows, best practices, domain expertise, step-by-step guides.

### 3. Hooks (Event Plugins)
Event handlers that run at specific points in the execution pipeline.

**Use cases:** Logging, metrics, notifications, request modification, security auditing.

---

## Tool Plugins

### Defining a Tool

```javascript
const { defineTool, schema, stringProperty, numberProperty, booleanProperty } = require('@commander/plugin-sdk');

const myTool = defineTool({
  // Required: Tool definition
  definition: {
    name: 'my_tool',
    description: 'What this tool does. Be specific about when to use it.',
    inputSchema: schema({
      // Helper functions for common types
      query: stringProperty('Search query'),
      limit: numberProperty('Max results', { minimum: 1, maximum: 100, default: 10 }),
      verbose: booleanProperty('Enable verbose output', false),
    }, ['query']),  // ['query'] = required fields
    category: 'web',  // Optional: helps with tool selection
    examples: [       // Optional: few-shot examples for the LLM
      { name: 'example1', arguments: { query: 'AI agents' } },
    ],
  },

  // Required: Execute function
  async execute(args) {
    const { query, limit, verbose } = args;
    // ... do something ...
    return JSON.stringify({ results: [...] });
  },

  // Optional: Safety flags
  isReadOnly: true,        // No side effects (allows speculative execution)
  isConcurrencySafe: true, // Can run in parallel with other safe tools
  timeout: 30000,          // Max execution time in ms
  maxOutputSize: 10000,    // Max output size in chars
});
```

### Tool Naming Convention

Tools are automatically prefixed with the plugin id to avoid collisions:
- Plugin `web-scraper`, tool `scrape_page` → registered as `web-scraper__scrape_page`
- The LLM sees the prefixed name; users can refer to the short name

### JSON Schema Helpers

```javascript
const { schema, stringProperty, numberProperty, booleanProperty } = require('@commander/plugin-sdk');

// Create an object schema
const mySchema = schema({
  name: stringProperty('User name'),
  age: numberProperty('User age', { minimum: 0, maximum: 150 }),
  active: booleanProperty('Is active', true),
  role: stringProperty('User role', { enum: ['admin', 'user', 'guest'] }),
}, ['name']);  // 'name' is required
```

### Tool Categories

Common categories: `web`, `filesystem`, `code`, `memory`, `development`, `multimodal`, `general`.

---

## Skills

Skills are markdown files that teach the agent how to perform tasks. No code required.

### Creating a Skill

Create a directory with a `SKILL.md` file:

```
~/.commander/skills/my-skill/
  SKILL.md              # Required: skill content
  scripts/              # Optional: helper scripts
  references/           # Optional: reference docs
```

### SKILL.md Format

```markdown
---
name: my-skill
description: "When to trigger this skill. Be specific about the user's intent."
version: "1.0.0"
author: "Your Name"
argument-hint: <topic>
allowed-tools: web_search web_fetch file_write
metadata:
  category: research
  tags: [research, analysis]
  source: community
  quality_score: 0.8
---

# Skill Title

Instructions for the agent when this skill is activated.

## Steps
1. Do this first
2. Then do this
3. Finally do this

## Output Format
Describe the expected output format.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique skill identifier (lowercase, hyphens) |
| `description` | Yes | When to trigger (used for auto-matching) |
| `version` | No | Semver version |
| `author` | No | Skill author |
| `license` | No | License identifier |
| `argument-hint` | No | Hint for arguments (e.g., `<topic>`) |
| `allowed-tools` | No | Space-separated list of tools this skill can use |
| `metadata.category` | No | Category: coding, research, analysis, writing, strategy, general |
| `metadata.tags` | No | Tags for discovery |
| `metadata.source` | No | Source: builtin, learned, community, user |
| `metadata.quality_score` | No | Quality score 0-1 |

### Triggering Skills

- **Auto-trigger:** The LLM matches the `description` field to the user's intent
- **Manual trigger:** User types `/skill-name <args>`
- **CLI trigger:** `commander skill run skill-name <args>`

### Installing Skills

```bash
# From git
commander skill install github:user/my-skill

# From local directory
commander skill install ./path/to/skill

# List installed skills
commander skill list
```

---

## Hooks

Hooks run at specific points in the execution pipeline.

### Available Hook Points

| Hook | When It Fires |
|------|---------------|
| `beforeToolCall` | Before a tool executes. Return non-null to block. |
| `afterToolCall` | After a tool executes. Can modify the result. |
| `beforeLLMCall` | Before an LLM call. Can modify the request. |
| `afterLLMCall` | After an LLM call. Can modify the response. |
| `onAgentStart` | When an agent starts execution. |
| `onAgentComplete` | When an agent completes execution. |
| `onError` | When an error occurs. |
| `beforeToolResolve` | Before resolving a tool from the registry. |
| `afterToolResolve` | After resolving a tool. |
| `onToolTimeout` | When a tool execution times out. |
| `onToolRetry` | Before retrying a failed tool call. |
| `beforeContextCompaction` | Before context compaction. |
| `afterContextCompaction` | After context compaction. |
| `onSessionFork` | When a sub-agent is spawned. |
| `onSessionArchive` | When a session is archived. |
| `onStepStart` | When an execution step starts. |
| `onStepComplete` | When an execution step completes. |
| `beforeBackendSelect` | Before selecting a backend for a tool. |
| `afterBackendSelect` | After selecting a backend. |

### Subscribing to Hooks

```javascript
module.exports = createPlugin({
  id: 'my-hooks',
  name: 'My Hooks',
  version: '1.0.0',

  async register(api) {
    // Subscribe to a hook
    api.on('afterToolCall', async (ctx) => {
      api.logger.info(`Tool ${ctx.toolName} took ${ctx.result.durationMs}ms`);
    });

    // "before" hooks can block execution by returning non-null
    api.on('beforeToolCall', async (ctx) => {
      if (ctx.toolName === 'dangerous_tool') {
        return { blocked: true, reason: 'This tool is disabled' };
      }
      return null; // Allow execution
    });
  },
});
```

---

## Plugin Configuration

Plugins can declare a configuration schema. Users override config in `.commander.json`.

### Declaring Config Schema

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "description": "API key for the service" },
      "timeout": { "type": "number", "default": 30000 },
      "enabled": { "type": "boolean", "default": true }
    },
    "required": ["apiKey"]
  }
}
```

### Reading Config

```javascript
async register(api) {
  const apiKey = api.config.apiKey;
  const timeout = api.config.timeout || 30000;
  // ...
}
```

### User Override

In `.commander.json`:

```json
{
  "plugins": {
    "my-plugin": {
      "apiKey": "sk-...",
      "timeout": 60000
    }
  }
}
```

---

## Security Model

### Tool Approval

All plugin tools inherit Commander's approval system:
- `read-only` mode: blocks write tools
- `plan` mode: blocks write and destructive tools
- `suggest` mode: prompts for destructive tools
- `full-auto` allows everything

Plugin tools default to `semi_auto` approval — the user is prompted on first execution.

### Hook Safety

- All hooks have a 5-second timeout
- `required: true` plugins cause hook failures to abort the operation
- Hook failures in non-required plugins are logged and swallowed

### Filesystem Sandboxing

Plugin tools are subject to `safePath()` — all file operations are confined to the workspace.

---

## Distribution

### npm

```bash
# Publish to npm
npm publish --access public

# Users install with
commander plugin install @scope/commander-plugin-name
```

**Package requirements:**
- `commander.plugin.json` in package root
- `keywords` includes `commander-plugin`
- Entry point exports a `CommanderPluginDef`

### Git

```bash
# Users install with
commander plugin install github:user/repo
```

### Local

```bash
# Users install with
commander plugin install ./path/to/plugin
```

---

## API Reference

### `createPlugin(def)`

Creates a plugin definition with validation.

```typescript
import { createPlugin } from '@commander/plugin-sdk';

export default createPlugin({
  id: 'my-plugin',      // Required: unique identifier
  name: 'My Plugin',    // Required: human-readable name
  version: '1.0.0',     // Required: semver version
  description: '...',   // Optional
  author: '...',        // Optional
  license: 'MIT',       // Optional
  keywords: [],         // Optional: for discovery
  dependsOn: [],        // Optional: plugin dependencies
  register: async (api) => { ... },  // Required
  unregister: async () => { ... },   // Optional: cleanup
});
```

### `defineTool(tool)`

Creates a tool definition with validation.

### `schema(properties, required?)`

Creates a JSON Schema object.

### `stringProperty(description?, opts?)`

Creates a string property schema.

### `numberProperty(description?, opts?)`

Creates a number property schema.

### `booleanProperty(description?, default?)`

Creates a boolean property schema.

### `CommanderPluginAPI`

The API object passed to `register(api)`:

| Method | Description |
|--------|-------------|
| `api.registerTool(tool)` | Register a tool |
| `api.unregisterTool(name)` | Unregister a tool |
| `api.on(event, handler)` | Subscribe to a hook |
| `api.off(event, handler)` | Unsubscribe from a hook |
| `api.registerCommand(name, opts)` | Register a CLI command |
| `api.config` | Plugin configuration |
| `api.logger` | Structured logger |
| `api.runtime` | Runtime access (workspace, version) |

---

## Examples

See the `examples/` directory in the Commander repository:

- `examples/plugins/hello-world/` — Minimal plugin example
- `examples/plugins/web-scraper/` — Complete tool plugin with config
- `examples/skills/deep-research/` — Complete skill example

---

## Comparison with OpenClaw

| Feature | OpenClaw | Commander Plugin SDK |
|---------|----------|---------------------|
| Tool registration | `api.registerTool()` | `api.registerTool()` |
| Hook system | `api.on('before_tool_call')` | `api.on('beforeToolCall')` |
| Skills | `SKILL.md` with frontmatter | `SKILL.md` with frontmatter (compatible) |
| CLI commands | `api.registerCli()` | `api.registerCommand()` |
| Config | `openclaw.plugin.json` | `commander.plugin.json` |
| Distribution | npm + ClawHub + git | npm + git |
| Type safety | TypeScript SDK | TypeScript SDK + JSON Schema validation |
| Two-tier loading | No | Yes (95% token savings) |
| Hook timeout | No | 5s default |
