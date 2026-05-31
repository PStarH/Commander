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
 *   commander quickstart                Interactive setup guide
 *   commander --version                 Show version
 *   commander help                      Show this help
 */
import { $, parseFlags, setTheme } from './cli/util';

// Initialize theme from env var before any output
if (process.env.COMMANDER_THEME) {
  setTheme(process.env.COMMANDER_THEME);
}
import {
  cmdPlan, cmdRun, cmdWatch, cmdCompany, cmdGoal, cmdSwarm, cmdDrive,
  cmdStatus, cmdConfig, cmdDoctor, cmdGui, cmdWorkers, cmdSkill,
  cmdMode, cmdReview, cmdHistory, cmdWorkflow, cmdHelp, cmdBenchmark,
  cmdQuickstart, cmdCompletion, cmdFeedback,
} from './cli/commands';
import { startTUI } from './tui';

// ============================================================================
// Per-command help text
// ============================================================================

const COMMAND_HELP: Record<string, string> = {
  run:        `  ${$.bold}commander run <task> [flags]${$.reset}\n\n  Execute a task with the full multi-agent pipeline.\n\n  ${$.bold}Flags:${$.reset}\n    --dry-run              Show plan without executing (replaces 'plan')\n    --stream               Real-time SSE progress (replaces 'watch')\n    --mode=<mode>          Execution mode: balanced (default), fast, thorough, goal\n    --provider=<name>      Force provider (mimo, openai, anthropic, etc.)\n    --budget=<tokens>      Token budget (default: 100000)\n    --max-rounds=<n>       Max rounds (goal mode only, default: 10)\n\n  ${$.dim}Examples:${$.reset}\n    commander run "Fix all TypeScript errors in src/"\n    commander run "Analyze auth module" --dry-run\n    commander run "Refactor auth" --stream\n    commander run "Research state management" --mode=goal --provider=mimo\n`,
  company:    `  ${$.bold}commander company <task>${$.reset}\n\n  Execute with Company Engine (capability matching + quality gating + memory).\n\n  ${$.dim}Example:${$.reset}\n    commander company "Build a CLI tool"\n`,
  swarm:      `  ${$.bold}commander swarm <task> [flags]${$.reset}\n\n  Recursive swarm: fission (decompose) + fusion (merge).\n\n  ${$.bold}Flags:${$.reset}\n    --max-depth=<n>                    Max tree depth (default: 3)\n    --max-workers=<n>                  Max parallel workers (default: 10)\n    --mode=<balanced|thorough|fast>    Execution mode\n\n  ${$.dim}Example:${$.reset}\n    commander swarm "Audit this codebase for security issues"\n`,
  drive:      `  ${$.bold}commander drive <task> [flags]${$.reset}\n\n  Autonomous drive loop with step-by-step execution.\n\n  ${$.bold}Flags:${$.reset}\n    --mode=<auto|supervised>           Drive mode\n    --iterations=<n>                   Max iterations (default: 20)\n    --verbose                          Show detailed output\n\n  ${$.dim}Example:${$.reset}\n    commander drive "Set up CI/CD pipeline" --verbose\n`,
  review:     `  ${$.bold}commander review [flags]${$.reset}\n\n  Review code changes with AI-powered analysis.\n\n  ${$.bold}Flags:${$.reset}\n    --commit [sha]     Review a specific commit (or latest)\n    --branch           Review entire branch vs main\n    --base <ref>       Compare against a specific ref\n    --json             Output as JSON\n    --guidelines <r>   Custom rules (pipe-separated)\n\n  ${$.dim}Example:${$.reset}\n    commander review --commit\n    commander review --branch --json\n`,
  status:     `  ${$.bold}commander status${$.reset}\n\n  Show system status: provider, API keys, runtime, meta-learner stats.\n`,
  config:     `  ${$.bold}commander config [subcommand]${$.reset}\n\n  ${$.bold}Subcommands:${$.reset}\n    show              Show current configuration\n    set <key> <val>   Set a config value\n    list-providers    List all available providers\n    list-models       List available models\n    test              Test API connection\n\n  ${$.dim}Example:${$.reset}\n    commander config set model gpt-4o\n    commander config test\n`,
  doctor:     `  ${$.bold}commander doctor${$.reset}\n\n  Run diagnostics: Node.js, API key, packages, git, workspace, connectivity.\n`,
  mode:       `  ${$.bold}commander mode [mode]${$.reset}\n\n  Show or set the approval mode.\n\n  ${$.bold}Modes:${$.reset}\n    plan         Analysis only, no modifications\n    read-only    No writes, no destructive ops\n    suggest      Prompts before risky operations\n    auto-edit    Allows most operations, flags sandbox escapes\n    full-auto    No approval gates\n\n  ${$.dim}Example:${$.reset}\n    commander mode auto-edit\n`,
  history:    `  ${$.bold}commander history [subcommand]${$.reset}\n\n  ${$.bold}Subcommands:${$.reset}\n    (none)            List all sessions\n    view <runId>      View session details\n    delete <runId>    Delete a session\n    prune <keep>      Keep only the last N sessions\n`,
  skill:      `  ${$.bold}commander skill [subcommand]${$.reset}\n\n  ${$.bold}Subcommands:${$.reset}\n    list (ls)         List all skills\n    view <name>       View skill details\n    create <name>     Create a new skill\n    pin <name>        Pin a skill (protect from curator)\n    unpin <name>      Unpin a skill\n    delete (rm)       Delete a skill\n    curate            Run curator (archive + consolidate)\n`,
  quickstart: `  ${$.bold}commander quickstart [--check]${$.reset}\n\n  Interactive setup guide for first-time users.\n\n  ${$.bold}Flags:${$.reset}\n    --check     Check prerequisites only (non-interactive)\n`,
  completion: `  ${$.bold}commander completion [shell]${$.reset}\n\n  Generate shell autocompletion scripts.\n\n  ${$.bold}Shells:${$.reset}\n    bash      Generate bash completion\n    zsh       Generate zsh completion\n    fish      Generate fish completion\n    install   Auto-detect shell and install (default)\n\n  ${$.dim}Example:${$.reset}\n    commander completion install\n    source <(commander completion bash)\n`,
  feedback:   `  ${$.bold}commander feedback [flags]${$.reset}\n\n  Submit feedback to help improve Commander.\n\n  ${$.bold}Flags:${$.reset}\n    --rating=<1-5>        Rate your experience\n    --message="<text>"    General feedback\n    --bug="<text>"        Report a bug\n    --feature="<text>"    Request a feature\n\n  ${$.bold}Subcommands:${$.reset}\n    stats                 View feedback summary\n\n  ${$.dim}Example:${$.reset}\n    commander feedback --rating=5 --message="Great tool!"\n    commander feedback --bug="crash on empty input"\n`,
  // Deprecated aliases
  plan:       `  ${$.yellow}⚠ DEPRECATED${$.reset} — Use ${$.bold}commander run <task> --dry-run${$.reset} instead.\n`,
  watch:      `  ${$.yellow}⚠ DEPRECATED${$.reset} — Use ${$.bold}commander run <task> --stream${$.reset} instead.\n`,
  goal:       `  ${$.yellow}⚠ DEPRECATED${$.reset} — Use ${$.bold}commander run <task> --mode=goal${$.reset} instead.\n`,
  workers:    `  ${$.yellow}⚠ DEPRECATED${$.reset} — Use ${$.bold}commander swarm${$.reset} instead.\n`,
  workflow:   `  ${$.yellow}⚠ DEPRECATED${$.reset} — Use ${$.bold}commander company${$.reset} instead.\n`,
  benchmark:  `  ${$.yellow}⚠ DEPRECATED${$.reset} — Use ${$.bold}commander run --benchmark${$.reset} instead.\n`,
};

