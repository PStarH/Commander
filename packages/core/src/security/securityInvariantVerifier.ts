/**
 * Security Invariant Verifier — runtime security property checks.
 *
 * Registers invariants that are evaluated at critical execution points
 * (tool execution, LLM calls, agent spawn) and blocks execution when any
 * invariant is violated.
 */

export interface InvariantContext {
  agentId?: string;
  runId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  capabilityTokenPresent?: boolean;
  /** When true, executeTool requires a capability token on the run context. */
  requireCapabilityToken?: boolean;
  agentSuspended?: boolean;
  agentQuarantined?: boolean;
}

export type InvariantPhase = 'executeTool' | 'callLLM' | 'spawnAgent' | string;

export interface SecurityInvariant {
  id: string;
  description: string;
  evaluate: (ctx: InvariantContext, phase: InvariantPhase) => boolean;
}

export interface InvariantViolation {
  invariant: SecurityInvariant;
  phase: InvariantPhase;
  message: string;
}

export interface InvariantResult {
  passed: boolean;
  violations: InvariantViolation[];
}

const invariants: SecurityInvariant[] = [];

/**
 * Register a security invariant for runtime evaluation.
 */
export function registerInvariant(invariant: SecurityInvariant): void {
  invariants.push(invariant);
}

/**
 * Register the default set of security invariants.
 */
export function registerDefaultInvariants(): void {
  if (invariants.length > 0) return; // already registered

  registerInvariant({
    id: 'AGENT_NOT_SUSPENDED',
    description: 'Tool execution is blocked while the agent is suspended.',
    evaluate: (ctx) => !ctx.agentSuspended,
  });

  registerInvariant({
    id: 'AGENT_NOT_QUARANTINED',
    description: 'Tool execution is blocked while the agent is quarantined.',
    evaluate: (ctx) => !ctx.agentQuarantined,
  });

  registerInvariant({
    id: 'CAPABILITY_TOKEN_FOR_TOOL',
    description: 'Tool execution requires a valid capability context.',
    evaluate: (ctx, phase) => {
      if (phase !== 'executeTool') return true;
      if (!ctx.requireCapabilityToken) return true;
      return ctx.capabilityTokenPresent === true;
    },
  });
}

/**
 * Evaluate all registered invariants for the given context and phase.
 */
export function assertInvariants(ctx: InvariantContext, phase: InvariantPhase): InvariantResult {
  if (invariants.length === 0) {
    registerDefaultInvariants();
  }

  const violations: InvariantViolation[] = [];

  for (const invariant of invariants) {
    try {
      const ok = invariant.evaluate(ctx, phase);
      if (!ok) {
        violations.push({
          invariant,
          phase,
          message: `Invariant ${invariant.id} violated during ${phase}`,
        });
      }
    } catch (err) {
      violations.push({
        invariant,
        phase,
        message: `Invariant ${invariant.id} threw: ${(err as Error).message}`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Reset all registered invariants — for test isolation only.
 */
export function resetInvariants(): void {
  invariants.length = 0;
}
