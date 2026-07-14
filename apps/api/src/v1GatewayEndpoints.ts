import { createHash } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  GatewayIdempotencyConflictError,
  GatewayStepIdConflictError,
  type KernelRun,
  type V1KernelGateway,
} from './v1GatewayKernel';
import { isTerminalRunState } from '@commander/contracts';

const idSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);
const providerSnapshotSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
});

const agentStepSchema = z.object({
  id: idSchema.optional(),
  kind: z.literal('agent'),
  input: z.object({
    goal: z.string().min(1).max(20_000),
    agentId: z.string().min(1).max(128),
    definitionVersion: z.string().min(1).max(64),
    providerSnapshot: providerSnapshotSchema,
    projectId: z.string().max(128).optional(),
    provider: z.string().max(64).optional(),
    maxSteps: z.number().int().min(1).max(10_000).optional(),
    tokenBudget: z.number().int().min(1).optional(),
    tools: z.array(z.string().max(128)).max(1_000).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  dependencies: z.array(idSchema).max(100).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

const toolStepSchema = z.object({
  id: idSchema.optional(),
  kind: z.literal('tool'),
  input: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(idSchema).max(100).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

const evaluatorStepSchema = z.object({
  id: idSchema.optional(),
  kind: z.literal('evaluator'),
  input: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(idSchema).max(100).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

const connectorStepSchema = z.object({
  id: idSchema.optional(),
  kind: z.literal('connector'),
  input: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(idSchema).max(100).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

const knownStepKinds = new Set(['agent', 'tool', 'evaluator', 'connector']);
const genericStepSchema = z
  .object({
    id: idSchema.optional(),
    kind: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
    input: z.record(z.string(), z.unknown()).optional(),
    dependencies: z.array(idSchema).max(100).optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    maxAttempts: z.number().int().min(1).max(20).optional(),
  })
  .refine((step) => !knownStepKinds.has(step.kind), {
    message: 'Known step kinds must use their specific schema',
    path: ['kind'],
  });

const stepSchema = z.union([
  agentStepSchema,
  toolStepSchema,
  evaluatorStepSchema,
  connectorStepSchema,
  genericStepSchema,
]);
const createRunSchema = z.object({
  goal: z.string().min(1).max(20_000),
  steps: z.array(stepSchema).min(1).max(100).optional(),
  workGraphVersion: z.string().min(1).max(64).default('v1'),
  policySnapshotId: z.string().min(1).max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function requiredTenant(req: Request, res: Response): string | null {
  // Tenant identity is resolved authoritatively by tenantContextMiddleware from
  // the authenticated principal (and stored on req.tenantId). Never re-read
  // X-Tenant-ID here — a client header must not be able to select a tenant
  // (AUTH-2 / B4). The operator-set single-tenant default remains allowed.
  const tenantId = req.tenantId ?? process.env.COMMANDER_DEFAULT_TENANT_ID;
  if (!tenantId) {
    res.status(401).json({
      error: {
        code: 'TENANT_IDENTITY_REQUIRED',
        message: 'A tenant-bound identity is required for V1 resources.',
      },
    });
    return null;
  }
  return tenantId;
}
function idempotencyKey(req: Request, res: Response): string | null {
  const value = req.header('Idempotency-Key');
  if (!value || !/^[A-Za-z0-9._:-]{8,256}$/.test(value)) {
    res.status(400).json({
      error: {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key must be 8-256 URL-safe characters.',
      },
    });
    return null;
  }
  return value;
}
function actor(req: Request): string {
  return req.apiKeyId ?? req.user?.id ?? 'gateway.unknown';
}
function stepId(runScope: string, index: number): string {
  // Step ids must be unique per run: commander_steps.id is a global primary key,
  // so deriving from the goal alone collides across distinct runs that share a goal
  // string (an uncaught DUPLICATE_STEP → HTTP 500, and a cross-tenant DoS vector).
  // runScope binds the id to (tenant, idempotency key) — the same uniqueness basis
  // as the derived runId — so equal goals in different runs no longer collide.
  return `step_${createHash('sha256').update(`${runScope}:${index}`).digest('hex').slice(0, 24)}`;
}
function renderRun(run: {
  id: string;
  state: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  policySnapshotId: string;
}) {
  return {
    id: run.id,
    state: run.state,
    tenantId: run.tenantId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    intentHash: run.intentHash,
    workGraphHash: run.workGraphHash,
    workGraphVersion: run.workGraphVersion,
    policySnapshotId: run.policySnapshotId,
  };
}

/** V1 resource API. It schedules durable work; it never constructs AgentRuntime. */
export function createV1GatewayRouter(resolveKernel: () => V1KernelGateway | null): Router {
  const router = express.Router();
  router.post('/runs', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const key = idempotencyKey(req, res);
    if (!key) return;
    const parsed = createRunSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: { code: 'INVALID_REQUEST', details: parsed.error.issues } });
    const kernel = resolveKernel();
    if (!kernel)
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    const policySnapshotId =
      parsed.data.policySnapshotId ?? process.env.COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID;
    if (!policySnapshotId)
      return res.status(503).json({
        error: {
          code: 'POLICY_SNAPSHOT_UNAVAILABLE',
          message: 'No policy snapshot is configured for V1 run submission.',
        },
      });
    const defaultDefinitionVersion = process.env.COMMANDER_DEFAULT_AGENT_DEFINITION_VERSION ?? 'v1';
    const defaultProviderSnapshot = {
      provider: process.env.COMMANDER_DEFAULT_PROVIDER ?? 'openai',
      model: process.env.COMMANDER_DEFAULT_MODEL ?? 'gpt-4o',
    };
    const steps = (
      parsed.data.steps ?? [
        {
          kind: 'agent',
          input: {
            goal: parsed.data.goal,
            agentId: 'agent-default',
            definitionVersion: defaultDefinitionVersion,
            providerSnapshot: defaultProviderSnapshot,
          },
        },
      ]
    ).map((step, index) => ({ ...step, id: step.id ?? stepId(`${tenantId}:${key}`, index) }));
    try {
      const result = await kernel.submit({
        tenantId,
        idempotencyKey: key,
        goal: parsed.data.goal,
        steps,
        workGraphVersion: parsed.data.workGraphVersion,
        policySnapshotId,
        metadata: parsed.data.metadata,
        actor: actor(req),
      });
      res
        .status(result.created ? 202 : 200)
        .location(`/v1/runs/${result.run.id}`)
        .json({ run: renderRun(result.run), idempotentReplay: !result.created });
    } catch (error) {
      if (error instanceof GatewayIdempotencyConflictError)
        return res
          .status(409)
          .json({ error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: error.message } });
      if (error instanceof GatewayStepIdConflictError)
        return res
          .status(409)
          .json({ error: { code: 'STEP_ID_CONFLICT', message: error.message } });
      throw error;
    }
  });
  router.get('/runs/:runId', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const kernel = resolveKernel();
    if (!kernel)
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    const run = await kernel.getRun(req.params.runId, tenantId);
    if (!run)
      return res
        .status(404)
        .json({ error: { code: 'RUN_NOT_FOUND', message: 'Run was not found.' } });
    res.json({ run: renderRun(run) });
  });
  router.get('/runs/:runId/events', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const kernel = resolveKernel();
    if (!kernel)
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    const events = await kernel.listEvents(req.params.runId, tenantId);
    res.json({ events });
  });

  // ── Lightweight status probe for benchmarks / workers ────────────────────
  router.get('/runs/:runId/status', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const kernel = resolveKernel();
    if (!kernel)
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    const run = await kernel.getRun(req.params.runId, tenantId);
    if (!run)
      return res
        .status(404)
        .json({ error: { code: 'RUN_NOT_FOUND', message: 'Run was not found.' } });
    res.json({
      runId: run.id,
      state: run.state,
      tenantId: run.tenantId,
      terminal: isTerminalRunState(run.state),
    });
  });

  // ── Run lifecycle control (pause/resume/cancel) ──────────────────────────
  // These routes transition durable run state in the shared kernel. The
  // repository returns null for both "not found" and "invalid transition", so
  // we disambiguate with a follow-up getRun: 404 when missing, 409 when the
  // current state forbids the requested transition.
  const lifecycleRoute = (
    verb: 'pause' | 'resume' | 'cancel',
    pastTense: string,
    transition: (
      kernel: V1KernelGateway,
      runId: string,
      tenantId: string,
      actor: string,
    ) => Promise<KernelRun | null>,
  ): void => {
    router.post(`/runs/:runId/${verb}`, async (req, res) => {
      const tenantId = requiredTenant(req, res);
      if (!tenantId) return;
      const kernel = resolveKernel();
      if (!kernel)
        return res.status(503).json({
          error: {
            code: 'KERNEL_UNAVAILABLE',
            message: 'Shared execution kernel is not configured.',
          },
        });
      const run = await transition(kernel, req.params.runId, tenantId, actor(req));
      if (!run) {
        const existing = await kernel.getRun(req.params.runId, tenantId);
        if (!existing)
          return res
            .status(404)
            .json({ error: { code: 'RUN_NOT_FOUND', message: 'Run was not found.' } });
        return res.status(409).json({
          error: {
            code: 'INVALID_STATE_TRANSITION',
            message: `Run is in state '${existing.state}' and cannot be ${pastTense}.`,
          },
        });
      }
      res.json({ run: renderRun(run) });
    });
  };
  lifecycleRoute('pause', 'paused', (kernel, runId, tenantId, actor) =>
    kernel.pauseRun(runId, tenantId, actor),
  );
  lifecycleRoute('resume', 'resumed', (kernel, runId, tenantId, actor) =>
    kernel.resumeRun(runId, tenantId, actor),
  );
  lifecycleRoute('cancel', 'cancelled', (kernel, runId, tenantId, actor) =>
    kernel.cancelRun(runId, tenantId, actor),
  );

  return router;
}
