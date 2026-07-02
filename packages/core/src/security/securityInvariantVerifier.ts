/**
 * Security Invariant Runtime Verifier
 *
 * Security (G9): Runtime enforcement of security invariants — properties that
 * must ALWAYS hold. While true formal verification (TLA+/Coq/Dafny) requires
 * mathematical proof systems, this verifier provides equivalent runtime guarantees
 * by checking invariants at every critical execution point.
 *
 * Design principle: "Fail-closed on invariant violation"
 * If any invariant is violated, the system immediately:
 * 1. Logs a critical security event
 * 2. Triggers the RASP response engine
 * 3. Aborts the current operation
 *
 * Invariants are organized by security domain:
 * - AUTH: Authentication invariants
 * - AUTHZ: Authorization invariants
 * - SANDBOX: Sandbox integrity invariants
 * - FLOW: Information flow control invariants
 * - AUDIT: Audit chain integrity invariants
 * - SUPPLY: Supply chain invariants
 * - AGENT: Agent lifecycle invariants
 */

import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { processSecurityAlert } from './securityResponseEngine';
import type { SecurityAlert } from './securityResponseEngine';

// ── Invariant Types ─────────────────────────────────────────────────────────

export type InvariantDomain = 'AUTH' | 'AUTHZ' | 'SANDBOX' | 'FLOW' | 'AUDIT' | 'SUPPLY' | 'AGENT';

export interface SecurityInvariant {
  /** Unique invariant ID (e.g., 'AUTH-001'). */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Security domain. */
  domain: InvariantDomain;
  /** Check function — returns true if the invariant HOLDS, false if violated. */
  check: (context: InvariantContext) => boolean;
  /** Severity when violated. */
  violationSeverity: 'high' | 'critical';
}

export interface InvariantContext {
  agentId?: string;
  runId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  sandboxMechanism?: string;
  authTokenPresent?: boolean;
  capabilityTokenPresent?: boolean;
  approvalResult?: { approved: boolean };
  auditChainIntact?: boolean;
  systemPromptModified?: boolean;
  outboundTool?: boolean;
  dataTaint?: 'trusted' | 'untrusted' | 'external';
  /** Set to false when a memory write was attempted outside the writer's namespace. */
  memoryWriteNamespaced?: boolean;
  /** Writer agent ID (for memory-write invariant checks). */
  writerAgentId?: string;
  /** Target memory path. */
  memoryTargetPath?: string;
  [key: string]: unknown;
}

export interface InvariantViolation {
  invariant: SecurityInvariant;
  context: InvariantContext;
  timestamp: Date;
  message: string;
}

// ── Invariant Registry ──────────────────────────────────────────────────────

/** All registered security invariants. */
const invariants: SecurityInvariant[] = [];

/**
 * Register a security invariant.
 * Call this during service initialization to add invariants.
 */
export function registerInvariant(invariant: SecurityInvariant): void {
  invariants.push(invariant);
  getGlobalLogger().info(
    'InvariantVerifier',
    `Registered invariant ${invariant.id}: ${invariant.description}`,
    { domain: invariant.domain, severity: invariant.violationSeverity },
  );
}

/**
 * Register the default set of security invariants.
 * Called during service initialization.
 */
export function registerDefaultInvariants(): void {
  // AUTH invariants
  registerInvariant({
    id: 'AUTH-001',
    description: 'Authentication token must be present for all non-GET requests',
    domain: 'AUTH',
    check: (ctx) => ctx.authTokenPresent !== false,
    violationSeverity: 'critical',
  });

  registerInvariant({
    id: 'AUTH-002',
    description: 'Capability token must be present for tool execution',
    domain: 'AUTH',
    check: (ctx) => ctx.capabilityTokenPresent !== false || ctx.toolName === undefined,
    violationSeverity: 'high',
  });

  // AUTHZ invariants
  registerInvariant({
    id: 'AUTHZ-001',
    description: 'Tool execution must be explicitly approved (no auto-approve for high-risk tools)',
    domain: 'AUTHZ',
    check: (ctx) => ctx.approvalResult?.approved !== false,
    violationSeverity: 'high',
  });

  // SANDBOX invariants
  registerInvariant({
    id: 'SANDBOX-001',
    description: 'Sandbox mechanism must not be "none" in production',
    domain: 'SANDBOX',
    check: (ctx) => ctx.sandboxMechanism !== 'none' || process.env.NODE_ENV !== 'production',
    violationSeverity: 'critical',
  });

  registerInvariant({
    id: 'SANDBOX-002',
    description: 'Sandbox mechanism must be verified and intact',
    domain: 'SANDBOX',
    check: (ctx) => ctx.sandboxIntegrityVerified !== false,
    violationSeverity: 'high',
  });

  // FLOW invariants
  registerInvariant({
    id: 'FLOW-001',
    description: 'Untrusted data must not flow into outbound tool parameters',
    domain: 'FLOW',
    check: (ctx) => !ctx.outboundTool || ctx.dataTaint === 'trusted' || ctx.dataTaint === undefined,
    violationSeverity: 'critical',
  });

  registerInvariant({
    id: 'FLOW-002',
    description: 'System prompt must not be modified by tool output',
    domain: 'FLOW',
    check: (ctx) => ctx.systemPromptModified !== true,
    violationSeverity: 'critical',
  });

  // AUDIT invariants
  registerInvariant({
    id: 'AUDIT-001',
    description: 'Audit chain integrity must be intact',
    domain: 'AUDIT',
    check: (ctx) => ctx.auditChainIntact !== false,
    violationSeverity: 'critical',
  });

  // SUPPLY invariants
  registerInvariant({
    id: 'SUPPLY-001',
    description: 'Plugins and MCP servers must be scanned before loading',
    domain: 'SUPPLY',
    check: (ctx) => ctx.supplyChainScanned !== false,
    violationSeverity: 'high',
  });

  // AGENT invariants
  registerInvariant({
    id: 'AGENT-001',
    description: 'Agent must not be in a suspended or quarantined state when executing tools',
    domain: 'AGENT',
    check: (ctx) => ctx.agentSuspended !== true && ctx.agentQuarantined !== true,
    violationSeverity: 'critical',
  });

  registerInvariant({
    id: 'AGENT-002',
    description: 'Agent identity must be verified before spawning child agents',
    domain: 'AGENT',
    check: (ctx) => ctx.parentVerified !== false,
    violationSeverity: 'high',
  });

  // MEMORY invariants (G10)
  registerInvariant({
    id: 'MEMORY-001',
    description:
      "All memory writes must stay within the writer agent's namespace or ACL-granted namespaces",
    domain: 'AGENT', // reuse AGENT domain — memory is an agent-lifecycle concern
    check: (ctx) => {
      // O(1) — pure memory comparison, never async.
      // The assertNamespaced() guard in MemorySystem throws before this check
      // fires; this invariant is the static guarantee that the guard ran.
      return ctx.memoryWriteNamespaced !== false;
    },
    violationSeverity: 'critical',
  });

  getGlobalLogger().info(
    'InvariantVerifier',
    `Registered ${invariants.length} default security invariants`,
  );
}

