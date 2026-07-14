/**
 * Security Guardian Facade — single perimeter for tool-call guardian checks (M6).
 *
 * Consolidates GuardianAgent.monitor() and EnterpriseSecurityGateway.preToolCheck()
 * so call sites share consistent fail modes.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getEnterpriseSecurityGateway } from './enterpriseSecurityGateway';
import { getGuardianAgent } from './guardianAgent';

export interface ToolGuardianCheckParams {
  agentId: string;
  runId: string;
  toolName: string;
  arguments: unknown;
  sessionId?: string;
  tenantId?: string;
  input?: string;
  /** When false, guardian errors fail-open (remote/MCP paths). Default: fail-closed. */
  failClosedOnGuardianError?: boolean;
}

export type ToolGuardianBlockKind =
  | 'gateway_blocked'
  | 'guardian_blocked'
  | 'guardian_error'
  | 'runtime_guardian_blocked';

export interface ToolGuardianCheckResult {
  allowed: boolean;
  reason?: string;
  kind?: ToolGuardianBlockKind;
}

/**
 * Unified pre-tool security gate used by ToolExecutionService and MCP remote runtime.
 */
export function checkToolGuardian(params: ToolGuardianCheckParams): ToolGuardianCheckResult {
  const failClosed = params.failClosedOnGuardianError !== false;

  try {
    const gateway = getEnterpriseSecurityGateway();
    const gatewayResult = gateway.preToolCheck({
      tenantId: params.tenantId,
      runId: params.runId,
      sessionId: params.sessionId ?? params.runId,
      toolName: params.toolName,
      source: params.agentId,
      input:
        params.input ?? `${params.toolName}(${JSON.stringify(params.arguments).slice(0, 500)})`,
    });
    if (!gatewayResult.allowed) {
      return {
        allowed: false,
        reason: gatewayResult.reason ?? 'Blocked by security gateway',
        kind: 'gateway_blocked',
      };
    }
  } catch (err) {
    reportSilentFailure(err, 'securityGuardianFacade:gateway');
    return {
      allowed: false,
      reason: 'Security gateway unavailable',
      kind: 'gateway_blocked',
    };
  }

  try {
    const guardian = getGuardianAgent();
    const intervention = guardian.monitor({
      agentId: params.agentId,
      runId: params.runId,
      timestamp: Date.now(),
      type: 'tool_call',
      content: `${params.toolName}(${JSON.stringify(params.arguments).slice(0, 200)})`,
      metadata: { args: params.arguments },
    });
    if (intervention) {
      return {
        allowed: false,
        reason: `${intervention} by security guardian for ${params.toolName}`,
        kind: 'guardian_blocked',
      };
    }
  } catch (err) {
    reportSilentFailure(err, 'securityGuardianFacade:guardian');
    if (failClosed) {
      return {
        allowed: false,
        reason: `Security guardian unavailable for ${params.toolName}: ${err instanceof Error ? err.message : String(err)}`,
        kind: 'guardian_error',
      };
    }
  }

  return { allowed: true };
}

/**
 * Remote agent invocation gate (MCP run_agent) with fail-open on guardian errors.
 */
export function checkRemoteAgentGuardian(params: {
  agentId: string;
  runId: string;
  goal: string;
  availableTools: string[];
}): ToolGuardianCheckResult {
  return checkToolGuardian({
    agentId: params.agentId,
    runId: params.runId,
    toolName: 'run_agent',
    arguments: { goal: params.goal, availableTools: params.availableTools },
    input: `run_agent: ${params.goal}`.slice(0, 500),
    failClosedOnGuardianError: false,
  });
}
