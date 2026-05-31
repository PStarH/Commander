/**
 * Commander quickstart — Interactive onboarding guide.
 *
 * Usage:
 *   commander quickstart          Interactive setup wizard
 *   commander quickstart --check  Check prerequisites only
 */
import * as fs from 'fs';
import * as path from 'path';
import { detectProvider, getEffectiveModel, listProviders } from '../../config/commanderConfig';
import { $, section, kv, bullet, startSpinner } from './_shared';

// ============================================================================
// Checks
// ============================================================================

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
  fix?: string;
}

function checkNode(): CheckResult {
  const major = parseInt(process.version.slice(1), 10);
  return {
    label: 'Node.js',
    pass: major >= 20,
    detail: process.version,
    fix: major < 20 ? 'Install Node.js v20+ from https://nodejs.org' : undefined,
  };
}

function checkProvider(): CheckResult {
  const provider = detectProvider();
  if (provider) {
    return {
      label: 'API Provider',
      pass: true,
      detail: `${provider.type} · ${getEffectiveModel()}`,
    };
  }
  return {
    label: 'API Provider',
    pass: false,
    detail: 'No API key found',
    fix: 'export OPENAI_API_KEY=sk-... (or ANTHROPIC_API_KEY, GOOGLE_API_KEY, etc.)',
  };
}

function checkGit(): CheckResult {
  try {
    const { execSync } = require('child_process');
    execSync('git --version', { stdio: 'pipe' });
    return { label: 'Git', pass: true, detail: 'available' };
  } catch {
    return {
      label: 'Git',
      pass: false,
      detail: 'not found',
      fix: 'Install git: https://git-scm.com',
    };
  }
}

function checkWorkspace(): CheckResult {
  const cwd = process.cwd();
  const hasCommanderDir = fs.existsSync(path.join(cwd, '.commander'));
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  if (hasCommanderDir) {
    return { label: 'Workspace', pass: true, detail: '.commander/ found' };
  }
  if (hasPackageJson) {
    return {
      label: 'Workspace',
      pass: true,
      detail: 'package.json found (run any command to initialize .commander/)',
    };
  }
  return {
    label: 'Workspace',
    pass: true,
    detail: `${cwd} (standalone mode)`,
  };
}

function checkTools(): CheckResult {
  const tools = (process.env.COMMANDER_TOOLS || 'web_search,web_fetch,file_read,file_write,file_edit,file_search,file_list,python_execute,shell_execute,git').split(',');
  return {
    label: 'Tools',
    pass: true,
    detail: `${tools.length} tools configured`,
  };
}

// ============================================================================
// Interactive quickstart
// ============================================================================

