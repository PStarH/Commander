/**
 * Config Injection Helper — write temporary config files for tests.
 *
 * Inspired by Codex CLI's write_mock_responses_config_toml(): create a
 * complete config that routes model calls to a mock server, with controlled
 * approval policy, sandbox mode, and retry settings.
 *
 * Usage:
 *   import { injectTestConfig, type TestConfig } from './helpers/configInjection';
 *
 *   const server = new MockLLMServer();
 *   await server.start();
 *
 *   const config = injectTestConfig(env.configDir, {
 *     mockServerUrl: server.baseUrl,
 *     approvalMode: 'full-auto',
 *     sandboxMode: 'read-only',
 *   });
 *   // config.apiBase now points to mock server
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TestConfigOptions {
  /** Mock server base URL (e.g. http://127.0.0.1:12345) */
  mockServerUrl?: string;
  /** Provider type (default: 'openai') */
  provider?: string;
  /** Model ID (default: 'mock-model') */
  model?: string;
  /** API key (default: 'test-key') */
  apiKey?: string;
  /** Approval mode for sandbox (default: 'full-auto') */
  approvalMode?: 'suggest' | 'auto-edit' | 'full-auto' | 'read-only' | 'plan';
  /** Sandbox mode (default: 'read-only') */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Max retries (default: 0 for deterministic tests) */
  maxRetries?: number;
  /** Stream max retries (default: 0) */
  streamMaxRetries?: number;
  /** Timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Additional environment variables to set */
  envVars?: Record<string, string | undefined>;
}

export interface InjectedConfig {
  /** Path to the config directory */
  configDir: string;
  /** Path to the config file */
  configFile: string;
  /** The API base URL (mock server or real) */
  apiBase: string;
  /** Original env var values for restoration */
  _originalEnv: Record<string, string | undefined>;
  /** Clean up injected config and restore env */
  cleanup(): void;
}

/**
 * Inject a test configuration that routes to a mock server.
 * Returns cleanup function to restore original state.
 */
export function injectTestConfig(
  configDir: string,
  options: TestConfigOptions = {}
): InjectedConfig {
  const {
    mockServerUrl = 'http://127.0.0.1:9999',
    provider = 'openai',
    model = 'mock-model',
    apiKey = 'test-key-mock',
    approvalMode = 'full-auto',
    sandboxMode = 'read-only',
    maxRetries = 0,
    streamMaxRetries = 0,
    timeoutMs = 10000,
    envVars = {},
  } = options;

  // Create config directory
  fs.mkdirSync(configDir, { recursive: true });

  // Write config file
  const configFile = path.join(configDir, 'config.json');
  const config = {
    provider,
    model,
    apiBase: mockServerUrl,
    apiKey,
    approvalMode,
    sandboxMode,
    maxRetries,
    streamMaxRetries,
    timeoutMs,
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  // Set environment variables, saving originals for restoration
  const originalEnv: Record<string, string | undefined> = {};

  const envMap: Record<string, string> = {
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: mockServerUrl,
    COMMANDER_MODEL: model,
    COMMANDER_APPROVAL_MODE: approvalMode,
    COMMANDER_SANDBOX_MODE: sandboxMode,
  };

  // Merge with custom env vars
  const allEnv = { ...envMap, ...envVars };

  for (const [key, value] of Object.entries(allEnv)) {
    originalEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  function cleanup(): void {
    // Restore original env vars
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    // Remove config file
    try {
      fs.unlinkSync(configFile);
    } catch { /* ignore */ }
  }

  return {
    configDir,
    configFile,
    apiBase: mockServerUrl,
    _originalEnv: originalEnv,
    cleanup,
  };
}

/**
 * Create a CommanderAgentLoop config pointing at a mock server.
 * Useful for tests that construct the agent loop directly.
 */
export function createMockAgentLoopConfig(options: {
  stateFile: string;
  mockServerUrl: string;
  tools?: string[];
  maxConcurrentTasks?: number;
  sessionTimeoutMs?: number;
}) {
  return {
    projectRoot: path.dirname(options.stateFile),
    stateFile: options.stateFile,
    maxConcurrentTasks: options.maxConcurrentTasks ?? 3,
    sessionTimeoutMs: options.sessionTimeoutMs ?? 60000,
    tools: options.tools ?? ['web_search', 'file_read'],
    apiBase: options.mockServerUrl,
  };
}
