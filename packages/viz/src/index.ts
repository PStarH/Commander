#!/usr/bin/env node

/**
 * Commander Viz — Lightweight execution topology visualizer.
 *
 * Usage:
 *   npx tsx packages/viz/src/index.ts              # read latest trace
 *   npx tsx packages/viz/src/index.ts --list        # list available traces
 *   npx tsx packages/viz/src/index.ts --file <path> # read specific trace
 *   npx tsx packages/viz/src/index.ts --run <id>    # read trace by run ID
 *   npx tsx packages/viz/src/index.ts --json        # output as JSON
 *   npx tsx packages/viz/src/index.ts --live        # live mode (requires MessageBus)
 */

import { listTraceFiles, readTraceFile, readLatestTrace } from './traceReader';
import { renderSnapshot } from './liveViewer';
import { renderSummary, buildTree, renderTree } from './topology';
import { fg, dim, bold, cursorShow, formatDuration, formatTokens } from './ansi';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { version: string };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp(exitCode = 0): void {
  console.log(`
${bold('commander-viz')} ${dim(pkg.version)} — execution topology visualizer

${bold('USAGE')}
  npx tsx packages/viz/src/index.ts [options]

${bold('OPTIONS')}
  --list           List available trace files
  --file <path>    Read a specific trace file
  --run <id>       Read trace by run ID (looks up in .commander_traces/)
  --json           Output as JSON instead of tree view
  --no-tokens      Hide token counts
  --no-timing      Hide timing info
  --live           Live mode (subscribes to MessageBus)
  --dir <path>     Traces directory (default: .commander_traces/)
  --help           Show this help
`);
  process.exit(exitCode);
}

function printVersion(): void {
  console.log(`commander-viz v${pkg.version}`);
  process.exit(0);
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const opts: CLIOptions = {
    mode: 'latest',
    showTokens: true,
    showTiming: true,
    asJson: false,
    tracesDir: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help':
        printHelp(0);
        break;
      case '--version':
        printVersion();
        break;
      case '--list':
        opts.mode = 'list';
        break;
      case '--json':
        opts.asJson = true;
        break;
      case '--no-tokens':
        opts.showTokens = false;
        break;
      case '--no-timing':
        opts.showTiming = false;
        break;
      case '--live':
        opts.mode = 'live';
        break;
      case '--file':
        opts.mode = 'file';
        opts.filePath = args[++i];
        break;
      case '--run':
        opts.mode = 'run';
        opts.runId = args[++i];
        break;
      case '--dir':
        opts.tracesDir = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp(1);
    }
  }

  return opts;
}

interface CLIOptions {
  mode: 'latest' | 'list' | 'file' | 'run' | 'live';
  showTokens: boolean;
  showTiming: boolean;
  asJson: boolean;
  tracesDir?: string;
  filePath?: string;
  runId?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  if (opts.mode === 'list') {
    const files = listTraceFiles(opts.tracesDir);
    if (files.length === 0) {
      console.log(dim('No trace files found in .commander_traces/'));
      process.exit(0);
    }
    console.log(fg('cyan', bold(`Found ${files.length} trace file(s):`)));
    console.log('');
    for (const f of files) {
      const sizeKb = (f.size / 1024).toFixed(1);
      console.log(
        `  ${fg('green', f.runId)} ${dim(`(${sizeKb}KB, ${f.modifiedAt.toISOString().slice(0, 16)})`)}`,
      );
    }
    process.exit(0);
  }

  if (opts.mode === 'live') {
    // Live mode requires MessageBus from core
    console.error(fg('yellow', 'Live mode requires Commander MessageBus.'));
    console.error(fg('yellow', 'Run: npx tsx packages/core/src/cli.ts watch "task"'));
    console.error(
      dim('  (Live mode via MessageBus subscription will be available in the next iteration)'),
    );
    console.error('');
    console.error(dim('For now, run without --live to read saved traces:'));
    console.error(dim('  npx tsx packages/viz/src/index.ts'));
    process.exit(1);
  }

  // --- File/run/latest modes ---
  let execData;

  if (opts.mode === 'file' && opts.filePath) {
    execData = readTraceFile(opts.filePath);
    if (!execData) {
      console.error(fg('red', `Failed to read trace file: ${opts.filePath}`));
      process.exit(1);
    }
  } else if (opts.mode === 'run' && opts.runId) {
    const dir = opts.tracesDir || process.cwd() + '/.commander_traces';
    execData = readTraceFile(`${dir}/${opts.runId}.ndjson`);
    if (!execData) {
      console.error(fg('red', `No trace found for run: ${opts.runId}`));
      process.exit(1);
    }
  } else {
    execData = readLatestTrace(opts.tracesDir);
    if (!execData) {
      console.error(fg('yellow', 'No trace files found.'));
      console.error(
        dim('  Run a Commander task first: npx tsx packages/core/src/cli.ts run "..."'),
      );
      console.error(dim('  Then view the execution topology: npx tsx packages/viz/src/index.ts'));
      process.exit(1);
    }
  }

  if (opts.asJson) {
    console.log(JSON.stringify(execData, null, 2));
    process.exit(0);
  }

  // Render
  const output = renderSnapshot(execData);
  console.log(output);
  console.log('');
  console.log(dim(`   ↑ topology view · ${execData.events.length} events processed`));
  console.log(dim(`     run: ${execData.runId}  |  agent: ${execData.agentId}`));
}

main().catch((err) => {
  console.error(fg('red', 'Fatal error:'), err);
  process.stderr.write(cursorShow);
  process.exit(1);
});