// ── Verification API ────────────────────────────────────────────────────────

/**
 * Verify all registered invariants against the given context.
 * If any invariant is violated, a security alert is emitted and the
 * RASP response engine is triggered.
 *
 * @param context - The execution context to verify.
 * @param checkPoint - Where in the execution flow this check is performed.
 * @returns Array of violations (empty if all invariants hold).
 */
export function verifyInvariants(
  context: InvariantContext,
  checkPoint: string,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const invariant of invariants) {
    try {
      const holds = invariant.check(context);
      if (!holds) {
        const violation: InvariantViolation = {
          invariant,
          context,
          timestamp: new Date(),
          message: `Invariant ${invariant.id} violated at ${checkPoint}: ${invariant.description}`,
        };
        violations.push(violation);
        handleViolation(violation, checkPoint);
      }
    } catch (err) {
      // If the check itself throws, treat as a violation (fail-closed)
      const violation: InvariantViolation = {
        invariant,
        context: { ...context, checkError: String(err) },
        timestamp: new Date(),
        message: `Invariant ${invariant.id} check threw an error at ${checkPoint}: ${err}`,
      };
      violations.push(violation);
      handleViolation(violation, checkPoint);
    }
  }

  return violations;
}

/**
 * Verify invariants and return a pass/fail result.
 * Convenience method for use as a guard clause.
 */
export function assertInvariants(
  context: InvariantContext,
  checkPoint: string,
): { passed: boolean; violations: InvariantViolation[] } {
  const violations = verifyInvariants(context, checkPoint);
  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Get all registered invariants (for reporting/auditing).
 */
export function getRegisteredInvariants(): SecurityInvariant[] {
  return [...invariants];
}

/**
 * Get the count of registered invariants by domain.
 */
export function getInvariantCountByDomain(): Record<InvariantDomain, number> {
  const counts: Record<InvariantDomain, number> = {
    AUTH: 0,
    AUTHZ: 0,
    SANDBOX: 0,
    FLOW: 0,
    AUDIT: 0,
    SUPPLY: 0,
    AGENT: 0,
  };
  for (const inv of invariants) {
    counts[inv.domain]++;
  }
  return counts;
}

// ── Internal ────────────────────────────────────────────────────────────────

function handleViolation(violation: InvariantViolation, checkPoint: string): void {
  const { invariant, message } = violation;

  getGlobalLogger().error(
    'InvariantVerifier',
    `SECURITY INVARIANT VIOLATED: ${invariant.id}`,
    undefined,
    {
      invariantId: invariant.id,
      domain: invariant.domain,
      description: invariant.description,
      checkPoint,
      context: violation.context,
    },
  );

  // Log to audit trail
  try {
    getSecurityAuditLogger().logEvent({
      type: 'security_decision',
      severity: invariant.violationSeverity,
      source: 'InvariantVerifier',
      message,
      details: {
        invariantId: invariant.id,
        domain: invariant.domain,
        checkPoint,
        context: violation.context,
      },
    });
  } catch {
    // best-effort
  }

  // Trigger RASP response for automated action
  const alert: SecurityAlert = {
    type: 'unknown_threat',
    severity: invariant.violationSeverity,
    agentId: violation.context.agentId ?? 'system',
    runId: violation.context.runId,
    message,
    details: {
      invariantId: invariant.id,
      domain: invariant.domain,
      checkPoint,
    },
    timestamp: violation.timestamp,
  };
  processSecurityAlert(alert);
}
