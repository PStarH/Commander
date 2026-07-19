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
import { createDefaultWorkerToolEffectCatalog } from './toolEffectCatalog.js';
import { EvaluatorStepExecutor } from './evaluatorStepExecutor.js';
import { CompositeStepExecutor } from './compositeStepExecutor.js';
import { createAgentStepExecutor, createExecutorManifest } from './workerRuntimeAdapter.js';
import { createProductionWorkerSandboxReadiness } from './sandboxReadiness.js';
import type { WorkerDefinition, WorkerIdentity, WorkerKind, StepExecutor } from './types.js';
import type { EffectExecutor, PolicyEvaluator, AuditSink, EffectKernelPort } from '@commander/effect-broker';
import {
  EffectBroker,
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  canonicalRequestHash,
} from '@commander/effect-broker';
import type { KernelInteraction, KernelRun, KernelStep } from '@commander/kernel';
import { InMemoryTicketAdapter } from './ticketAdapter.js';

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
  const { broker: effectBroker, issuer: capabilityIssuer } = createEffectBroker(kernel, workerId);

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
      // Generation is only known after registry.register — bind into broker affinity.
      onRegistered: (worker) => effectBroker.bindLocalWorkerGeneration(worker.generation),
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
interface ActionGatewayPolicyKernel {
  getRun(runId: string, tenantId: string): Promise<KernelRun | null>;
  getStep(stepId: string, tenantId: string): Promise<KernelStep | null>;
  listInteractions(runId: string, tenantId: string): Promise<KernelInteraction[]>;
  findMatchingKillSwitch(
    tenantId: string,
    dims: {
      package?: string;
      model?: string;
      tool?: string;
      destination?: string;
      effectType?: string;
    },
  ): Promise<{ scope: string; value: string; enabled: boolean } | null>;
}

function isActionGatewayPolicyKernel(value: unknown): value is ActionGatewayPolicyKernel {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActionGatewayPolicyKernel>;
  return (
    typeof candidate.getRun === 'function' &&
    typeof candidate.getStep === 'function' &&
    typeof candidate.listInteractions === 'function' &&
    typeof candidate.findMatchingKillSwitch === 'function'
  );
}

function denyActionGateway(reason: string) {
  return {
    effect: 'deny' as const,
    decisionId: 'action-gateway-deny-default',
    reason,
    policySnapshotId: 'action-gateway-mvp-v1',
  };
}

