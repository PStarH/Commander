import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'mimo'
  | 'deepseek'
  | 'glm'
  | 'xiaomi'
  | 'ollama'
  | 'vllm'
  | 'cohere'
  | 'mistral'
  | 'groq'
  | 'together'
  | 'perplexity'
  | 'fireworks'
  | 'replicate'
  | 'bedrock'
  | 'xai'
  | 'anyscale'
  | 'deepinfra'
  | 'agnes';

export const PROVIDER_ORDER: ProviderType[] = [
  'ollama',
  'vllm',
  'deepinfra',
  'anyscale',
  'replicate',
  'cohere',
  'mistral',
  'groq',
  'together',
  'perplexity',
  'fireworks',
  'xiaomi',
  'mimo',
  'deepseek',
  'glm',
  'xai',
  'bedrock',
  'agnes',
  'openrouter',
  'anthropic',
  'google',
  'openai',
];

export const ENV_MAP: Record<ProviderType, { key: string; url: string; model: string }> = {
  openai: { key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', model: 'OPENAI_MODEL' },
  anthropic: { key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL', model: 'ANTHROPIC_MODEL' },
  google: { key: 'GOOGLE_API_KEY', url: 'GOOGLE_BASE_URL', model: 'GOOGLE_MODEL' },
  openrouter: { key: 'OPENROUTER_API_KEY', url: 'OPENROUTER_BASE_URL', model: 'OPENROUTER_MODEL' },
  mimo: { key: 'MIMO_API_KEY', url: 'MIMO_BASE_URL', model: 'MIMO_MODEL' },
  deepseek: { key: 'DEEPSEEK_API_KEY', url: 'DEEPSEEK_BASE_URL', model: 'DEEPSEEK_MODEL' },
  glm: { key: 'ZHIPU_API_KEY', url: 'ZHIPU_BASE_URL', model: 'ZHIPU_MODEL' },
  xiaomi: { key: 'XIAOMI_API_KEY', url: 'XIAOMI_BASE_URL', model: 'XIAOMI_MODEL' },
  ollama: { key: 'OLLAMA_API_KEY', url: 'OLLAMA_BASE_URL', model: 'OLLAMA_MODEL' },
  vllm: { key: 'VLLM_API_KEY', url: 'VLLM_BASE_URL', model: 'VLLM_MODEL' },
  cohere: { key: 'CO_API_KEY', url: 'COHERE_BASE_URL', model: 'COHERE_MODEL' },
  mistral: { key: 'MISTRAL_API_KEY', url: 'MISTRAL_BASE_URL', model: 'MISTRAL_MODEL' },
  groq: { key: 'GROQ_API_KEY', url: 'GROQ_BASE_URL', model: 'GROQ_MODEL' },
  together: { key: 'TOGETHER_API_KEY', url: 'TOGETHER_BASE_URL', model: 'TOGETHER_MODEL' },
  perplexity: { key: 'PERPLEXITY_API_KEY', url: 'PERPLEXITY_BASE_URL', model: 'PERPLEXITY_MODEL' },
  fireworks: { key: 'FIREWORKS_API_KEY', url: 'FIREWORKS_BASE_URL', model: 'FIREWORKS_MODEL' },
  replicate: { key: 'REPLICATE_API_TOKEN', url: 'REPLICATE_BASE_URL', model: 'REPLICATE_MODEL' },
  bedrock: { key: 'AWS_ACCESS_KEY_ID', url: 'AWS_BASE_URL', model: 'BEDROCK_MODEL' },
  xai: { key: 'XAI_API_KEY', url: 'XAI_BASE_URL', model: 'XAI_MODEL' },
  anyscale: { key: 'ANYSCALE_API_KEY', url: 'ANYSCALE_BASE_URL', model: 'ANYSCALE_MODEL' },
  deepinfra: { key: 'DEEPINFRA_API_KEY', url: 'DEEPINFRA_BASE_URL', model: 'DEEPINFRA_MODEL' },
  agnes: { key: 'AGNES_API_KEY', url: 'AGNES_BASE_URL', model: 'AGNES_MODEL' },
};

export const DEFAULT_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  mimo: 'https://token-plan-sgp.xiaomimimo.com/v1',
  deepseek: 'https://api.deepseek.com',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  xiaomi: 'https://api.xiaomimimo.com/v1',
  ollama: 'http://localhost:11434/v1',
  vllm: 'http://localhost:8000/v1',
  cohere: 'https://api.cohere.com',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.ai/v1',
  perplexity: 'https://api.perplexity.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  replicate: 'https://api.replicate.com/v1',
  bedrock: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  xai: 'https://api.x.ai/v1',
  anyscale: 'https://api.endpoints.anyscale.com/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  agnes: 'https://apihub.agnes-ai.com/v1',
};

export const DEFAULT_MODELS: Record<ProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-sonnet-20241022',
  google: 'gemini-2.0-flash',
  openrouter: 'openai/gpt-4o-mini',
  mimo: 'mimo-v2.5',
  deepseek: 'deepseek-v4-flash',
  glm: 'glm-4.7',
  xiaomi: 'mimo-v2-flash',
  ollama: 'llama3.2',
  vllm: 'meta-llama/Llama-3.2-3B-Instruct',
  cohere: 'command-a-plus-05-2026',
  mistral: 'mistral-large-latest',
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  perplexity: 'sonar-pro',
  fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  replicate: 'meta/meta-llama-3.3-70b-instruct',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  xai: 'grok-2-latest',
  anyscale: 'meta-llama/Llama-3.3-70B-Instruct',
  deepinfra: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  agnes: 'agnes-2.0-flash',
};

