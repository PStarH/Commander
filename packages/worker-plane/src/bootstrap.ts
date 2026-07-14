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
 * - COMMANDER_EFFECT_BROKER_SEED: Seed for capability token signing (default: random)
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
import type { WorkerDefinition, WorkerIdentity, WorkerKind, StepExecutor } from './types.js';
import type { EffectExecutor, PolicyEvaluator, AuditSink, EffectKernelPort } from '@commander/effect-broker';
import { EffectBroker, CapabilityTokenService } from '@commander/effect-broker';

// Lazy import to avoid circular dependency at module load time
/* eslint-disable @typescript-eslint/no-explicit-any */
type Pool = { connect(): Promise<any>; end(): Promise<void> };

export async function createWorkerService(): Promise<WorkerService> {
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
  const capabilities = (process.env.COMMANDER_WORKER_CAPABILITIES ?? 'agent').split(',').map((s) => s.trim());
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
  const { Pool: PgPool } = await import('pg') as unknown as {
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
  const effectBroker = createEffectBroker(kernel);

  // ── Create step executor based on worker kind ──
  const executor = await createExecutorForKind(workerKind, capabilities, effectBroker);

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
    },
  );

  return service;
}

function createEffectBroker(kernel: EffectKernelPort): EffectBroker {
  const seed = process.env.COMMANDER_EFFECT_BROKER_SEED ?? randomUUID().replace(/-/g, '');
  const tokens = new CapabilityTokenService(seed);

  // Default permissive policy: production deployments should replace this with
  // a real policy service that evaluates tenant/risk/context rules.
  const policy: PolicyEvaluator = {
    evaluate: async () => ({
      effect: 'allow' as const,
      decisionId: 'permit-default',
      reason: 'Default worker policy allows all effects',
      policySnapshotId: 'worker-default',
    }),
  };

  // Minimal executor: logs the effect and returns a marker. Operators can
  // replace this with a real connector (HTTP, DB, queue, etc.) dispatcher.
  const executor: EffectExecutor = {
    execute: async (input: { type: string; request: Record<string, unknown>; signal: AbortSignal }) => {
      // eslint-disable-next-line no-console
      console.warn(`[effect-broker] Executing effect type=${input.type}`, input.request);
      return { executed: true, type: input.type };
    },
  };

  // Console audit sink. Production should forward to a durable audit store.
  const audit: AuditSink = {
    append: async (event: { type: string; severity: 'low' | 'medium' | 'high' | 'critical'; tenantId: string; runId: string; stepId: string; at: string; details: Record<string, unknown> }) => {
      // eslint-disable-next-line no-console
      console.log(`[effect-audit] ${event.type} ${event.severity}`, event.details);
    },
  };

  return new EffectBroker(tokens, policy, kernel, executor, audit, {
    audience: 'commander.effect-broker',
    requireRequestBinding: false,
  });
}

/**
 * Create the appropriate step executor(s) based on worker kind.
 * A worker can handle multiple step kinds if configured with multiple capabilities.
 */
async function createExecutorForKind(
  kind: WorkerKind,
  capabilities: string[],
  effectBroker?: EffectBroker,
): Promise<StepExecutor> {
  // Explicit executor manifest — validated at startup. No runtime guessing.
  const manifest = createExecutorManifest({
    agent: () => createAgentStepExecutor(),
    tool: () => new ToolStepExecutor(undefined, effectBroker),
    evaluator: () => new EvaluatorStepExecutor(),
    connector: async () => {
      const { ConnectorStepExecutor } = await import('./connectorStepExecutor.js');
      return new ConnectorStepExecutor(undefined, effectBroker);
    },
  });

  manifest.validate(capabilities);

  const requiredCapabilities = capabilities.includes('*') ? Array.from(manifest.entries.keys()) : capabilities;
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
    throw new Error(`No executor available for worker kind '${kind}' with capabilities [${capabilities.join(', ')}]`);
  }
  return single;
}
