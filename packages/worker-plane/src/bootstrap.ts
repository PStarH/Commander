/**
 * Production worker bootstrap module.
 *
 * This module is the bridge between the worker-plane's fail-closed `main.ts`
 * entry point and the actual runtime infrastructure (Postgres kernel, AgentRuntime,
 * tool registries). It is loaded via `COMMANDER_WORKER_BOOTSTRAP` env var.
 *
 * Environment variables:
 * - DATABASE_URL: PostgreSQL connection string (required)
 * - COMMANDER_WORKER_ID: Worker instance ID (default: auto-generated)
 * - COMMANDER_WORKER_KIND: Worker type (default: 'agent')
 * - COMMANDER_WORKER_CAPABILITIES: Comma-separated capability list (default: 'agent')
 * - COMMANDER_WORKER_MAX_CONCURRENCY: Max concurrent steps (default: 10)
 * - COMMANDER_WORKER_TENANTS: Comma-separated tenant IDs, or '*' for all
 * - COMMANDER_WORKER_AUTH_TOKEN: Worker authentication token
 * - COMMANDER_WORKER_AUTH_SUBJECT: Worker identity subject
 * - COMMANDER_WORKER_LEASE_TTL_MS: Step lease TTL (default: 30000)
 * - COMMANDER_WORKER_HEARTBEAT_MS: Heartbeat interval (default: 10000)
 * - COMMANDER_WORKER_POLL_MS: Poll interval (default: 250)
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WorkerService } from './workerService.js';
import { PostgresWorkerRegistry } from './registry.js';
import { ApiKeyWorkerAuthenticator } from './apiKeyAuthenticator.js';
import { ToolStepExecutor } from './toolStepExecutor.js';
import { EvaluatorStepExecutor } from './evaluatorStepExecutor.js';
import { CompositeStepExecutor } from './compositeStepExecutor.js';
import { createAgentStepExecutor, createExecutorManifest } from './workerRuntimeAdapter.js';
import { createProductionWorkerSandboxReadiness } from './sandboxReadiness.js';
import type { WorkerDefinition, WorkerIdentity, WorkerKind, StepExecutor } from './types.js';
import type { EffectExecutor, PolicyEvaluator, AuditSink, EffectKernelPort } from '@commander/effect-broker';
import { EffectBroker, CapabilityTokenIssuer, CapabilityTokenVerifier } from '@commander/effect-broker';

// Lazy import to avoid circular dependency at module load time
/* eslint-disable @typescript-eslint/no-explicit-any */
type Pool = { connect(): Promise<any>; end(): Promise<void> };