const DISPLAY_NAMES: Record<ProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  mimo: 'MiMo',
  deepseek: 'DeepSeek',
  glm: 'GLM (Zhipu AI)',
  xiaomi: 'Xiaomi MiMo',
  ollama: 'Ollama (Local)',
  vllm: 'vLLM (Local)',
  cohere: 'Cohere',
  mistral: 'Mistral AI',
  groq: 'Groq',
  together: 'Together AI',
  perplexity: 'Perplexity',
  fireworks: 'Fireworks AI',
  replicate: 'Replicate',
  bedrock: 'AWS Bedrock',
  xai: 'xAI (Grok)',
  anyscale: 'Anyscale',
  deepinfra: 'DeepInfra',
  agnes: 'Agnes AI',
};

export const API_TYPE: Record<ProviderType, 'openai' | 'anthropic' | 'google'> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  openrouter: 'openai',
  mimo: 'openai',
  deepseek: 'openai',
  glm: 'openai',
  xiaomi: 'openai',
  ollama: 'openai',
  vllm: 'openai',
  cohere: 'openai',
  mistral: 'openai',
  groq: 'openai',
  together: 'openai',
  perplexity: 'openai',
  fireworks: 'openai',
  replicate: 'openai',
  bedrock: 'openai',
  xai: 'openai',
  anyscale: 'openai',
  deepinfra: 'openai',
  agnes: 'openai',
};

export interface ProviderInfo {
  type: ProviderType;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  apiType: 'openai' | 'anthropic' | 'google';
}

/**
 * Auto-detect which provider is configured based on env vars.
 * Returns the first provider with a matching API key, in priority order.
 */
function checkLocalProvider(
  type: ProviderType,
  keyEnv: string,
  urlEnv: string,
  modelEnv: string,
): ProviderInfo | null {
  const baseUrl = process.env[urlEnv] || DEFAULT_URLS[type];
  const defaultModel = process.env[modelEnv] || DEFAULT_MODELS[type];
  if (!process.env[urlEnv] && !process.env[modelEnv]) return null;
  return {
    type,
    apiKey: process.env[keyEnv] || '',
    baseUrl,
    defaultModel,
    apiType: API_TYPE[type],
  };
}

/**
 * Resolve the API key for a provider, checking fallback env var names.
 */
export function resolveApiKey(type: ProviderType, primaryKey: string): string {
  return (
    process.env[primaryKey] ||
    (type === 'cohere' ? process.env.COHERE_API_KEY || '' : '') ||
    (type === 'replicate' ? process.env.REPLICATE_API_KEY || '' : '') ||
    (type === 'perplexity' ? process.env.PPLX_API_KEY || '' : '') ||
    ''
  );
}

