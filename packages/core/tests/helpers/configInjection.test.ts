/**
 * Tests for Config Injection Helper.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { injectTestConfig, createMockAgentLoopConfig, type InjectedConfig } from './configInjection';
import { createTestEnvSync, type TestEnv } from './testEnv';

describe('configInjection', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnvSync('configInjection');
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('injectTestConfig', () => {
    it('creates config file', () => {
      const config = injectTestConfig(env.configDir, {
        mockServerUrl: 'http://127.0.0.1:12345',
      });

      assert.ok(fs.existsSync(config.configFile));
      const data = JSON.parse(fs.readFileSync(config.configFile, 'utf-8'));
      assert.strictEqual(data.apiBase, 'http://127.0.0.1:12345');
      assert.strictEqual(data.provider, 'openai');
      assert.strictEqual(data.model, 'mock-model');

      config.cleanup();
    });

    it('sets environment variables', () => {
      const config = injectTestConfig(env.configDir, {
        mockServerUrl: 'http://127.0.0.1:12345',
        apiKey: 'test-key-123',
      });

      assert.strictEqual(process.env.OPENAI_API_KEY, 'test-key-123');
      assert.strictEqual(process.env.OPENAI_BASE_URL, 'http://127.0.0.1:12345');
      assert.strictEqual(process.env.COMMANDER_MODEL, 'mock-model');

      config.cleanup();
    });

    it('restores environment variables on cleanup', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      const originalUrl = process.env.OPENAI_BASE_URL;

      const config = injectTestConfig(env.configDir, {
        mockServerUrl: 'http://127.0.0.1:12345',
        apiKey: 'temp-key',
      });

      assert.strictEqual(process.env.OPENAI_API_KEY, 'temp-key');

      config.cleanup();

      assert.strictEqual(process.env.OPENAI_API_KEY, originalKey);
      assert.strictEqual(process.env.OPENAI_BASE_URL, originalUrl);
    });

    it('uses default values', () => {
      const config = injectTestConfig(env.configDir);

      const data = JSON.parse(fs.readFileSync(config.configFile, 'utf-8'));
      assert.strictEqual(data.approvalMode, 'full-auto');
      assert.strictEqual(data.sandboxMode, 'read-only');
      assert.strictEqual(data.maxRetries, 0);
      assert.strictEqual(data.streamMaxRetries, 0);
      assert.strictEqual(data.timeoutMs, 10000);

      config.cleanup();
    });

    it('accepts custom values', () => {
      const config = injectTestConfig(env.configDir, {
        approvalMode: 'suggest',
        sandboxMode: 'workspace-write',
        maxRetries: 3,
        timeoutMs: 30000,
      });

      const data = JSON.parse(fs.readFileSync(config.configFile, 'utf-8'));
      assert.strictEqual(data.approvalMode, 'suggest');
      assert.strictEqual(data.sandboxMode, 'workspace-write');
      assert.strictEqual(data.maxRetries, 3);
      assert.strictEqual(data.timeoutMs, 30000);

      config.cleanup();
    });

    it('accepts custom env vars', () => {
      const config = injectTestConfig(env.configDir, {
        envVars: {
          CUSTOM_VAR: 'custom-value',
          UNSET_VAR: undefined,
        },
      });

      assert.strictEqual(process.env.CUSTOM_VAR, 'custom-value');

      config.cleanup();

      // CUSTOM_VAR should be removed after cleanup
      assert.strictEqual(process.env.CUSTOM_VAR, undefined);
    });

    it('returns apiBase', () => {
      const config = injectTestConfig(env.configDir, {
        mockServerUrl: 'http://localhost:5555',
      });

      assert.strictEqual(config.apiBase, 'http://localhost:5555');

      config.cleanup();
    });
  });

  describe('createMockAgentLoopConfig', () => {
    it('creates config with mock server url', () => {
      const config = createMockAgentLoopConfig({
        stateFile: env.stateFile,
        mockServerUrl: 'http://127.0.0.1:12345',
      });

      assert.strictEqual(config.stateFile, env.stateFile);
      assert.strictEqual(config.apiBase, 'http://127.0.0.1:12345');
      assert.strictEqual(config.maxConcurrentTasks, 3);
      assert.strictEqual(config.sessionTimeoutMs, 60000);
      assert.deepStrictEqual(config.tools, ['web_search', 'file_read']);
    });

    it('accepts custom values', () => {
      const config = createMockAgentLoopConfig({
        stateFile: env.stateFile,
        mockServerUrl: 'http://localhost:9999',
        tools: ['web_search', 'shell_execute'],
        maxConcurrentTasks: 10,
        sessionTimeoutMs: 120000,
      });

      assert.deepStrictEqual(config.tools, ['web_search', 'shell_execute']);
      assert.strictEqual(config.maxConcurrentTasks, 10);
      assert.strictEqual(config.sessionTimeoutMs, 120000);
    });
  });
});