async function showProviderSetup() {
  section('SET UP API PROVIDER');
  console.log(`  Commander supports 20+ providers. Pick one:\n`);

  const providers = [
    { name: 'OpenAI', env: 'OPENAI_API_KEY', url: 'https://platform.openai.com/api-keys', models: 'GPT-4o, GPT-4.1, o3' },
    { name: 'Anthropic', env: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com', models: 'Claude Sonnet 4.6, Opus 4.8' },
    { name: 'Google', env: 'GOOGLE_API_KEY', url: 'https://aistudio.google.com/apikey', models: 'Gemini 2.5 Pro/Flash' },
    { name: 'OpenRouter', env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/keys', models: '200+ models' },
    { name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', url: 'https://platform.deepseek.com', models: 'DeepSeek R1, V3' },
    { name: 'Ollama (local)', env: 'OLLAMA_HOST', url: 'https://ollama.com', models: 'Llama 3, Mistral, etc.' },
  ];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const hasKey = !!process.env[p.env];
    const status = hasKey ? `${$.green}✓${$.reset}` : `${$.dim}○${$.reset}`;
    console.log(`  ${status} ${$.bold}${i + 1}.${$.reset} ${$.cyan}${p.name.padEnd(14)}${$.reset} ${$.dim}${p.models}${$.reset}`);
  }

  console.log(`\n  ${$.dim}To configure:${$.reset}`);
  console.log(`  ${$.gray}$ export OPENAI_API_KEY=sk-...${$.reset}`);
  console.log(`  ${$.dim}or${$.reset}`);
  console.log(`  ${$.gray}$ commander config set model <model-id>${$.reset}`);
  console.log(`  ${$.gray}$ commander config list-providers${$.reset}  ${$.dim}See all options${$.reset}`);
}

function showFirstSteps() {
  section('YOUR FIRST TASKS');
  console.log(`  Try these to get familiar with Commander:\n`);

  const examples = [
    { cmd: 'commander "Explain this codebase"', desc: 'Quick analysis — no setup needed' },
    { cmd: 'commander plan "Build a REST API"', desc: 'See the multi-agent plan before running' },
    { cmd: 'commander run "Fix all TypeScript errors"', desc: 'Full pipeline with execution' },
    { cmd: 'commander watch "Refactor auth module"', desc: 'Real-time progress as agents work' },
    { cmd: 'commander status', desc: 'Check your system & provider status' },
    { cmd: 'commander doctor', desc: 'Run diagnostics if something is wrong' },
  ];

  for (const ex of examples) {
    console.log(`  ${$.cyan}${ex.cmd.padEnd(44)}${$.reset} ${$.dim}${ex.desc}${$.reset}`);
  }

  console.log(`\n  ${$.bold}Pro tips:${$.reset}`);
  bullet(`Any unrecognized command is treated as a task: ${$.cyan}commander fix the login bug${$.reset}`);
  bullet(`Use ${$.cyan}--help${$.reset} with any command for options`);
  bullet(`Use ${$.cyan}commander config test${$.reset} to verify your API connection`);
  bullet(`Use ${$.cyan}commander mode auto-edit${$.reset} to skip approval prompts`);
}

function showProjectStructure() {
  section('PROJECT STRUCTURE');
  console.log(`  Commander creates these directories:\n`);
  kv('.commander/', '', $.cyan);
  bullet(`${$.dim}workflows/     Custom workflow definitions (.md)${$.reset}`);
  bullet(`${$.dim}scheduler/     Scheduled task state${$.reset}`);
  bullet(`${$.dim}webhooks.json  Webhook configurations${$.reset}`);
  console.log();
  kv('.commander_results/', '', $.cyan);
  bullet(`${$.dim}Cached execution results${$.reset}`);
  console.log();
}

// ============================================================================
// Main command
// ============================================================================

export async function cmdQuickstart(args: string[]) {
  const checkOnly = args.includes('--check');

  console.log(`
  ${$.bold}${$.blue}╭──────────────────────────────────────────────────╮${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander Quickstart${$.reset}                           ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.dim}Let's get you set up${$.reset}                            ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}╰──────────────────────────────────────────────────╯${$.reset}`);

  // Run all checks
  const checks = [checkNode(), checkProvider(), checkGit(), checkWorkspace(), checkTools()];
  const failures = checks.filter(c => !c.pass);

  section('PREREQUISITES');
  for (const c of checks) {
    const icon = c.pass ? `${$.green}✓${$.reset}` : `${$.red}✗${$.reset}`;
    console.log(`  ${icon} ${$.bold}${c.label.padEnd(16)}${$.reset} ${c.pass ? $.dim : $.yellow}${c.detail}${$.reset}`);
    if (!c.pass && c.fix) {
      console.log(`    ${$.dim}→ ${c.fix}${$.reset}`);
    }
  }

  if (checkOnly) {
    console.log();
    if (failures.length === 0) {
      console.log(`  ${$.green}${$.bold}All checks passed!${$.reset} You're ready to go.`);
      console.log(`  ${$.dim}Try: ${$.cyan}commander "Hello, world!"${$.reset}\n`);
    } else {
      console.log(`  ${$.yellow}${failures.length} check(s) need attention${$.reset}\n`);
    }
    return;
  }

  // Only show detailed guidance if not all checks pass
  if (failures.length > 0) {
    await showProviderSetup();
  }

  showFirstSteps();
  showProjectStructure();

  // Final summary
  section('SUMMARY');
  if (failures.length === 0) {
    console.log(`  ${$.green}${$.bold}✓ Everything looks good!${$.reset}`);
    console.log(`  ${$.dim}Run ${$.cyan}commander "your first task"${$.reset}${$.dim} to get started.${$.reset}\n`);
  } else {
    console.log(`  ${$.yellow}⚠ ${failures.length} item(s) to fix above.${$.reset}`);
    console.log(`  ${$.dim}Fix them, then run ${$.cyan}commander quickstart --check${$.reset}${$.dim} to verify.${$.reset}\n`);
  }
}