export function detectProvider(): ProviderInfo | null {
  for (const type of PROVIDER_ORDER) {
    const env = ENV_MAP[type];
    const apiKey = resolveApiKey(type, env.key);

    if (!apiKey) {
      // Local providers (Ollama, vLLM) — need env configured, no API key required
      if (type === 'ollama') {
        // Support both OLLAMA_HOST (official: host:port) and OLLAMA_BASE_URL (full URL)
        const host = process.env.OLLAMA_HOST;
        const baseUrl = process.env.OLLAMA_BASE_URL;
        if (!host && !baseUrl && !process.env.OLLAMA_MODEL) continue;
        let resolvedBaseUrl: string;
        if (host) {
          const prefix = host.startsWith('http://') || host.startsWith('https://') ? '' : 'http://';
          resolvedBaseUrl = `${prefix}${host}`.replace(/\/+$/, '') + '/v1';
        } else {
          resolvedBaseUrl = baseUrl || DEFAULT_URLS[type];
        }
        return {
          type,
          apiKey: '',
          baseUrl: resolvedBaseUrl,
          defaultModel: process.env.OLLAMA_MODEL || DEFAULT_MODELS[type],
          apiType: 'openai',
        };
      }
      if (type === 'vllm') {
        const result = checkLocalProvider(type, 'VLLM_API_KEY', 'VLLM_BASE_URL', 'VLLM_MODEL');
        if (result) return result;
        continue;
      }

      // Bedrock uses AWS credentials, not a traditional API key
      if (type === 'bedrock') {
        const hasAwsCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
        if (!hasAwsCreds) continue;
        return {
          type,
          apiKey: '',
          baseUrl: DEFAULT_URLS[type],
          defaultModel: process.env.BEDROCK_MODEL || DEFAULT_MODELS[type],
          apiType: API_TYPE[type],
        };
      }

      // Check if OPENAI_API_KEY + base URL hints match this provider
      if (type !== 'openai' && process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
        const baseUrl = process.env.OPENAI_BASE_URL.toLowerCase();
        const nonOpenai = type as string;
        const match =
          (nonOpenai === 'mimo' && (baseUrl.includes('mimo') || baseUrl.includes('xiaomimi'))) ||
          (nonOpenai === 'deepseek' && baseUrl.includes('deepseek')) ||
          (nonOpenai === 'glm' && (baseUrl.includes('bigmodel') || baseUrl.includes('zhipu'))) ||
          (nonOpenai === 'ollama' && baseUrl.includes('localhost:11434')) ||
          (nonOpenai === 'vllm' && baseUrl.includes('localhost:8000')) ||
          (nonOpenai === 'groq' && baseUrl.includes('groq')) ||
          (nonOpenai === 'mistral' && baseUrl.includes('mistral')) ||
          (nonOpenai === 'together' && baseUrl.includes('together'));
        if (!match) continue;
      } else {
        continue;
      }
    }

    const baseUrl = process.env[env.url] || DEFAULT_URLS[type];
    const defaultModel = process.env[env.model] || DEFAULT_MODELS[type];

    return {
      type,
      apiKey: resolveApiKey(type, env.key) || process.env.OPENAI_API_KEY || '',
      baseUrl,
      defaultModel,
      apiType: API_TYPE[type],
    };
  }
  return null;
}

export interface CommanderSettings {
  model?: string;
  enableMetaTools?: boolean;
  toolRetrieval?: boolean;
  entropyGating?: boolean;
  speculativeExecution?: boolean;
}

const CONFIG_PATHS = [
  path.join(process.cwd(), '.commander.json'),
  path.join(process.cwd(), '.commander', 'config.json'),
];

const SETTING_ALIASES: Record<string, keyof CommanderSettings> = {
  model: 'model',
  'meta-tools': 'enableMetaTools',
  meta_tools: 'enableMetaTools',
  enableMetaTools: 'enableMetaTools',
  toolRetrieval: 'toolRetrieval',
  entropyGating: 'entropyGating',
  speculativeExecution: 'speculativeExecution',
};

/**
 * Read settings from config file.
 */
function loadSettings(): CommanderSettings {
  for (const p of CONFIG_PATHS) {
    try {
      if (fs.existsSync(p)) {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch (err) {
          reportSilentFailure(err, 'commanderConfig:334');
          getGlobalLogger().warn('CommanderConfig', `Failed to parse config file ${p}`);
          return {};
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'commanderConfig:340');
      getGlobalLogger().debug('CommanderConfig', `Skipping config file ${p}`);
    }
  }
  return {};
}

function saveSettings(s: CommanderSettings): void {
  const filePath = CONFIG_PATHS[0];
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(s, null, 2), 'utf-8');
}

let cachedSettings: CommanderSettings | null = null;

function getSettings(): CommanderSettings {
  if (!cachedSettings) cachedSettings = loadSettings();
  return cachedSettings;
}

export function getModelOverride(): string | undefined {
  return getSettings().model;
}

export function getEffectiveModel(): string {
  const provider = detectProvider();
  const override = getModelOverride();
  return override || provider?.defaultModel || 'gpt-4o';
}

export function setConfig(key: string, value: string): void {
  const settings = getSettings();
  const normalizedKey = SETTING_ALIASES[key];
  if (!normalizedKey) {
    throw new Error(
      `Unknown setting: ${key}. Try: model, meta-tools, toolRetrieval, entropyGating, speculativeExecution`,
    );
  }
  if (normalizedKey === 'model') {
    settings.model = value;
  } else {
    (settings as Record<string, unknown>)[normalizedKey] =
      value === 'true' || value === '1' || value === 'on';
  }
  saveSettings(settings);
  cachedSettings = settings;
}

