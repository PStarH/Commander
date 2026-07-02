import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectProvider } from '../../config/commanderConfig';
import { TELOSOrchestrator } from '../../telos/telosOrchestrator';
import { UltimateOrchestrator } from '../../ultimate/orchestrator';
import { AgentRuntime } from '../../runtime/agentRuntime';
import type { EffortLevel } from '../../ultimate/types';
import { Scheduler, WorkflowRegistry } from '../../scheduler';
import type { ScheduleEntry, WorkflowTrigger } from '../../scheduler';
import { createRuntime, loadTools, $, onboardingMessage } from './_shared';

// ── Workflow template ─────────────────────────────────────────────────────
//
// The default workflow template lives in code as a fallback. Users can
// customize it by placing a file at `.commander/templates/workflow-default.md`
// — when present, that file is used instead (with {{name}}, {{description}},
// {{cron}} placeholders substituted). This keeps the template out of the CLI
// command logic and lets teams version-control their own scaffolds.

const BUILTIN_WORKFLOW_TEMPLATE = `---
name: {{name}}
description: {{description}}
topology: SEQUENTIAL
effort: auto
trigger:
{{cron}}
---

## Steps

### 1. Analysis
goal: Analyze the current state and gather context
tools: [Read, Grep, Glob]
model-tier: standard
parallelizable: false

### 2. Execution
goal: Perform the main work
tools: [Read, Write, Edit, Bash]
model-tier: best
parallelizable: true
depends-on: [analysis]

### 3. Verification
goal: Verify the results are correct
tools: [Bash, Read]
model-tier: standard
depends-on: [execution]
`;

function getTemplatesDir(): string {
  return path.join(process.cwd(), '.commander', 'templates');
}

function resolveWorkflowTemplate(name: string, description: string, cron: string): string {
  const customPath = path.join(getTemplatesDir(), 'workflow-default.md');
  let raw = BUILTIN_WORKFLOW_TEMPLATE;
  if (fs.existsSync(customPath)) {
    try {
      raw = fs.readFileSync(customPath, 'utf-8');
    } catch {
      /* fall back to builtin */
    }
  }
  return raw
    .replaceAll('{{name}}', name)
    .replaceAll('{{description}}', description)
    .replaceAll('{{cron}}', cron);
}

