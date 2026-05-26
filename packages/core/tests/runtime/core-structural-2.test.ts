import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// Structural tests for next batch of uncovered runtime modules
// ============================================================================

import { AgentHandoff } from '../../src/runtime/agentHandoff';
import type { HandoffRequest, HandoffStatus } from '../../src/runtime/agentHandoff';
import { AgentInbox } from '../../src/runtime/agentInbox';

import {
  TenantProvider, NullTenantProvider, SimpleTenantProvider,
  ThreeLayerMemoryRegistry, getGlobalTenantProvider,
  resetGlobalTenantProvider, getGlobalMemoryRegistry, resetGlobalMemoryRegistry,
} from '../../src/runtime/tenantProvider';
import type { TenantConfig } from '../../src/runtime/tenantProvider';

import { AuthManager, getAuthManager, resetAuthManager } from '../../src/runtime/authManager';
import type { AuthRole, ApiKeyEntry, AuthUser, AuthData } from '../../src/runtime/authManager';

import { SSEStream } from '../../src/runtime/sseStream';
import type { StructuredSSEEvent, StructuredSSEEventType } from '../../src/runtime/sseStream';

import { captureProvenance, createRunProvenance } from '../../src/runtime/provenance';
import type { RunProvenance } from '../../src/runtime/provenance';

import { PersistentTraceStore } from '../../src/runtime/traceStore';
import type { TraceStore } from '../../src/runtime/traceStore';
import type { TraceEvent } from '../../src/runtime/types';

import { buildSystemPrompt, buildCacheAwareUserPrompt } from '../../src/runtime/promptBuilder';
import type { AgentExecutionContext, RoutingDecision, AgentRuntimeConfig } from '../../src/runtime/types';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';

import {
  createSchema, mergeWithDefaults, validateConfig,
  validateRuntimeConfig, validateHttpServerConfig, validateField,
} from '../../src/runtime/configValidator';
import type { ConfigSchema, ConfigField, ConfigValidationResult, FieldType } from '../../src/runtime/configValidator';

import { ToolResultCache } from '../../src/runtime/toolResultCache';
import type { ToolCacheStats, ToolCacheConfig } from '../../src/runtime/toolResultCache';
import type { ToolCall, ToolResult } from '../../src/runtime/types';

import { WebhookDispatcher, getWebhookDispatcher, resetWebhookDispatcher } from '../../src/runtime/webhookDispatcher';
import type { WebhookConfig, WebhookEvent, WebhookDelivery } from '../../src/runtime/webhookDispatcher';

import { SamplesStore } from '../../src/runtime/samplesStore';

import { ContextWindowManager, estimateTotalTokens } from '../../src/runtime/contextWindow';
import type { ContextWindowConfig, WindowAction } from '../../src/runtime/contextWindow';
import type { LLMMessage } from '../../src/runtime/types';

// ============================================================================
// AgentHandoff
// ============================================================================

describe('AgentHandoff', () => {
  const inboxDir = '/tmp/commander-test-handoff-inbox';

  it('can be constructed', () => {
    const inbox = new AgentInbox(inboxDir);
    const h = new AgentHandoff(inbox);
    assert.ok(h instanceof AgentHandoff);
    inbox.dispose();
  });

  it('has expected methods', () => {
    const inbox = new AgentInbox(inboxDir);
    const h = new AgentHandoff(inbox);
    assert.strictEqual(typeof h.request, 'function');
    assert.strictEqual(typeof h.accept, 'function');
    assert.strictEqual(typeof h.reject, 'function');
    assert.strictEqual(typeof h.complete, 'function');
    assert.strictEqual(typeof h.getHandoff, 'function');
    assert.strictEqual(typeof h.listForAgent, 'function');
    inbox.dispose();
  });

  it('HandoffRequest type is structural', () => {
    const req: HandoffRequest = {
      handoffId: 'h-1',
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      goal: 'test',
      context: {
        messages: [{ role: 'user', content: 'hello' }],
        availableTools: ['read'],
        tokenBudget: 10000,
      },
      status: 'requested',
      createdAt: new Date().toISOString(),
    };
    assert.strictEqual(req.fromAgent, 'agent-a');
    assert.strictEqual(req.status, 'requested');
  });

  it('HandoffStatus type supports all states', () => {
    const statuses: HandoffStatus[] = ['requested', 'accepted', 'rejected', 'completed', 'failed'];
    assert.strictEqual(statuses.length, 5);
  });

  it('request creates a pending handoff', async () => {
    const inbox = new AgentInbox(inboxDir);
    const h = new AgentHandoff(inbox);
    const req = await h.request({
      handoffId: 'test-1',
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      goal: 'handoff test',
      context: {
        messages: [{ role: 'user', content: 'help' }],
        availableTools: [],
        tokenBudget: 5000,
      },
    });
    assert.strictEqual(req.status, 'requested');
    assert.strictEqual(req.handoffId, 'test-1');
    inbox.dispose();
  });
});