function showCommandHelp(cmd: string): boolean {
  const help = COMMAND_HELP[cmd];
  if (!help) return false;
  console.log(help);
  return true;
}

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

  // Per-command --help
  if (rest.includes('--help') || rest.includes('-h')) {
    if (showCommandHelp(cmd)) process.exit(0);
  }

  switch (cmd) {
    // ── Core execution (unified: replaces plan, watch, goal) ──
    case 'run': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0 || rest.includes('--help')) { showCommandHelp('run'); process.exit(rest.includes('--help') ? 0 : 1); }
      await cmdRun(positional.join(' '), flags);
      break;
    }

    // ── Deprecated aliases → redirect to run ──
    case 'plan':
      console.log(`  ${$.yellow}⚠${$.reset} ${$.dim}"plan" is deprecated. Use "run --dry-run" instead.${$.reset}\n`);
      await cmdRun(rest.join(' '), { '--dry-run': '' });
      break;
    case 'watch':
      console.log(`  ${$.yellow}⚠${$.reset} ${$.dim}"watch" is deprecated. Use "run --stream" instead.${$.reset}\n`);
      await cmdRun(rest.join(' '), { '--stream': '' });
      break;
    case 'goal': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0) { showCommandHelp('goal'); process.exit(1); }
      await cmdRun(positional.join(' '), { ...flags, mode: 'goal' });
      break;
    }

    // ── Enterprise engine (unified: replaces workflow) ──
    case 'company':
      if (rest.length === 0 || rest[0] === '--help') { showCommandHelp('company'); process.exit(rest.length === 0 ? 1 : 0); }
      await cmdCompany(rest.join(' '));
      break;

    // ── Deprecated alias → redirect to company ──
    case 'workflow':
      console.log(`  ${$.yellow}⚠${$.reset} ${$.dim}"workflow" is deprecated. Use "company" instead.${$.reset}\n`);
      await cmdCompany(rest.join(' '));
      break;

    // ── Recursive swarm (unified: replaces workers) ──
    case 'swarm': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0) { showCommandHelp('swarm'); process.exit(1); }
      await cmdSwarm(positional.join(' '), flags);
      break;
    }

    // ── Deprecated alias → redirect to swarm ──
    case 'workers':
      console.log(`  ${$.yellow}⚠${$.reset} ${$.dim}"workers" is deprecated. Use "swarm" instead.${$.reset}\n`);
      await cmdWorkers(rest.length > 0 ? rest : []);
      break;

    // ── Autonomous drive ──
    case 'drive': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0) { showCommandHelp('drive'); process.exit(1); }
      await cmdDrive(positional.join(' '), flags);
      break;
    }

    // ── Code review ──
    case 'review':
      await cmdReview(rest);
      break;

    // ── Deprecated alias → redirect to run ──
    case 'benchmark':
      console.log(`  ${$.yellow}⚠${$.reset} ${$.dim}"benchmark" is deprecated. Use "run --benchmark" instead.${$.reset}\n`);
      await cmdBenchmark(rest);
      break;

    // ── Management commands ──
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
    case 'skill':
      await cmdSkill(rest);
      break;
    case 'mode':
      await cmdMode(rest[0]);
      break;
    case 'history':
      await cmdHistory(rest);
      break;
    case 'quickstart':
      await cmdQuickstart(rest);
      break;
    case 'completion':
      await cmdCompletion(rest);
      break;
    case 'feedback':
      await cmdFeedback(rest);
      break;

    default:
      // Treat as a task — quick run
      await cmdRun(args.join(' '));
      break;
  }
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} ${msg}`);
  if (err instanceof Error && err.stack) {
    // Show abbreviated stack in debug mode
    if (process.env.DEBUG || process.env.COMMANDER_DEBUG) {
      const stackLines = err.stack.split('\n').slice(1, 4);
      for (const line of stackLines) {
        console.error(`  ${$.dim}${line.trim()}${$.reset}`);
      }
    }
  }
  console.error(`  ${$.dim}Run ${$.cyan}commander doctor${$.reset}${$.dim} to diagnose issues.${$.reset}`);
  console.error(`  ${$.dim}Run ${$.cyan}commander quickstart${$.reset}${$.dim} for setup guidance.${$.reset}\n`);
  process.exit(1);
});