export async function createWorkerService(): Promise<WorkerService> {
  await createProductionWorkerSandboxReadiness().assertReady();

  // ── Validate required env vars ──
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is required for worker bootstrap');
  }

  const authToken = process.env.COMMANDER_WORKER_AUTH_TOKEN;
  if (!authToken) {
    throw new Error('COMMANDER_WORKER_AUTH_TOKEN is required for worker bootstrap');
  }

  // ── Parse configuration ──
  const workerId = process.env.COMMANDER_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;
  const workerKind = (process.env.COMMANDER_WORKER_KIND ?? 'agent') as WorkerKind;
  const capabilities = (process.env.COMMANDER_WORKER_CAPABILITIES ?? 'agent')
    .split(',')
    .map((s) => s.trim());
  const maxConcurrency = parseInt(process.env.COMMANDER_WORKER_MAX_CONCURRENCY ?? '10', 10);
  const tenantIds = (process.env.COMMANDER_WORKER_TENANTS ?? '*').split(',').map((s) => s.trim());

  // ── Build worker identity ──
  const expiresAt = new Date(Date.now() + 3600_000); // 1 hour
  const identity: WorkerIdentity = {
    subject: process.env.COMMANDER_WORKER_AUTH_SUBJECT ?? `worker:${workerId}`,
    token: authToken,
    expiresAt: expiresAt.toISOString(),
  };

  // ── Build worker definition ──
  const definition: WorkerDefinition = {
    id: workerId,
    kind: workerKind,
    version: process.env.npm_package_version ?? '0.2.0',
    capabilities,
    maxConcurrency,
    labels: {
      hostname: hostname(),
      pid: String(process.pid),
      node_version: process.version,
    },
  };

  // ── Connect to PostgreSQL ──
  const { Pool: PgPool } = (await import('pg')) as unknown as {
    Pool: new (config: { connectionString: string; max: number }) => Pool;
  };
  const pool = new PgPool({ connectionString: dbUrl, max: maxConcurrency + 5 });

  // ── Create kernel repository adapter ──
  // Lazy dynamic import to avoid circular dependency at module load time.
  // A worker configured to serve all tenants ('*') acts like a scheduler/recovery
  // process for cross-tenant claim/heartbeat and must connect as the
  // commander_scheduler role. Workers scoped to specific tenants use the
  // commander_app role and carry an explicit tenant scope on every write.
  const allTenants = tenantIds.includes('*');
  const { PostgresKernelRepository } = (await import('@commander/kernel')) as unknown as {
    PostgresKernelRepository: new (pool: any, options?: { schedulerMode?: boolean }) => any;
  };
  const kernel = new PostgresKernelRepository(pool, { schedulerMode: allTenants });

  // ── Create registry ──
  const registry = new PostgresWorkerRegistry(pool);

  // ── Create authenticator ──
  const authenticator = new ApiKeyWorkerAuthenticator({
    validTokens: new Set([authToken]),
    defaultTenantIds: tenantIds,
    defaultCapabilities: capabilities,
  });

  // ── Create shared Effect Broker for external side effects ──
  const { broker: effectBroker, issuer: capabilityIssuer } = createEffectBroker(kernel);

  // ── Create step executor based on worker kind ──
  const executor = await createExecutorForKind(
    workerKind,
    capabilities,
    effectBroker,
    capabilityIssuer,
  );

  // ── Build worker service ──
  const service = new WorkerService(
    definition,
    identity,
    authenticator,
    registry,
    kernel,
    executor,
    {
      leaseTtlMs: parseInt(process.env.COMMANDER_WORKER_LEASE_TTL_MS ?? '30000', 10),
      workerHeartbeatMs: parseInt(process.env.COMMANDER_WORKER_HEARTBEAT_MS ?? '10000', 10),
      pollIntervalMs: parseInt(process.env.COMMANDER_WORKER_POLL_MS ?? '250', 10),
      sandboxReadiness: createProductionWorkerSandboxReadiness(),
    },
  );

  return service;
}

/**
 * Worker-plane effect policy (Architecture V2 admission force).
 *
 * - `llm.*` is allow-by-default so agents can call models once EffectBroker is
 *   wired (still subject to capability tokens + kernel allowlist).
 * - All other external effect types remain deny-by-default (fail-closed).
 * - `COMMANDER_WORKER_EFFECT_POLICY=permit` is intentionally ignored (WS2 §4).
 */
export function createWorkerPolicyEvaluator(
  _env: NodeJS.ProcessEnv = process.env,
): PolicyEvaluator {
  void _env;
  return {
    evaluate: async (input) => {
      if (typeof input.type === 'string' && input.type.startsWith('llm.')) {
        return {
          effect: 'allow' as const,
          decisionId: 'llm-model-default',
          reason: `Default worker policy allows model invocation (type=${input.type}).`,
          policySnapshotId: 'worker-llm-v1',
        };
      }
      return {
        effect: 'deny' as const,
        decisionId: 'deny-default',
        reason:
          `Default worker policy denies external effects (type=${input.type}). ` +
          'Add a kernel allowlist entry and inject a broader PolicyEvaluator for tools/connectors.',
        policySnapshotId: 'worker-llm-v1',
      };
    },
  };
}

type AllowlistKernel = EffectKernelPort & {
  ensureAllowlistDefault?(tenantId: string, actionPattern: string, allowed: boolean): Promise<void>;
};

/** Seed llm.* allowlist defaults without overwriting explicit denies. */
export function withDefaultLlmAllowlist(kernel: AllowlistKernel): EffectKernelPort {
  return {
    admitEffect: (input) => kernel.admitEffect(input),
    completeEffect: (effectId, tenantId, lease, response, actor) =>
      kernel.completeEffect(effectId, tenantId, lease, response, actor),
    markEffectCompletionUnknown: kernel.markEffectCompletionUnknown?.bind(kernel),
    incrementQuota: kernel.incrementQuota?.bind(kernel),
    getQuota: kernel.getQuota?.bind(kernel),
    isActionAllowed: async (tenantId, action) => {
      if (action.startsWith('llm.') && kernel.ensureAllowlistDefault) {
        await kernel.ensureAllowlistDefault(tenantId, 'llm.*', true);
      }
      if (!kernel.isActionAllowed) return action.startsWith('llm.');
      return kernel.isActionAllowed(tenantId, action);
    },
  };
}