// ============================================================================
// TenantProvider
// ============================================================================

describe('TenantProvider', () => {
  afterEach(() => {
    resetGlobalTenantProvider();
    resetGlobalMemoryRegistry();
  });

  it('NullTenantProvider returns undefined config', () => {
    const p = new NullTenantProvider();
    assert.strictEqual(p.getTenantConfig('any'), undefined);
  });

  it('NullTenantProvider getKnownTenants returns empty', () => {
    const p = new NullTenantProvider();
    assert.deepStrictEqual(p.getKnownTenants(), []);
  });

  it('SimpleTenantProvider stores and retrieves config', () => {
    const configs: TenantConfig[] = [
      { tenantId: 'tenant-1', tokenBudget: 10000, maxConcurrency: 5, maxRunsPerMinute: 10, enabled: true },
    ];
    const p = new SimpleTenantProvider(configs);
    const config = p.getTenantConfig('tenant-1');
    assert.ok(config !== undefined);
    assert.strictEqual(config?.tokenBudget, 10000);
    assert.strictEqual(config?.maxConcurrency, 5);
  });

  it('SimpleTenantProvider returns undefined for unknown tenant', () => {
    const p = new SimpleTenantProvider([]);
    assert.strictEqual(p.getTenantConfig('unknown'), undefined);
  });

  it('SimpleTenantProvider getKnownTenants returns all keys', () => {
    const configs: TenantConfig[] = [
      { tenantId: 'a', tokenBudget: 1, maxConcurrency: 1, maxRunsPerMinute: 1, enabled: true },
      { tenantId: 'b', tokenBudget: 1, maxConcurrency: 1, maxRunsPerMinute: 1, enabled: true },
    ];
    const p = new SimpleTenantProvider(configs);
    const ids = p.getKnownTenants();
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('b'));
  });

  it('ThreeLayerMemoryRegistry can be created', () => {
    const r = new ThreeLayerMemoryRegistry();
    assert.ok(r instanceof ThreeLayerMemoryRegistry);
  });

  it('ThreeLayerMemoryRegistry has expected methods', () => {
    const r = new ThreeLayerMemoryRegistry();
    assert.strictEqual(typeof r.getOrCreate, 'function');
    assert.strictEqual(typeof r.remove, 'function');
    assert.strictEqual(typeof r.getTenantCount, 'function');
  });

  it('getGlobalTenantProvider returns NullTenantProvider by default', () => {
    const p = getGlobalTenantProvider();
    assert.ok(p instanceof NullTenantProvider);
  });

  it('TenantProvider interface is structural', () => {
    const p: TenantProvider = new NullTenantProvider();
    assert.strictEqual(typeof p.getTenantConfig, 'function');
    assert.strictEqual(typeof p.getKnownTenants, 'function');
  });

  it('TenantConfig type supports all fields', () => {
    const cfg: TenantConfig = {
      tenantId: 'test',
      tokenBudget: 50000,
      maxConcurrency: 10,
      maxRunsPerMinute: 100,
      enabled: true,
      workspacePath: '/tmp/workspace',
    };
    assert.strictEqual(cfg.tenantId, 'test');
    assert.ok(cfg.enabled);
  });
});

// ============================================================================
// AuthManager
// ============================================================================

