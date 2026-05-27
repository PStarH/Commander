/**
 * CredentialManager — Centralized credential loading and access.
 *
 * Reads all known API keys and credentials from process.env at initialization,
 * providing a single source of truth. Eliminates scattered process.env reads
 * across 27+ files.
 *
 * Security properties:
 * - Credentials are loaded once at init, not read from env on every access
 * - `mask()` utility for safe logging (shows first 4 + last 4 chars)
 * - `clear()` for cleanup (zeroes references)
 * - Thread-safe (immutable after init)
 *
 * Usage:
 *   import { getCredentialManager } from './runtime/credentialManager';
 *   const cm = getCredentialManager();
 *   const key = cm.get('OPENAI_API_KEY');
 *   console.log(cm.mask('OPENAI_API_KEY')); // "sk-...AB12"
 */

/** Known credential env vars that are actual secrets (keys, tokens). */
const SECRET_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'ZHIPU_API_KEY',
  'MIMO_API_KEY',
  'XIAOMI_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'PERPLEXITY_API_KEY',
  'PPLX_API_KEY',
  'FIREWORKS_API_KEY',
  'REPLICATE_API_TOKEN',
  'REPLICATE_API_KEY',
  'MISTRAL_API_KEY',
  'CO_API_KEY',
  'COHERE_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'ANYSCALE_API_KEY',
  'DEEPINFRA_API_KEY',
  'VLLM_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

/** Known non-secret config env vars (base URLs, model names, etc.). */
const CONFIG_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'GOOGLE_BASE_URL',
  'GOOGLE_MODEL',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'ZHIPU_BASE_URL',
  'ZHIPU_MODEL',
  'MIMO_BASE_URL',
  'MIMO_MODEL',
  'XIAOMI_BASE_URL',
  'XIAOMI_MODEL',
  'GROQ_BASE_URL',
  'GROQ_MODEL',
  'TOGETHER_BASE_URL',
  'TOGETHER_MODEL',
  'PERPLEXITY_BASE_URL',
  'PERPLEXITY_MODEL',
  'FIREWORKS_BASE_URL',
  'FIREWORKS_MODEL',
  'REPLICATE_BASE_URL',
  'REPLICATE_MODEL',
  'MISTRAL_BASE_URL',
  'MISTRAL_MODEL',
  'CO_BASE_URL',
  'CO_MODEL',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL',
  'XAI_BASE_URL',
  'XAI_MODEL',
  'ANYSCALE_BASE_URL',
  'ANYSCALE_MODEL',
  'DEEPINFRA_BASE_URL',
  'DEEPINFRA_MODEL',
  'VLLM_BASE_URL',
  'VLLM_MODEL',
  'OLLAMA_HOST',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'BEDROCK_MODEL',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'VISION_BASE_URL',
  'COMMANDER_SSH_KEY',
] as const;

/** All known env var keys. */
const ALL_KEYS = [...SECRET_KEYS, ...CONFIG_KEYS] as const;
type EnvKey = typeof ALL_KEYS[number];

export class CredentialManager {
  private store = new Map<string, string>();
  private initialized = false;

  /** Load all known credentials from process.env. Safe to call multiple times. */
  init(): void {
    if (this.initialized) return;
    for (const key of ALL_KEYS) {
      const val = process.env[key];
      if (val !== undefined && val !== '') {
        this.store.set(key, val);
      }
    }
    this.initialized = true;
  }

  /** Get a credential by env var name. Returns undefined if not set. */
  get(key: string): string | undefined {
    return this.store.get(key);
  }

  /** Get a credential with a default fallback. */
  getOrDefault(key: string, defaultVal: string): string {
    return this.store.get(key) ?? defaultVal;
  }

  /** Check if a credential is available. */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Get all configured secret keys (for auditing). */
  listConfiguredSecrets(): string[] {
    return SECRET_KEYS.filter(k => this.store.has(k));
  }

  /**
   * Resolve an API key with fallback env var names.
   * Returns the first found value or empty string.
   */
  resolveApiKey(...candidates: string[]): string {
    for (const key of candidates) {
      const val = this.store.get(key);
      if (val) return val;
    }
    return '';
  }

  /** Check if any of the given env vars have a value. */
  any(...candidates: string[]): boolean {
    return candidates.some(k => this.store.has(k));
  }

  /**
   * Mask a credential for safe logging.
   * Shows "sk-...FGh2" (first 4 + last 4 chars when possible).
   */
  mask(key: string): string {
    const val = this.store.get(key);
    return val ? CredentialManager.maskValue(val) : '(not set)';
  }

  /** Static mask utility. */
  static maskValue(val: string): string {
    if (!val) return '(empty)';
    if (val.length <= 8) return '****';
    return val.slice(0, 4) + '...' + val.slice(-4);
  }

  /** Clear all stored credentials. */
  clear(): void {
    this.store.clear();
    this.initialized = false;
  }

  /** Check if initialized. */
  isInitialized(): boolean {
    return this.initialized;
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const credentialManagerSingleton = createTenantAwareSingleton(() => {
  const cm = new CredentialManager();
  cm.init();
  return cm;
}, {
  dispose: (cm) => cm.clear(),
});

export function getCredentialManager(): CredentialManager {
  return credentialManagerSingleton.get();
}

export function resetCredentialManager(): void {
  credentialManagerSingleton.reset();
}
