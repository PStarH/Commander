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
export declare class CredentialManager {
    private store;
    private initialized;
    /** Load all known credentials from process.env. Safe to call multiple times. */
    init(): void;
    /** Get a credential by env var name. Returns undefined if not set. */
    get(key: string): string | undefined;
    /** Get a credential with a default fallback. */
    getOrDefault(key: string, defaultVal: string): string;
    /** Check if a credential is available. */
    has(key: string): boolean;
    /** Get all configured secret keys (for auditing). */
    listConfiguredSecrets(): string[];
    /**
     * Resolve an API key with fallback env var names.
     * Returns the first found value or empty string.
     */
    resolveApiKey(...candidates: string[]): string;
    /** Check if any of the given env vars have a value. */
    any(...candidates: string[]): boolean;
    /**
     * Mask a credential for safe logging.
     * Shows "sk-...FGh2" (first 4 + last 4 chars when possible).
     */
    mask(key: string): string;
    /** Static mask utility. */
    static maskValue(val: string): string;
    /** Clear all stored credentials. */
    clear(): void;
    /** Check if initialized. */
    isInitialized(): boolean;
}
export declare function getCredentialManager(): CredentialManager;
export declare function resetCredentialManager(): void;
//# sourceMappingURL=credentialManager.d.ts.map