import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import {
  type ProviderType,
  ENV_MAP,
  DEFAULT_URLS,
  DEFAULT_MODELS,
  API_TYPE,
  PROVIDER_ORDER,
  resolveApiKey,
} from './commanderConfig';

export type ExecutionMode = 'fast' | 'balanced' | 'thorough';
export type TopologyChoice =
  | 'auto'
  | 'single'
  | 'sequential'
  | 'parallel'
  | 'hierarchical'
  | 'hybrid'
  | 'debate'
  | 'ensemble'
  | 'evaluator-optimizer';

export interface RuntimeConfig {
  provider: string;
  model: string;
  mode: ExecutionMode;
  topology: TopologyChoice;
  budget: number | 'auto';
  apiKey: string;
  baseUrl: string;
  apiType: 'openai' | 'anthropic' | 'google';
  providerChain: string[];
  storage: {
    checkpoints: string;
    traces: string;
    samples: string;
  };
  debug: boolean;
  verbose: boolean;
  tenantId?: string;
}

export interface CommanderFileConfig {
  $schema?: string;
  version?: number;
  provider?: string;
  model?: string;
  mode?: ExecutionMode;
  topology?: TopologyChoice;
  budget?: number | 'auto';
  _providerChain?: string[];
  _storage?: {
    checkpoints?: string;
    traces?: string;
    samples?: string;
  };
  _initResults?: Record<string, unknown>;
  fallbackChain?: string[];
  warRoom?: Record<string, unknown>;
  mcpServers?: unknown[];
  a2a?: Record<string, unknown>;
  [key: string]: unknown;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  provider: 'auto',
  model: 'auto',
  mode: 'balanced',
  topology: 'auto',
  budget: 'auto',
  apiKey: '',
  baseUrl: '',
  apiType: 'openai',
  providerChain: [],
  storage: {
    checkpoints: path.join(process.cwd(), '.commander_state'),
    traces: path.join(process.cwd(), '.commander_traces'),
    samples: path.join(process.cwd(), '.commander_samples'),
  },
  debug: false,
  verbose: false,
};

const CONFIG_PATHS = [
  path.join(process.cwd(), '.commander.json'),
  path.join(process.cwd(), '.commander', 'config.json'),
];

function loadFileConfig(): CommanderFileConfig {
  for (const p of CONFIG_PATHS) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as CommanderFileConfig;
      }
    } catch (e) {
      getGlobalLogger().debug('ConfigResolver', `Failed to read config file ${p}`, {
        error: (e as Error)?.message,
      });
    }
  }
  return {};
}

function resolveFromEnv(providerName: string): {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiType: 'openai' | 'anthropic' | 'google';
} {
  if (providerName === 'auto') {
    const detected = detectFirstAvailableProvider();
    if (detected) providerName = detected;
    else return { apiKey: '', baseUrl: '', model: '', apiType: 'openai' };
  }
  const env = ENV_MAP[providerName as ProviderType];
  if (!env) return { apiKey: '', baseUrl: '', model: '', apiType: 'openai' };
  return {
    apiKey: resolveApiKey(providerName as ProviderType, env.key),
    baseUrl: process.env[env.url] || DEFAULT_URLS[providerName as ProviderType] || '',
    model: process.env[env.model] || DEFAULT_MODELS[providerName as ProviderType] || '',
    apiType: API_TYPE[providerName as ProviderType] || 'openai',
  };
}

function detectFirstAvailableProvider(): string | null {
  for (const type of PROVIDER_ORDER) {
    const env = ENV_MAP[type];
    if (resolveApiKey(type, env.key)) return type;
    if (type === 'ollama' && (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL)) return type;
    if (type === 'vllm' && (process.env.VLLM_BASE_URL || process.env.VLLM_MODEL)) return type;
    if (type === 'bedrock' && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE)) return type;
  }
  return null;
}