describe('AuthManager', () => {
  afterEach(() => {
    resetAuthManager();
  });

  it('can be constructed', () => {
    const a = new AuthManager();
    assert.ok(a instanceof AuthManager);
  });

  it('has expected methods', () => {
    const a = new AuthManager();
    assert.strictEqual(typeof a.generateApiKey, 'function');
    assert.strictEqual(typeof a.revokeApiKey, 'function');
    assert.strictEqual(typeof a.listApiKeys, 'function');
    assert.strictEqual(typeof a.createUser, 'function');
    assert.strictEqual(typeof a.getUser, 'function');
    assert.strictEqual(typeof a.authenticate, 'function');
  });

  it('singleton getter returns instance', () => {
    const a = getAuthManager();
    assert.ok(a instanceof AuthManager);
  });

  it('AuthRole type supports all roles', () => {
    const roles: AuthRole[] = ['admin', 'operator', 'viewer'];
    assert.strictEqual(roles.length, 3);
  });

  it('ApiKeyEntry type is structural', () => {
    const entry: ApiKeyEntry = {
      keyHash: 'abc123',
      name: 'default',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      keyPrefix: 'xyz',
      lastUsedAt: undefined,
    };
    assert.strictEqual(entry.keyPrefix, 'xyz');
    assert.ok(entry.keyHash.length > 0);
  });

  it('AuthUser type is structural', () => {
    const user: AuthUser = {
      id: 'user-1',
      username: 'testuser',
      role: 'admin',
      apiKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true,
    };
    assert.strictEqual(user.username, 'testuser');
    assert.ok(user.enabled);
  });
});

// ============================================================================
// SSEStream
// ============================================================================

describe('SSEStream', () => {
  it('can be constructed', () => {
    const s = new SSEStream();
    assert.ok(s instanceof SSEStream);
    s.close();
  });

  it('has expected methods', () => {
    const s = new SSEStream();
    assert.strictEqual(typeof s.emitStructured, 'function');
    assert.strictEqual(typeof s.close, 'function');
    assert.strictEqual(typeof s.onEvent, 'function');
    assert.strictEqual(typeof s.emitReasoning, 'function');
    assert.strictEqual(typeof s.emitToolCall, 'function');
    assert.strictEqual(typeof s.pipe, 'function');
    s.close();
  });

  it('StructuredSSEEventType supports all event types', () => {
    const types: StructuredSSEEventType[] = [
      'agent.status', 'agent.thinking', 'reasoning.delta',
      'tool_call.delta', 'tool_call.started', 'tool_call.completed',
      'tool_call.timeout', 'tool_call.retry', 'tool_call.blocked',
      'output.delta', 'output.completed', 'diff.available',
      'error.occurred',
    ];
    assert.strictEqual(types.length, 13);
  });

  it('StructuredSSEEvent type is structural', () => {
    const evt: StructuredSSEEvent = {
      event: 'agent.status',
      data: { status: 'running' },
      timestamp: new Date().toISOString(),
      seq: 1,
    };
    assert.strictEqual(evt.event, 'agent.status');
    assert.strictEqual(evt.seq, 1);
  });

  it('emitStructured sends events', () => {
    const s = new SSEStream();
    const events: string[] = [];
    s.onEvent((event) => { events.push(event); });
    s.emitStructured('agent.status', { status: 'running' });
    assert.strictEqual(events.length, 1);
    assert.ok(events[0].includes('agent.status'));
    s.close();
  });
});

// ============================================================================
// Provenance
// ============================================================================

describe('Provenance', () => {
  it('captureProvenance returns git and system info', () => {
    const p = captureProvenance();
    assert.ok(p !== undefined);
    assert.ok(p.git !== undefined);
    assert.ok(typeof p.git.commitHash === 'string');
    assert.ok(p.system !== undefined);
    assert.ok(typeof p.system.platform === 'string');
  });

  it('createRunProvenance returns full provenance', () => {
    const p = createRunProvenance('run-1', { provider: 'openai', modelId: 'gpt-4', tier: 'default' });
    assert.strictEqual(p.runId, 'run-1');
    assert.ok(p.timestamp !== undefined);
    assert.ok(p.tags !== undefined);
    assert.ok(p.model.provider === 'openai');
  });

  it('RunProvenance type is structural', () => {
    const p: RunProvenance = {
      runId: 'run-1',
      timestamp: new Date().toISOString(),
      git: { commitHash: 'abc123', branch: 'main', dirty: false },
      model: { provider: 'openai', modelId: 'gpt-4', tier: 'default' },
      system: { nodeVersion: 'v20', platform: 'darwin', arch: 'arm64' },
      tags: { env: 'test' },
    };
    assert.strictEqual(p.runId, 'run-1');
    assert.strictEqual(p.git.commitHash, 'abc123');
    assert.strictEqual(p.model.provider, 'openai');
    assert.strictEqual(p.tags.env, 'test');
  });
});

// ============================================================================
// TraceStore
// ============================================================================

