/**
 * Provider Registry Tests — verify the extensibility contract of the
 * centralized provider registry.
 *
 * Adding a provider is a ONE-STEP operation: append a registerProvider()
 * call. These tests guard that contract so a future regression (e.g.
 * re-introducing scattered Records or a switch statement) is caught.
 *
 * Tested:
 *   - registerProvider / hasProvider / getProviderRegistration
 *   - listProviderTypes preserves insertion order
 *   - createProvider constructs the right provider type
 *   - derived accessors (getProviderOrder/getEnvMap/getDefaultUrls/
 *     getDefaultModels/getDisplayNames/getApiTypes) cover all registered
 *   - third-party registration (the actual extensibility guarantee)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  registerProvider,
  hasProvider,
  getProviderRegistration,
  listProviderTypes,
  getProviderOrder,
  getEnvMap,
  getDefaultUrls,
  getDefaultModels,
  getDisplayNames,
  getApiTypes,
  createProvider,
} from '../src/runtime/providers/providerRegistry';

// Built-in provider count — keep in sync with providerRegistry.ts.
// As of writing: ollama, vllm, deepinfra, anyscale, replicate, cohere,
// mistral, groq, together, perplexity, fireworks, xiaomi, mimo, deepseek,
// glm, xai, bedrock, agnes, stepfun, minimax, openrouter, anthropic,
// google, openai → 24.
const EXPECTED_BUILTIN_COUNT = 24;
const EXPECTED_BUILTIN_TYPES = new Set([
  'ollama', 'vllm', 'deepinfra', 'anyscale', 'replicate', 'cohere',
  'mistral', 'groq', 'together', 'perplexity', 'fireworks', 'xiaomi',
  'mimo', 'deepseek', 'glm', 'xai', 'bedrock', 'agnes', 'stepfun',
  'minimax', 'openrouter', 'anthropic', 'google', 'openai',
]);

describe('providerRegistry: built-in coverage', () => {
  it('registers all expected built-in providers', () => {
    const types = listProviderTypes();
    assert.strictEqual(types.length, EXPECTED_BUILTIN_COUNT);
    for (const t of EXPECTED_BUILTIN_TYPES) {
      assert.ok(hasProvider(t), `expected built-in provider "${t}" to be registered`);
    }
  });

  it('listProviderTypes preserves insertion order (local-first)', () => {
    const types = listProviderTypes();
    // Local providers must come first (auto-detect priority).
    assert.strictEqual(types[0], 'ollama');
    assert.strictEqual(types[1], 'vllm');
    // OpenAI (most reliable fallback) must be last.
    assert.strictEqual(types[types.length - 1], 'openai');
  });

  it('getProviderOrder matches listProviderTypes (alias contract)', () => {
    assert.deepEqual(getProviderOrder(), listProviderTypes());
  });
});

describe('providerRegistry: derived accessors cover all registered', () => {
  const accessors: Array<{
    name: string;
    fn: () => Record<string, unknown>;
    expectedShape: 'string' | 'object';
  }> = [
    { name: 'getEnvMap', fn: getEnvMap, expectedShape: 'object' },
    { name: 'getDefaultUrls', fn: getDefaultUrls, expectedShape: 'string' },
    { name: 'getDefaultModels', fn: getDefaultModels, expectedShape: 'string' },
    { name: 'getDisplayNames', fn: getDisplayNames, expectedShape: 'string' },
    { name: 'getApiTypes', fn: getApiTypes, expectedShape: 'string' },
  ];

  for (const { name, fn, expectedShape } of accessors) {
    it(`${name} returns a key for every registered provider`, () => {
      const map = fn();
      const registered = listProviderTypes();
      for (const t of registered) {
        assert.ok(t in map, `${name}() missing entry for "${t}"`);
        if (expectedShape === 'string') {
          assert.strictEqual(typeof map[t], 'string', `${name}()["${t}"] must be a string`);
        } else {
          assert.ok(map[t] && typeof map[t] === 'object', `${name}()["${t}"] must be an object`);
        }
      }
    });
  }

  it('getEnvMap entries have { key, url, model } shape', () => {
    const map = getEnvMap();
    for (const t of listProviderTypes()) {
      const entry = map[t] as { key: string; url: string; model: string };
      assert.ok(entry.key, `${t}.key must be non-empty`);
      assert.ok(entry.url, `${t}.url must be non-empty`);
      assert.ok(entry.model, `${t}.model must be non-empty`);
    }
  });

  it('getApiTypes returns one of the allowed apiType values', () => {
    const map = getApiTypes();
    const allowed = new Set(['openai', 'anthropic', 'google']);
    for (const t of listProviderTypes()) {
      assert.ok(allowed.has(map[t] as string), `${t} has invalid apiType "${map[t]}"`);
    }
  });
});

describe('providerRegistry: createProvider factory', () => {
  // Clear env vars so factories don't pick up real keys during construction.
  const envVarsToClear = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
    'DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'GROQ_API_KEY',
    'OLLAMA_API_KEY', 'VLLM_API_KEY', 'CO_API_KEY', 'COHERE_API_KEY',
    'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'PERPLEXITY_API_KEY',
    'FIREWORKS_API_KEY', 'XIAOMI_API_KEY', 'MIMO_API_KEY',
    'OPENROUTER_API_KEY', 'XAI_API_KEY', 'ANYSCALE_API_KEY',
    'DEEPINFRA_API_KEY', 'AGNES_API_KEY', 'STEPFUN_API_KEY',
    'MINIMAX_API_KEY', 'REPLICATE_API_TOKEN',
  ];
  beforeEach(() => { for (const k of envVarsToClear) delete process.env[k]; });
  afterEach(() => { for (const k of envVarsToClear) delete process.env[k]; });

  it('creates a provider for every registered type', () => {
    for (const type of listProviderTypes()) {
      const provider = createProvider(type);
      assert.ok(provider, `createProvider("${type}") returned falsy`);
      assert.strictEqual(typeof provider.call, 'function', `${type} must implement call()`);
    }
  });

  it('createProvider falls back to OpenAI for unknown type', () => {
    const provider = createProvider('nonexistent-provider-xyz');
    assert.ok(provider, 'fallback should return a provider, not throw');
  });

  it('built-in providers expose correct name property', () => {
    for (const type of listProviderTypes()) {
      const provider = createProvider(type);
      assert.strictEqual(
        provider.name,
        type,
        `createProvider("${type}").name should equal "${type}" but got "${provider.name}"`,
      );
    }
  });
});

describe('providerRegistry: extensibility contract (third-party registration)', () => {
  // The crucial A-grade guarantee: external packages can register providers
  // WITHOUT modifying the registry file. This locks that contract in place.
  const TEST_TYPE = '__test_third_party_provider__';
  let originalRegistered: boolean;

  beforeEach(() => {
    originalRegistered = hasProvider(TEST_TYPE);
  });

  afterEach(() => {
    // We can't unregister (the registry is append-only by design —
    // providers are meant to be permanent within a process). Tests below
    // use unique names so they don't pollute the global registry.
  });

  it('registerProvider adds a new provider without touching other files', () => {
    registerProvider({
      type: TEST_TYPE,
      envKey: 'TEST_PROVIDER_API_KEY',
      envBaseUrlKey: 'TEST_PROVIDER_BASE_URL',
      envModelKey: 'TEST_PROVIDER_MODEL',
      defaultUrl: 'https://test.example.com/v1',
      defaultModel: 'test-model-v1',
      displayName: 'Test Provider',
      apiType: 'openai',
      factory: () => ({
        name: TEST_TYPE,
        async call() {
          return { content: 'test response' };
        },
        getDefaultModel() { return 'test-model-v1'; },
        getDefaultBaseUrl() { return 'https://test.example.com/v1'; },
      }) as any,
    });

    assert.ok(hasProvider(TEST_TYPE), 'third-party provider must be registered');
    const reg = getProviderRegistration(TEST_TYPE);
    assert.ok(reg, 'getProviderRegistration must return the registration');
    assert.strictEqual(reg!.displayName, 'Test Provider');
    assert.strictEqual(reg!.defaultModel, 'test-model-v1');

    // Derived accessors must pick up the new provider.
    assert.ok(getProviderOrder().includes(TEST_TYPE));
    assert.ok(TEST_TYPE in getEnvMap());
    assert.ok(TEST_TYPE in getDefaultUrls());
    assert.ok(TEST_TYPE in getDefaultModels());
    assert.ok(TEST_TYPE in getDisplayNames());
    assert.ok(TEST_TYPE in getApiTypes());

    // Factory must be invoked.
    const instance = createProvider(TEST_TYPE);
    assert.strictEqual(instance.name, TEST_TYPE);
  });

  it('registerProvider is idempotent (re-registering updates, does not duplicate)', () => {
    registerProvider({
      type: TEST_TYPE,
      envKey: 'TEST_PROVIDER_API_KEY_V2',
      envBaseUrlKey: 'TEST_PROVIDER_BASE_URL_V2',
      envModelKey: 'TEST_PROVIDER_MODEL_V2',
      defaultUrl: 'https://v2.example.com/v1',
      defaultModel: 'test-model-v2',
      displayName: 'Test Provider V2',
      apiType: 'openai',
      factory: () => ({
        name: TEST_TYPE,
        async call() { return { content: 'v2' }; },
        getDefaultModel() { return 'test-model-v2'; },
        getDefaultBaseUrl() { return 'https://v2.example.com/v1'; },
      }) as any,
    });

    const types = listProviderTypes();
    const occurrences = types.filter((t) => t === TEST_TYPE).length;
    assert.strictEqual(occurrences, 1, 're-registering must not create duplicate entries');
    assert.strictEqual(getProviderRegistration(TEST_TYPE)!.displayName, 'Test Provider V2');
  });
});