export function createWorkerPolicyEvaluator(
  kernelOrEnv: ActionGatewayPolicyKernel | NodeJS.ProcessEnv = process.env,
): PolicyEvaluator {
  const kernel = isActionGatewayPolicyKernel(kernelOrEnv) ? kernelOrEnv : null;
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
      if (!kernel) {
        return {
          effect: 'deny' as const,
          decisionId: 'deny-default',
          reason:
            `Default worker policy denies external effects (type=${input.type}). ` +
            'A kernel-backed Action Gateway policy evaluator is required.',
          policySnapshotId: 'worker-llm-v1',
        };
      }
      try {
        const [run, step] = await Promise.all([
          kernel.getRun(input.runId, input.tenantId),
          kernel.getStep(input.stepId, input.tenantId),
        ]);
        if (!run || !step || step.runId !== run.id || step.tenantId !== run.tenantId) {
          return denyActionGateway('ACTION_GATEWAY_RUN_NOT_FOUND');
        }
        const value = run.metadata.actionGateway;
        if (!value || typeof value !== 'object') {
          return denyActionGateway('ACTION_GATEWAY_METADATA_REQUIRED');
        }
        const metadata = value as Record<string, unknown>;
        const envelope = metadata.envelope;
        const decision = metadata.decision;
        const simulation = metadata.simulation;
        if (
          metadata.authority !== 'commander.action-gateway/v1' ||
          metadata.stepId !== step.id ||
          typeof metadata.effectId !== 'string' ||
          typeof metadata.actionDigest !== 'string' ||
          typeof metadata.policySnapshotId !== 'string' ||
          !envelope ||
          typeof envelope !== 'object' ||
          !decision ||
          typeof decision !== 'object'
        ) {
          return denyActionGateway('ACTION_GATEWAY_METADATA_INVALID');
        }
        const actionEnvelope = envelope as Record<string, unknown>;
        const actionDecision = decision as Record<string, unknown>;
        if (!simulation || typeof simulation !== 'object') {
          return denyActionGateway('SIMULATION_MISMATCH');
        }
        try {
          const killSwitch = await kernel.findMatchingKillSwitch(input.tenantId, {
            package: typeof actionEnvelope.package === 'string' ? actionEnvelope.package : undefined,
            model: typeof actionEnvelope.model === 'string' ? actionEnvelope.model : undefined,
            tool: typeof actionEnvelope.tool === 'string' ? actionEnvelope.tool : undefined,
            destination:
              typeof actionEnvelope.destination === 'string' ? actionEnvelope.destination : undefined,
            effectType:
              typeof actionEnvelope.effectType === 'string' ? actionEnvelope.effectType : undefined,
          });
          if (killSwitch) {
            return denyActionGateway('KILL_SWITCH_ACTIVE');
          }
        } catch {
          return denyActionGateway('KILL_SWITCH_LOOKUP_FAILED');
        }
        const actionSimulation = simulation as Record<string, unknown>;
        if (
          typeof actionSimulation.simulationId !== 'string' ||
          actionSimulation.actionDigest !== metadata.actionDigest ||
          actionSimulation.effect !== actionDecision.effect ||
          actionSimulation.decisionId !== actionDecision.decisionId ||
          actionSimulation.reason !== actionDecision.reason ||
          actionSimulation.policySnapshotId !== metadata.policySnapshotId
        ) {
          return denyActionGateway('SIMULATION_MISMATCH');
        }
        const persistedStepEnvelope = step.input.actionEnvelope;
        const actionArgs = actionEnvelope.args;
        const stepArgs = step.input.args;
        const requestArgs = input.request.args;
        if (
          actionEnvelope.tenantId !== input.tenantId ||
          actionEnvelope.effectType !== input.type ||
          step.input.effectType !== input.type ||
          metadata.effectId !== step.input.effectId ||
          !persistedStepEnvelope ||
          typeof persistedStepEnvelope !== 'object' ||
          !actionArgs ||
          typeof actionArgs !== 'object' ||
          !stepArgs ||
          typeof stepArgs !== 'object' ||
          !requestArgs ||
          typeof requestArgs !== 'object'
        ) {
          return denyActionGateway('ACTION_GATEWAY_BINDING_MISMATCH');
        }
        const digest = canonicalRequestHash(actionEnvelope);
        if (
          digest !== metadata.actionDigest ||
          canonicalRequestHash(persistedStepEnvelope as Record<string, unknown>) !== digest ||
          canonicalRequestHash(input.request) !== digest ||
          canonicalRequestHash(stepArgs as Record<string, unknown>) !==
            canonicalRequestHash(actionArgs as Record<string, unknown>) ||
          canonicalRequestHash(requestArgs as Record<string, unknown>) !==
            canonicalRequestHash(actionArgs as Record<string, unknown>)
        ) {
          return denyActionGateway('ACTION_DIGEST_MISMATCH');
        }
        if (
          run.policySnapshotId !== metadata.policySnapshotId ||
          actionDecision.policySnapshotId !== metadata.policySnapshotId ||
          typeof actionDecision.reason !== 'string'
        ) {
          return denyActionGateway('POLICY_SNAPSHOT_DRIFT');
        }
        if (actionDecision.effect === 'allow') {
          if (actionDecision.decisionId !== 'action-gateway-allow') {
            return denyActionGateway('ACTION_GATEWAY_DECISION_INVALID');
          }
          return {
            effect: 'allow' as const,
            decisionId: actionDecision.decisionId,
            reason: actionDecision.reason,
            policySnapshotId: String(metadata.policySnapshotId),
          };
        }
        if (actionDecision.effect !== 'require_approval') {
          return denyActionGateway('ACTION_GATEWAY_POLICY_DENIED');
        }
        if (
          actionDecision.decisionId !== 'action-gateway-require_approval' ||
          typeof metadata.interactionId !== 'string'
        ) {
          return denyActionGateway('ACTION_GATEWAY_APPROVAL_MISSING');
        }
        const interactions = await kernel.listInteractions(run.id, run.tenantId);
        const approval = interactions.find(
          (interaction) =>
            interaction.id === metadata.interactionId &&
            interaction.stepId === step.id &&
            interaction.status === 'answered',
        );
        if (approval?.response?.approved !== true) {
          return denyActionGateway('ACTION_GATEWAY_APPROVAL_REQUIRED');
        }
        if (
          approval.response.actionDigest !== metadata.actionDigest ||
          approval.response.simulationId !== actionSimulation.simulationId ||
          approval.response.policySnapshotId !== metadata.policySnapshotId ||
          typeof approval.response.reviewer !== 'string' ||
          approval.response.reviewer.length === 0 ||
          approval.response.runId !== run.id ||
          approval.response.tenantId !== run.tenantId
        ) {
          return denyActionGateway('APPROVAL_BINDING_MISMATCH');
        }
        return {
          effect: 'allow' as const,
          decisionId: 'action-gateway-allow-after-approval',
          reason: 'A tenant/run/step-bound approval was recorded by the kernel.',
          policySnapshotId: String(metadata.policySnapshotId),
        };
      } catch {
        return denyActionGateway('ACTION_GATEWAY_POLICY_LOOKUP_FAILED');
      }
    },
  };
}

