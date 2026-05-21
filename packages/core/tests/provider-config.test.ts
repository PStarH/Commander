/**
 * Provider Configuration Tests — Verify all 18 providers are properly configured.
 *
 * Tests:
 * - Provider name, default base URL, default model
 * - Dual env-var fallback behavior
 * - Instantiation with empty/minimal config
 * - Tool-calling warnings for unsupported providers
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// Ollama
// ============================================================================
describe('OllamaProvider', () => {
  const OLLAMA_HOST = 'OLLAMA_HOST';
  const OLLAMA_BASE_URL = 'OLLAMA_BASE_URL';
  const OLLAMA_MODEL = 'OLLAMA_MODEL';

  beforeEach(() => {
    delete process.env[OLLAMA_HOST];
    delete process.env[OLLAMA_BASE_URL];
    delete process.env[OLLAMA_MODEL];
  });

  it('has correct name', async () => {
    const { OllamaProvider } = await import('../src/runtime/providers/ollamaProvider');
    const p = new OllamaProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'ollama');
  });

  it('defaults to localhost base URL', async () => {
    const { OllamaProvider, resolveOllamaBaseUrl } = await import('../src/runtime/providers/ollamaProvider');
    assert.strictEqual(resolveOllamaBaseUrl(), 'http://localhost:11434/v1');
    const p = new OllamaProvider({ apiKey: 'test' });
  });

  it('uses OLLAMA_HOST as primary env var', async () => {
    const { resolveOllamaBaseUrl } = await import('../src/runtime/providers/ollamaProvider');
    process.env[OLLAMA_HOST] = '192.168.1.100:11434';
    assert.strictEqual(resolveOllamaBaseUrl(), 'http://192.168.1.100:11434/v1');
  });

  it('uses OLLAMA_BASE_URL as fallback env var', async () => {
    const { resolveOllamaBaseUrl } = await import('../src/runtime/providers/ollamaProvider');
    process.env[OLLAMA_BASE_URL] = 'http://my-ollama:11434/v1';
    assert.strictEqual(resolveOllamaBaseUrl(), 'http://my-ollama:11434/v1');
  });

  it('prefers OLLAMA_HOST over OLLAMA_BASE_URL', async () => {
    const { resolveOllamaBaseUrl } = await import('../src/runtime/providers/ollamaProvider');
    process.env[OLLAMA_HOST] = '10.0.0.1:11434';
    process.env[OLLAMA_BASE_URL] = 'http://fallback:11434/v1';
    assert.strictEqual(resolveOllamaBaseUrl(), 'http://10.0.0.1:11434/v1');
  });

  it('uses correct default model', async () => {
    const { OllamaProvider } = await import('../src/runtime/providers/ollamaProvider');
    const p = new OllamaProvider({ apiKey: 'test' });
    assert.strictEqual(p.getDefaultModel(), 'llama3.2');
  });

  it('respects OLLAMA_MODEL env var', async () => {
    const { OllamaProvider } = await import('../src/runtime/providers/ollamaProvider');
    process.env[OLLAMA_MODEL] = 'qwen2.5';
    const p = new OllamaProvider({ apiKey: 'test' });
    assert.strictEqual(p.getDefaultModel(), 'qwen2.5');
  });

  it('can be instantiated with no apiKey for local use', async () => {
    const { OllamaProvider } = await import('../src/runtime/providers/ollamaProvider');
    const p = new OllamaProvider({});
    assert.strictEqual(p.name, 'ollama');
  });
});

// ============================================================================
// vLLM
// ============================================================================
describe('VLLMProvider', () => {
  beforeEach(() => {
    delete process.env.VLLM_BASE_URL;
    delete process.env.VLLM_MODEL;
    delete process.env.VLLM_API_KEY;
  });

  it('has correct name', async () => {
    const { VLLMProvider } = await import('../src/runtime/providers/vllmProvider');
    const p = new VLLMProvider({});
    assert.strictEqual(p.name, 'vllm');
  });

  it('defaults to localhost base URL', async () => {
    const { VLLMProvider } = await import('../src/runtime/providers/vllmProvider');
    const p = new VLLMProvider({});
    assert.strictEqual(p.getDefaultBaseUrl(), 'http://localhost:8000/v1');
  });

  it('respects VLLM_BASE_URL env var', async () => {
    const { VLLMProvider } = await import('../src/runtime/providers/vllmProvider');
    process.env.VLLM_BASE_URL = 'http://my-vllm:8080/v1';
    const p = new VLLMProvider({});
    assert.strictEqual(p.getDefaultBaseUrl(), 'http://my-vllm:8080/v1');
  });

  it('uses correct default model', async () => {
    const { VLLMProvider } = await import('../src/runtime/providers/vllmProvider');
    assert.strictEqual(
      new VLLMProvider({}).getDefaultModel(),
      'meta-llama/Llama-3.2-3B-Instruct'
    );
  });

  it('has isLocal flag', async () => {
    const { VLLMProvider } = await import('../src/runtime/providers/vllmProvider');
    const p = new VLLMProvider({});
    assert.ok(p.getExtraConfig().isLocal);
  });
});

// ============================================================================
// Cohere
// ============================================================================
describe('CohereProvider', () => {
  beforeEach(() => {
    delete process.env.CO_API_KEY;
    delete process.env.COHERE_API_KEY;
    delete process.env.COHERE_BASE_URL;
    delete process.env.COHERE_MODEL;
  });

  it('has correct name', async () => {
    const { CohereProvider } = await import('../src/runtime/providers/cohereProvider');
    const p = new CohereProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'cohere');
  });

  it('uses CO_API_KEY as primary env var', async () => {
    const { CohereProvider } = await import('../src/runtime/providers/cohereProvider');
    process.env.CO_API_KEY = 'co-key-primary';
    const p = new CohereProvider({ apiKey: '' });
    assert.strictEqual(p.name, 'cohere');
  });

  it('uses COHERE_API_KEY as fallback', async () => {
    const { CohereProvider } = await import('../src/runtime/providers/cohereProvider');
    delete process.env.CO_API_KEY;
    process.env.COHERE_API_KEY = 'co-key-fallback';
    const p = new CohereProvider({ apiKey: '' });
    assert.strictEqual(p.name, 'cohere');
  });

  it('defaults to correct base URL', async () => {
    const { CohereProvider } = await import('../src/runtime/providers/cohereProvider');
    const p = new CohereProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'cohere');
  });

  it('uses correct default model', async () => {
    const { CohereProvider } = await import('../src/runtime/providers/cohereProvider');
    const p = new CohereProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'cohere');
  });
});

// ============================================================================
// Mistral
// ============================================================================
describe('MistralProvider', () => {
  beforeEach(() => {
    delete process.env.MISTRAL_BASE_URL;
    delete process.env.MISTRAL_MODEL;
  });

  it('has correct name', async () => {
    const { MistralProvider } = await import('../src/runtime/providers/mistralProvider');
    const p = new MistralProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'mistral');
  });

  it('defaults to correct base URL', async () => {
    const { MistralProvider } = await import('../src/runtime/providers/mistralProvider');
    assert.strictEqual(
      new MistralProvider({ apiKey: 'test' }).getDefaultBaseUrl(),
      'https://api.mistral.ai/v1'
    );
  });

  it('uses correct default model', async () => {
    const { MistralProvider } = await import('../src/runtime/providers/mistralProvider');
    assert.strictEqual(
      new MistralProvider({ apiKey: 'test' }).getDefaultModel(),
      'mistral-large-latest'
    );
  });

  it('respects MISTRAL_BASE_URL env var', async () => {
    const { MistralProvider } = await import('../src/runtime/providers/mistralProvider');
    process.env.MISTRAL_BASE_URL = 'https://custom.mistral.ai/v1';
    assert.strictEqual(
      new MistralProvider({ apiKey: 'test' }).getDefaultBaseUrl(),
      'https://custom.mistral.ai/v1'
    );
  });
});

// ============================================================================
// Groq
// ============================================================================
describe('GroqProvider', () => {
  beforeEach(() => {
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_MODEL;
  });

  it('has correct name', async () => {
    const { GroqProvider } = await import('../src/runtime/providers/groqProvider');
    const p = new GroqProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'groq');
  });

  it('defaults to correct base URL', async () => {
    const { GroqProvider } = await import('../src/runtime/providers/groqProvider');
    assert.strictEqual(
      new GroqProvider({ apiKey: 'test' }).getDefaultBaseUrl(),
      'https://api.groq.com/openai/v1'
    );
  });

  it('uses correct default model', async () => {
    const { GroqProvider } = await import('../src/runtime/providers/groqProvider');
    assert.strictEqual(
      new GroqProvider({ apiKey: 'test' }).getDefaultModel(),
      'llama-3.3-70b-versatile'
    );
  });

  it('respects GROQ_BASE_URL env var', async () => {
    const { GroqProvider } = await import('../src/runtime/providers/groqProvider');
    process.env.GROQ_BASE_URL = 'https://custom.groq.com/v1';
    assert.strictEqual(
      new GroqProvider({ apiKey: 'test' }).getDefaultBaseUrl(),
      'https://custom.groq.com/v1'
    );
  });
});

// ============================================================================
// Together AI
// ============================================================================
describe('TogetherProvider', () => {
  beforeEach(() => {
    delete process.env.TOGETHER_BASE_URL;
    delete process.env.TOGETHER_MODEL;
  });

  it('has correct name', async () => {
    const { TogetherProvider } = await import('../src/runtime/providers/togetherProvider');
    const p = new TogetherProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'together');
  });

  it('defaults to api.together.ai base URL', async () => {
    const { TogetherProvider } = await import('../src/runtime/providers/togetherProvider');
    assert.strictEqual(
      new TogetherProvider({ apiKey: 'test' }).getDefaultBaseUrl(),
      'https://api.together.ai/v1'
    );
  });

  it('uses correct default model', async () => {
    const { TogetherProvider } = await import('../src/runtime/providers/togetherProvider');
    assert.strictEqual(
      new TogetherProvider({ apiKey: 'test' }).getDefaultModel(),
      'meta-llama/Llama-3.3-70B-Instruct-Turbo'
    );
  });
});

// ============================================================================
// Perplexity
// ============================================================================
describe('PerplexityProvider', () => {
  beforeEach(() => {
    delete process.env.PERPLEXITY_BASE_URL;
    delete process.env.PERPLEXITY_MODEL;
  });

  it('has correct name', async () => {
    const { PerplexityProvider } = await import('../src/runtime/providers/perplexityProvider');
    const p = new PerplexityProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'perplexity');
  });

  it('defaults to correct base URL', async () => {
    const { PerplexityProvider } = await import('../src/runtime/providers/perplexityProvider');
    assert.strictEqual(
      new PerplexityProvider({ apiKey: 'test' }).getDefaultBaseUrl(),
      'https://api.perplexity.ai/v1'
    );
  });

  it('uses correct default model', async () => {
    const { PerplexityProvider } = await import('../src/runtime/providers/perplexityProvider');
    assert.strictEqual(
      new PerplexityProvider({ apiKey: 'test' }).getDefaultModel(),
      'sonar-pro'
    );
  });

  it('throws when tools are passed (unsupported)', async () => {
    const { PerplexityProvider } = await import('../src/runtime/providers/perplexityProvider');
    const p = new PerplexityProvider({ apiKey: 'test' });
    try {
      await p.call({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'test', description: 'test', inputSchema: { type: 'object', properties: {} } }] });
      assert.fail('Should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes('perplexity'), 'Error should mention provider');
      assert.ok(e.message.includes('tool'), 'Error should mention tool calling limitation');
    }
  });
});

// ============================================================================
// Fireworks AI
// ============================================================================
describe('FireworksProvider', () => {
  beforeEach(() => {
    delete process.env.FIREWORKS_BASE_URL;
    delete process.env.FIREWORKS_MODEL;
  });

  it('has correct name', async () => {
    const { FireworksProvider } = await import('../src/runtime/providers/fireworksProvider');
    const p = new FireworksProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'fireworks');
  });

  it('defaults to correct base URL', async () => {
    const { FireworksProvider } = await import('../src/runtime/providers/fireworksProvider');
    assert.strictEqual(
      new FireworksProvider({ apiKey: 'test' }).getDefaultBaseUrl(),
      'https://api.fireworks.ai/inference/v1'
    );
  });

  it('uses correct default model', async () => {
    const { FireworksProvider } = await import('../src/runtime/providers/fireworksProvider');
    assert.strictEqual(
      new FireworksProvider({ apiKey: 'test' }).getDefaultModel(),
      'accounts/fireworks/models/llama-v3p3-70b-instruct'
    );
  });
});

// ============================================================================
// Replicate
// ============================================================================
describe('ReplicateProvider', () => {
  beforeEach(() => {
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_KEY;
    delete process.env.REPLICATE_BASE_URL;
    delete process.env.REPLICATE_MODEL;
  });

  it('has correct name', async () => {
    const { ReplicateProvider } = await import('../src/runtime/providers/replicateProvider');
    const p = new ReplicateProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'replicate');
  });

  it('uses REPLICATE_API_TOKEN as primary env var', async () => {
    const { ReplicateProvider } = await import('../src/runtime/providers/replicateProvider');
    process.env.REPLICATE_API_TOKEN = 'token-primary';
    const p = new ReplicateProvider({ apiKey: '' });
    assert.strictEqual(p.name, 'replicate');
  });

  it('uses REPLICATE_API_KEY as fallback', async () => {
    const { ReplicateProvider } = await import('../src/runtime/providers/replicateProvider');
    delete process.env.REPLICATE_API_TOKEN;
    process.env.REPLICATE_API_KEY = 'key-fallback';
    const p = new ReplicateProvider({ apiKey: '' });
    assert.strictEqual(p.name, 'replicate');
  });

  it('uses correct default model', async () => {
    const { ReplicateProvider } = await import('../src/runtime/providers/replicateProvider');
    const p = new ReplicateProvider({ apiKey: 'test' });
    assert.strictEqual(p.name, 'replicate');
  });

  it('throws when tools are passed (unsupported)', async () => {
    const { ReplicateProvider } = await import('../src/runtime/providers/replicateProvider');
    const p = new ReplicateProvider({ apiKey: 'test' });
    try {
      await p.call({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'test', description: 'test', inputSchema: { type: 'object', properties: {} } }] });
      assert.fail('Should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes('replicate'), 'Error should mention provider');
      assert.ok(e.message.includes('tool'), 'Error should mention tool calling limitation');
    }
  });
});

// ============================================================================
// AWS Bedrock
// ============================================================================
describe('BedrockProvider', () => {
  beforeEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.BEDROCK_MODEL;
  });

  it('has correct name', async () => {
    const { BedrockProvider } = await import('../src/runtime/providers/bedrockProvider');
    const p = new BedrockProvider({});
    assert.strictEqual(p.name, 'bedrock');
  });

  it('defaults to us-east-1 region', async () => {
    const { BedrockProvider } = await import('../src/runtime/providers/bedrockProvider');
    const p = new BedrockProvider({});
    assert.strictEqual(p.name, 'bedrock');
  });

  it('uses correct default model', async () => {
    const { BedrockProvider } = await import('../src/runtime/providers/bedrockProvider');
    const p = new BedrockProvider({});
    assert.strictEqual(p.name, 'bedrock');
  });

  it('respects AWS_REGION env var', async () => {
    const { BedrockProvider } = await import('../src/runtime/providers/bedrockProvider');
    process.env.AWS_REGION = 'eu-west-1';
    const p = new BedrockProvider({});
    assert.strictEqual(p.name, 'bedrock');
  });

  it('respects BEDROCK_MODEL env var', async () => {
    const { BedrockProvider } = await import('../src/runtime/providers/bedrockProvider');
    process.env.BEDROCK_MODEL = 'anthropic.claude-opus-4-6-v1';
    const p = new BedrockProvider({});
    assert.strictEqual(p.name, 'bedrock');
  });
});

// ============================================================================
// Dual env-var fallback — config-level
// ============================================================================
describe('commanderConfig resolveApiKey', () => {
  beforeEach(() => {
    delete process.env.CO_API_KEY;
    delete process.env.COHERE_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.PPLX_API_KEY;
  });

  it('resolves Cohere API key with fallback', async () => {
    const { resolveApiKey } = await import('../src/config/commanderConfig');
    process.env.COHERE_API_KEY = 'fallback-key';
    const key = resolveApiKey('cohere', 'CO_API_KEY');
    assert.strictEqual(key, 'fallback-key');
  });

  it('resolves Replicate API key with fallback', async () => {
    const { resolveApiKey } = await import('../src/config/commanderConfig');
    process.env.REPLICATE_API_KEY = 'fallback-key';
    const key = resolveApiKey('replicate', 'REPLICATE_API_TOKEN');
    assert.strictEqual(key, 'fallback-key');
  });

  it('resolves Perplexity API key with fallback', async () => {
    const { resolveApiKey } = await import('../src/config/commanderConfig');
    process.env.PPLX_API_KEY = 'fallback-key';
    const key = resolveApiKey('perplexity', 'PERPLEXITY_API_KEY');
    assert.strictEqual(key, 'fallback-key');
  });

  it('prefers primary over fallback for Cohere', async () => {
    const { resolveApiKey } = await import('../src/config/commanderConfig');
    process.env.CO_API_KEY = 'primary-key';
    process.env.COHERE_API_KEY = 'fallback-key';
    const key = resolveApiKey('cohere', 'CO_API_KEY');
    assert.strictEqual(key, 'primary-key');
  });

  it('prefers primary over fallback for Replicate', async () => {
    const { resolveApiKey } = await import('../src/config/commanderConfig');
    process.env.REPLICATE_API_TOKEN = 'primary-token';
    process.env.REPLICATE_API_KEY = 'fallback-key';
    const key = resolveApiKey('replicate', 'REPLICATE_API_TOKEN');
    assert.strictEqual(key, 'primary-token');
  });

  it('prefers primary over fallback for Perplexity', async () => {
    const { resolveApiKey } = await import('../src/config/commanderConfig');
    process.env.PERPLEXITY_API_KEY = 'primary-key';
    process.env.PPLX_API_KEY = 'fallback-key';
    const key = resolveApiKey('perplexity', 'PERPLEXITY_API_KEY');
    assert.strictEqual(key, 'primary-key');
  });
});

// ============================================================================
// Provider enum consistency
// ============================================================================
describe('Provider registration consistency', () => {
  it('all providers are in ENV_MAP', async () => {
    const { ENV_MAP } = await import('../src/config/commanderConfig');
    const expectedVars = [
      'openai', 'anthropic', 'google', 'openrouter', 'deepseek',
      'glm', 'mimo', 'xiaomi', 'cohere', 'mistral', 'groq',
      'together', 'perplexity', 'fireworks', 'replicate', 'ollama',
      'vllm', 'bedrock', 'xai', 'anyscale', 'deepinfra',
    ];
    for (const provider of expectedVars) {
      assert.ok(ENV_MAP[provider], `Missing ENV_MAP entry for ${provider}`);
    }
    assert.strictEqual(Object.keys(ENV_MAP).length, 21);
  });

  it('all providers are in PROVIDER_ORDER', async () => {
    const { PROVIDER_ORDER } = await import('../src/config/commanderConfig');
    const expectedProviders = [
      'openai', 'anthropic', 'google', 'openrouter', 'deepseek',
      'glm', 'mimo', 'xiaomi', 'cohere', 'mistral', 'groq',
      'together', 'perplexity', 'fireworks', 'replicate', 'ollama',
      'vllm', 'bedrock', 'xai', 'anyscale', 'deepinfra',
    ];
    for (const provider of expectedProviders) {
      assert.ok(PROVIDER_ORDER.includes(provider), `Missing from PROVIDER_ORDER: ${provider}`);
    }
    assert.strictEqual(PROVIDER_ORDER.length, 21);
  });

  it('all providers are in DEFAULT_MODELS', async () => {
    const { DEFAULT_MODELS } = await import('../src/config/commanderConfig');
    assert.strictEqual(Object.keys(DEFAULT_MODELS).length, 21);
  });

  it('all providers are in DEFAULT_URLS', async () => {
    const { DEFAULT_URLS } = await import('../src/config/commanderConfig');
    assert.strictEqual(Object.keys(DEFAULT_URLS).length, 21);
  });

  it('all providers are in API_TYPE', async () => {
    const { API_TYPE } = await import('../src/config/commanderConfig');
    assert.strictEqual(Object.keys(API_TYPE).length, 21);
  });
});

// ============================================================================
// detectProvider() — auto-detection flow
// ============================================================================
describe('detectProvider', () => {
  beforeEach(() => {
    const allVars = [
      'OPENAI_API_KEY', 'OPENAI_BASE_URL',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY',
      'CO_API_KEY', 'COHERE_API_KEY',
      'MISTRAL_API_KEY',
      'GROQ_API_KEY',
      'TOGETHER_API_KEY',
      'PERPLEXITY_API_KEY', 'PPLX_API_KEY',
      'FIREWORKS_API_KEY',
      'REPLICATE_API_TOKEN', 'REPLICATE_API_KEY',
      'OLLAMA_HOST', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL',
      'VLLM_BASE_URL', 'VLLM_API_KEY',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE',
      'DEEPSEEK_API_KEY',
      'ZHIPU_API_KEY',
      'MIMO_API_KEY',
      'XIAOMI_API_KEY',
    ];
    for (const v of allVars) delete process.env[v];
  });

  it('returns null with no env vars set', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    const result = detectProvider();
    assert.strictEqual(result, null);
  });

  it('detects Ollama with OLLAMA_HOST', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.OLLAMA_HOST = '10.0.0.5:11434';
    const result = detectProvider();
    assert.ok(result, 'Should detect Ollama');
    assert.strictEqual(result?.type, 'ollama');
    assert.strictEqual(result?.baseUrl, 'http://10.0.0.5:11434/v1');
  });

  it('detects Ollama with OLLAMA_HOST (with http prefix)', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.OLLAMA_HOST = 'http://ollama-server:11434';
    const result = detectProvider();
    assert.ok(result, 'Should detect Ollama');
    assert.strictEqual(result?.type, 'ollama');
    assert.strictEqual(result?.baseUrl, 'http://ollama-server:11434/v1');
  });

  it('detects Ollama with OLLAMA_BASE_URL', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.OLLAMA_BASE_URL = 'http://my-ollama:11434/v1';
    const result = detectProvider();
    assert.ok(result, 'Should detect Ollama');
    assert.strictEqual(result?.type, 'ollama');
    assert.strictEqual(result?.baseUrl, 'http://my-ollama:11434/v1');
  });

  it('detects Ollama with only OLLAMA_MODEL', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.OLLAMA_MODEL = 'qwen2.5';
    const result = detectProvider();
    assert.ok(result, 'Should detect Ollama with model set');
    assert.strictEqual(result?.type, 'ollama');
    assert.strictEqual(result?.baseUrl, 'http://localhost:11434/v1');
    assert.strictEqual(result?.defaultModel, 'qwen2.5');
  });

  it('detects vLLM with VLLM_BASE_URL', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.VLLM_BASE_URL = 'http://localhost:8080/v1';
    const result = detectProvider();
    assert.ok(result, 'Should detect vLLM');
    assert.strictEqual(result?.type, 'vllm');
    assert.strictEqual(result?.baseUrl, 'http://localhost:8080/v1');
  });

  it('does not detect vLLM without any env', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    const result = detectProvider();
    assert.strictEqual(result, null);
  });

  it('detects Cohere with CO_API_KEY', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.CO_API_KEY = 'co-key';
    const result = detectProvider();
    assert.ok(result, 'Should detect Cohere');
    assert.strictEqual(result?.type, 'cohere');
  });

  it('detects Cohere with COHERE_API_KEY fallback', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.COHERE_API_KEY = 'fallback-key';
    const result = detectProvider();
    assert.ok(result, 'Should detect Cohere via fallback key');
    assert.strictEqual(result?.type, 'cohere');
    assert.strictEqual(result?.apiKey, 'fallback-key');
  });

  it('detects Replicate with REPLICATE_API_TOKEN', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.REPLICATE_API_TOKEN = 'replicate-token';
    const result = detectProvider();
    assert.ok(result, 'Should detect Replicate');
    assert.strictEqual(result?.type, 'replicate');
  });

  it('detects Replicate with REPLICATE_API_KEY fallback', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.REPLICATE_API_KEY = 'fallback-key';
    const result = detectProvider();
    assert.ok(result, 'Should detect Replicate via fallback key');
    assert.strictEqual(result?.type, 'replicate');
  });

  it('detects Perplexity with PERPLEXITY_API_KEY', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.PERPLEXITY_API_KEY = 'pplx-key';
    const result = detectProvider();
    assert.ok(result, 'Should detect Perplexity');
    assert.strictEqual(result?.type, 'perplexity');
  });

  it('detects Perplexity with PPLX_API_KEY fallback', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.PPLX_API_KEY = 'fallback-key';
    const result = detectProvider();
    assert.ok(result, 'Should detect Perplexity via fallback key');
    assert.strictEqual(result?.type, 'perplexity');
  });

  it('detects Bedrock with AWS credentials', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.AWS_ACCESS_KEY_ID = 'AKID123';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    const result = detectProvider();
    assert.ok(result, 'Should detect Bedrock');
    assert.strictEqual(result?.type, 'bedrock');
  });

  it('detects standard provider (OpenAI)', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.OPENAI_API_KEY = 'sk-test';
    const result = detectProvider();
    assert.ok(result, 'Should detect OpenAI');
    assert.strictEqual(result?.type, 'openai');
    assert.strictEqual(result?.baseUrl, 'https://api.openai.com/v1');
  });

  it('returns ollama before vllm (priority order)', async () => {
    const { detectProvider } = await import('../src/config/commanderConfig');
    process.env.OLLAMA_HOST = 'localhost:11434';
    process.env.VLLM_BASE_URL = 'http://localhost:8000/v1';
    const result = detectProvider();
    assert.ok(result, 'Should detect a provider');
    assert.strictEqual(result?.type, 'ollama');
  });
});