export async function cmdWorkflow(subargs: string[]) {
  const subcmd = subargs[0];
  const rest = subargs.slice(1);

  const registry = new WorkflowRegistry([
    path.join(process.cwd(), '.commander', 'workflows'),
    path.join(process.env.HOME || process.env.USERPROFILE || '~', '.commander', 'workflows'),
  ]);
  const scheduler = new Scheduler();

  switch (subcmd) {
    case 'list':
    case 'ls': {
      const workflows = registry.scan();
      const schedules = scheduler.list();
      if (workflows.length === 0 && schedules.length === 0) {
        console.log(
          `  ${$.dim}No workflows found. Create one in .commander/workflows/*.md${$.reset}`,
        );
        break;
      }
      console.log(`\n  ${$.bold}Available workflows${$.reset}\n`);
      for (const wf of workflows) {
        const trig = wf.triggers.map((t) => t.label).join(', ') || 'manual only';
        console.log(`  ${$.cyan}${wf.id}${$.reset}`);
        console.log(`    ${$.dim}${wf.description}${$.reset}`);
        console.log(`    ${$.dim}triggers: ${trig}${$.reset}`);
        console.log(`    ${$.dim}steps: ${wf.steps.length} | file: ${wf.sourcePath}${$.reset}\n`);
      }
      if (schedules.length > 0) {
        console.log(`  ${$.bold}Scheduled tasks${$.reset}\n`);
        for (const s of schedules) {
          const status = s.enabled ? `${$.green}active${$.reset}` : `${$.gray}paused${$.reset}`;
          console.log(`  ${$.cyan}${s.id}${$.reset} ${status}`);
          console.log(
            `    ${$.dim}workflow: ${s.workflowName} | trigger: ${s.trigger.label}${$.reset}`,
          );
          console.log(
            `    ${$.dim}runs: ${s.runCount} | next: ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'never'}${$.reset}\n`,
          );
        }
      }
      break;
    }

    case 'run': {
      const wfId = rest[0];
      if (!wfId) {
        console.error(`  ${$.red}Usage: commander workflow run <workflow-id>${$.reset}\n`);
        break;
      }
      registry.scan();
      const wf = registry.get(wfId);
      if (!wf) {
        console.error(`  ${$.red}Workflow "${wfId}" not found${$.reset}\n`);
        break;
      }

      const provider = detectProvider();
      const runtime = createRuntime();
      if (!runtime || !provider) {
        console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
        onboardingMessage();
        break;
      }

      const rt: AgentRuntime = runtime;
      const telos = new TELOSOrchestrator(rt);
      const orch = new UltimateOrchestrator(telos, rt);

      console.log(`  ${$.yellow}→ Executing workflow: ${wf.name}${$.reset}\n`);
      console.log(`  ${$.dim}${wf.description} | ${wf.steps.length} steps${$.reset}\n`);

      const startTime = Date.now();
      const result = await orch.execute({
        projectId: 'workflow',
        agentId: `wf-${wf.id}`,
        tenantId: wf.tenantId,
        goal: wf.goal,
        contextData: {
          availableTools: loadTools(),
          workflowId: wf.id,
          steps: wf.steps,
        },
        effortLevel: undefined as EffortLevel | undefined,
        topology: wf.topology,
        onProgress: (phase, detail) => {
          if (phase === 'COMPLETE') return;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(
            `  ${$.dim}[${elapsed}s]${$.reset} ${$.bold}${phase}${$.reset} ${$.dim}${detail.slice(0, 70)}${$.reset}`,
          );
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const icon = result.status === 'SUCCESS' ? '✅' : result.status === 'PARTIAL' ? '⚠️' : '❌';
      const statusColor =
        result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red;
      console.log(
        `\n  ${icon} ${statusColor}${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s · ${result.metrics.totalTokens.toLocaleString()} tok · $${result.metrics.totalCostUsd.toFixed(4)}${$.reset}`,
      );

      if (result.status !== 'SUCCESS' && result.errors.length > 0) {
        for (const err of result.errors) {
          console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
        }
      }
      if (result.synthesis) {
        const preview = result.synthesis
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 5)
          .join('\n  ');
        console.log(`\n  ${preview}`);
      }
      console.log();
      break;
    }

    case 'schedule': {
      if (rest.length === 0) {
        console.error(
          `  ${$.red}Usage: commander workflow schedule <workflow-id> --cron="0 6 * * 1"${$.reset}\n`,
        );
        break;
      }
      const wfId = rest[0];
      registry.scan();
      const wf = registry.get(wfId);
      if (!wf) {
        console.error(`  ${$.red}Workflow "${wfId}" not found${$.reset}\n`);
        break;
      }

      const flags: Record<string, string> = {};
      for (const arg of rest.slice(1)) {
        if (arg.startsWith('--') && arg.includes('=')) {
          const [k, v] = arg.split('=');
          flags[k.slice(2)] = v;
        } else if (arg.startsWith('--')) {
          flags[arg.slice(2)] = 'true';
        }
      }

      const trigger: WorkflowTrigger = flags.cron
        ? { type: 'cron', cron: flags.cron, label: `cron:${flags.cron}` }
        : flags.interval
          ? { type: 'interval', interval: flags.interval, label: `every ${flags.interval}` }
          : { type: 'interval', interval: '24h', label: 'every 24h' };

      const entry: ScheduleEntry = {
        id: `${wf.id}__${Date.now()}`,
        workflowId: wf.id,
        workflowName: wf.name,
        trigger,
        tenantId: wf.tenantId,
        createdAt: new Date().toISOString(),
        runCount: 0,
        enabled: true,
        tags: flags.tag ? flags.tag.split(',') : [],
      };

      scheduler.add(entry);
      console.log(`  ${$.green}✓ Scheduled "${wf.name}"${$.reset}`);
      console.log(`  ${$.dim}  trigger: ${trigger.label}${$.reset}`);
      console.log(`  ${$.dim}  id: ${entry.id}${$.reset}\n`);
      break;
    }

    case 'unschedule':
    case 'rm': {
      const sId = rest[0];
      if (!sId) {
        console.error(`  ${$.red}Usage: commander workflow unschedule <schedule-id>${$.reset}\n`);
        break;
      }
      if (scheduler.remove(sId)) {
        console.log(`  ${$.green}✓ Removed schedule ${sId}${$.reset}\n`);
      } else {
        console.error(`  ${$.red}Schedule "${sId}" not found${$.reset}\n`);
      }
      break;
    }

    case 'pause': {
      const sId = rest[0];
      if (!sId || !scheduler.disable(sId)) {
        console.error(
          `  ${$.red}Schedule not found. Usage: commander workflow pause <schedule-id>${$.reset}\n`,
        );
      } else {
        console.log(`  ${$.yellow}○ Paused schedule ${sId}${$.reset}\n`);
      }
      break;
    }

    case 'resume': {
      const sId = rest[0];
      if (!sId || !scheduler.enable(sId)) {
        console.error(
          `  ${$.red}Schedule not found. Usage: commander workflow resume <schedule-id>${$.reset}\n`,
        );
      } else {
        console.log(`  ${$.green}✓ Resumed schedule ${sId}${$.reset}\n`);
      }
      break;
    }

    case 'history':
    case 'log': {
      const wfId = rest[0];
      const records = scheduler.getHistory(wfId || undefined);
      if (records.length === 0) {
        console.log(`  ${$.dim}No execution records found${$.reset}\n`);
        break;
      }
      console.log(`\n  ${$.bold}Execution history${$.reset}\n`);
      for (const r of records.slice(-10).reverse()) {
        const statusColor =
          r.status === 'success' ? $.green : r.status === 'failed' ? $.red : $.yellow;
        const started = new Date(r.startedAt).toLocaleString();
        const dur = r.durationMs ? ` | ${(r.durationMs / 1000).toFixed(1)}s` : '';
        console.log(
          `  ${statusColor}${r.status.padEnd(8)}${$.reset} ${started}${$.dim}${dur} | ${r.workflowId}${$.reset}`,
        );
        if (r.summary) console.log(`  ${$.dim}  ${r.summary.slice(0, 120)}${$.reset}`);
      }
      console.log();
      break;
    }

    case 'create': {
      const name = rest[0];
      if (!name) {
        console.error(
          `  ${$.red}Usage: commander workflow create <name> [--description=...] [--cron="0 6 * * *"]${$.reset}\n`,
        );
        break;
      }
      const flags: Record<string, string> = {};
      for (const arg of rest.slice(1)) {
        if (arg.startsWith('--') && arg.includes('=')) {
          const [k, v] = arg.split('=');
          flags[k.slice(2)] = v;
        }
      }

      const wfDir = path.join(process.cwd(), '.commander', 'workflows');
      fs.mkdirSync(wfDir, { recursive: true });
      const filePath = path.join(wfDir, `${name}.md`);

      if (fs.existsSync(filePath)) {
        console.error(`  ${$.red}Workflow already exists: ${filePath}${$.reset}\n`);
        break;
      }

      const desc = flags.description || `Automated ${name} workflow`;
      const cron = flags.cron ? `  cron: "${flags.cron}"` : '#  cron: "0 6 * * 1-5"';

      const template = resolveWorkflowTemplate(name, desc, cron);
      fs.writeFileSync(filePath, template);
      console.log(`  ${$.green}✓ Created workflow: ${filePath}${$.reset}\n`);
      console.log(
        `  ${$.dim}Tip: customize the scaffold via .commander/templates/workflow-default.md${$.reset}\n`,
      );
      break;
    }

    case 'daemon':
    case 'start': {
      const provider = detectProvider();
      const runtime = createRuntime();
      if (!runtime || !provider) {
        console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
        onboardingMessage();
        break;
      }

      const rt: AgentRuntime = runtime;
      const telos = new TELOSOrchestrator(rt);
      const orch = new UltimateOrchestrator(telos, rt);
      scheduler.setOrchestrator(orch);

      const watchDir = path.join(process.cwd(), '.commander', 'workflows');
      if (fs.existsSync(watchDir)) {
        fs.watch(watchDir, (eventType, filename) => {
          if (filename?.endsWith('.md')) {
            const wfId = filename.replace(/\.md$/, '');
            const reloaded = registry.reload(wfId);
            if (reloaded) {
              console.log(
                `  ${$.dim}[${new Date().toLocaleTimeString()}] reloaded: ${wfId}${$.reset}`,
              );
            }
          }
        });
      }

      scheduler.start();
      console.log(`  ${$.green}✓ Scheduler daemon running${$.reset}`);
      console.log(`  ${$.dim}  Tick: ${scheduler.getConfig().tickIntervalMs / 1000}s`);
      console.log(
        `  ${$.dim}  State: ${path.join(process.cwd(), '.commander', 'scheduler')}${$.reset}`,
      );
      console.log(`  ${$.dim}  Workflows: ${registry.list().length} loaded${$.reset}\n`);

      process.on('SIGINT', () => {
        scheduler.stop();
        console.log(`\n  ${$.yellow}○ Scheduler daemon stopped${$.reset}\n`);
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        scheduler.stop();
        process.exit(0);
      });

      await new Promise(() => {});
      break;
    }

    case 'stop':
      scheduler.stop();
      console.log(`  ${$.yellow}○ Scheduler stopped${$.reset}\n`);
      break;

    default:
      console.log(`
  ${$.bold}WORKFLOW COMMANDS${$.reset}
    ${$.cyan}commander workflow ls${$.reset}              List available and scheduled workflows
    ${$.cyan}commander workflow run <id>${$.reset}        Show workflow details
    ${$.cyan}commander workflow schedule <id>${$.reset}   Schedule a workflow (--cron="..." --interval="30m")
    ${$.cyan}commander workflow unschedule <id>${$.reset} Remove a scheduled workflow
    ${$.cyan}commander workflow pause <id>${$.reset}      Pause a scheduled workflow
    ${$.cyan}commander workflow resume <id>${$.reset}     Resume a scheduled workflow
    ${$.cyan}commander workflow history${$.reset}          Show execution history
    ${$.cyan}commander workflow daemon${$.reset}           Start the scheduler daemon
    ${$.cyan}commander workflow stop${$.reset}             Stop the scheduler daemon
      `);
      break;
  }
}
