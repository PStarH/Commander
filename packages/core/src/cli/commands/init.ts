/**
 * commander init — Zero-config environment scan + fallback chain setup.
 *
 * Scans all 20+ API keys in the environment, tests connectivity to each
 * available provider, measures latency, recommends the optimal fallback
 * chain, and saves configuration to .commander.json.
 *
 * This is the main onboarding experience for Commander.
 */
import * as fs from 'fs';
import * as path from 'path';
import { probeEnvironment, testConnectivity, recommendFallbackChain } from '../../commander/probe';
import type { ConnectivityResult } from '../../commander/probe';
import { $, startSpinner, section, kv } from '../util';
import { cmdQuickstart } from './quickstart';

// ============================================================================
// Color helpers for table rendering
// ============================================================================

function statusIcon(status: ConnectivityResult['status']): string {
  switch (status) {
    case 'reachable':
      return `${$.green}●${$.reset}`;
    case 'auth_error':
      return `${$.yellow}▲${$.reset}`;
    case 'timeout':
      return `${$.yellow}⏱${$.reset}`;
    case 'unreachable':
      return `${$.red}✗${$.reset}`;
    case 'skipped':
      return `${$.dim}○${$.reset}`;
  }
}

function statusLabel(status: ConnectivityResult['status']): string {
  switch (status) {
    case 'reachable':
      return `${$.green}OK${$.reset}`;
    case 'auth_error':
      return `${$.yellow}AUTH${$.reset}`;
    case 'timeout':
      return `${$.yellow}T/O${$.reset}`;
    case 'unreachable':
      return `${$.red}DOWN${$.reset}`;
    case 'skipped':
      return `${$.dim}--${$.reset}`;
  }
}

function tierBadge(tier: string): string {
  switch (tier) {
    case 'local':
      return `${$.cyan}local${$.reset}`;
    case 'cloud':
      return `${$.dim}cloud${$.reset}`;
    case 'premium':
      return `${$.yellow}premium${$.reset}`;
    default:
      return tier;
  }
}

function latencyStr(ms?: number): string {
  if (ms === undefined) return `${$.dim}---${$.reset}`;
  if (ms < 100) return `${$.green}${ms}ms${$.reset}`;
  if (ms < 300) return `${$.yellow}${ms}ms${$.reset}`;
  return `${$.dim}${ms}ms${$.reset}`;
}

// ============================================================================
// Main command
// ============================================================================

