#!/usr/bin/env node
/**
 * Commander CLI — Multi-Agent Orchestration System
 *
 * Usage:
 *   commander <task>                    Quick plan (default)
 *   commander run <task>                Execute with full pipeline
 *   commander plan <task>               Show deliberation plan
 *   commander watch <task>              Real-time execution stream
 *   commander company <task>            Company mode execution
 *   commander workers [topics]          Parallel research workers
 *   commander review [options]          Code review (P0-P3 findings)
 *   commander --version                 Show version
 *   commander help                      Show this help
 */
import { $ } from './cli/util';
import {
  cmdPlan, cmdRun, cmdWatch, cmdCompany, cmdGoal, cmdSwarm, cmdDrive,
  cmdStatus, cmdConfig, cmdDoctor, cmdGui, cmdWorkers, cmdSkill,
  cmdMode, cmdReview, cmdHistory, cmdWorkflow, cmdHelp,
} from './cli/commands';
import { startTUI } from './tui';

// ============================================================================
// Main entry
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
    cmdHelp();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === 'version') {
    console.log('1.0.0-alpha.1');
    process.exit(0);
  }

  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case 'plan':
      if (rest.length === 0) { console.error('  Usage: commander plan <task>\n'); process.exit(1); }
      await cmdPlan(rest.join(' '));
      break;

    case 'run':
      if (rest.length === 0) { console.error('  Usage: commander run <task>\n'); process.exit(1); }
      await cmdRun(rest.join(' '));
      break;

    case 'watch':
      if (rest.length === 0) { console.error('  Usage: commander watch <task>\n'); process.exit(1); }
      await cmdWatch(rest.join(' '));
      break;

    case 'company':
      if (rest.length === 0) { console.error('  Usage: commander company <task>\n'); process.exit(1); }
      await cmdCompany(rest.join(' '));
      break;

    case 'status':
      await cmdStatus();
      break;

    case 'config':
      await cmdConfig(rest);
      break;

    case 'doctor':
      await cmdDoctor();
      break;

    case 'gui':
      await cmdGui();
      break;

    case 'tui':
      startTUI();
      break;

    case 'workers':
      await cmdWorkers(rest.length > 0 ? rest : []);
      break;

    case 'goal': {
      const flags: Record<string, string> = {};
      const taskParts: string[] = [];
      for (const arg of rest) {
        if (arg.startsWith('--') && arg.includes('=')) {
          const [k, v] = arg.split('=');
          flags[k] = v;
        } else if (arg.startsWith('--')) {
          flags[arg] = 'true';
        } else {
          taskParts.push(arg);
        }
      }
      await cmdGoal(taskParts.join(' '), flags);
      break;
    }

    case 'swarm': {
      const sFlags: Record<string, string> = {};
      const sTaskParts: string[] = [];
      for (const arg of rest) {
        if (arg.startsWith('--') && arg.includes('=')) {
          const [k, v] = arg.split('=');
          sFlags[k] = v;
        } else if (arg.startsWith('--')) {
          sFlags[arg] = 'true';
        } else {
          sTaskParts.push(arg);
        }
      }
      await cmdSwarm(sTaskParts.join(' '), sFlags);
      break;
    }

    case 'drive': {
      const dFlags: Record<string, string> = {};
      const dTaskParts: string[] = [];
      for (const arg of rest) {
        if (arg.startsWith('--') && arg.includes('=')) {
          const [k, v] = arg.split('=');
          dFlags[k] = v;
        } else if (arg.startsWith('--')) {
          dFlags[arg] = 'true';
        } else {
          dTaskParts.push(arg);
        }
      }
      await cmdDrive(dTaskParts.join(' '), dFlags);
      break;
    }

    case 'skill':
      await cmdSkill(rest);
      break;

    case 'mode':
      await cmdMode(rest[0]);
      break;

    case 'review':
      await cmdReview(rest);
      break;

    case 'history':
      await cmdHistory(rest);
      break;

    case 'workflow':
      await cmdWorkflow(rest);
      break;

    default:
      // Treat as a task — quick plan
      await cmdPlan(args.join(' '));
      break;
  }
}

main().catch(err => {
  console.error(`\n  ${$.red}${$.bold}FATAL${$.reset} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
