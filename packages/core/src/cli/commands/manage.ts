import * as fs from 'fs';
import * as path from 'path';
import {
  detectProvider,
  getEffectiveModel,
  setConfig,
  showConfig,
  listProviders,
  listModels,
} from '../../config/commanderConfig';
import { getMetaLearner } from '../../selfEvolution/metaLearner';
import { getEvolverAgent } from '../../selfEvolution/evolverAgent';
import { getApprovalSystem } from '../../sandbox';
import type { ApprovalMode } from '../../sandbox';
import { getGlobalLogger } from '../../logging';
import {
  createRuntime,
  $,
  section,
  kv,
  bullet,
  cmdHeader,
  startSpinner,
  onboardingMessage,
  setTheme,
  getThemeName,
  listThemes,
} from './_shared';

export async function cmdStatus() {
  const provider = detectProvider();

  section('SYSTEM STATUS');
  kv('Version', '1.0.0-alpha.1');
  kv('Node', process.version);
  kv('Platform', process.platform);

  if (provider) {
    section('ACTIVE PROVIDER');
    kv('Name', provider.type, $.cyan);
    kv('API URL', provider.baseUrl, $.dim);
    kv('Model', getEffectiveModel(), $.green);
  } else {
    kv('Provider', 'None — set an API key env var', $.red);
  }

  const envVars = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'ZHIPU_API_KEY',
    'MIMO_API_KEY',
    'XIAOMI_API_KEY',
  ];
  section('API KEYS');
  for (const v of envVars) {
    const exists = !!process.env[v];
    console.log(`  ${exists ? $.green + '✓' : $.dim + '✗'}${$.reset} ${v}`);
  }
  if (process.env.OPENAI_BASE_URL)
    console.log(`  ${$.dim}  (base URL: ${process.env.OPENAI_BASE_URL})${$.reset}`);

  const runtime = createRuntime();
  kv('Runtime', runtime ? `${$.green}ready${$.reset}` : `${$.red}no API key${$.reset}`);

  try {
    const learner = getMetaLearner();
    const stats = learner.getStats();
    kv('Experiences', String(stats.totalExperiences));
    kv('Strategies', String(stats.trackedStrategies));
    kv('Avg success', (stats.avgSuccessRate * 100).toFixed(0) + '%');
    const suggestions = learner.getSuggestions();
    if (suggestions.length > 0) {
      section('OPTIMIZATIONS');
      for (const s of suggestions.slice(0, 3)) {
        console.log(
          `  ${$.yellow}!${$.reset} ${s.type}: ${s.from} → ${s.to} (${(s.confidence * 100).toFixed(0)}%)`,
        );
      }
    }

    // Shadow mode stats
    const shadows = learner.getShadowComparisons(5);
    if (shadows.length > 0) {
      section('SHADOW MODE');
      const lastShadow = shadows[shadows.length - 1];
      const betterStrategy =
        lastShadow.shadowSuccess && !lastShadow.mainSuccess
          ? lastShadow.shadowStrategy
          : !lastShadow.shadowSuccess && lastShadow.mainSuccess
            ? lastShadow.mainStrategy
            : null;
      kv(
        'Last run',
        `${lastShadow.mainStrategy} vs ${$.cyan}${lastShadow.shadowStrategy}${$.reset}`,
      );
      kv(
        'Main result',
        lastShadow.mainSuccess ? `${$.green}✓${$.reset}` : `${$.red}✗${$.reset}`,
        $.dim,
      );
      kv(
        'Shadow result',
        lastShadow.shadowSuccess ? `${$.green}✓${$.reset}` : `${$.red}✗${$.reset}`,
        $.dim,
      );
      if (betterStrategy) {
        console.log(
          `  ${$.yellow}💡${$.reset} ${$.cyan}${betterStrategy}${$.reset} would have performed better in the last run`,
        );
      }
      kv('Total shadows', `${shadows.length}`, $.dim);
    }
  } catch (err) {
    getGlobalLogger().debug('CLI', 'Failed to load MetaLearner stats', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const poolStatsPath = path.join(process.cwd(), '.commander_results');
  if (fs.existsSync(poolStatsPath)) {
    const files = fs.readdirSync(poolStatsPath).filter((f) => f.endsWith('.txt'));
    if (files.length > 0) kv('Cached results', String(files.length));
  }
}

export async function cmdConfig(args: string[]) {
  if (args.length === 0 || args[0] === 'show') {
    section('CONFIGURATION');
    showConfig();
    console.log(`\n  ${$.dim}Set:  commander config set model <model-id>${$.reset}`);
    console.log(`  ${$.dim}      commander config set theme <dark|light|minimal>${$.reset}`);
    console.log(`  ${$.dim}      commander config set meta-tools on${$.reset}`);
    console.log(`  ${$.dim}      commander config list-providers${$.reset}`);
    console.log(`  ${$.dim}      commander config list-models${$.reset}`);
    console.log(`  ${$.dim}      commander config test${$.reset}`);
    return;
  }

  if (args[0] === 'set' && args.length >= 3) {
    const key = args[1];
    const value = args.slice(2).join(' ');

    // Handle theme specially (local config, not persisted via setConfig)
    if (key === 'theme') {
      const themes = listThemes();
      if (!themes.includes(value)) {
        console.log(`  ${$.red}Unknown theme:${$.reset} "${value}"`);
        console.log(`  ${$.dim}Available: ${themes.join(', ')}${$.reset}`);
        console.log(`  ${$.dim}NO_COLOR=1 disables all colors (https://no-color.org)${$.reset}\n`);
        return;
      }
      setTheme(value);
      console.log(`  ${$.green}✓${$.reset} theme = ${$.cyan}${value}${$.reset}`);
      console.log(
        `  ${$.dim}Colors updated for this session. Persist with: export COMMANDER_THEME=${value}${$.reset}\n`,
      );
      return;
    }

    try {
      setConfig(key, value);
      console.log(`  ${$.green}✓${$.reset} ${key} = ${value}`);
    } catch (e) {
      console.log(`  ${$.red}✗${$.reset} ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (args[0] === 'list-providers') {
    section('AVAILABLE PROVIDERS');
    console.log(`  ${$.dim}Set any API key env var to activate a provider:${$.reset}\n`);
    listProviders();
    console.log(
      `\n  ${$.dim}  ✓ = configured  ~ = via OPENAI_API_KEY  (space) = not set${$.reset}`,
    );
    return;
  }

  if (args[0] === 'list-models') {
    section('AVAILABLE MODELS');
    listModels();
    return;
  }

  if (args[0] === 'test') {
    const provider = detectProvider();
    if (!provider) {
      console.log(`  ${$.red}No API key found. Set one of the env vars.${$.reset}`);
      return;
    }
    section('TESTING');
    console.log(`  Provider: ${provider.type}`);
    console.log(`  URL:      ${provider.baseUrl}`);
    process.stdout.write(`  Testing...`);
    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) console.log(` ${$.green}✓ Connection OK${$.reset}`);
      else console.log(` ${$.red}✗ ${res.status}${$.reset}`);
    } catch {
      console.log(` ${$.yellow}! Connection failed${$.reset}`);
    }
    return;
  }

  if (args[0] === 'canary-status') {
    section('CANARY DEPLOYMENT');
    console.log(`\n  ${$.dim}Canary deployment was removed.${$.reset}\n`);
    return;
  }

  console.log(
    `  ${$.red}Usage:${$.reset} commander config [show|set <key> <val>|list-providers|list-models|test]`,
  );
}

export async function cmdDoctor() {
  section('DOCTOR');
  const provider = detectProvider();
  const major = parseInt(process.version.slice(1), 10);

  // Core checks
  const checks: Array<{ label: string; pass: boolean; msg: string; section?: string }> = [];

  // Environment
  checks.push({
    label: 'Node.js v20+',
    pass: major >= 20,
    msg: major < 20 ? `Current: ${process.version}. Install from https://nodejs.org` : '',
    section: 'ENVIRONMENT',
  });

  // Git
  let gitVersion = '';
  try {
    const { execSync } = require('child_process');
    gitVersion = execSync('git --version', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    checks.push({ label: 'Git', pass: true, msg: gitVersion });
  } catch {
    checks.push({ label: 'Git', pass: false, msg: 'Not found. Install: https://git-scm.com' });
  }

  // Package manager
  let pm = 'unknown';
  try {
    const { execSync } = require('child_process');
    if (fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))) pm = 'pnpm';
    else if (fs.existsSync(path.join(process.cwd(), 'yarn.lock'))) pm = 'yarn';
    else if (fs.existsSync(path.join(process.cwd(), 'package-lock.json'))) pm = 'npm';
    checks.push({
      label: 'Package manager',
      pass: pm !== 'unknown',
      msg: pm !== 'unknown' ? pm : 'No lockfile found',
    });
  } catch {
    checks.push({ label: 'Package manager', pass: false, msg: 'Unknown' });
  }

  // Provider
  checks.push({
    label: 'API key',
    pass: !!provider,
    msg: provider
      ? `${provider.type} · ${getEffectiveModel()}`
      : 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.',
    section: 'PROVIDER',
  });

  // Packages
  const nodeModulesExists =
    fs.existsSync(path.join(process.cwd(), 'node_modules')) ||
    fs.existsSync(path.join(__dirname, '..', '..', '..', 'node_modules'));
  checks.push({
    label: 'Packages installed',
    pass: nodeModulesExists,
    msg: nodeModulesExists ? '' : 'Run: pnpm install',
  });

  // Workspace
  const cwd = process.cwd();
  const hasCommanderDir = fs.existsSync(path.join(cwd, '.commander'));
  checks.push({
    label: '.commander/ dir',
    pass: true,
    msg: hasCommanderDir ? 'Found' : 'Not found (will be created on first run)',
    section: 'WORKSPACE',
  });

  // Tools config
  const tools = (
    process.env.COMMANDER_TOOLS ||
    'web_search,web_fetch,file_read,file_write,file_edit,file_search,file_list,python_execute,shell_execute,git'
  ).split(',');
  checks.push({ label: 'Tools configured', pass: true, msg: `${tools.length} tools` });

  // Disk space
  try {
    const { execSync } = require('child_process');
    const df = execSync('df -h . | tail -1', { encoding: 'utf-8' }).trim();
    const parts = df.split(/\s+/);
    const avail = parts[3] || 'unknown';
    const usePercent = parseInt(parts[4] || '0', 10);
    checks.push({
      label: 'Disk space',
      pass: usePercent < 95,
      msg: `${avail} available (${parts[4]} used)${usePercent >= 95 ? ' — LOW SPACE' : ''}`,
    });
  } catch {
    // Non-critical
  }

  // Print checks
  let lastSection = '';
  let allOk = true;
  for (const c of checks) {
    if (!c.pass) allOk = false;
    if (c.section && c.section !== lastSection) {
      lastSection = c.section;
      console.log(`\n  ${$.dim}${c.section}${$.reset}`);
    }
    console.log(
      `  ${c.pass ? $.green + '✓' : $.red + '✗'}${$.reset} ${c.label}${c.msg ? ' — ' + (c.pass ? $.dim : $.yellow) + c.msg + $.reset : ''}`,
    );
  }

  // Connectivity test
  if (provider) {
    console.log(`\n  ${$.dim}CONNECTIVITY${$.reset}`);
    console.log(`  ${$.dim}Testing ${provider.type} at ${provider.baseUrl}...${$.reset}`);
    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        console.log(`  ${$.green}✓${$.reset} API reachable (HTTP ${res.status})`);
        try {
          const data = (await res.json()) as { data?: Array<{ id: string }> };
          const modelCount = data.data?.length ?? 0;
          if (modelCount > 0) {
            console.log(`  ${$.green}✓${$.reset} ${modelCount} models available`);
          }
        } catch {
          /* ignore */
        }
      } else {
        console.log(`  ${$.red}✗${$.reset} API returned HTTP ${res.status}`);
        if (res.status === 401)
          console.log(`    ${$.yellow}→ Invalid API key. Check your credentials.${$.reset}`);
        if (res.status === 429)
          console.log(`    ${$.yellow}→ Rate limited. Try again later.${$.reset}`);
      }
    } catch (err) {
      console.log(`  ${$.red}✗${$.reset} API unreachable`);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOTFOUND'))
        console.log(
          `    ${$.yellow}→ DNS resolution failed. Check your internet connection.${$.reset}`,
        );
      else if (msg.includes('ECONNREFUSED'))
        console.log(`    ${$.yellow}→ Connection refused. Is the server running?${$.reset}`);
      else if (msg.includes('timeout'))
        console.log(`    ${$.yellow}→ Connection timed out. Check network/firewall.${$.reset}`);
      else console.log(`    ${$.dim}${msg.slice(0, 100)}${$.reset}`);
    }
  }

  // Summary
  console.log();
  if (allOk) {
    console.log(`  ${$.green}${$.bold}All checks passed ✓${$.reset}`);
    console.log(
      `  ${$.dim}Run ${$.cyan}commander quickstart${$.reset}${$.dim} for usage tips.${$.reset}`,
    );
  } else {
    console.log(`  ${$.yellow}Some checks need attention${$.reset}`);
    console.log(
      `  ${$.dim}Run ${$.cyan}commander quickstart${$.reset}${$.dim} for setup guidance.${$.reset}`,
    );
  }
  console.log();
}