describe('TraceStore', () => {
  it('PersistentTraceStore can be constructed', () => {
    const t = new PersistentTraceStore('/tmp/commander-test-traces-2');
    assert.ok(t instanceof PersistentTraceStore);
  });

  it('has expected methods', () => {
    const t = new PersistentTraceStore('/tmp/commander-test-traces-2');
    assert.strictEqual(typeof t.append, 'function');
    assert.strictEqual(typeof t.flush, 'function');
    assert.strictEqual(typeof t.readTrace, 'function');
    assert.strictEqual(typeof t.flushAll, 'function');
    assert.strictEqual(typeof t.shutdown, 'function');
  });

  it('TraceStore interface is structural', () => {
    const t: TraceStore = new PersistentTraceStore('/tmp/commander-test-traces-2');
    assert.strictEqual(typeof t.append, 'function');
    assert.strictEqual(typeof t.flush, 'function');
  });

  it('append and readTrace round-trips', () => {
    const t = new PersistentTraceStore('/tmp/commander-test-traces-2');
    const event: TraceEvent = {
      runId: 'test-run-1',
      timestamp: new Date().toISOString(),
      type: 'tool_execution',
      agentId: 'agent-1',
      payload: { tool: 'read' },
    };
    t.append(event);
    t.flush('test-run-1');
    const events = t.readTrace('test-run-1');
    assert.ok(events.length >= 1);
    assert.strictEqual(events[0].agentId, 'agent-1');
  });
});

// ============================================================================
// PromptBuilder
// ============================================================================