function resolveProviderChain(fileConfig: CommanderFileConfig): string[] {
  const explicitChain = fileConfig._providerChain ?? fileConfig.fallbackChain;
  if (explicitChain && Array.isArray(explicitChain) && explicitChain.length > 0) {
    return explicitChain as string[];
  }
  const available: string[] = [];
  for (const type of PROVIDER_ORDER) {
    const env = ENV_MAP[type];
    if (resolveApiKey(type, env.key)) {
      available.push(type);
      if (available.length >= 5) break;
    }
    if (type === 'ollama' && (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL)) available.push(type);
    if (type === 'vllm' && process.env.VLLM_BASE_URL) available.push(type);
    if (type === 'bedrock' && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE)) available.push(type);
  }
  return available;
}

export class ConfigResolver {
  private fileConfig: CommanderFileConfig;
  private envCache: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    apiType: 'openai' | 'anthropic' | 'google';
  } | null = null;

  constructor() {
    this.fileConfig = loadFileConfig();
  }

  resolve(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
    const file = this.fileConfig;
    const providerName = overrides.provider ?? file.provider ?? DEFAULT_CONFIG.provider;

    if (!this.envCache || this.envCache.provider !== providerName) {
      this.envCache = { provider: providerName, ...resolveFromEnv(providerName) };
    }
    const env = this.envCache;

    const model = overrides.model ?? file.model ?? (env.model || DEFAULT_CONFIG.model);
    const mode = (overrides.mode ?? file.mode ?? DEFAULT_CONFIG.mode) as ExecutionMode;
    const topology = (overrides.topology ?? file.topology ?? DEFAULT_CONFIG.topology) as TopologyChoice;
    const budget = overrides.budget ?? file.budget ?? DEFAULT_CONFIG.budget;
    const providerChain = resolveProviderChain(file);

    return {
      provider: providerName === 'auto' ? (env.model ? providerName : detectFirstAvailableProvider() ?? 'none') : providerName,
      model: model === 'auto' ? env.model || 'gpt-4o' : model,
      mode, topology, budget,
      apiKey: env.apiKey, baseUrl: env.baseUrl, apiType: env.apiType,
      providerChain,
      storage: {
        checkpoints: overrides.storage?.checkpoints ?? file._storage?.checkpoints ?? DEFAULT_CONFIG.storage.checkpoints,
        traces: overrides.storage?.traces ?? file._storage?.traces ?? DEFAULT_CONFIG.storage.traces,
        samples: overrides.storage?.samples ?? file._storage?.samples ?? DEFAULT_CONFIG.storage.samples,
      },
      debug: overrides.debug ?? (!!process.env.COMMANDER_DEBUG || DEFAULT_CONFIG.debug),
      verbose: overrides.verbose ?? (!!process.env.COMMANDER_VERBOSE || DEFAULT_CONFIG.verbose),
      tenantId: overrides.tenantId ?? process.env.COMMANDER_TENANT_ID ?? undefined,
    };
  }

  reload(): void {
    this.fileConfig = loadFileConfig();
    this.envCache = null;
  }

  getFileConfig(): CommanderFileConfig {
    return { ...this.fileConfig };
  }

  detectAvailableProviders(): Array<{ name: string; displayName: string; apiKey: boolean }> {
    const { DISPLAY_NAMES } = require('./commanderConfig');
    const available: Array<{ name: string; displayName: string; apiKey: boolean }> = [];

    for (const type of PROVIDER_ORDER) {
      const env = ENV_MAP[type];
      const hasKey = !!resolveApiKey(type, env.key);
      if (hasKey) {
        available.push({ name: type, displayName: DISPLAY_NAMES[type], apiKey: true });
      } else if (type === 'ollama' && (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL)) {
        available.push({ name: type, displayName: DISPLAY_NAMES[type], apiKey: false });
      } else if (type === 'vllm' && process.env.VLLM_BASE_URL) {
        available.push({ name: type, displayName: DISPLAY_NAMES[type], apiKey: false });
      } else if (type === 'bedrock' && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE)) {
        available.push({ name: type, displayName: DISPLAY_NAMES[type], apiKey: false });
      }
    }
    return available;
  }
}

let _instance: ConfigResolver | null = null;

export function getConfigResolver(): ConfigResolver {
  if (!_instance) _instance = new ConfigResolver();
  return _instance;
}

export function resetConfigResolver(): void {
  _instance = null;
}
