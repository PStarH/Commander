import * as fs from 'fs';
import * as path from 'path';

export type ProviderType = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'mimo' | 'deepseek' | 'glm' | 'xiaomi';

const PROVIDER_ORDER: ProviderType[] = [
  'xiaomi', 'mimo', 'deepseek', 'glm', 'openrouter', 'anthropic', 'google', 'openai',
];

const ENV_MAP: Record<ProviderType, { key: string; url: string; model: string }> = {
  openai: { key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', model: 'OPENAI_MODEL' },
  anthropic: { key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL', model: 'ANTHROPIC_MODEL' },
  google: { key: 'GOOGLE_API_KEY', url: 'GOOGLE_BASE_URL', model: 'GOOGLE_MODEL' },
  openrouter: { key: 'OPENROUTER_API_KEY', url: 'OPENROUTER_BASE_URL', model: 'OPENROUTER_MODEL' },
  mimo: { key: 'MIMO_API_KEY', url: 'MIMO_BASE_URL', model: 'MIMO_MODEL' },
  deepseek: { key: 'DEEPSEEK_API_KEY', url: 'DEEPSEEK_BASE_URL', model: 'DEEPSEEK_MODEL' },
  glm: { key: 'ZHIPU_API_KEY', url: 'ZHIPU_BASE_URL', model: 'ZHIPU_MODEL' },
  xiaomi: { key: 'XIAOMI_API_KEY', url: 'XIAOMI_BASE_URL', model: 'XIAOMI_MODEL' },
};

const DEFAULT_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  mimo: 'https://token-plan-sgp.xiaomimimo.com/v1',
  deepseek: 'https://api.deepseek.com',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  xiaomi: 'https://api.xiaomimimo.com/v1',
};

const DEFAULT_MODELS: Record<ProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-sonnet-20241022',
  google: 'gemini-2.0-flash',
  openrouter: 'openai/gpt-4o-mini',
  mimo: 'mimo-v2.5',
  deepseek: 'deepseek-v4-flash',
  glm: 'glm-4.7',
  xiaomi: 'mimo-v2-flash',
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
};

const API_TYPE: Record<ProviderType, 'openai' | 'anthropic' | 'google'> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  openrouter: 'openai',
  mimo: 'openai',
  deepseek: 'openai',
  glm: 'openai',
  xiaomi: 'openai',
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
export function detectProvider(): ProviderInfo | null {
  for (const type of PROVIDER_ORDER) {
    const env = ENV_MAP[type];
    const apiKey = process.env[env.key] || '';
    if (!apiKey) {
      // Check if OPENAI_API_KEY + base URL hints match this provider
      if (type !== 'openai' && process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
        const baseUrl = process.env.OPENAI_BASE_URL.toLowerCase();
        const match = (
          (type === 'mimo' && (baseUrl.includes('mimo') || baseUrl.includes('xiaomimi'))) ||
          (type === 'deepseek' && baseUrl.includes('deepseek')) ||
          (type === 'glm' && (baseUrl.includes('bigmodel') || baseUrl.includes('zhipu')))
        );
        if (!match) continue;
      } else {
        continue;
      }
    }

    const baseUrl = process.env[env.url] || DEFAULT_URLS[type];
    const defaultModel = process.env[env.model] || DEFAULT_MODELS[type];

    return {
      type,
      apiKey: process.env[env.key] || process.env.OPENAI_API_KEY || '',
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
  'model': 'model',
  'meta-tools': 'enableMetaTools',
  'meta_tools': 'enableMetaTools',
  'enableMetaTools': 'enableMetaTools',
  'toolRetrieval': 'toolRetrieval',
  'entropyGating': 'entropyGating',
  'speculativeExecution': 'speculativeExecution',
};

/**
 * Read settings from config file.
 */
function loadSettings(): CommanderSettings {
  for (const p of CONFIG_PATHS) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch {}
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
    throw new Error(`Unknown setting: ${key}. Try: model, meta-tools, toolRetrieval, entropyGating, speculativeExecution`);
  }
  if (normalizedKey === 'model') {
    settings.model = value;
} else {
     (settings as Record<string, unknown>)[normalizedKey] = value === 'true' || value === '1' || value === 'on';
   }
  saveSettings(settings);
  cachedSettings = settings;
}

export function showConfig(): void {
  const provider = detectProvider();
  const settings = getSettings();

  console.log(`\n  Provider:  ${provider ? `${DISPLAY_NAMES[provider.type]} (${provider.type})` : 'None'}`);
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
    const viaOpenAI = !hasKey && type !== 'openai' && process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL;
    const model = process.env[env.model] || DEFAULT_MODELS[type];
    console.log(`  ${hasKey ? '✓' : viaOpenAI ? '~' : ' '} ${DISPLAY_NAMES[type].padEnd(20)} ${type.padEnd(12)} ${model}`);
  }
}

export function listModels(): void {
  const all = [
    { provider: 'openai', name: 'gpt-4o, gpt-4o-mini, gpt-4.1, o3-mini, o4-mini' },
    { provider: 'anthropic', name: 'claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus, claude-4-sonnet' },
    { provider: 'google', name: 'gemini-2.0-flash, gemini-2.0-pro, gemini-2.5-pro' },
    { provider: 'openrouter', name: 'openai/gpt-4o, anthropic/claude-3.5-sonnet, google/gemini-2.0-flash, deepseek/deepseek-chat, meta-llama/llama-3.3-70b, mistral/mistral-large' },
    { provider: 'deepseek', name: 'deepseek-v4-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner' },
    { provider: 'glm', name: 'glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.7-flash, glm-4.6, glm-4.5' },
    { provider: 'mimo', name: 'mimo-v2.5, mimo-v2.5-pro, mimo-v2-pro, mimo-v2-omni' },
    { provider: 'xiaomi', name: 'mimo-v2-flash, mimo-v2-pro, mimo-v2-omni' },
  ];
  for (const p of all) {
    console.log(`  ${DISPLAY_NAMES[p.provider as ProviderType]} (${p.provider}):`);
    console.log(`    ${p.name}`);
  }
}

export function resetConfig(): void {
  cachedSettings = null;
}