export async function cmdInit(flags: Record<string, string> = {}): Promise<void> {
  const skipTests = !!flags['skip-tests'] || !!flags['no-connectivity'];
  const saveOnly = !!flags['save'];
  const timeout = flags['timeout'] ? parseInt(flags['timeout'], 10) : 5000;

  // ── Header ──────────────────────────────────────────────────────────
  console.log(
    `\n  ${$.bold}${$.blue}╭──────────────────────────────────────────────────────────╮${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander Init${$.reset} — Zero-Config Environment Setup          ${$.bold}${$.blue}│${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}╰──────────────────────────────────────────────────────────╯${$.reset}\n`,
  );

  // ── Phase 1: Probe ──────────────────────────────────────────────────
  const probeDone = startSpinner('Scanning environment for API keys...');
  const probe = await probeEnvironment();
  probeDone();

  section('ENVIRONMENT');
  kv(
    'API keys found',
    `${probe.apiProviderCount}`,
    probe.apiProviderCount > 0 ? $.green : $.yellow,
  );
  kv(
    'Ollama',
    probe.ollamaAvailable ? `${$.green}available${$.reset}` : `${$.dim}not found${$.reset}`,
  );
  kv('vLLM', probe.vllmAvailable ? `${$.green}available${$.reset}` : `${$.dim}not found${$.reset}`);
  kv(
    'Docker',
    probe.dockerAvailable ? `${$.green}available${$.reset}` : `${$.dim}not found${$.reset}`,
  );
  kv(
    'Redis',
    probe.redisUrl ? `${$.green}${probe.redisUrl}${$.reset}` : `${$.dim}not configured${$.reset}`,
  );
  kv(
    'Kubernetes',
    probe.inKubernetes
      ? `${$.green}in-cluster (${probe.k8sNamespace ?? 'default'})${$.reset}`
      : `${$.dim}not detected${$.reset}`,
  );
  console.log();

  // ── Phase 2: Render provider table ──────────────────────────────────
  const allProviderNames = [
    ...new Set([
      ...probe.availableProviders,
      ...(probe.ollamaAvailable ? ['ollama'] : []),
      ...(probe.vllmAvailable ? ['vllm'] : []),
    ]),
  ];

  // Also show providers that have env keys set but weren't in the probe's available list
  const extraProviders = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'glm',
    'mimo',
    'xiaomi',
    'openrouter',
    'cohere',
    'mistral',
    'groq',
    'together',
    'perplexity',
    'fireworks',
    'replicate',
    'bedrock',
    'xai',
    'anyscale',
    'deepinfra',
    'agnes',
  ];
  for (const p of extraProviders) {
    if (!allProviderNames.includes(p)) {
      const envKey = getEnvKeyForProvider(p);
      if (envKey && process.env[envKey]) {
        allProviderNames.push(p);
      }
    }
  }

  // ── Phase 3: Connectivity tests ────────────────────────────────────
  let results: ConnectivityResult[] = [];

  if (!skipTests && allProviderNames.length > 0) {
    console.log(
      `  ${$.dim}Testing connectivity to ${allProviderNames.length} providers (${timeout}ms timeout)...${$.reset}\n`,
    );

    // Run tests with visual progress
    const testStart = Date.now();
    results = await testConnectivity(allProviderNames, timeout);

    // ── Render table ──────────────────────────────────────────────────
    const nameWidth = 20;
    const header = `  ${$.bold}${'Provider'.padEnd(nameWidth)} Status  Latency   Tier     Model${$.reset}`;
    const divider = `  ${$.dim}${'─'.repeat(nameWidth + 36)}${$.reset}`;
    console.log(header);
    console.log(divider);

    for (const r of results) {
      const name = r.displayName.slice(0, nameWidth - 1).padEnd(nameWidth);
      const status = `${statusIcon(r.status)} ${statusLabel(r.status)}`.padEnd(14);
      const lat = latencyStr(r.latencyMs).padEnd(18);
      const tier = tierBadge(r.tier).padEnd(18);
      const model = `${$.dim}${r.defaultModel.slice(0, 25)}${$.reset}`;
      console.log(`  ${$.cyan}${name}${$.reset} ${status} ${lat} ${tier} ${model}`);

      // Show error detail for non-reachable
      if (r.error && r.status !== 'reachable') {
        console.log(`  ${' '.repeat(nameWidth)} ${$.dim}↳ ${r.error.slice(0, 60)}${$.reset}`);
      }
    }
    console.log();

    const elapsed = Date.now() - testStart;
    const reachable = results.filter((r) => r.status === 'reachable').length;
    const authErrors = results.filter((r) => r.status === 'auth_error').length;
    console.log(
      `  ${$.dim}${elapsed}ms — ${$.green}${reachable} reachable${$.reset}${authErrors > 0 ? `, ${$.yellow}${authErrors} auth errors${$.reset}` : ''}${$.reset}\n`,
    );
  } else if (skipTests) {
    console.log(`  ${$.dim}Connectivity tests skipped (--skip-tests).${$.reset}\n`);
  }

  // ── Phase 4: Fallback chain recommendation ─────────────────────────
  if (results.length > 0) {
    section('RECOMMENDED FALLBACK CHAIN');

    const chain = recommendFallbackChain(results);

    if (chain.length === 0) {
      console.log(`  ${$.red}No reachable providers found.${$.reset}`);
      console.log(
        `  ${$.dim}Launching ${$.cyan}commander quickstart${$.reset}${$.dim} to set one up...${$.reset}\n`,
      );
      // UX audit P0-3: turn the dead-end into a recovery path. Hand off to
      // the interactive setup wizard so users that completed the scan are
      // served guidance, not a wall of text telling them to "go elsewhere".
      try {
        await cmdQuickstart([]);
      } catch (err) {
        console.log(
          `  ${$.yellow}⚠${$.reset} ${$.dim}Quickstart failed: ${(err as Error).message}${$.reset}`,
        );
        console.log(`  ${$.dim}Set an API key (e.g., OPENAI_API_KEY) and try again.${$.reset}\n`);
      }
      return;
    }

    // Show chain visualization
    const chainDisplay = chain
      .map((p, i) => {
        const result = results.find((r) => r.provider === p)!;
        const arrow = i < chain.length - 1 ? ` ${$.dim}→${$.reset} ` : '';
        return `${$.cyan}${result.displayName}${$.reset} ${$.dim}(${latencyStr(result.latencyMs)})${$.reset}${arrow}`;
      })
      .join('');

    console.log(`  ${chainDisplay}\n`);

    // Save configuration
    const configPath = path.join(process.cwd(), '.commander.json');
    let existingConfig: Record<string, unknown> = {};

    try {
      if (fs.existsSync(configPath)) {
        existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch {
      /* start fresh */
    }

    // Build fallback chain config
    const primary = chain[0];
    const primaryResult = results.find((r) => r.provider === primary)!;
    const fallbackProviders = chain.slice(1);

    const newConfig = {
      ...existingConfig,
      model: primaryResult.defaultModel,
      provider: primary,
      fallbackChain: fallbackProviders.length > 0 ? fallbackProviders : undefined,
      // Store full connectivity results for future reference
      _initResults: {
        timestamp: new Date().toISOString(),
        reachable: results.filter((r) => r.status === 'reachable').map((r) => r.provider),
        chain,
      },
    };

    // Remove undefined fields for clean JSON
    const cleanConfig = JSON.parse(JSON.stringify(newConfig));

    try {
      fs.writeFileSync(configPath, JSON.stringify(cleanConfig, null, 2), 'utf-8');
      console.log(
        `  ${$.green}✓${$.reset} Configuration saved to ${$.cyan}.commander.json${$.reset}`,
      );
      console.log(
        `  ${$.dim}  Provider: ${$.cyan}${primary}${$.reset}${$.dim}  Model: ${$.cyan}${primaryResult.defaultModel}${$.reset}`,
      );

      if (fallbackProviders.length > 0) {
        console.log(`  ${$.dim}  Fallback: ${$.cyan}${fallbackProviders.join(' → ')}${$.reset}`);
      }
      console.log();
    } catch (err) {
      console.log(`  ${$.red}✗${$.reset} Failed to save config: ${(err as Error).message}\n`);
      return;
    }
  }

  // ── Phase 5: Quick start guide ──────────────────────────────────────
  if (!saveOnly) {
    section('GET STARTED');
    console.log(`  ${$.dim}Run your first task:${$.reset}`);
    console.log(`    ${$.cyan}commander run \"Hello, world!\"${$.reset}`);
    console.log();
    console.log(`  ${$.dim}Common commands:${$.reset}`);
    console.log(
      `    ${$.cyan}commander run \"<task>\"${$.reset}        ${$.dim}Execute a task${$.reset}`,
    );
    console.log(
      `    ${$.cyan}commander run \"<task>\" --dry-run${$.reset} ${$.dim}Plan without executing${$.reset}`,
    );
    console.log(
      `    ${$.cyan}commander run \"<task>\" --stream${$.reset}  ${$.dim}Real-time progress${$.reset}`,
    );
    console.log(
      `    ${$.cyan}commander status${$.reset}              ${$.dim}System status${$.reset}`,
    );
    console.log(
      `    ${$.cyan}commander config${$.reset}              ${$.dim}Manage configuration${$.reset}`,
    );
    console.log(
      `    ${$.cyan}commander doctor${$.reset}              ${$.dim}Run diagnostics${$.reset}`,
    );
    console.log(
      `    ${$.cyan}commander tui${$.reset}                 ${$.dim}Interactive dashboard${$.reset}`,
    );
    console.log();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getEnvKeyForProvider(provider: string): string | undefined {
  const map: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    glm: 'ZHIPU_API_KEY',
    mimo: 'MIMO_API_KEY',
    xiaomi: 'XIAOMI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    cohere: 'CO_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    groq: 'GROQ_API_KEY',
    together: 'TOGETHER_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    replicate: 'REPLICATE_API_TOKEN',
    xai: 'XAI_API_KEY',
    anyscale: 'ANYSCALE_API_KEY',
    deepinfra: 'DEEPINFRA_API_KEY',
    agnes: 'AGNES_API_KEY',
  };
  return map[provider];
}
