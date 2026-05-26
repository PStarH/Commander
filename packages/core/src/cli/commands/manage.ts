import * as fs from 'fs';
import * as path from 'path';
import { detectProvider, getEffectiveModel, setConfig, showConfig, listProviders, listModels } from '../../config/commanderConfig';
import { getMetaLearner } from '../../selfEvolution/metaLearner';
import { getApprovalSystem } from '../../sandbox';
import type { ApprovalMode } from '../../sandbox';
import { getGlobalLogger } from '../../logging';
import { createRuntime, $, section, kv, bullet, cmdHeader, startSpinner, onboardingMessage } from './_shared';

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

  const envVars = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'MIMO_API_KEY', 'XIAOMI_API_KEY'];
  section('API KEYS');
  for (const v of envVars) {
    const exists = !!process.env[v];
    console.log(`  ${exists ? $.green + '✓' : $.dim + '✗'}${$.reset} ${v}`);
  }
  if (process.env.OPENAI_BASE_URL) console.log(`  ${$.dim}  (base URL: ${process.env.OPENAI_BASE_URL})${$.reset}`);

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
        console.log(`  ${$.yellow}!${$.reset} ${s.type}: ${s.from} → ${s.to} (${(s.confidence * 100).toFixed(0)}%)`);
      }
    }
  } catch (err) {
    getGlobalLogger().debug('CLI', 'Failed to load MetaLearner stats', { error: err instanceof Error ? err.message : String(err) });
  }

  const poolStatsPath = path.join(process.cwd(), '.commander_results');
  if (fs.existsSync(poolStatsPath)) {
    const files = fs.readdirSync(poolStatsPath).filter(f => f.endsWith('.txt'));
    if (files.length > 0) kv('Cached results', String(files.length));
  }
}

export async function cmdConfig(args: string[]) {
  if (args.length === 0 || args[0] === 'show') {
    section('CONFIGURATION');
    showConfig();
    console.log(`\n  ${$.dim}Set:  commander config set model <model-id>${$.reset}`);
    console.log(`  ${$.dim}      commander config set meta-tools on${$.reset}`);
    console.log(`  ${$.dim}      commander config list-providers${$.reset}`);
    console.log(`  ${$.dim}      commander config list-models${$.reset}`);
    console.log(`  ${$.dim}      commander config test${$.reset}`);
    return;
  }

  if (args[0] === 'set' && args.length >= 3) {
    try {
      setConfig(args[1], args.slice(2).join(' '));
      console.log(`  ${$.green}✓${$.reset} ${args[1]} = ${args.slice(2).join(' ')}`);
    } catch (e) {
      console.log(`  ${$.red}✗${$.reset} ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (args[0] === 'list-providers') {
    section('AVAILABLE PROVIDERS');
    console.log(`  ${$.dim}Set any API key env var to activate a provider:${$.reset}\n`);
    listProviders();
    console.log(`\n  ${$.dim}  ✓ = configured  ~ = via OPENAI_API_KEY  (space) = not set${$.reset}`);
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
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) console.log(` ${$.green}✓ Connection OK${$.reset}`);
      else console.log(` ${$.red}✗ ${res.status}${$.reset}`);
    } catch {
      console.log(` ${$.yellow}! Connection failed${$.reset}`);
    }
    return;
  }

  console.log(`  ${$.red}Usage:${$.reset} commander config [show|set <key> <val>|list-providers|list-models|test]`);
}

export async function cmdDoctor() {
  section('DOCTOR');
  const provider = detectProvider();
  const checks = [
    { label: 'Node.js v20+', pass: process.version.startsWith('v22') || process.version.startsWith('v20'), msg: '' },
    { label: `API key ${provider ? '✓' : '✗'}`, pass: !!provider, msg: 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.' },
    { label: 'Packages installed', pass: fs.existsSync(path.join(process.cwd(), 'node_modules')) || fs.existsSync(path.join(__dirname, '..', 'node_modules')), msg: 'Run: pnpm install' },
  ];
  let allOk = true;
  for (const c of checks) {
    if (!c.pass) allOk = false;
    console.log(`  ${c.pass ? $.green + '✓' : $.red + '✗'}${$.reset} ${c.label}${c.msg ? ' — ' + $.yellow + c.msg + $.reset : ''}`);
  }
  if (provider) {
    console.log(`  ${$.dim}Testing ${provider.type} at ${provider.baseUrl}...${$.reset}`);
    try {
      const res = await fetch(`${provider.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      console.log(`  ${res.ok ? $.green + '✓' : $.red + '✗'}${$.reset} API: ${res.status}`);
    } catch {
      console.log(`  ${$.yellow}!${$.reset} API unreachable`);
    }
  }
  if (allOk) console.log(`\n  ${$.green}${$.bold}All checks passed${$.reset}`);
  else console.log(`\n  ${$.yellow}Some checks need attention${$.reset}`);
}

export async function cmdMode(modeArg?: string) {
  const approval = getApprovalSystem();

  if (!modeArg) {
    const current = approval.getMode();
    const modeLabels: Record<string, string> = {
      'suggest': 'Suggest mode — prompts before risky operations',
      'auto-edit': 'Auto-edit mode — allows most operations, flags sandbox escapes',
      'full-auto': 'Full-auto mode — no approval gates',
      'read-only': 'Read-only mode — no writes, no destructive ops',
      'plan': 'Plan mode — analysis only, no modifications',
    };
    section('APPROVAL MODE');
    kv('Mode', current, $.cyan);
    console.log(`  ${$.dim}${modeLabels[current] ?? ''}${$.reset}`);
    console.log(`\n  ${$.dim}Set:  commander mode <plan|read-only|auto-edit|full-auto|suggest>${$.reset}\n`);
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
