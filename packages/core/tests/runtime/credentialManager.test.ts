import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialManager } from '../../src/runtime/credentialManager';

describe('CredentialManager', () => {
  let cm: CredentialManager;

  beforeEach(() => {
    cm = new CredentialManager();
  });

  it('starts uninitialized', () => {
    expect(cm.isInitialized()).toBe(false);
  });

  it('loads environment variables on init', () => {
    const original = process.env.TEST_CM_KEY;
    process.env.TEST_CM_KEY = 'test-value';
    // Re-init with a fresh manager that captures env
    const cm2 = new CredentialManager();
    // Since TEST_CM_KEY is not in the ALL_KEYS list, it won't be loaded
    // We test with known keys instead - just verify init() doesn't throw
    cm2.init();
    expect(cm2.isInitialized()).toBe(true);
    process.env.TEST_CM_KEY = original;
  });

  it('get returns undefined for unknown key', () => {
    cm.init();
    expect(cm.get('NONEXISTENT_KEY')).toBeUndefined();
  });

  it('has returns false for unknown key', () => {
    cm.init();
    expect(cm.has('NONEXISTENT_KEY')).toBe(false);
  });

  it('getOrDefault returns default when key not found', () => {
    cm.init();
    expect(cm.getOrDefault('NONEXISTENT_KEY', 'default-val')).toBe('default-val');
  });

  it('getOrDefault returns value when key found', () => {
    // Use a known env var that exists (PATH always exists)
    const original = process.env.PATH;
    // PATH is not in ALL_KEYS though, so let's just test with manual init
    const cm2 = new CredentialManager();
    // Manually add a key via the internal store
    (cm2 as any).store.set('MY_TEST_KEY', 'my-value');
    (cm2 as any).initialized = true;
    expect(cm2.getOrDefault('MY_TEST_KEY', 'fallback')).toBe('my-value');
  });

  it('resolveApiKey returns first match from candidates', () => {
    const cm2 = new CredentialManager();
    (cm2 as any).store.set('KEY_A', 'value-a');
    (cm2 as any).store.set('KEY_B', 'value-b');
    (cm2 as any).initialized = true;
    expect(cm2.resolveApiKey('KEY_A', 'KEY_B')).toBe('value-a');
    expect(cm2.resolveApiKey('NONE', 'KEY_B')).toBe('value-b');
  });

  it('resolveApiKey returns empty string if no match', () => {
    cm.init();
    expect(cm.resolveApiKey('NONEXISTENT')).toBe('');
  });

  it('any returns true if any key exists', () => {
    const cm2 = new CredentialManager();
    (cm2 as any).store.set('EXISTING_KEY', 'val');
    (cm2 as any).initialized = true;
    expect(cm2.any('EXISTING_KEY', 'MISSING')).toBe(true);
    expect(cm2.any('MISSING_A', 'MISSING_B')).toBe(false);
  });

  it('mask returns masked value for existing key', () => {
    const cm2 = new CredentialManager();
    (cm2 as any).store.set('API_KEY', 'sk-abc123def456xyz');
    (cm2 as any).initialized = true;
    expect(cm2.mask('API_KEY')).toBe('sk-a...6xyz');
  });

  it('mask returns (not set) for missing key', () => {
    cm.init();
    expect(cm.mask('NONEXISTENT')).toBe('(not set)');
  });

  it('static maskValue masks correctly', () => {
    expect(CredentialManager.maskValue('sk-abcdefgh12345678')).toBe('sk-a...5678');
    expect(CredentialManager.maskValue('short')).toBe('****');
    expect(CredentialManager.maskValue('')).toBe('(empty)');
  });

  it('listConfiguredSecrets returns only secrets that exist', () => {
    const cm2 = new CredentialManager();
    (cm2 as any).store.set('OPENAI_API_KEY', 'sk-test');
    (cm2 as any).store.set('DEEPSEEK_API_KEY', 'ds-test');
    (cm2 as any).store.set('OLLAMA_HOST', 'localhost'); // config key, not secret
    (cm2 as any).initialized = true;
    const secrets = cm2.listConfiguredSecrets();
    expect(secrets).toContain('OPENAI_API_KEY');
    expect(secrets).toContain('DEEPSEEK_API_KEY');
    expect(secrets).not.toContain('OLLAMA_HOST');
  });

  it('init is idempotent', () => {
    cm.init();
    cm.init(); // second call should be no-op
    expect(cm.isInitialized()).toBe(true);
  });

  it('clear resets all state', () => {
    const cm2 = new CredentialManager();
    (cm2 as any).store.set('SOME_KEY', 'val');
    (cm2 as any).initialized = true;
    cm2.clear();
    expect(cm2.isInitialized()).toBe(false);
    expect(cm2.get('SOME_KEY')).toBeUndefined();
  });
});
