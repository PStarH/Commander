import express, { type Request, type Response, type Router } from 'express';
import {
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  isClassAEffectType,
  type ActionStateV1,
} from '@commander/contracts';
import { z } from 'zod';
import {
  assertTerminalEvidence,
  canonicalEvidenceBody,
  verifyEvidenceBundle,
  verifyEvidenceSignature,
  type EvidenceJwks,
} from '@commander/effect-broker';
import {
  GatewayIdempotencyConflictError,
  GatewayStepIdConflictError,
  canonicalPrincipalDigest,
  canonicalValueHash,
  deriveGatewayRunId,
  type KernelRun,
  type V1KernelGateway,
} from './v1GatewayKernel';
import type { KillSwitchMatchDims } from './v1GatewayKernel';

const ACTION_GATEWAY_AUTHORITY = 'commander.action-gateway/v1';
const ACTION_POLICY_SNAPSHOT = 'action-gateway-mvp-v1';

function configuredEvidenceJwks(): EvidenceJwks | null {
  const raw = process.env.COMMANDER_EVIDENCE_JWKS_JSON?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as { keys?: unknown }).keys)
    ) {
      return null;
    }
    return parsed as EvidenceJwks;
  } catch {
    return null;
  }
}

const actionInputSchema = z
  .object({
    source: z.string().min(1).max(128),
    package: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    tool: z.string().min(1).max(128),
    destination: z.string().min(1).max(512),
    effectType: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
    args: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,256}$/),
  })
  .strict();

const compensationInputSchema = z
  .object({
    originalEffectId: z.string().min(1).max(256),
    adapterVersion: z.string().min(1).max(256),
    compensationEffectType: z.string().regex(/^compensate\.[a-zA-Z0-9._:-]{1,117}$/),
    compensationPatch: z.record(z.string(), z.unknown()),
    forwardReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const compensationApprovalSchema = z
  .object({
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policySnapshotId: z.string().min(1).max(256),
  })
  .strict();

const approvalSchema = z
  .object({
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    simulationId: z.string().min(1).max(256),
    policySnapshotId: z.string().min(1).max(256),
  })
  .strict();

const rejectionSchema = z
  .object({
    reason: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const killSwitchScopeSchema = z.enum([
  'tenant',
  'package',
  'model',
  'tool',
  'destination',
  'effect-type',
]);

const killSwitchBodySchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export interface ActionEnvelope {
  tenantId: string;
  source: string;
  package: string;
  model: string;
  tool: string;
  destination: string;
  effectType: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ActionDecision {
  effect: 'allow' | 'deny' | 'require_approval';
  decisionId: string;
  reason: string;
  policySnapshotId: string;
}

export interface ActionSimulation extends ActionDecision {
  simulationId: string;
  actionDigest: string;
}

type GatewayStep = NonNullable<Awaited<ReturnType<V1KernelGateway['getStep']>>>;
type GatewayEffect = NonNullable<Awaited<ReturnType<V1KernelGateway['getEffect']>>>;

export function projectCanonicalActionState(input: {
  decisionEffect: ActionDecision['effect'];
  approval?: boolean;
  runState: KernelRun['state'];
  stepState?: GatewayStep['state'];
  effectState?: GatewayEffect['state'];
  reconcileEscalatedAt?: GatewayEffect['reconcileEscalatedAt'];
  reconcileDisposition?: GatewayEffect['reconcileDisposition'];
}): ActionStateV1 {
  if (input.decisionEffect === 'deny' || input.approval === false) return 'FAILED';
  if (input.decisionEffect === 'require_approval' && input.approval !== true) {
    return 'AWAITING_APPROVAL';
  }

  if (input.reconcileEscalatedAt || input.reconcileDisposition === 'ESCALATED') {
    return 'ESCALATED';
  }
  if (
    input.effectState === 'COMPLETION_UNKNOWN' ||
    input.stepState === 'WAITING_FOR_RECONCILIATION'
  ) {
    return 'COMPLETION_UNKNOWN';
  }

  if (input.runState === 'SUCCEEDED' || input.runState === 'COMPENSATED') return 'SUCCEEDED';
  if (input.runState === 'FAILED' || input.runState === 'CANCELLED') return 'FAILED';

  if (input.stepState === 'SUCCEEDED') return 'SUCCEEDED';
  if (
    input.stepState === 'FAILED' ||
    input.stepState === 'CANCELLED' ||
    input.stepState === 'SKIPPED'
  ) {
    return 'FAILED';
  }

  if (input.effectState === 'COMPLETED') return 'SUCCEEDED';
  if (input.effectState === 'FAILED' || input.effectState === 'CONFIRMED_NOT_APPLIED') {
    return 'FAILED';
  }

  if (
    input.runState === 'RUNNING' ||
    input.runState === 'COMPENSATING' ||
    input.stepState === 'RUNNING'
  ) {
    return 'RUNNING';
  }
  return 'ADMITTED';
}

interface ActionGatewayMetadata {
  authority: typeof ACTION_GATEWAY_AUTHORITY;
  stepId: string;
  effectId: string;
  interactionId?: string;
  actionDigest: string;
  policySnapshotId: string;
  decision: ActionDecision;
  simulation: ActionSimulation;
  envelope: ActionEnvelope;
}

function requiredTenant(req: Request, res: Response): string | null {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'An authenticated principal is required.',
      },
    });
    return null;
  }
  if (!req.tenantId) {
    res.status(401).json({
      error: {
        code: 'TENANT_IDENTITY_REQUIRED',
        message: 'A tenant-bound authenticated principal is required.',
      },
    });
    return null;
  }
  return req.tenantId;
}

function requiredIdempotencyKey(req: Request, res: Response): string | null {
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

function assertBodyIdempotencyKey(
  bodyKey: string | undefined,
  headerKey: string,
  res: Response,
): boolean {
  if (bodyKey !== undefined && bodyKey !== headerKey) {
    res.status(409).json({
      error: {
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'Idempotency-Key header does not match the request binding.',
      },
    });
    return false;
  }
  return true;
}

function requiredApprover(req: Request, res: Response): string | null {
  const principalId = req.user?.id ?? req.apiKeyId;
  if (!principalId) {
    res.status(401).json({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'An authenticated principal is required.',
      },
    });
    return null;
  }
  const isAdminUser = req.user?.role === 'admin' || req.user?.role === 'super_admin';
  const apiScopes = req.apiKeyId ? (req.apiScopes ?? []) : [];
  const hasApiApprovalScope =
    apiScopes.includes('actions:approve') || apiScopes.includes('admin') || apiScopes.includes('*');
  if (!isAdminUser && !hasApiApprovalScope) {
    res.status(403).json({
      error: {
        code: 'ACTION_APPROVAL_FORBIDDEN',
        message: 'Admin role or actions:approve API key scope is required.',
      },
    });
    return null;
  }
  return principalId;
}

function requiredReconcileAuthority(req: Request, res: Response): string | null {
  const principalId = req.user?.id ?? req.apiKeyId;
  if (!principalId) {
    res.status(401).json({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'An authenticated principal is required.',
      },
    });
    return null;
  }
  const isAdminUser = req.user?.role === 'admin' || req.user?.role === 'super_admin';
  const apiScopes = req.apiKeyId ? (req.apiScopes ?? []) : [];
  const hasScope =
    apiScopes.includes('actions:reconcile') ||
    apiScopes.includes('admin') ||
    apiScopes.includes('*');
  if (!isAdminUser && !hasScope) {
    res.status(403).json({
      error: {
        code: 'ACTION_RECONCILE_FORBIDDEN',
        message: 'Admin role or actions:reconcile API key scope is required.',
      },
    });
    return null;
  }
  return principalId;
}