describe('PromptBuilder', () => {
  const mockCtx: AgentExecutionContext = {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'test goal',
    tokenBudget: 10000,
    maxSteps: 10,
    availableTools: ['read', 'write'],
    contextData: {},
  };
  const mockRouting: RoutingDecision = {
    modelId: 'gpt-4',
    provider: 'openai',
    tier: 'default',
  };
  const mockConfig: AgentRuntimeConfig = {
    maxStepsPerRun: 10,
    maxRetries: 3,
    timeoutMs: 60000,
    maxConcurrency: 5,
    budgetHardCapTokens: 50000,
  };
  const governor = new TokenGovernor({ totalBudget: 10000 });

  it('buildSystemPrompt returns a string', () => {
    const result = buildSystemPrompt(mockCtx, mockRouting, mockConfig, new Map(), governor);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('buildSystemPrompt includes the agent ID', () => {
    const result = buildSystemPrompt(mockCtx, mockRouting, mockConfig, new Map(), governor);
    assert.ok(result.includes('test-agent'));
  });

  it('buildCacheAwareUserPrompt returns a string', () => {
    const result = buildCacheAwareUserPrompt(mockCtx, mockRouting, governor);
    assert.ok(typeof result === 'string');
  });
});

// ============================================================================
// ConfigValidator
// ============================================================================

describe('ConfigValidator', () => {
  it('createSchema returns the schema', () => {
    const schema = createSchema({
      name: { type: 'string', required: true, description: 'Name field' },
    });
    assert.ok(schema.name.type === 'string');
    assert.ok(schema.name.required);
  });

  it('mergeWithDefaults fills missing values', () => {
    const result = mergeWithDefaults(
      { name: 'test' },
      { name: { type: 'string', default: 'default-name', description: '' }, count: { type: 'number', default: 42, description: '' } },
    );
    assert.strictEqual(result.name, 'test');
    assert.strictEqual(result.count, 42);
  });

  it('validateConfig returns valid result for valid config', () => {
    const schema = createSchema({
      name: { type: 'string', required: true, description: 'Name' },
    });
    const result = validateConfig({ name: 'hello' }, schema);
    assert.ok(result.valid);
  });

  it('validateConfig returns invalid for missing required field', () => {
    const schema = createSchema({
      name: { type: 'string', required: true, description: 'Name' },
    });
    const result = validateConfig({}, schema);
    assert.ok(!result.valid);
    assert.ok(result.errors.length > 0);
  });

  it('validateField validates string type', () => {
    const field: ConfigField = { type: 'string', required: true, description: '' };
    const errors = validateField('hello', field, 'test');
    assert.strictEqual(errors.length, 0);
  });

  it('validateField rejects wrong type', () => {
    const field: ConfigField = { type: 'string', required: true, description: '' };
    const errors = validateField(42, field, 'test');
    assert.ok(errors.length > 0);
  });

  it('validateRuntimeConfig returns ConfigValidationResult', () => {
    const result = validateRuntimeConfig({});
    assert.ok('valid' in result);
    assert.ok('errors' in result);
  });

  it('validateHttpServerConfig returns ConfigValidationResult', () => {
    const result = validateHttpServerConfig({});
    assert.ok('valid' in result);
    assert.ok('errors' in result);
  });

  it('FieldType supports all types', () => {
    const types: FieldType[] = ['string', 'number', 'boolean', 'enum', 'array', 'object'];
    assert.strictEqual(types.length, 6);
  });
});

// ============================================================================
// ToolResultCache
// ============================================================================

describe('ToolResultCache', () => {
  it('can be constructed with defaults', () => {
    const c = new ToolResultCache();
    assert.ok(c instanceof ToolResultCache);
  });

  it('can be constructed with custom config', () => {
    const c = new ToolResultCache({ enabled: true, maxEntries: 50, defaultTtlMs: 60000 });
    assert.ok(c instanceof ToolResultCache);
  });

  it('has expected methods', () => {
    const c = new ToolResultCache();
    assert.strictEqual(typeof c.get, 'function');
    assert.strictEqual(typeof c.set, 'function');
    assert.strictEqual(typeof c.clear, 'function');
    assert.strictEqual(typeof c.getStats, 'function');
    assert.strictEqual(typeof c.invalidateTool, 'function');
  });

  it('get returns undefined when cache disabled', () => {
    const c = new ToolResultCache();
    const toolCall: ToolCall = { id: 'tc-1', name: 'read', arguments: { path: 'test.txt' } };
    assert.strictEqual(c.get(toolCall), undefined);
  });

  it('set and get round-trips when enabled', () => {
    const c = new ToolResultCache({ enabled: true, maxEntries: 100 });
    const toolCall: ToolCall = { id: 'tc-1', name: 'read', arguments: { path: 'hello.txt' } };
    const result: ToolResult = { toolCallId: 'tc-1', name: 'read', output: 'hello', durationMs: 10 };
    c.set(toolCall, result);
    const cached = c.get(toolCall);
    assert.ok(cached !== undefined);
    assert.strictEqual(cached.output, 'hello');
  });

  it('clear removes all entries', () => {
    const c = new ToolResultCache({ enabled: true, maxEntries: 100 });
    const tc1: ToolCall = { id: 'tc-1', name: 'read', arguments: { path: 'a.txt' } };
    const tc2: ToolCall = { id: 'tc-2', name: 'read', arguments: { path: 'b.txt' } };
    c.set(tc1, { toolCallId: 'tc-1', name: 'read', output: 'a', durationMs: 1 });
    c.set(tc2, { toolCallId: 'tc-2', name: 'read', output: 'b', durationMs: 1 });
    c.clear();
    assert.strictEqual(c.get(tc1), undefined);
    assert.strictEqual(c.get(tc2), undefined);
  });

  it('getStats returns ToolCacheStats', () => {
    const c = new ToolResultCache({ enabled: true, maxEntries: 100, defaultTtlMs: 30000 });
    const tc: ToolCall = { id: 'tc-1', name: 'read', arguments: { path: 'x.txt' } };
    c.set(tc, { toolCallId: 'tc-1', name: 'read', output: 'value', durationMs: 1 });
    const stats: ToolCacheStats = c.getStats();
    assert.ok(stats.totalEntries >= 1);
    assert.strictEqual(typeof stats.hitRate, 'number');
    assert.ok(stats.memoryEstimateBytes > 0);
  });

  it('ToolCacheConfig type is structural', () => {
    const cfg: ToolCacheConfig = { enabled: true, maxEntries: 200, defaultTtlMs: 120000, toolTtls: {}, neverCache: [] };
    assert.strictEqual(cfg.maxEntries, 200);
  });
});

// ============================================================================
// WebhookDispatcher
// ============================================================================

describe('WebhookDispatcher', () => {
  afterEach(() => {
    resetWebhookDispatcher();
  });

  it('can be constructed', () => {
    const w = new WebhookDispatcher();
    assert.ok(w instanceof WebhookDispatcher);
  });

  it('has expected methods', () => {
    const w = new WebhookDispatcher();
    assert.strictEqual(typeof w.registerWebhook, 'function');
    assert.strictEqual(typeof w.dispatch, 'function');
    assert.strictEqual(typeof w.deregisterWebhook, 'function');
    assert.strictEqual(typeof w.listWebhooks, 'function');
    assert.strictEqual(typeof w.getWebhook, 'function');
    assert.strictEqual(typeof w.start, 'function');
    assert.strictEqual(typeof w.stop, 'function');
  });

  it('singleton getter returns instance', () => {
    const w = getWebhookDispatcher();
    assert.ok(w instanceof WebhookDispatcher);
  });

  it('WebhookConfig type is structural', () => {
    const cfg: WebhookConfig = {
      id: 'wh-1',
      url: 'https://example.com/hook',
      events: ['agent.thinking'],
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    assert.strictEqual(cfg.url, 'https://example.com/hook');
    assert.ok(cfg.enabled);
  });

  it('WebhookEvent type is structural', () => {
    const evt: WebhookEvent = {
      event: 'tool_call.started',
      timestamp: new Date().toISOString(),
      source: 'agent-1',
      payload: { tool: 'test' },
    };
    assert.strictEqual(evt.event, 'tool_call.started');
  });

  it('registerWebhook adds and getWebhook retrieves', () => {
    const w = new WebhookDispatcher();
    const cfg = w.registerWebhook({
      url: 'https://example.com/hook',
      events: ['agent.thinking'],
      enabled: true,
    });
    assert.ok(cfg.id.length > 0);
    const retrieved = w.getWebhook(cfg.id);
    assert.ok(retrieved !== undefined);
    assert.strictEqual(retrieved.url, 'https://example.com/hook');
  });
});

// ============================================================================
// SamplesStore
// ============================================================================

describe('SamplesStore', () => {
  it('can be constructed', () => {
    const s = new SamplesStore('/tmp/commander-test-samples-2');
    assert.ok(s instanceof SamplesStore);
  });

  it('has expected methods', () => {
    const s = new SamplesStore('/tmp/commander-test-samples-2');
    assert.strictEqual(typeof s.recordLLMCall, 'function');
    assert.strictEqual(typeof s.recordVerification, 'function');
    assert.strictEqual(typeof s.recordRunManifest, 'function');
    assert.strictEqual(typeof s.flush, 'function');
    assert.strictEqual(typeof s.getCallCount, 'function');
  });

  it('getCallCount returns zero for empty store', () => {
    const s = new SamplesStore('/tmp/commander-test-samples-2');
    assert.strictEqual(s.getCallCount(), 0);
  });

  it('getVerificationCount returns zero for empty store', () => {
    const s = new SamplesStore('/tmp/commander-test-samples-2');
    assert.strictEqual(s.getVerificationCount(), 0);
  });
});

// ============================================================================
// ContextWindow
// ============================================================================

describe('ContextWindow', () => {
  it('ContextWindowManager can be constructed', () => {
    const c = new ContextWindowManager();
    assert.ok(c instanceof ContextWindowManager);
  });

  it('has expected methods', () => {
    const c = new ContextWindowManager();
    assert.strictEqual(typeof c.apply, 'function');
    assert.strictEqual(typeof c.getConfig, 'function');
    assert.strictEqual(typeof c.updateConfig, 'function');
    assert.strictEqual(typeof c.remainingCapacity, 'function');
    assert.strictEqual(typeof c.needsTrimming, 'function');
  });

  it('estimateTotalTokens returns a number', () => {
    const msg: LLMMessage = { role: 'user', content: 'hello' };
    const result = estimateTotalTokens([msg]);
    assert.strictEqual(typeof result, 'number');
    assert.ok(result > 0);
  });

  it('ContextWindowConfig type is structural', () => {
    const cfg: ContextWindowConfig = {
      maxContextTokens: 4096,
      triggerThreshold: 0.8,
      keepRecentCount: 10,
      enableSummarization: false,
      messageOverheadTokens: 50,
    };
    assert.strictEqual(cfg.maxContextTokens, 4096);
    assert.strictEqual(cfg.triggerThreshold, 0.8);
  });

  it('apply returns action with applied=false when under threshold', () => {
    const c = new ContextWindowManager({ maxContextTokens: 100000, triggerThreshold: 0.9 });
    const msg: LLMMessage = { role: 'user', content: 'hello' };
    const result = c.apply([msg]);
    assert.strictEqual(result.action.applied, false);
    assert.strictEqual(result.action.droppedCount, 0);
  });
});
