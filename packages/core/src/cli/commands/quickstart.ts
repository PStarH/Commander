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
import { t } from '../i18n';

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
    label: t('quickcheck.label.node'),
    pass: major >= 20,
    detail: process.version,
    fix: major < 20 ? t('quickcheck.fix.node') : undefined,
  };
}

function checkProvider(): CheckResult {
  const provider = detectProvider();
  if (provider) {
    return {
      label: t('quickcheck.label.provider'),
      pass: true,
      detail: t('quickcheck.provider_run_hint', {
        type: provider.type,
        model: getEffectiveModel(),
      }),
    };
  }
  return {
    label: t('quickcheck.label.provider'),
    pass: false,
    detail: t('quickcheck.provider_missing'),
    fix: t('quickcheck.fix.provider'),
  };
}

function checkGit(): CheckResult {
  try {
    const { execSync } = require('child_process');
    execSync('git --version', { stdio: 'pipe' });
    return { label: t('quickcheck.label.git'), pass: true, detail: 'available' };
  } catch {
    return {
      label: t('quickcheck.label.git'),
      pass: false,
      detail: 'not found',
      fix: t('quickcheck.fix.git'),
    };
  }
}

function checkWorkspace(): CheckResult {
  const cwd = process.cwd();
  const hasCommanderDir = fs.existsSync(path.join(cwd, '.commander'));
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  if (hasCommanderDir) {
    return {
      label: t('quickcheck.label.workspace'),
      pass: true,
      detail: t('quickcheck.workspace.found'),
    };
  }
  if (hasPackageJson) {
    return {
      label: t('quickcheck.label.workspace'),
      pass: true,
      detail: t('quickcheck.workspace.package_json'),
    };
  }
  return {
    label: t('quickcheck.label.workspace'),
    pass: true,
    detail: `${cwd} ${t('quickcheck.workspace.standalone')}`,
  };
}

function checkTools(): CheckResult {
  const tools = (
    process.env.COMMANDER_TOOLS ||
    'web_search,web_fetch,file_read,file_write,file_edit,file_search,file_list,python_execute,shell_execute,git'
  ).split(',');
  return {
    label: t('quickcheck.label.tools'),
    pass: true,
    detail: t('quickcheck.tools_configured', { n: tools.length }),
  };
}

// ============================================================================
// Interactive quickstart
// ============================================================================

async function showProviderSetup() {
  section(t('quickstart.want_setup'));
  console.log(`  ${t('quickstart.provider_supports')}\n`);

  // Each provider has a fixed product name (kept literal) + i18n description key.
  const providers = [
    {
      name: 'OpenAI',
      env: 'OPENAI_API_KEY',
      url: 'https://platform.openai.com/api-keys',
      descKey: 'quickstart.openai.desc',
    },
    {
      name: 'Anthropic',
      env: 'ANTHROPIC_API_KEY',
      url: 'https://console.anthropic.com',
      descKey: 'quickstart.anthropic.desc',
    },
    {
      name: 'Google',
      env: 'GOOGLE_API_KEY',
      url: 'https://aistudio.google.com/apikey',
      descKey: 'quickstart.google.desc',
    },
    {
      name: 'OpenRouter',
      env: 'OPENROUTER_API_KEY',
      url: 'https://openrouter.ai/keys',
      descKey: 'quickstart.openrouter.desc',
    },
    {
      name: 'DeepSeek',
      env: 'DEEPSEEK_API_KEY',
      url: 'https://platform.deepseek.com',
      descKey: 'quickstart.deepseek.desc',
    },
    {
      name: 'Ollama (local)',
      env: 'OLLAMA_HOST',
      url: 'https://ollama.com',
      descKey: 'quickstart.ollama.desc',
    },
  ];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const hasKey = !!process.env[p.env];
    const status = hasKey ? `${$.green}✓${$.reset}` : `${$.dim}○${$.reset}`;
    console.log(
      `  ${status} ${$.bold}${i + 1}.${$.reset} ${$.cyan}${p.name.padEnd(14)}${$.reset} ${$.dim}${t(p.descKey)}${$.reset}`,
    );
  }

  console.log(`\n  ${$.dim}${t('quickstart.to_configure')}${$.reset}`);
  console.log(`  ${$.gray}$ export OPENAI_API_KEY=sk-...${$.reset}`);
  console.log(`  ${$.dim}${t('quickstart.config_alt_step')}${$.reset}`);
  console.log(`  ${$.gray}$ commander config set model <model-id>${$.reset}`);
  console.log(
    `  ${$.gray}$ commander config list-providers${$.reset}  ${$.dim}See all options${$.reset}`,
  );
}

