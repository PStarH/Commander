import { Router, type Request, type Response } from 'express';
import { getV1KernelGateway } from './v1GatewayKernel';

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface ControlledRun {
  id: string;
  state: string;
}

export interface RunControlGateway {
  pauseRun(runId: string, tenantId: string, actor: string): Promise<ControlledRun | null>;
  resumeRun(runId: string, tenantId: string, actor: string): Promise<ControlledRun | null>;
}

type ResolveRunControlGateway = () => RunControlGateway | null;

function isValidRunId(runId: unknown): runId is string {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 128 &&
    RUN_ID_PATTERN.test(runId)
  );
}

function principal(req: Request, res: Response): { tenantId: string; actor: string } | null {
  if (!req.tenantId) {
    res.status(401).json({
      error: {
        code: 'TENANT_IDENTITY_REQUIRED',
        message: 'A tenant-bound authenticated principal is required.',
      },
    });
    return null;
  }
  return {
    tenantId: req.tenantId,
    actor: req.user?.id ?? req.apiKeyId ?? 'api-run-control',
  };
}

function kernelUnavailable(res: Response): void {
  res.status(503).json({
    error: {
      code: 'KERNEL_UNAVAILABLE',
      message: 'Shared execution kernel is not configured.',
    },
  });
}

function migrationGone(res: Response, replacement: string): void {
  res.status(410).json({
    error: {
      code: 'LEGACY_EXECUTION_DISABLED',
      message: 'This process-local run operation has been removed.',
      replacement,
    },
  });
}

export function createPauseRouter(
  resolveGateway: ResolveRunControlGateway = getV1KernelGateway,
): Router {
  const router = Router();

  const transition = (
    operation: 'pause' | 'resume',
    invoke: (
      gateway: RunControlGateway,
      runId: string,
      tenantId: string,
      actor: string,
    ) => Promise<ControlledRun | null>,
  ): void => {
    router.post(`/runtime/${operation}`, async (req, res) => {
      const { runId } = req.body ?? {};
      if (!isValidRunId(runId)) {
        res.status(400).json({ error: 'runId is required and must be alphanumeric' });
        return;
      }
      const identity = principal(req, res);
      if (!identity) return;
      const gateway = resolveGateway();
      if (!gateway) {
        kernelUnavailable(res);
        return;
      }
      const run = await invoke(gateway, runId, identity.tenantId, identity.actor);
      if (!run) {
        res.status(409).json({
          error: {
            code: 'INVALID_STATE_TRANSITION',
            message: `Run cannot be ${operation === 'pause' ? 'paused' : 'resumed'}.`,
          },
        });
        return;
      }
      res.json({ run });
    });
  };

  transition('pause', (gateway, runId, tenantId, actor) =>
    gateway.pauseRun(runId, tenantId, actor),
  );
  transition('resume', (gateway, runId, tenantId, actor) =>
    gateway.resumeRun(runId, tenantId, actor),
  );

  router.post('/runtime/rollback', (_req, res) => {
    migrationGone(res, 'POST /v1/runs');
  });

  router.get('/runtime/active', (_req, res) => {
    migrationGone(res, 'GET /v1/runs/:runId');
  });

  return router;
}