export async function cmdMode(modeArg?: string) {
  const approval = getApprovalSystem();

  if (!modeArg) {
    const current = approval.getMode();
    const modeLabels: Record<string, string> = {
      suggest: 'Suggest mode — prompts before risky operations',
      'auto-edit': 'Auto-edit mode — allows most operations, flags sandbox escapes',
      'full-auto': 'Full-auto mode — no approval gates',
      'read-only': 'Read-only mode — no writes, no destructive ops',
      plan: 'Plan mode — analysis only, no modifications',
    };
    section('APPROVAL MODE');
    kv('Mode', current, $.cyan);
    console.log(`  ${$.dim}${modeLabels[current] ?? ''}${$.reset}`);
    console.log(
      `\n  ${$.dim}Set:  commander mode <plan|read-only|auto-edit|full-auto|suggest>${$.reset}\n`,
    );
    return;
  }

  const validModes: ApprovalMode[] = ['suggest', 'auto-edit', 'full-auto', 'read-only', 'plan'];
  if (!validModes.includes(modeArg as ApprovalMode)) {
    console.log(`  ${$.red}Invalid mode:${$.reset} "${modeArg}"`);
    console.log(`  ${$.dim}Valid modes:${$.reset} ${validModes.join(', ')}\n`);
    return;
  }

  approval.setMode(modeArg as ApprovalMode);
  console.log(`  ${$.green}✓${$.reset} Mode set to ${$.cyan}${modeArg}${$.reset}\n`);
}
