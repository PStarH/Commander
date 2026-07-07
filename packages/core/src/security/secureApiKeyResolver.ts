/**
 * Secure API Key Resolver
 *
 * Security: Replaces direct process.env access for API keys with a
 * vault-first approach. Keys are stored encrypted in the EncryptedSecretsVault
 * and only decrypted on-demand. The master key is the only env var needed.
 *
 * Multi-tenant isolation: the resolver is tenant-aware. When a multi-tenant
 * provider is active, `resolveSecureApiKey` resolves the vault via the current
 * tenant context so each tenant has its own encrypted secrets. Falls back to
 * the global vault (single-tenant mode) or env var (dev/legacy) in that order.
 *
 * Flow:
 * 1. Try to retrieve from EncryptedSecretsVault (encrypted at rest, tenant-scoped)
 * 2. Fall back to env var with a security warning (for dev/legacy)
 * 3. Never log or expose the resolved key
 */

import { getGlobalLogger } from '../logging';
import { getEncryptedSecretsVault } from './encryptedSecretsVault';
import { isMultiTenantEnabled } from '../runtime/tenantContext';

/**
 * Vault instance shape used by the secure API key resolver.
 * Default resolves via tenant-aware `getEncryptedSecretsVault()`.
 * Tests can override via `initSecureApiKeyResolver`.
 */
type VaultResolver = {
  hasSecret: (name: string) => boolean;
  getSecret: (name: string, version?: number) => string | null;
};

let customVaultResolver: VaultResolver | null = null;
let vaultInitialized = false;

/**
 * Initialize the secure API key resolver with a custom vault resolver.
 * Called during service initialization or by tests.
 * Pass null to revert to the default tenant-aware resolver.
 */
export function initSecureApiKeyResolver(vault: unknown | null): void {
  if (vault === null) {
    customVaultResolver = null;
    vaultInitialized = false;
    return;
  }
  customVaultResolver = vault as VaultResolver;
  vaultInitialized = true;
}

/**
 * Resolve the active vault resolver. Prefers a custom resolver (set via
 * `initSecureApiKeyResolver`); otherwise uses the tenant-aware default.
 */
function getVaultResolver(): VaultResolver | null {
  if (customVaultResolver) return customVaultResolver;
  // Lazy: only access the vault when multi-tenant or vault is available.
  // In single-tenant dev mode without a configured vault, fall through to env.
  try {
    const vault = getEncryptedSecretsVault();
    return {
      hasSecret: (name: string) => vault.hasSecret(name),
      getSecret: (name: string, version?: number) => vault.getSecret(name, version),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve an API key securely.
 *
 * @param keyName - The vault secret name (e.g., 'OPENAI_API_KEY')
 * @param envVar - The fallback env var name (same as keyName by default)
 * @returns The decrypted API key, or empty string if not found
 */
export function resolveSecureApiKey(keyName: string, envVar: string = keyName): string {
  // 1. Try vault first (tenant-aware when multi-tenant provider is active)
  const resolver = getVaultResolver();
  if (resolver) {
    try {
      if (resolver.hasSecret(keyName)) {
        const decrypted = resolver.getSecret(keyName);
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
    // Warn in production or when multi-tenant is enabled — env var fallback
    // bypasses tenant isolation and should never be used in multi-tenant prod.
    if (process.env.NODE_ENV === 'production' || isMultiTenantEnabled()) {
      getGlobalLogger().warn(
        'SecureApiKeyResolver',
        `API key "${envVar}" loaded from environment variable instead of encrypted vault. ` +
          'Store keys in the EncryptedSecretsVault for production security. ' +
          (isMultiTenantEnabled()
            ? 'MULTI-TENANT MODE: env var fallback is shared across tenants.'
            : ''),
        { keyName, envVar, multiTenant: isMultiTenantEnabled() },
      );
    }
  }

  return envValue;
}

/**
 * Batch resolve multiple API keys.
 */
export function resolveSecureApiKeys(keys: string[]): Record<string, string> {
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
  if (vaultInitialized && customVaultResolver) return true;
  try {
    getEncryptedSecretsVault();
    return true;
  } catch {
    return false;
  }
}