function createEffectBroker(kernel: AllowlistKernel): {
  broker: EffectBroker;
  issuer: CapabilityTokenIssuer;
} {
  // WS2 §9: the CapabilityTokenService seed-based facade is removed. The worker
  // bootstrap now generates a fresh Ed25519 keypair and builds a matching
  // verifier. In production the verifier should be wired with the issuer's
  // distributed public keys instead; this dev path keeps local workers working.
  const issuer = CapabilityTokenIssuer.generate({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    keyId: 'worker-bootstrap',
  });
  const tokens = new CapabilityTokenVerifier({
    issuer: 'commander-worker',
    audience: 'commander.effect-broker',
    publicKeys: { 'worker-bootstrap': issuer.publicKey },
  });
  const policy = createWorkerPolicyEvaluator();
  const effectKernel = withDefaultLlmAllowlist(kernel);

  // Minimal executor: llm.* dispatches through the WS2 §1 invoke registry;
  // other types log a marker. Operators replace this with a real connector
  // dispatcher. Default policy allows llm.*; tools/connectors stay denied.
  const executor: EffectExecutor = {
    execute: async (input: {
      type: string;
      request: Record<string, unknown>;
      signal: AbortSignal;
    }) => {
      if (input.type.startsWith('llm.')) {
        const { dispatchLlmEffect } = await import('./llmBrokerBridge.js');
        return dispatchLlmEffect(input);
      }
      // eslint-disable-next-line no-console
      console.warn(`[effect-broker] Executing effect type=${input.type}`, input.request);
      return { executed: true, type: input.type };
    },
  };

  // Console audit sink. Production should forward to a durable audit store.
  const audit: AuditSink = {
    append: async (event: {
      type: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      tenantId: string;
      runId: string;
      stepId: string;
      at: string;
      details: Record<string, unknown>;
    }) => {
      // eslint-disable-next-line no-console
      console.log(`[effect-audit] ${event.type} ${event.severity}`, event.details);
    },
  };

  // WS2 §4: request binding is mandatory. The EffectBroker constructor
  // enforces this in production (throws REQUEST_BINDING_DISABLED_IN_PROD).
  const broker = new EffectBroker(tokens, policy, effectKernel, executor, audit, {
    audience: 'commander.effect-broker',
    requireRequestBinding: true,
  });
  return { broker, issuer };
}

/**
 * Create the appropriate step executor(s) based on worker kind.
 * A worker can handle multiple step kinds if configured with multiple capabilities.
 */
async function createExecutorForKind(
  kind: WorkerKind,
  capabilities: string[],
  effectBroker?: EffectBroker,
  capabilityIssuer?: CapabilityTokenIssuer,
): Promise<StepExecutor> {
  // Explicit executor manifest — validated at startup. No runtime guessing.
  const manifest = createExecutorManifest({
    agent: () => createAgentStepExecutor({ effectBroker, capabilityIssuer }),
    tool: () => new ToolStepExecutor(undefined, effectBroker, capabilityIssuer),
    evaluator: () => new EvaluatorStepExecutor(),
    connector: async () => {
      const { ConnectorStepExecutor } = await import('./connectorStepExecutor.js');
      return new ConnectorStepExecutor(undefined, effectBroker, capabilityIssuer);
    },
  });

  manifest.validate(capabilities);

  const requiredCapabilities = capabilities.includes('*')
    ? Array.from(manifest.entries.keys())
    : capabilities;
  const executors: Record<string, StepExecutor> = {};
  for (const cap of requiredCapabilities) {
    const entry = manifest.entries.get(cap);
    if (!entry) {
      throw new Error(`No executor manifest entry for capability '${cap}'`);
    }
    executors[cap] = await entry.factory();
  }

  // If multiple executors, use composite
  const executorList = Object.entries(executors);
  if (executorList.length > 1) {
    return new CompositeStepExecutor(new Map(executorList));
  }

  // Single executor — return directly
  const single = executorList[0]?.[1];
  if (!single) {
    throw new Error(
      `No executor available for worker kind '${kind}' with capabilities [${capabilities.join(', ')}]`,
    );
  }
  return single;
}