function requiredKillSwitchManager(req: Request, res: Response): string | null {
  const principalId = req.user?.id ?? req.apiKeyId;
  if (!principalId) {
    res.status(401).json({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'An authenticated principal is required.',
      },
    });
    return null;
  }
  const isAdminUser = req.user?.role === 'admin' || req.user?.role === 'super_admin';
  const apiScopes = req.apiKeyId ? (req.apiScopes ?? []) : [];
  const hasKillScope =
    apiScopes.includes('actions:kill') || apiScopes.includes('admin') || apiScopes.includes('*');
  if (!isAdminUser && !hasKillScope) {
    res.status(403).json({
      error: {
        code: 'KILL_SWITCH_FORBIDDEN',
        message: 'Admin role or actions:kill API key scope is required.',
      },
    });
    return null;
  }
  return principalId;
}

function killSwitchDims(envelope: ActionEnvelope): KillSwitchMatchDims {
  return {
    package: envelope.package,
    model: envelope.model,
    tool: envelope.tool,
    destination: envelope.destination,
    effectType: envelope.effectType,
  };
}

async function rejectIfKillSwitchActive(
  kernel: V1KernelGateway,
  envelope: ActionEnvelope,
  res: Response,
): Promise<boolean> {
  try {
    const match = await kernel.findMatchingKillSwitch(envelope.tenantId, killSwitchDims(envelope));
    if (!match) return false;
    res.status(403).json({
      error: {
        code: 'KILL_SWITCH_ACTIVE',
        message: `Kill switch active for ${match.scope}=${match.value}.`,
        details: { scope: match.scope, value: match.value },
      },
    });
    return true;
  } catch {
    res.status(503).json({
      error: {
        code: 'KILL_SWITCH_LOOKUP_FAILED',
        message: 'Kill switch lookup failed.',
      },
    });
    return true;
  }
}

