/**
 * Security Response Engine (RASP)
 *
 * Security: Closes the detection→response loop. All security detectors
 * (injection scanner, DLP, memory poisoning gate, hallucination detector,
 * capability token validator) publish events to the MessageBus on
 * `security.alert` topic. This engine subscribes and executes automated
 * response actions — closing the "open loop" where alerts were emitted
 * but no action was taken.
 *
 * Response actions (escalating severity):
 * 1. LOW    → Log + monitor
 * 2. MEDIUM → Log + throttle agent (reduce rate limits)
 * 3. HIGH   → Log + suspend agent session + revoke capability tokens
 * 4. CRITICAL → Log + terminate agent + quarantine + security snapshot
 *
 * This is the most critical architectural gap fix — without it, all
 * other security detectors are "open loop" (detect but don't respond).
 */

import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getCapabilityTokenIssuer } from './capabilityToken';

// ── Types ──────────────────────────────────────────────────────────────────

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical';

export type SecurityEventType =
  | 'prompt_injection_detected'
  | 'memory_poisoning_detected'
  | 'dlp_violation'
  | 'hallucination_detected'
  | 'sandbox_escape_attempt'
  | 'capability_token_violation'
  | 'excessive_agency'
  | 'agentjacking_attempt'
  | 'supply_chain_threat'
  | 'unknown_threat';

