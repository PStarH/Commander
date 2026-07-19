import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  buildRunEvidenceBundle,
  verifyEvidenceBundle,
  type EvidenceAuditSource,
  type EvidenceEffectSource,
} from '@commander/effect-broker';
import type { KernelEvent } from '@commander/kernel';
import {
  GatewayIdempotencyConflictError,
  GatewayStepIdConflictError,
  canonicalValueHash,
  deriveGatewayRunId,
  type KernelRun,
  type V1KernelGateway,
} from './v1GatewayKernel';
import type { KillSwitchMatchDims } from './v1GatewayKernel';

const ACTION_GATEWAY_AUTHORITY = 'commander.action-gateway/v1';
const ACTION_POLICY_SNAPSHOT = 'action-gateway-mvp-v1';

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
    apiScopes.includes('actions:approve') ||
    apiScopes.includes('admin') ||
    apiScopes.includes('*');
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
    apiScopes.includes('actions:kill') ||
    apiScopes.includes('admin') ||
    apiScopes.includes('*');
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
  let state: string = run.state;
  if (metadata.decision.effect === 'deny') state = 'DENIED';
  if (metadata.decision.effect === 'require_approval') {
    if (interaction?.response?.approved === false) state = 'REJECTED';
    else if (interaction?.response?.approved !== true) state = 'WAITING_FOR_APPROVAL';
    else state = 'APPROVED';
  }
  if (
    metadata.decision.effect !== 'deny' &&
    interaction?.response?.approved !== false &&
    (metadata.decision.effect !== 'require_approval' || interaction?.response?.approved === true)
  ) {
    if (effect?.state === 'COMPLETION_UNKNOWN') state = 'COMPLETION_UNKNOWN';
    else if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) state = run.state;
    else if (step && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'].includes(step.state)) {
      state = step.state;
    } else if (effect?.state === 'COMPLETED' || effect?.state === 'FAILED') {
      state = effect.state;
    }
  }
  return {
    runId: run.id,
    stepId: metadata.stepId,
    effectId: metadata.effectId,
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

function evidenceAuditDetails(event: KernelEvent): Record<string, unknown> {
  if (event.type === 'interaction.created') {
    const expiresAt = event.payload.expiresAt;
    return {
      interactionId: event.aggregateId,
      status: 'pending',
      expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
    };
  }
  if (event.type === 'interaction.answered') {
    const response =
      event.payload.response && typeof event.payload.response === 'object'
        ? event.payload.response as Record<string, unknown>
        : {};
    return {
      interactionId: event.aggregateId,
      status: 'answered',
      ...(typeof response.approved === 'boolean' ? { approved: response.approved } : {}),
    };
  }
  return event.payload;
}

export function createActionGatewayRouter(
  resolveKernel: () => V1KernelGateway | null,
): Router {
  const router = express.Router();

  router.get('/kill-switches', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const manager = requiredKillSwitchManager(req, res);
    if (!manager) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
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
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
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
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
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
    const parsed = actionInputSchema.safeParse(req.body);
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
    const parsed = actionInputSchema.safeParse(req.body);
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

    const envelope: ActionEnvelope = { tenantId, ...parsed.data };
    if (await rejectIfKillSwitchActive(kernel, envelope, res)) return;
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
          state: 'DENIED',
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
            initialState:
              decision.effect === 'require_approval' ? 'WAITING_FOR_HUMAN' : 'PENDING',
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
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    return res.json({ action: await renderAction(kernel, loaded.run, loaded.metadata) });
  });

  router.post('/:runId/approve', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const reviewer = requiredApprover(req, res);
    if (!reviewer) return;
    const parsed = approvalSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    if (
      loaded.metadata.decision.effect !== 'require_approval' ||
      !loaded.metadata.interactionId
    ) {
      return res.status(409).json({
        error: { code: 'ACTION_APPROVAL_NOT_REQUIRED', message: 'This action is not awaiting approval.' },
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
    const reviewer = requiredApprover(req, res);
    if (!reviewer) return;
    const parsed = rejectionSchema.safeParse(req.body);
    if (!parsed.success) return invalidRequest(res, parsed.error);
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    if (
      loaded.metadata.decision.effect !== 'require_approval' ||
      !loaded.metadata.interactionId
    ) {
      return res.status(409).json({
        error: { code: 'ACTION_APPROVAL_NOT_REQUIRED', message: 'This action is not awaiting approval.' },
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

  router.post('/:runId/reconcile', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    const effects = await kernel.listEffects(loaded.run.id, tenantId);
    const unknown = effects.find((effect) => effect.state === 'COMPLETION_UNKNOWN');
    if (!unknown) {
      return res.status(409).json({
        error: { code: 'NO_RECONCILABLE_EFFECT', message: 'No completion-unknown effect exists.' },
      });
    }
    return res.status(501).json({
      error: {
        code: 'RECONCILER_NOT_CONFIGURED',
        message: 'The adapter reconciler is not configured on this API process.',
      },
      effectId: unknown.id,
    });
  });

  router.get('/:runId/evidence', async (req, res) => {
    const tenantId = requiredTenant(req, res);
    if (!tenantId) return;
    const kernel = resolveKernel();
    if (!kernel) {
      return res.status(503).json({
        error: { code: 'KERNEL_UNAVAILABLE', message: 'Shared execution kernel is not configured.' },
      });
    }
    const loaded = await loadAction(kernel, req.params.runId, tenantId);
    if (!loaded) return actionNotFound(res);
    const [events, effects] = await Promise.all([
      kernel.listEvents(loaded.run.id, tenantId),
      kernel.listEffects(loaded.run.id, tenantId),
    ]);
    const evidenceEffects: EvidenceEffectSource[] = effects.map((effect) => ({
      ...effect,
      approvalInteractionId:
        effect.id === loaded.metadata.effectId ? loaded.metadata.interactionId : undefined,
    }));
    const auditEvents: EvidenceAuditSource[] = events.map((event) => ({
      type: event.type,
      severity: event.type.includes('failed') || event.type.includes('denied') ? 'high' : 'low',
      tenantId: event.tenantId,
      runId: event.runId,
      stepId: event.stepId ?? loaded.metadata.stepId,
      at: event.occurredAt,
      details: evidenceAuditDetails(event),
    }));
    const bundle = buildRunEvidenceBundle({
      tenantId,
      runId: loaded.run.id,
      intentHash: loaded.run.intentHash,
      workGraphHash: loaded.run.workGraphHash,
      workGraphVersion: loaded.run.workGraphVersion,
      policySnapshotId: loaded.run.policySnapshotId,
      kernelApiVersion: 'v1',
      effects: evidenceEffects,
      auditEvents,
      exportedAt: loaded.run.updatedAt,
      bundleId: `bundle_${canonicalValueHash({
        runId: loaded.run.id,
        actionDigest: loaded.metadata.actionDigest,
        updatedAt: loaded.run.updatedAt,
      }).slice(0, 40)}`,
    });
    return res.json({ bundle, verification: verifyEvidenceBundle(bundle) });
  });

  return router;
}
