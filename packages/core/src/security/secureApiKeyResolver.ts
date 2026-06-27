/**
 * Secure API Key Resolver
 *
 * Security: Replaces direct process.env access for API keys with a
 * vault-first approach. Keys are stored encrypted in the EncryptedSecretsVault
 * and only decrypted on-demand. The master key is the only env var needed.
 *
 * Flow:
 * 1. Try to retrieve from EncryptedSecretsVault (encrypted at rest)
 * 2. Fall back to env var with a security warning (for dev/legacy)
 * 3. Never log or expose the resolved key
 */

import { getGlobalLogger } from '../logging';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vaultInstance: any = null;
let vaultInitialized = false;

/**
 * Initialize the secure API key resolver with a vault instance.
 * Called during service initialization.
 */
export function initSecureApiKeyResolver(vault: unknown): void {
  vaultInstance = vault;
  vaultInitialized = true;
}

/**
 * Resolve an API key securely.
 *
 * @param keyName - The vault secret name (e.g., 'OPENAI_API_KEY')
 * @param envVar - The fallback env var name (same as keyName by default)
 * @returns The decrypted API key, or empty string if not found
 */
export function resolveSecureApiKey(
  keyName: string,
  envVar: string = keyName,
): string {
  // 1. Try vault first
  if (vaultInitialized && vaultInstance) {
    try {
      const stored = vaultInstance.retrieve?.(keyName);
      if (stored) {
        const decrypted = vaultInstance.decrypt?.(keyName, stored);
        if (decrypted && typeof decrypted === 'string' && decrypted.length > 0) {
          return decrypted;
        }
      }
    } catch {
      // Vault lookup failed — fall through to env var
    }
  }

  // 2. Fall back to env var with security warning
  const envValue = process.env[envVar] ?? '';
  if (envValue) {
    // Only warn in production; dev environments commonly use env vars
    if (process.env.NODE_ENV === 'production') {
      getGlobalLogger().warn(
        'SecureApiKeyResolver',
        `API key "${envVar}" loaded from environment variable instead of encrypted vault. ` +
        'Store keys in the EncryptedSecretsVault for production security.',
        { keyName, envVar },
      );
    }
  }

  return envValue;
}

/**
 * Batch resolve multiple API keys.
 */
export function resolveSecureApiKeys(
  keys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    result[key] = resolveSecureApiKey(key);
  }
  return result;
}

/**
 * Check if the vault is initialized and available.
 */
export function isVaultAvailable(): boolean {
  return vaultInitialized && vaultInstance !== null;
}
