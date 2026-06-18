/**
 * @commander/security — Sandbox, Isolation & Policy Enforcement
 *
 * Public API surface for Commander's security domain.
 * Re-exports from @commander/core with a stable, documented surface.
 *
 * ## What's here
 * - SandboxManager — multi-mechanism sandbox (local/SSH/docker)
 * - SandboxProfile — execution confinement profiles
 * - ExecPolicyEngine — command allowlisting
 * - PrivacyRouter — sensitive data detection & routing
 * - AuthManager — API key validation & RBAC
 * - Keychain — credential management
 * - ContentScanner — unsafe pattern detection
 * - CompensationRegistry — mutation rollback
 *
 * ## What's NOT here (moved to @commander/core)
 * - AgentRuntime (execution engine)
 * - Topology routing (orchestration)
 * - Tool execution (tool subsystem)
 *
 * ## What's NOT here (moved to @commander/observability)
 * - Metrics collection
 * - Execution tracing
 * - OpenTelemetry export
 */

// ── Sandbox ─────────────────────────────────────────────────────────────────
export { SandboxManager, getSandboxManager, resetSandboxManager } from '@commander/core';

export type {
  SandboxMode,
  SandboxProfile,
  SandboxMechanism,
  NetworkPolicy,
  FileAccessPolicy,
  SandboxExecutionResult,
  PlatformSandbox,
} from '@commander/core';

// ── Execution Policy ────────────────────────────────────────────────────────
export { ExecPolicyEngine } from '@commander/core';

// ── Privacy ─────────────────────────────────────────────────────────────────
export { PrivacyRouter, getPrivacyRouter, resetPrivacyRouter } from '@commander/core';

export type {
  PrivacyRouterConfig,
  PrivacyDecision,
  PrivacyRoute,
  SensitivityMatch,
  SensitivityCategory,
} from '@commander/core';

// ── Authentication ──────────────────────────────────────────────────────────
export { AuthManager } from '@commander/core';

// ── Credential Management ───────────────────────────────────────────────────
export { CredentialManager } from '@commander/core';

// ── Content Security ────────────────────────────────────────────────────────
export { ContentScanner } from '@commander/core';

// ── Compensation ────────────────────────────────────────────────────────────
export {
  CompensationRegistry,
  type CompensableAction,
  type CompensationHandler,
} from '@commander/core';

// ── Hallucination Detection ─────────────────────────────────────────────────
export { HallucinationDetector } from '@commander/core';

// ── Security Audit ──────────────────────────────────────────────────────────
export { SecurityAuditLogger } from '@commander/core';
export { SecurityMonitor } from '@commander/core';

// ── Guardian Agent ──────────────────────────────────────────────────────────
export { GuardianAgent } from '@commander/core';