export function showConfig(): void {
  const provider = detectProvider();
  const settings = getSettings();

  console.log(
    `\n  Provider:  ${provider ? `${DISPLAY_NAMES[provider.type]} (${provider.type})` : 'None'}`,
  );
  console.log(`  Model:     ${settings.model || provider?.defaultModel || 'auto'}`);
  console.log(`  API URL:   ${provider?.baseUrl || '-'}`);
  console.log(`  API type:  ${provider?.apiType || '-'}`);
  console.log(`\n  Features:`);
  console.log(`    meta-tools:         ${settings.enableMetaTools ? 'on' : 'off'}`);
  console.log(`    toolRetrieval:      ${settings.toolRetrieval ? 'on' : 'off'}`);
  console.log(`    entropyGating:      ${settings.entropyGating ? 'on' : 'off'}`);
  console.log(`    speculativeExec:    ${settings.speculativeExecution ? 'on' : 'off'}`);
}

export function listProviders(): void {
  for (const type of PROVIDER_ORDER) {
    const env = ENV_MAP[type];
    const key = process.env[env.key] || '';
    const hasKey = !!key;
    const viaOpenAI =
      !hasKey && type !== 'openai' && process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL;
    const model = process.env[env.model] || DEFAULT_MODELS[type];
    console.log(
      `  ${hasKey ? '✓' : viaOpenAI ? '~' : ' '} ${DISPLAY_NAMES[type].padEnd(20)} ${type.padEnd(12)} ${model}`,
    );
  }
}

export function listModels(): void {
  const all = [
    { provider: 'openai', name: 'gpt-4o, gpt-4o-mini, gpt-4.1, o3-mini, o4-mini' },
    {
      provider: 'anthropic',
      name: 'claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus, claude-4-sonnet',
    },
    { provider: 'google', name: 'gemini-2.0-flash, gemini-2.0-pro, gemini-2.5-pro' },
    {
      provider: 'openrouter',
      name: 'openai/gpt-4o, anthropic/claude-3.5-sonnet, google/gemini-2.0-flash, deepseek/deepseek-chat, meta-llama/llama-3.3-70b, mistral/mistral-large',
    },
    {
      provider: 'deepseek',
      name: 'deepseek-v4-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner',
    },
    {
      provider: 'glm',
      name: 'glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.7-flash, glm-4.6, glm-4.5',
    },
    { provider: 'mimo', name: 'mimo-v2.5, mimo-v2.5-pro, mimo-v2-pro, mimo-v2-omni' },
    { provider: 'xiaomi', name: 'mimo-v2-flash, mimo-v2-pro, mimo-v2-omni' },
    {
      provider: 'ollama',
      name: 'llama3.2, llama3.1, llama3, mistral, qwen2.5, codellama, deepseek-coder (local)',
    },
    {
      provider: 'vllm',
      name: 'Llama-3.2, Mistral, Qwen2.5, DeepSeek-Coder, any HF model (self-hosted)',
    },
    {
      provider: 'cohere',
      name: 'command-a-plus-05-2026, command-r-08-2024, command-r-plus-08-2024',
    },
    {
      provider: 'mistral',
      name: 'mistral-large-latest, mistral-small-latest, codestral-latest, open-mistral-nemo',
    },
    {
      provider: 'groq',
      name: 'llama-3.3-70b-versatile, llama3-70b-8192, mixtral-8x7b-32768, gemma2-9b-it',
    },
    {
      provider: 'together',
      name: 'Llama-3.3-70B, DeepSeek-V3, Qwen2.5-72B, Mixtral-8x22B, Gemma-2-27b',
    },
    {
      provider: 'perplexity',
      name: 'sonar-pro, sonar, sonar-reasoning-pro, sonar-reasoning, sonar-deep-research, r1-1776',
    },
    {
      provider: 'fireworks',
      name: 'llama-v3p3-70b, deepseek-v3, qwen2p5-coder-32b, mixtral-8x22b',
    },
    {
      provider: 'replicate',
      name: 'meta-llama-3.3-70b, mistral-7b, gemma-2-27b (open-source via cloud)',
    },
    {
      provider: 'bedrock',
      name: 'Claude 3.5 Sonnet/Haiku/Opus, Llama 3 70B/8B, Mistral Large (AWS)',
    },
  ];
  for (const p of all) {
    console.log(`  ${DISPLAY_NAMES[p.provider as ProviderType]} (${p.provider}):`);
    console.log(`    ${p.name}`);
  }
}

export function resetConfig(): void {
  cachedSettings = null;
}
