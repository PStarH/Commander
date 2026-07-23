import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithTenant } from './tenantContext';
import {
  DETECTOR_TO_ASI_OVERRIDE,
  SECURITY_EVENT_TYPE_TO_ASI,
  getOwaspAsiTop10,
} from '../security/owaspAgenticAiTop10';
import { getComplianceAuditManager } from '../security/complianceAuditReport';
import { getEuAiActComplianceReporter } from '../security/euAiActCompliance';
import type { SecurityEvent } from '../security/securityAuditLogger';
import { parseBody, sendJson } from './httpUtils';
import { assertBodyTenant } from './httpTenantGate';
import { requireMinRole, resolveHttpAuthContext } from './httpRbacGate';

export interface HttpSecurityRouteDeps {
  maxBodyBytes: number;
  tenantApiKeyHashes: ReadonlyMap<string, string>;
  requireTenant: (req: IncomingMessage, res: ServerResponse) => string | undefined;
}

/**
 * Handle /api/v1/security/* routes. Returns true when handled.
 */
export async function handleSecurityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  deps: HttpSecurityRouteDeps,
): Promise<boolean> {
  if (segments[0] !== 'v1' || segments[1] !== 'security') return false;

  const method = req.method ?? 'GET';
  const sub = segments[2];

  if (sub === 'owasp-agentic-ai-top10') {
    if (method === 'GET') {
      const tenantId = deps.requireTenant(req, res);
      if (res.writableEnded) return true;
      const authCtx = resolveHttpAuthContext(req, deps.tenantApiKeyHashes);
      if (!requireMinRole(res, authCtx, 'auditor', 'GET /api/v1/security/owasp-agentic-ai-top10')) {
        return true;
      }
      const report = await runWithTenant(tenantId, async () => getOwaspAsiTop10().report());
      sendJson(res, 200, report);
      return true;
    }
    if (method === 'POST') {
      const body = (await parseBody(req, deps.maxBodyBytes)) as SecurityEvent & {
        tenantId?: string;
      };
      if (!body || typeof body !== 'object' || !body.type) {
        sendJson(res, 400, {
          error:
            'POST /api/v1/security/owasp-agentic-ai-top10 requires a SecurityEvent-shaped body { type, severity, ... }.',
        });
        return true;
      }
      const tenantId = deps.requireTenant(req, res);
      if (res.writableEnded) return true;
      const authCtx = resolveHttpAuthContext(req, deps.tenantApiKeyHashes);
      if (!requireMinRole(res, authCtx, 'admin', 'POST /api/v1/security/owasp-agentic-ai-top10')) {
        return true;
      }
      if (!assertBodyTenant(req, res, tenantId, body, deps.tenantApiKeyHashes)) {
        return true;
      }

      const detector = (body.details?.detector as string | undefined) ?? body.source ?? undefined;
      const routingAsis = SECURITY_EVENT_TYPE_TO_ASI[body.type as SecurityEvent['type']] ?? [];
      const overrideAsi = detector ? (DETECTOR_TO_ASI_OVERRIDE[detector] ?? null) : null;
      const categories = Array.isArray(body.details?.category)
        ? (body.details!.category as string[])
        : body.details?.category
          ? [body.details.category as string]
          : [];
      const isOutputTamper =
        detector === 'outputSanitizer' &&
        categories.some((c) =>
          ['jwt_token', 'connection_string', 'base64_blob', 'password_secret'].includes(c),
        );
      const routedAsis: string[] = Array.from(
        new Set<string>([
          ...routingAsis,
          ...(overrideAsi ? [overrideAsi] : []),
          ...(isOutputTamper ? ['ASI09'] : []),
        ]),
      );
      await runWithTenant(tenantId, async () => {
        getOwaspAsiTop10().classifyFromSecurityEvent(body);
      });
      sendJson(res, 202, {
        accepted: true,
        routedAsis,
        detector: detector ?? null,
        eventType: body.type,
        windowMs: getOwaspAsiTop10().report().windowMs,
      });
      return true;
    }
    return false;
  }

  if (sub === 'compliance-audit' && method === 'GET') {
    const tenantId = deps.requireTenant(req, res);
    if (res.writableEnded) return true;
    const authCtx = resolveHttpAuthContext(req, deps.tenantApiKeyHashes);
    if (!requireMinRole(res, authCtx, 'auditor', 'GET /api/v1/security/compliance-audit')) {
      return true;
    }
    const report = await runWithTenant(tenantId, async () =>
      getComplianceAuditManager().generateFullReport(),
    );
    sendJson(res, 200, report);
    return true;
  }

  if (sub === 'eu-ai-act' && method === 'GET') {
    const tenantId = deps.requireTenant(req, res);
    if (res.writableEnded) return true;
    const authCtx = resolveHttpAuthContext(req, deps.tenantApiKeyHashes);
    if (!requireMinRole(res, authCtx, 'auditor', 'GET /api/v1/security/eu-ai-act')) {
      return true;
    }
    const report = await runWithTenant(tenantId, async () =>
      getEuAiActComplianceReporter().generateReport(),
    );
    sendJson(res, 200, report);
    return true;
  }

  return false;
}
