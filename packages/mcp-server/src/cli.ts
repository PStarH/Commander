#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertActionGatewayConfigured, startStdioServer } from './stdioServer';

const HELP = `
commander-mcp-server

A publishable MCP server that exposes Commander tools over stdin/stdout JSON-RPC.

Usage:
  commander-mcp-server [options]

Options:
  --name <name>              Server name advertised during MCP initialization (default: commander-mcp-server)
  --version <version>        Server version advertised during MCP initialization (default: 0.2.0)
  --model-router-only        Only register the lightweight model-router tools
  --allow-dangerous-tools    Expose dangerous built-in tools such as shell_execute
  --help                     Show this help message
`;

function parseArgs(argv: string[]): {
  name?: string;
  version?: string;
  modelRouterOnly?: boolean;
  allowDangerousTools?: boolean;
  help?: boolean;
} {
  const args = argv.slice(2);
  const options: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--name':
        options.name = args[++i];
        break;
      case '--version':
        options.version = args[++i];
        break;
      case '--model-router-only':
        options.modelRouterOnly = true;
        break;
      case '--allow-dangerous-tools':
        options.allowDangerousTools = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function run(argv: string[] = process.argv): void {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP.trim() + '\n');
    process.exit(0);
  }

  try {
    assertActionGatewayConfigured(process.env, {
      allowDangerousTools: options.allowDangerousTools === true,
    });
  } catch (err) {
    process.stderr.write(
      `[commander-mcp-server] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  startStdioServer({
    name: options.name,
    version: options.version,
    modelRouterOnly: options.modelRouterOnly,
    allowDangerousTools: options.allowDangerousTools,
  });

  process.stderr.write(
    `[commander-mcp-server] Started ${options.name ?? 'commander-mcp-server'} (${options.version ?? '0.2.0'})\n`,
  );
}

/** True when this ESM module was launched as the CLI entrypoint. */
export function isDirectCliInvocation(moduleUrl: string, argv1 = process.argv[1]): boolean {
  return Boolean(argv1) && fileURLToPath(moduleUrl) === resolve(argv1!);
}

if (isDirectCliInvocation(import.meta.url)) {
  run();
}