type AllowlistKernel = EffectKernelPort & {
  ensureAllowlistDefault?(tenantId: string, actionPattern: string, allowed: boolean): Promise<void>;
} & ActionGatewayPolicyKernel;

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
      if (action === 'demo.ticket.create' && kernel.ensureAllowlistDefault) {
        await kernel.ensureAllowlistDefault(tenantId, 'demo.ticket.create', true);
      }
      if (action === 'compensate.demo.ticket.create' && kernel.ensureAllowlistDefault) {
        await kernel.ensureAllowlistDefault(tenantId, 'compensate.demo.ticket.create', true);
      }
      if (!kernel.isActionAllowed) {
        return (
          action.startsWith('llm.') ||
          action === 'demo.ticket.create' ||
          action === 'compensate.demo.ticket.create'
        );
      }
      return kernel.isActionAllowed(tenantId, action);
    },
  };
}

export function createWorkerEffectExecutor(
  tickets = new InMemoryTicketAdapter(),
): EffectExecutor {
  return {
    execute: async (input) => {
      if (input.type.startsWith('llm.')) {
        const ctx = input.executionContext;
        if (
          !ctx?.tenantId ||
          !ctx.workerId ||
          typeof ctx.fencingEpoch !== 'number' ||
          typeof ctx.leaseToken !== 'string' ||
          !ctx.leaseToken
        ) {
          throw new Error(
            'EFFECT_AUTHORIZATION_REQUIRED: llm.* execute requires executionContext tenantId, workerId, fencingEpoch, leaseToken from grant lease',
          );
        }
        const { dispatchLlmEffect } = await import('./llmBrokerBridge.js');
        return dispatchLlmEffect({
          type: input.type,
          request: input.request,
          signal: input.signal,
          tenantId: ctx.tenantId,
          workerId: ctx.workerId,
          fencingEpoch: ctx.fencingEpoch,
          leaseToken: ctx.leaseToken,
        });
      }
      if (input.type === 'demo.ticket.create') {
        const ctx = input.executionContext;
        const args = input.request.args;
        if (
          !ctx?.tenantId ||
          !args ||
          typeof args !== 'object' ||
          typeof (args as Record<string, unknown>).title !== 'string' ||
          typeof input.request.idempotencyKey !== 'string'
        ) {
          throw new Error('INVALID_DEMO_TICKET_ACTION');
        }
        const ticket = await tickets.create({
          tenantId: ctx.tenantId,
          idempotencyKey: input.request.idempotencyKey,
          title: (args as Record<string, unknown>).title as string,
        });
        return {
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
        };
      }
      if (input.type === 'compensate.demo.ticket.create') {
        const ctx = input.executionContext;
        const args = input.request.args;
        if (
          !ctx?.tenantId ||
          !args ||
          typeof args !== 'object' ||
          typeof (args as Record<string, unknown>).targetIdempotencyKey !== 'string'
        ) {
          throw new Error('INVALID_DEMO_TICKET_COMPENSATION');
        }
        const ticket = await tickets.compensate({
          tenantId: ctx.tenantId,
          idempotencyKey: (args as Record<string, unknown>).targetIdempotencyKey as string,
        });
        return {
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
        };
      }
      throw new Error(`UNREGISTERED_EFFECT_TYPE: ${input.type}`);
    },
  };
}

function createEffectBroker(
  kernel: AllowlistKernel,
  localWorkerId: string,
): {
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
  const policy = createWorkerPolicyEvaluator(kernel);
  const effectKernel = withDefaultLlmAllowlist(kernel);
  const executor = createWorkerEffectExecutor();

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
    localWorkerId,
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
  const toolEffectCatalog = createDefaultWorkerToolEffectCatalog();

  // Explicit executor manifest — validated at startup. No runtime guessing.
  const manifest = createExecutorManifest({
    agent: () => createAgentStepExecutor({ effectBroker, capabilityIssuer }),
    tool: () => new ToolStepExecutor(undefined, effectBroker, capabilityIssuer, toolEffectCatalog),
    evaluator: () => new EvaluatorStepExecutor(),
    connector: async () => {
      const { ConnectorStepExecutor } = await import('./connectorStepExecutor.js');
      return new ConnectorStepExecutor(undefined, effectBroker, capabilityIssuer, toolEffectCatalog);
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