function actor(req: Request): string {
  return req.apiKeyId ?? req.user?.id ?? 'action-gateway.unknown';
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${canonicalValueHash(value).slice(0, 32)}`;
}

function evaluateAction(envelope: ActionEnvelope): ActionDecision {
  const manifest = findAdapterManifest({
    effectType: envelope.effectType,
    toolName: envelope.tool,
    destination: envelope.destination,
  });
  if (manifest) {
    const effect = evaluateManifestGatewayEffect(manifest, envelope.destination);
    return {
      effect,
      decisionId: `action-gateway-manifest-${effect}`,
      reason: `Registered adapter policy requires '${effect}' for this exact action.`,
      policySnapshotId: ACTION_POLICY_SNAPSHOT,
    };
  }
  const isCreate =
    envelope.effectType === 'demo.ticket.create' && envelope.tool === 'ticket.create';
  const isCompensation =
    envelope.effectType === 'compensate.demo.ticket.create' &&
    envelope.tool === 'ticket.compensate';
  if (!isCreate && !isCompensation) {
    return {
      effect: 'deny',
      decisionId: 'action-gateway-deny',
      reason: `Effect type '${envelope.effectType}' is not registered by the Action Gateway.`,
      policySnapshotId: ACTION_POLICY_SNAPSHOT,
    };
  }
  if (envelope.destination === 'demo://tickets') {
    return {
      effect: 'allow',
      decisionId: 'action-gateway-allow',
      reason: 'The registered demo ticket destination is allowed.',
      policySnapshotId: ACTION_POLICY_SNAPSHOT,
    };
  }
  if (envelope.destination === 'demo://tickets/approval') {
    return {
      effect: 'require_approval',
      decisionId: 'action-gateway-require_approval',
      reason: 'The approval demo destination requires a human decision.',
      policySnapshotId: ACTION_POLICY_SNAPSHOT,
    };
  }
  return {
    effect: 'deny',
    decisionId: 'action-gateway-deny',
    reason: `Destination '${envelope.destination}' is not registered by the Action Gateway.`,
    policySnapshotId: ACTION_POLICY_SNAPSHOT,
  };
}

function buildSimulation(envelope: ActionEnvelope): ActionSimulation {
  const actionDigest = canonicalValueHash(envelope);
  return {
    ...evaluateAction(envelope),
    simulationId: deriveGatewayRunId(envelope.tenantId, `simulation:${actionDigest}`),
    actionDigest,
  };
}

async function persistSimulation(
  kernel: V1KernelGateway,
  envelope: ActionEnvelope,
  simulation: ActionSimulation,
  requestedBy: string,
): Promise<void> {
  // Zero-step audit run: durable simulation record, never claimable work.
  // Immediately cancel so authority does not leave a permanent PENDING run.
  const result = await kernel.submit({
    tenantId: envelope.tenantId,
    idempotencyKey: `simulation:${simulation.actionDigest}`,
    goal: `Simulate ${envelope.effectType} via ${envelope.tool}`,
    steps: [],
    workGraphVersion: 'action-gateway-simulation/v1',
    policySnapshotId: simulation.policySnapshotId,
    metadata: { actionGatewaySimulation: simulation },
    actor: requestedBy,
  });
  if (result.run.state === 'PENDING') {
    await kernel.cancelRun(result.run.id, envelope.tenantId, requestedBy);
  }
}

function parseActionMetadata(run: KernelRun): ActionGatewayMetadata | null {
  const value = run.metadata.actionGateway;
  if (!value || typeof value !== 'object') return null;
  const metadata = value as Partial<ActionGatewayMetadata>;
  if (
    metadata.authority !== ACTION_GATEWAY_AUTHORITY ||
    typeof metadata.stepId !== 'string' ||
    typeof metadata.effectId !== 'string' ||
    typeof metadata.actionDigest !== 'string' ||
    typeof metadata.policySnapshotId !== 'string' ||
    !metadata.decision ||
    !metadata.simulation ||
    !metadata.envelope
  ) {
    return null;
  }
  return metadata as ActionGatewayMetadata;
}

async function loadAction(
  kernel: V1KernelGateway,
  runId: string,
  tenantId: string,
): Promise<{ run: KernelRun; metadata: ActionGatewayMetadata } | null> {
  const run = await kernel.getRun(runId, tenantId);
  if (!run) return null;
  const metadata = parseActionMetadata(run);
  return metadata ? { run, metadata } : null;
}

async function renderAction(
  kernel: V1KernelGateway,
  run: KernelRun,
  metadata: ActionGatewayMetadata,
) {
  const [step, interactions, effects] = await Promise.all([
    kernel.getStep(metadata.stepId, run.tenantId),
    kernel.listInteractions(run.id, run.tenantId),
    kernel.listEffects(run.id, run.tenantId),
  ]);
  const interaction = metadata.interactionId
    ? interactions.find((item) => item.id === metadata.interactionId)
    : undefined;
  const effect = effects.find((item) => item.id === metadata.effectId);
  const approval = interaction?.response?.approved;
  const state = projectCanonicalActionState({
    decisionEffect: metadata.decision.effect,
    approval: typeof approval === 'boolean' ? approval : undefined,
    runState: run.state,
    stepState: step?.state,
    effectState: effect?.state,
    reconcileEscalatedAt: effect?.reconcileEscalatedAt,
    reconcileDisposition: effect?.reconcileDisposition,
  });
  return {
    runId: run.id,
    stepId: metadata.stepId,
    effectId: metadata.effectId,
    ...(effect?.state === 'COMPLETED' && effect.response
      ? { forwardReceiptHash: canonicalValueHash(effect.response) }
      : {}),
    state,
    decision: metadata.decision,
    simulation: metadata.simulation,
    actionDigest: metadata.actionDigest,
    policySnapshotId: metadata.policySnapshotId,
    createdAt: run.createdAt,
    updatedAt: step?.updatedAt ?? run.updatedAt,
  };
}

function invalidRequest(res: Response, error: z.ZodError) {
  return res.status(400).json({
    error: { code: 'INVALID_REQUEST', details: error.issues },
  });
}

function actionNotFound(res: Response) {
  return res.status(404).json({
    error: { code: 'ACTION_NOT_FOUND', message: 'Action was not found.' },
  });
}

export function createActionGatewayRouter(resolveKernel: () => V1KernelGateway | null): Router {
  const router = express.Router();

  router.use(async (req, res, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
    const tenantId = req.tenantId;
    const key = req.header('Idempotency-Key');
    if (
      !tenantId ||
      (!req.user && !req.apiKeyId) ||
      !key ||
      !/^[A-Za-z0-9._:-]{8,256}$/.test(key)
    ) {
      return next();
    }
    const kernel = resolveKernel();
    if (!kernel) return next();
    if (!kernel.beginActionRequest || !kernel.completeActionRequest) {
      return res.status(503).json({
        error: {
          code: 'ACTION_IDEMPOTENCY_UNAVAILABLE',
          message: 'Durable Action request binding is unavailable.',
        },
      });
    }
    const requestHash = canonicalValueHash({
      method: req.method,
      path: req.originalUrl.split('?')[0],
      body: req.body ?? null,
      actor: req.apiKeyId ? canonicalPrincipalDigest(req.apiKeyId) : req.user?.id,
    });
    let binding: Awaited<ReturnType<NonNullable<V1KernelGateway['beginActionRequest']>>>;
    try {
      binding = await kernel.beginActionRequest({
        tenantId,
        idempotencyKey: key,
        requestHash,
      });
    } catch {
      return res.status(503).json({
        error: {
          code: 'ACTION_IDEMPOTENCY_UNAVAILABLE',
          message: 'Durable Action request binding could not be verified.',
        },
      });
    }
    if (binding.state === 'CONFLICT') {
      return res.status(409).json({
        error: {
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'Idempotency-Key was already used with a different request.',
        },
      });
    }
    if (binding.state === 'IN_PROGRESS') {
      return res.status(409).json({
        error: {
          code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
          message: 'The original request has not reached a durable response.',
        },
      });
    }
    if (binding.state === 'REPLAY') {
      res.status(binding.responseStatus);
      if (binding.responseStatus === 204) return res.send();
      return res.json(binding.responseBody);
    }

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let completing = false;
    const complete = async (body: unknown): Promise<void> => {
      await kernel.completeActionRequest!({
        tenantId,
        idempotencyKey: key,
        requestHash,
        responseStatus: res.statusCode,
        responseBody: body ?? null,
      });
    };
    res.json = ((body: unknown) => {
      if (completing) return originalJson(body);
      completing = true;
      void complete(body)
        .then(() => originalJson(body))
        .catch(next);
      return res;
    }) as Response['json'];
    res.send = ((body?: unknown) => {
      if (completing) return originalSend(body);
      completing = true;
      void complete(body)
        .then(() => originalSend(body))
        .catch(next);
      return res;
    }) as Response['send'];
    return next();
  });

  router.get('/kill-switches', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const manager = requiredKillSwitchManager(req, res);
    if (!manager) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    try {
      const killSwitches = await kernel.listKillSwitches(tenantId);
      return res.json({ killSwitches });
    } catch {
      return res.status(503).json({
        error: { code: 'KILL_SWITCH_LOOKUP_FAILED', message: 'Kill switch lookup failed.' },
      });
    }
  });

  router.put('/kill-switches/:scope/:value', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    if (!requiredIdempotencyKey(req, res)) return;
    const manager = requiredKillSwitchManager(req, res);
    if (!manager) return;
    const scopeParsed = killSwitchScopeSchema.safeParse(req.params.scope);
    if (!scopeParsed.success) {
      return res.status(400).json({
        error: { code: 'INVALID_SCOPE', details: scopeParsed.error.issues },
      });
    }
    const bodyParsed = killSwitchBodySchema.safeParse(req.body);
    if (!bodyParsed.success) return invalidRequest(res, bodyParsed.error);
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const value = decodeURIComponent(req.params.value);
    if (scopeParsed.data === 'tenant' && value !== tenantId) {
      return res.status(400).json({
        error: {
          code: 'INVALID_TENANT_KILL_SWITCH',
          message: 'Tenant-scoped kill switches must use the authenticated tenant id as value.',
        },
      });
    }
    try {
      const killSwitch = await kernel.putKillSwitch({
        tenantId,
        scope: scopeParsed.data,
        value,
        enabled: bodyParsed.data.enabled,
        reason: bodyParsed.data.reason,
        actor: manager,
      });
      return res.json({ killSwitch });
    } catch {
      return res.status(503).json({
        error: { code: 'KILL_SWITCH_WRITE_FAILED', message: 'Kill switch update failed.' },
      });
    }
  });

  router.delete('/kill-switches/:scope/:value', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    if (!requiredIdempotencyKey(req, res)) return;
    const manager = requiredKillSwitchManager(req, res);
    if (!manager) return;
    const scopeParsed = killSwitchScopeSchema.safeParse(req.params.scope);
    if (!scopeParsed.success) {
      return res.status(400).json({
        error: { code: 'INVALID_SCOPE', details: scopeParsed.error.issues },
      });
    }
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    try {
      await kernel.removeKillSwitch({
        tenantId,
        scope: scopeParsed.data,
        value: decodeURIComponent(req.params.value),
      });
      return res.status(204).send();
    } catch {
      return res.status(503).json({
        error: { code: 'KILL_SWITCH_WRITE_FAILED', message: 'Kill switch delete failed.' },
      });
    }
  });

  router.post('/simulate', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const headerKey = requiredIdempotencyKey(req, res);
    if (!headerKey) return;
    const parsed = actionInputSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    if (!assertBodyIdempotencyKey(parsed.data.idempotencyKey, headerKey, res)) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const envelope: ActionEnvelope = { tenantId, ...parsed.data };
    if (await rejectIfKillSwitchActive(kernel, envelope, res)) return;
    const simulation = buildSimulation(envelope);
    await persistSimulation(kernel, envelope, simulation, actor(req));
    // Simulation is preview-only: always 200 with the decision (including deny).
    return res.json({ simulation });
  });

  router.post('/', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const headerKey = requiredIdempotencyKey(req, res);
    if (!headerKey) return;
    const parsed = actionInputSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    if (!assertBodyIdempotencyKey(parsed.data.idempotencyKey, headerKey, res)) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }

    const envelope: ActionEnvelope = { tenantId, ...parsed.data };
    if (await rejectIfKillSwitchActive(kernel, envelope, res)) return;
    if (isClassAEffectType(envelope.effectType)) {
      try {
        const readiness = await kernel.getOperationsReadiness(tenantId);
        if (!readiness.ready) {
          return res.status(503).json({
            error: {
              code: 'OPERATIONS_NOT_READY',
              message: 'Required reconciliation and compensation drains are unavailable.',
              details: readiness,
            },
          });
        }
        const evidenceReadiness = kernel.getEvidenceRepositoryAvailability
          ? await kernel.getEvidenceRepositoryAvailability()
          : { ready: false };
        if (!evidenceReadiness.ready) {
          return res.status(503).json({
            error: {
              code: 'OPERATIONS_NOT_READY',
              message: 'Required operations and evidence repository are unavailable.',
              details: {
                operations: readiness,
                evidenceRepository: { ready: false },
              },
            },
          });
        }
      } catch {
        return res.status(503).json({
          error: {
            code: 'OPERATIONS_NOT_READY',
            message: 'Operations readiness could not be verified.',
            details: { evidenceRepository: { ready: false } },
          },
        });
      }
    }
    const simulation = buildSimulation(envelope);
    const decision: ActionDecision = {
      effect: simulation.effect,
      decisionId: simulation.decisionId,
      reason: simulation.reason,
      policySnapshotId: simulation.policySnapshotId,
    };
    await persistSimulation(kernel, envelope, simulation, actor(req));
    if (decision.effect === 'deny') {
      const runId = deriveGatewayRunId(tenantId, envelope.idempotencyKey);
      return res.status(403).json({
        error: { code: 'ACTION_POLICY_DENIED', message: decision.reason },
        action: {
          runId,
          state: 'FAILED',
          decision,
          simulation,
          actionDigest: simulation.actionDigest,
          policySnapshotId: simulation.policySnapshotId,
          envelope,
        },
        idempotentReplay: false,
      });
    }
    const runId = deriveGatewayRunId(tenantId, envelope.idempotencyKey);
    const stepId = deterministicId('step', `${runId}:tool`);
    const effectId = deterministicId('effect', `${runId}:effect`);
    const interactionId =
      decision.effect === 'require_approval'
        ? deterministicId('interaction', `${runId}:approval`)
        : undefined;
    const metadata: ActionGatewayMetadata = {
      authority: ACTION_GATEWAY_AUTHORITY,
      stepId,
      effectId,
      interactionId,
      actionDigest: simulation.actionDigest,
      policySnapshotId: simulation.policySnapshotId,
      decision,
      simulation,
      envelope,
    };

    try {
      const result = await kernel.submit({
        tenantId,
        idempotencyKey: envelope.idempotencyKey,
        goal: `Govern ${envelope.effectType} via ${envelope.tool}`,
        steps: [
          {
            id: stepId,
            kind: 'tool',
            initialState: decision.effect === 'require_approval' ? 'WAITING_FOR_HUMAN' : 'PENDING',
            interaction: interactionId
              ? {
                  id: interactionId,
                  prompt: `Approve ${envelope.effectType} for ${envelope.destination}?`,
                }
              : undefined,
            input: {
              toolName: envelope.tool,
              effectType: envelope.effectType,
              args: envelope.args,
              actionEnvelope: envelope,
              effectId,
              idempotencyKey: envelope.idempotencyKey,
              hasExternalEffects: true,
            },
          },
        ],
        workGraphVersion: 'action-gateway/v1',
        policySnapshotId: simulation.policySnapshotId,
        metadata: { actionGateway: metadata },
        actor: actor(req),
      });
      const action = await renderAction(kernel, result.run, metadata);
      return res
        .status(result.created ? 202 : 200)
        .location(`/v1/actions/${result.run.id}`)
        .json({ action, idempotentReplay: !result.created });
    } catch (error) {
      if (error instanceof GatewayIdempotencyConflictError) {
        return res.status(409).json({
          error: { code: 'IDEMPOTENCY_KEY_CONFLICT', message: error.message },
        });
      }
      if (error instanceof GatewayStepIdConflictError) {
        return res.status(409).json({
          error: { code: 'STEP_ID_CONFLICT', message: error.message },
        });
      }
      throw error;
    }
  });

  router.get('/:runId', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    return res.json({ action: await renderAction(kernel, loaded.run, loaded.metadata) });
  });

  router.post('/:runId/approve', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    if (!requiredIdempotencyKey(req, res)) return;
    const reviewer = requiredApprover(req, res);
    if (!reviewer) return;
    const parsed = approvalSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    if (loaded.metadata.decision.effect !== 'require_approval' || !loaded.metadata.interactionId) {
      return res.status(409).json({
        error: {
          code: 'ACTION_APPROVAL_NOT_REQUIRED',
          message: 'This action is not awaiting approval.',
        },
      });
    }
    if (parsed.data.actionDigest !== loaded.metadata.simulation.actionDigest) {
      return res.status(409).json({
        error: {
          code: 'ACTION_DIGEST_MISMATCH',
          message: 'Approval action digest does not match the persisted simulation.',
        },
      });
    }
    if (
      parsed.data.simulationId !== loaded.metadata.simulation.simulationId ||
      parsed.data.policySnapshotId !== loaded.metadata.simulation.policySnapshotId
    ) {
      return res.status(409).json({
        error: {
          code: 'APPROVAL_BINDING_MISMATCH',
          message: 'Approval does not match the persisted simulation binding.',
        },
      });
    }
    const interactions = await kernel.listInteractions(loaded.run.id, tenantId);
    const interaction = interactions.find(
      (item) => item.id === loaded.metadata.interactionId && item.status === 'pending',
    );
    if (!interaction) {
      return res.status(409).json({
        error: { code: 'ACTION_ALREADY_REVIEWED', message: 'This action was already reviewed.' },
      });
    }
    await kernel.answerInteraction({
      interactionId: interaction.id,
      runId: loaded.run.id,
      tenantId,
      response: {
        approved: true,
        actionDigest: parsed.data.actionDigest,
        simulationId: parsed.data.simulationId,
        policySnapshotId: parsed.data.policySnapshotId,
        reviewer,
        runId: loaded.run.id,
        tenantId,
      },
      actor: reviewer,
    });
    const current = await kernel.getRun(loaded.run.id, tenantId);
    return res.json({
      action: await renderAction(kernel, current!, loaded.metadata),
    });
  });

  router.post('/:runId/reject', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    if (!requiredIdempotencyKey(req, res)) return;
    const reviewer = requiredApprover(req, res);
    if (!reviewer) return;
    const parsed = rejectionSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    if (loaded.metadata.decision.effect !== 'require_approval' || !loaded.metadata.interactionId) {
      return res.status(409).json({
        error: {
          code: 'ACTION_APPROVAL_NOT_REQUIRED',
          message: 'This action is not awaiting approval.',
        },
      });
    }
    const interactions = await kernel.listInteractions(loaded.run.id, tenantId);
    const interaction = interactions.find(
      (item) => item.id === loaded.metadata.interactionId && item.status === 'pending',
    );
    if (!interaction) {
      return res.status(409).json({
        error: { code: 'ACTION_ALREADY_REVIEWED', message: 'This action was already reviewed.' },
      });
    }
    await kernel.answerInteraction({
      interactionId: interaction.id,
      runId: loaded.run.id,
      tenantId,
      response: {
        approved: false,
        reviewer,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      },
      actor: reviewer,
      releaseStep: false,
    });
    await kernel.cancelRun(loaded.run.id, tenantId, reviewer);
    const current = await kernel.getRun(loaded.run.id, tenantId);
    return res.json({
      action: await renderAction(kernel, current!, loaded.metadata),
    });
  });

  router.post('/:runId/compensations', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    if (!requiredIdempotencyKey(req, res)) return;
    const parsed = compensationInputSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    const originalEffect = await kernel.getEffect(parsed.data.originalEffectId, tenantId);
    if (
      !originalEffect ||
      originalEffect.runId !== loaded.run.id ||
      originalEffect.state !== 'COMPLETED' ||
      originalEffect.type.startsWith('compensate.') ||
      !originalEffect.response
    ) {
      return res.status(404).json({
        error: {
          code: 'FORWARD_EFFECT_NOT_FOUND',
          message: 'Completed forward effect was not found.',
        },
      });
    }
    if (canonicalValueHash(originalEffect.response) !== parsed.data.forwardReceiptHash) {
      return res.status(409).json({
        error: {
          code: 'FORWARD_RECEIPT_MISMATCH',
          message: 'Forward receipt binding does not match.',
        },
      });
    }
    const destination = originalEffect.request.destination;
    if (typeof destination !== 'string' || destination.length === 0) {
      return res.status(409).json({
        error: {
          code: 'FORWARD_EFFECT_INVALID',
          message: 'Forward effect has no durable destination.',
        },
      });
    }
    const compensationAction = {
      type: parsed.data.compensationEffectType,
      originalEffectId: originalEffect.id,
      adapterVersion: parsed.data.adapterVersion,
      forwardResponse: originalEffect.response,
      compensationPatch: parsed.data.compensationPatch,
    };
    const actionDigest = canonicalValueHash(compensationAction);
    const envelope: ActionEnvelope = {
      tenantId,
      source: loaded.metadata.envelope.source,
      package: loaded.metadata.envelope.package,
      model: loaded.metadata.envelope.model,
      tool:
        parsed.data.compensationEffectType === 'compensate.demo.ticket.create'
          ? 'ticket.compensate'
          : loaded.metadata.envelope.tool,
      destination,
      effectType: parsed.data.compensationEffectType,
      args: parsed.data.compensationPatch,
      idempotencyKey: `cmp:${originalEffect.id}:${parsed.data.adapterVersion}`,
    };
    const decision = evaluateAction(envelope);
    const authorizationId = `authorization_${canonicalValueHash({
      tenantId,
      originalRunId: loaded.run.id,
      originalEffectId: originalEffect.id,
      adapterVersion: parsed.data.adapterVersion,
      actionDigest,
    }).slice(0, 40)}`;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const approvalInteractionId =
      decision.effect === 'require_approval'
        ? `interaction_${canonicalValueHash({ authorizationId, actionDigest }).slice(0, 40)}`
        : undefined;
    if (approvalInteractionId) {
      const existing = (await kernel.listInteractions(loaded.run.id, tenantId)).find(
        (interaction) => interaction.id === approvalInteractionId,
      );
      if (!existing) {
        await kernel.createInteraction(
          {
            id: approvalInteractionId,
            runId: loaded.run.id,
            stepId: loaded.metadata.stepId,
            tenantId,
            prompt: `Approve compensation authorization ${authorizationId}`,
            expiresAt: new Date(expiresAt),
          },
          actor(req),
        );
      }
    }
    const authorization = {
      id: authorizationId,
      tenantId,
      originalRunId: loaded.run.id,
      originalEffectId: originalEffect.id,
      compensationEffectType: parsed.data.compensationEffectType,
      adapterVersion: parsed.data.adapterVersion,
      compensationPatch: parsed.data.compensationPatch,
      forwardReceiptHash: parsed.data.forwardReceiptHash,
      policyDecisionId: decision.decisionId,
      policySnapshotId: decision.policySnapshotId,
      decision: decision.effect,
      actionDigest,
      expiresAt,
      ...(approvalInteractionId ? { approvalInteractionId } : {}),
    };
    try {
      const persisted = await kernel.createCompensationAuthorization(authorization);
      if (decision.effect === 'require_approval') {
        return res.status(202).json({
          authorization: persisted.authorization,
          replayed: persisted.replayed,
          state: 'AWAITING_APPROVAL',
        });
      }
      const result = await kernel.requestCompensation({
        tenantId,
        authorizationId,
        actor: actor(req),
      });
      if (result.accepted) return res.status(202).json(result);
      return res.status(result.reason === 'POLICY_DENIED' ? 403 : 409).json({
        error: { code: result.reason, message: 'Compensation authorization was not executable.' },
        requestId: result.requestId,
      });
    } catch (error) {
      return res.status(409).json({
        error: {
          code: error instanceof Error ? error.message : 'COMPENSATION_AUTHORIZATION_FAILED',
          message: 'Compensation authorization could not be persisted.',
        },
      });
    }
  });

  router.post('/:runId/compensations/:authorizationId/approve', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    if (!requiredIdempotencyKey(req, res)) return;
    const approver = requiredApprover(req, res);
    if (!approver) return;
    const parsed = compensationApprovalSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const kernel = resolveKernel();
    if (!kernel) return res.status(503).json({ error: { code: 'KERNEL_UNAVAILABLE' } });
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    const authorization = await kernel.getCompensationAuthorization(
      req.params.authorizationId,
      tenantId,
    );
    if (!authorization || authorization.originalRunId !== loaded.run.id) {
      return res.status(404).json({ error: { code: 'COMPENSATION_AUTHORIZATION_NOT_FOUND' } });
    }
    if (
      authorization.decision !== 'require_approval' ||
      !authorization.approvalInteractionId ||
      authorization.actionDigest !== parsed.data.actionDigest ||
      authorization.policySnapshotId !== parsed.data.policySnapshotId
    ) {
      return res.status(409).json({ error: { code: 'APPROVAL_BINDING_MISMATCH' } });
    }
    const interaction = await kernel.answerInteraction({
      interactionId: authorization.approvalInteractionId,
      runId: loaded.run.id,
      tenantId,
      response: {
        approved: true,
        approvedBy: approver,
        authorizationId: authorization.id,
        originalEffectId: authorization.originalEffectId,
        actionDigest: authorization.actionDigest,
        policyDecisionId: authorization.policyDecisionId,
        policySnapshotId: authorization.policySnapshotId,
      },
      actor: approver,
      releaseStep: false,
    });
    const result = await kernel.requestCompensation({
      tenantId,
      authorizationId: authorization.id,
      actor: approver,
    });
    return result.accepted
      ? res.status(202).json({ interaction, ...result })
      : res.status(409).json({ error: { code: result.reason }, requestId: result.requestId });
  });

  router.post('/:runId/reconcile', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    if (!requiredIdempotencyKey(req, res)) return;
    const actor = requiredReconcileAuthority(req, res);
    if (!actor) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    const result = await kernel.requestReconcile(loaded.metadata.effectId, tenantId, actor);
    if (result.scheduled) return res.status(202).json(result);
    switch (result.reason) {
      case 'NOT_FOUND':
        return actionNotFound(res);
      case 'NOT_UNKNOWN':
        return res.status(409).json({
          error: {
            code: 'NO_RECONCILABLE_EFFECT',
            message: 'No completion-unknown effect exists.',
          },
        });
      case 'ESCALATED':
        return res.status(409).json({
          error: {
            code: 'RECONCILIATION_ESCALATED',
            message: 'The completion-unknown effect is already escalated.',
          },
        });
      case 'DEADLINE_EXPIRED':
        return res.status(410).json({
          error: {
            code: 'RECONCILIATION_DEADLINE_EXPIRED',
            message: 'The completion-unknown effect reconciliation deadline has expired.',
          },
        });
    }
  });

  router.get('/:runId/evidence', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: {
          code: 'KERNEL_UNAVAILABLE',
          message: 'Shared execution kernel is not configured.',
        },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    const record = await kernel.getEvidence(loaded.run.id, tenantId);
    if (!record?.anchoredAt || !record.signature) {
      return res.status(503).json({
        error: {
          code: 'EVIDENCE_NOT_READY',
          message: 'A signed and anchored evidence receipt is not available.',
        },
      });
    }
    try {
      if (
        record.tenantId !== tenantId ||
        record.runId !== loaded.run.id ||
        record.body.scope.tenantId !== tenantId ||
        record.body.scope.runId !== loaded.run.id ||
        record.bundleId !== record.body.bundleId ||
        record.actionDigest !== record.body.actionDigest ||
        record.contentHash !== record.body.contentHash
      ) {
        throw new Error('EVIDENCE_RECORD_BINDING_INVALID');
      }
      const receipt = { ...record.body, signature: record.signature };
      const verification = verifyEvidenceBundle(receipt);
      if (!verification.ok) throw new Error(verification.reason ?? 'EVIDENCE_INVALID');
      assertTerminalEvidence(receipt);
      const jwks = configuredEvidenceJwks();
      if (
        !jwks ||
        !verifyEvidenceSignature(canonicalEvidenceBody(receipt), record.signature, jwks)
      ) {
        throw new Error('EVIDENCE_SIGNATURE_INVALID');
      }
      return res.json({ receipt, verification });
    } catch {
      return res.status(503).json({
        error: { code: 'EVIDENCE_INVALID', message: 'Persisted evidence failed integrity checks.' },
      });
    }
  });

  return router;
}