function showFirstSteps() {
  section(t('quickstart.first_steps'));
  console.log(`  ${t('quickstart.try.these')}\n`);

  const examples = [
    { cmdKey: 'quickstart.example.1', descKey: 'quickstart.example.1.desc' },
    { cmdKey: 'quickstart.example.2', descKey: 'quickstart.example.2.desc' },
    { cmdKey: 'quickstart.example.3', descKey: 'quickstart.example.3.desc' },
    { cmdKey: 'quickstart.example.4', descKey: 'quickstart.example.4.desc' },
    { cmdKey: 'quickstart.example.5', descKey: 'quickstart.example.5.desc' },
    { cmdKey: 'quickstart.example.6', descKey: 'quickstart.example.6.desc' },
  ];

  for (const ex of examples) {
    console.log(
      `  ${$.cyan}${t(ex.cmdKey).padEnd(44)}${$.reset} ${$.dim}${t(ex.descKey)}${$.reset}`,
    );
  }

  console.log(`\n  ${$.bold}${t('quickstart.pro_tips')}${$.reset}`);
  bullet(t('quickstart.tip.treat_as_task'));
  bullet(t('quickstart.tip.help'));
  bullet(t('quickstart.tip.config_test'));
  bullet(t('quickstart.tip.mode_auto_edit'));
}

function showProjectStructure() {
  section(t('quickstart.structure'));
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
  ${$.bold}${$.blue}│${$.reset}  ${$.bold}${t('quickstart.title.banner')}${$.reset}                           ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.dim}${t('quickstart.subtitle.banner')}${$.reset}                            ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}╰──────────────────────────────────────────────────╯${$.reset}`);

  // Run all checks
  const checks = [checkNode(), checkProvider(), checkGit(), checkWorkspace(), checkTools()];
  const failures = checks.filter((c) => !c.pass);

  section(t('quickstart.prereqs'));
  for (const c of checks) {
    const icon = c.pass ? `${$.green}✓${$.reset}` : `${$.red}✗${$.reset}`;
    console.log(
      `  ${icon} ${$.bold}${c.label.padEnd(16)}${$.reset} ${c.pass ? $.dim : $.yellow}${c.detail}${$.reset}`,
    );
    if (!c.pass && c.fix) {
      console.log(`    ${$.dim}→ ${c.fix}${$.reset}`);
    }
  }

  if (checkOnly) {
    console.log();
    if (failures.length === 0) {
      console.log(`  ${$.green}${$.bold}${t('quickstart.all.passed')}${$.reset} ${t('quickstart.ready')}`);
      console.log(`  ${$.dim}${t('quickstart.all_passed_try')}${$.reset}\n`);
    } else {
      console.log(
        `  ${$.yellow}${t('quickstart.need_attention', { n: failures.length })}${$.reset}\n`,
      );
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
  section(t('quickstart.summary.section'));
  if (failures.length === 0) {
    console.log(`  ${$.green}${$.bold}${t('quickstart.all_good')}${$.reset}`);
    console.log(`  ${$.dim}${t('quickstart.run_first_task_hint')}${$.reset}\n`);
  } else {
    console.log(`  ${$.yellow}⚠ ${t('quickstart.need_attention', { n: failures.length })}${$.reset}`);
    console.log(`  ${$.dim}${t('quickstart.fix_and_verify')}${$.reset}\n`);
  }
}
