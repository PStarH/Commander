import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { getConfigResolver } from '../../config/configResolver';
import { getFreezeDryManager } from '../../runtime/freezeDry';
import { getMetricsCollector } from '../../runtime/metricsCollector';
import { $, section } from './_shared';
import { cmdRun } from './core';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export async function cmdUp(args: string[], flags: Record<string, string>): Promise<void> {
  const resumeMode = !!flags['resume'];
  const noOpen = !!flags['no-open'];
  const port = flags['port'] ? parseInt(flags['port'], 10) : 4000;

  const task = args.join(' ').trim();

  if (resumeMode) {
    return cmdResumeUp();
  }

  console.log(
    `\n  ${$.bold}${$.blue}╭──────────────────────────────────────────────────────╮${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander Up${$.reset} — Unified Execution + Web TUI      ${$.bold}${$.blue}│${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}╰──────────────────────────────────────────────────────╯${$.reset}\n`,
  );

  const config = getConfigResolver().resolve();
  if (!config.apiKey && config.provider !== 'none') {
    console.log(`  ${$.yellow}⚠ No API key found for ${config.provider}.${$.reset}`);
    console.log(
      `  ${$.dim}  Run ${$.cyan}commander init --probe${$.reset}${$.dim} to configure.${$.reset}\n`,
    );
  }

  if (task) {
    console.log(`  ${$.dim}Task:${$.reset} ${task}\n`);
  }

  const webDist = path.join(process.cwd(), 'apps', 'web', 'dist');
  const hasWebDist = fs.existsSync(webDist);

  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/api/metrics/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(
        `data: ${JSON.stringify({ type: 'snapshot', metrics: getMetricsCollector().getMetricsSnapshot() })}\n\n`,
      );
      sseClients.add(res);
      const interval = setInterval(() => {
        try {
          res.write(
            `data: ${JSON.stringify({ type: 'snapshot', metrics: getMetricsCollector().getMetricsSnapshot() })}\n\n`,
          );
        } catch {
          clearInterval(interval);
        }
      }, 1000);
      req.on('close', () => {
        clearInterval(interval);
        sseClients.delete(res);
      });
      return;
    }

    if (!hasWebDist) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'commander-up' }));
      return;
    }
    let filePath = path.join(webDist, url === '/' ? 'index.html' : url);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(webDist)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
      if (err) {
        fs.readFile(path.join(webDist, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data2);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  let serverPort = port;
  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        serverPort++;
        server.listen(serverPort);
      } else {
        reject(err);
      }
    });
    server.listen(serverPort, '127.0.0.1', () => resolve());
  });

  const tuiUrl = `http://localhost:${serverPort}`;
  if (hasWebDist) {
    console.log(`  ${$.green}✓${$.reset} Web TUI: ${$.cyan}${tuiUrl}${$.reset}`);
  } else {
    console.log(
      `  ${$.dim}○ Web TUI: ${tuiUrl} (API only — build with ${$.cyan}cd apps/web && npx vite build${$.reset}${$.dim})${$.reset}`,
    );
  }
  console.log(`  ${$.dim}  Press Ctrl+C to stop and freeze execution${$.reset}\n`);

  if (!noOpen && hasWebDist) {
    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(openCmd, [tuiUrl], { stdio: 'ignore', detached: true }).unref();
  }

  const cleanup = () => {
    server.close();
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  if (task) {
    await cmdRun(task, { ...flags, 'up-mode': 'true' });
    server.close();
    console.log(`  ${$.green}✓${$.reset} Task complete. Web TUI at ${$.cyan}${tuiUrl}${$.reset}\n`);
    console.log(`  ${$.dim}Press Ctrl+C to exit.${$.reset}\n`);
    await new Promise(() => {});
  } else {
    await new Promise(() => {});
  }
}

async function cmdResumeUp(): Promise<void> {
  const stateDir = path.join(process.cwd(), '.commander_state');
  const manifestPath = path.join(stateDir, 'freeze.manifest.json');

  if (!fs.existsSync(manifestPath)) {
    section('NO FREEZE FOUND');
    const runs = listCheckpointDirs(stateDir);
    if (runs.length > 0) {
      console.log(`  ${$.dim}No freeze manifest, but checkpoint dirs exist:${$.reset}`);
      for (const r of runs) {
        console.log(`    ${$.cyan}${r}${$.reset}`);
      }
      console.log(`\n  ${$.dim}Resume with: ${$.cyan}commander resume <runId>${$.reset}\n`);
    } else {
      console.log(`  ${$.yellow}No frozen runs or checkpoints found. Starting fresh.${$.reset}\n`);
    }
    return;
  }

  let manifest: { runs: string[]; frozenAt: string };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    console.log(`  ${$.red}Failed to read freeze manifest.${$.reset}\n`);
    return;
  }

  const runCount = manifest.runs?.length ?? 0;
  if (runCount === 0) {
    console.log(`  ${$.yellow}Freeze manifest is empty.${$.reset}\n`);
    fs.unlinkSync(manifestPath);
    return;
  }

  section('FREEZE DETECTED');
  console.log(
    `  ${$.cyan}${runCount} run(s)${$.reset} frozen at ${$.dim}${manifest.frozenAt}${$.reset}\n`,
  );

  for (const runId of manifest.runs) {
    const cpPath = path.join(stateDir, runId, 'checkpoint.json');
    if (!fs.existsSync(cpPath)) {
      console.log(`  ${$.yellow}⚠ Checkpoint missing for ${runId}, skipping.${$.reset}`);
      continue;
    }
    let cp: { stepNumber?: number; phase?: string; context?: { goal?: string } };
    try {
      cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    } catch {
      console.log(`  ${$.yellow}⚠ Corrupt checkpoint for ${runId}, skipping.${$.reset}`);
      continue;
    }
    const goal = cp.context?.goal ?? '(unknown)';
    const stepInfo = cp.stepNumber != null ? `step ${cp.stepNumber}` : (cp.phase ?? '(unknown)');
    console.log(`  ${$.green}►${$.reset} ${$.bold}${runId}${$.reset}`);
    console.log(`    ${$.dim}Goal:${$.reset} ${goal.slice(0, 100)}`);
    console.log(`    ${$.dim}State:${$.reset} ${stepInfo}`);
    console.log(`    ${$.dim}Resuming...${$.reset}\n`);

    const { AgentRuntime } = await import('../../runtime/agentRuntime');
    const runtime = new AgentRuntime();
    const result = await runtime.resume(runId);
    if (!result) {
      console.log(
        `  ${$.red}✗ Resume failed for ${runId} (lease lost or missing checkpoint)${$.reset}\n`,
      );
      continue;
    }
    console.log(
      `  ${$.green}✓${$.reset} ${runId} recovered — ${result.completedToolCallIds.size} completed tool calls skipped\n`,
    );
  }

  try {
    const archived = manifestPath + '.archived';
    fs.renameSync(manifestPath, archived);
    console.log(`  ${$.dim}Freeze manifest archived to ${archived}${$.reset}\n`);
  } catch {
    void 0;
  }

  console.log(
    `  ${$.green}✓${$.reset} All runs recovered. Use ${$.cyan}commander up "task"${$.reset} to continue.\n`,
  );
}

function listCheckpointDirs(stateDir: string): string[] {
  try {
    return fs
      .readdirSync(stateDir)
      .filter((f) => f.startsWith('run_') && fs.statSync(path.join(stateDir, f)).isDirectory());
  } catch {
    return [];
  }
}