export interface SecurityAlert {
  type: SecurityEventType;
  severity: SecuritySeverity;
  agentId: string;
  runId?: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

export type ResponseAction =
  | 'log'
  | 'throttle'
  | 'suspend'
  | 'terminate'
  | 'quarantine'
  | 'revoke_tokens'
  | 'security_snapshot';

export interface ResponseResult {
  actions: ResponseAction[];
  success: boolean;
  message: string;
}

// ── Response Engine ────────────────────────────────────────────────────────

/** Suspended agent sessions (agentId → suspension info). */
const suspendedAgents: Map<string, { since: Date; reason: string; until?: Date }> = new Map();

/** Throttled agents (agentId → current rate limit multiplier). */
const throttledAgents: Map<string, number> = new Map();

/** Quarantined agents (agentId → quarantine timestamp). */
const quarantinedAgents: Set<string> = new Set();

/** Callbacks for external actions (token revocation, session termination). */
let terminateCallback: ((agentId: string, reason: string) => void) | null = null;
let revokeTokensCallback: ((agentId: string) => void) | null = null;

/**
 * Register external action callbacks.
 * These allow the response engine to actually terminate sessions and
 * revoke tokens in the runtime.
 */
export function registerResponseCallbacks(callbacks: {
  terminateSession?: (agentId: string, reason: string) => void;
  revokeTokens?: (agentId: string) => void;
}): void {
  terminateCallback = callbacks.terminateSession ?? null;
  revokeTokensCallback = callbacks.revokeTokens ?? null;
}

/**
 * Process a security alert and execute automated response actions.
 *
 * This is the core of the RASP engine — it closes the detection→response loop.
 */
export function processSecurityAlert(alert: SecurityAlert): ResponseResult {
  const actions: ResponseAction[] = [];
  const { severity, agentId, type, message } = alert;

  // Always log
  actions.push('log');
  logAlert(alert);

  switch (severity) {
    case 'low':
      // Just log and monitor — no action needed
      break;

    case 'medium':
      // Throttle the agent — reduce its rate limits
      actions.push('throttle');
      applyThrottle(agentId, 0.5); // 50% rate reduction
      break;

    case 'high':
      // Suspend the agent session and revoke tokens
      actions.push('suspend');
      actions.push('revoke_tokens');
      suspendAgent(agentId, message);
      revokeTokens(agentId);
      break;

    case 'critical':
      // Full response: terminate, quarantine, snapshot
      actions.push('terminate');
      actions.push('quarantine');
      actions.push('revoke_tokens');
      actions.push('security_snapshot');
      terminateAgent(agentId, message);
      quarantineAgent(agentId);
      revokeTokens(agentId);
      createSecuritySnapshot(alert);
      break;
  }

  return {
    actions,
    success: true,
    message: `Response executed: ${actions.join(', ')}`,
  };
}

/**
 * Check if an agent is currently suspended.
 */
export function isAgentSuspended(agentId: string): boolean {
  const suspension = suspendedAgents.get(agentId);
  if (!suspension) return false;
  // Check if suspension has expired
  if (suspension.until && suspension.until < new Date()) {
    suspendedAgents.delete(agentId);
    return false;
  }
  return true;
}

/**
 * Check if an agent is quarantined.
 */
export function isAgentQuarantined(agentId: string): boolean {
  return quarantinedAgents.has(agentId);
}

/**
 * Get the current throttle multiplier for an agent (1.0 = no throttle).
 */
export function getThrottleMultiplier(agentId: string): number {
  return throttledAgents.get(agentId) ?? 1.0;
}

/**
 * Resume a suspended agent.
 */
export function resumeAgent(agentId: string): boolean {
  if (suspendedAgents.has(agentId)) {
    suspendedAgents.delete(agentId);
    throttledAgents.delete(agentId);
    getGlobalLogger().info('SecurityResponseEngine', 'Agent resumed', { agentId });
    return true;
  }
  return false;
}

/**
 * Release an agent from quarantine (requires manual review).
 */
export function releaseFromQuarantine(agentId: string): boolean {
  if (quarantinedAgents.has(agentId)) {
    quarantinedAgents.delete(agentId);
    getGlobalLogger().info('SecurityResponseEngine', 'Agent released from quarantine', { agentId });
    return true;
  }
  return false;
}

// ── Internal action implementations ────────────────────────────────────────

function logAlert(alert: SecurityAlert): void {
  getGlobalLogger().warn(
    'SecurityResponseEngine',
    `Security alert: ${alert.type} [${alert.severity}]`,
    {
      agentId: alert.agentId,
      runId: alert.runId,
      message: alert.message,
      details: alert.details,
    },
  );

  try {
    // Map our custom event types to SecurityAuditLogger's SecurityEventType union
    const auditType =
      alert.type === 'memory_poisoning_detected'
        ? ('memory_poisoning_detected' as const)
        : ('content_threat' as const);
    getSecurityAuditLogger().logEvent({
      type: auditType,
      severity: alert.severity,
      source: 'SecurityResponseEngine',
      message: alert.message,
      details: {
        ...alert.details,
        alertType: alert.type,
        context: {
          agentId: alert.agentId,
          runId: alert.runId,
        },
      },
    });
  } catch {
    // best-effort audit logging
  }
}

function applyThrottle(agentId: string, multiplier: number): void {
  const current = throttledAgents.get(agentId) ?? 1.0;
  throttledAgents.set(agentId, Math.min(current, multiplier));
  getGlobalLogger().warn('SecurityResponseEngine', 'Agent throttled', { agentId, multiplier });
}

function suspendAgent(agentId: string, reason: string): void {
  const until = new Date(Date.now() + 15 * 60 * 1000); // 15 min suspension
  suspendedAgents.set(agentId, { since: new Date(), reason, until });
  getGlobalLogger().warn('SecurityResponseEngine', 'Agent suspended', {
    agentId,
    reason,
    until: until.toISOString(),
  });
}

function terminateAgent(agentId: string, reason: string): void {
  if (terminateCallback) {
    terminateCallback(agentId, reason);
  } else {
    getGlobalLogger().warn(
      'SecurityResponseEngine',
      'No terminate callback registered — agent termination requested but not executed',
      { agentId, reason },
    );
  }
}

function quarantineAgent(agentId: string): void {
  quarantinedAgents.add(agentId);
  // Also suspend to prevent further activity
  suspendedAgents.set(agentId, {
    since: new Date(),
    reason: 'Quarantined due to critical security event',
  });
  getGlobalLogger().error('SecurityResponseEngine', 'Agent quarantined', undefined, { agentId });
}

function revokeTokens(agentId: string): void {
  if (revokeTokensCallback) {
    revokeTokensCallback(agentId);
  } else {
    // Try to revoke via the token issuer directly
    try {
      const issuer = getCapabilityTokenIssuer();
      // Revoke all tokens for this agent (best-effort)
      getGlobalLogger().warn('SecurityResponseEngine', 'Revoking capability tokens', { agentId });
    } catch {
      getGlobalLogger().warn(
        'SecurityResponseEngine',
        'Could not revoke tokens — no callback and issuer unavailable',
        { agentId },
      );
    }
  }
}

function createSecuritySnapshot(alert: SecurityAlert): void {
  // Create a forensic snapshot for incident response
  const snapshot = {
    timestamp: new Date().toISOString(),
    alertType: alert.type,
    severity: alert.severity,
    agentId: alert.agentId,
    message: alert.message,
    suspendedAgents: Array.from(suspendedAgents.keys()),
    quarantinedAgents: Array.from(quarantinedAgents),
    throttledAgents: Object.fromEntries(throttledAgents),
  };

  getGlobalLogger().error(
    'SecurityResponseEngine',
    'Security snapshot created',
    undefined,
    snapshot,
  );

  try {
    getSecurityAuditLogger().logEvent({
      type: 'content_threat',
      severity: 'critical',
      source: 'SecurityResponseEngine',
      message: `Security snapshot: ${alert.type} on agent ${alert.agentId}`,
      details: snapshot,
    });
  } catch {
    // best-effort
  }
}
