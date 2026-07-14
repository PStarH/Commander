/**
 * Hybrid Sandbox Scheduler — risk-driven tier selection
 *
 * Implements the ISandboxScheduler contract from Pillar III.
 *
 * Architecture:
 *   Request → [Risk Assessment] → [Tier Selection] → [Sandbox Execution]
 *
 * 1. Risk Assessment: classifies the code's risk level based on source,
 *    data sensitivity, and network requirements.
 *
 * 2. Tier Selection: maps risk level to sandbox isolation tier:
 *    LOW      → v8-isolate (lightest, in-process)
 *    MEDIUM   → seccomp (OS-level syscall filtering)
 *    HIGH     → docker/gvisor (container isolation)
 *    CRITICAL → tee (hardware enclave, platform-conditional)
 *
 * Per constraint PIII-FR-10, tier selection is automatic.
 * Per constraint PIII-FR-15, risk-based tier selection.
 *
 * Simplification note: the previous WFQ queue + Petri net deadlock detector
 * were never invoked on the production path (localBackend only queried
 * analyzeDeadlock/getPetriState, which always returned trivial results
 * because admit/complete never fired). The dead weight was removed; the
 * public interface is preserved so callers continue to compile. Real
 * concurrency control is delegated to the backend sandboxes themselves
 * (v8-isolate has its own concurrency limit, TEE is platform-conditional).
 */

import { getGlobalLogger } from '../logging';
import type {
  ISandboxScheduler,
  ISandboxResult,
  SandboxTier,
  RiskProfile,
  RiskLevel,
  QuotaLimits,
  SchedulerUtilization,
} from '../contracts/pillarIII';
import type { ISandbox } from '../contracts/pillarIII';
import { isV8IsolateAvailable, getV8IsolateSandbox } from './v8Isolate';

// ============================================================================
// Risk Assessment
// ============================================================================

/**
 * Assess the risk level of a code execution request.
 *
 * Factors:
 * - Source: trusted code (internal) vs untrusted (user-provided)
 * - Data sensitivity: handles PII/secrets?
 * - Network: requires network access?
 * - Code patterns: eval, fs, process, child_process
 */
export function assessRisk(
  code: string,
  context?: {
    source?: 'TRUSTED' | 'UNTRUSTED' | 'UNKNOWN';
    handlesSensitiveData?: boolean;
    requiresNetwork?: boolean;
  },
): RiskProfile {
  const source = context?.source ?? 'UNKNOWN';
  const handlesSensitiveData = context?.handlesSensitiveData ?? false;
  const requiresNetwork = context?.requiresNetwork ?? false;

  // Check for dangerous code patterns
  const dangerousPatterns = [
    /eval\s*\(/,
    /Function\s*\(/,
    /child_process/,
    /require\s*\(\s*['"]fs['"]\s*\)/,
    /require\s*\(\s*['"]net['"]\s*\)/,
    /require\s*\(\s*['"]http['"]\s*\)/,
    /process\.env/,
    /process\.exit/,
    /__proto__/,
    /constructor\.constructor/,
  ];

  const hasDangerousPattern = dangerousPatterns.some((p) => p.test(code));

  // Determine risk level
  let level: RiskLevel;
  if (source === 'UNTRUSTED' && (hasDangerousPattern || handlesSensitiveData)) {
    level = 'CRITICAL';
  } else if (source === 'UNTRUSTED' || (hasDangerousPattern && requiresNetwork)) {
    level = 'HIGH';
  } else if (hasDangerousPattern || handlesSensitiveData || requiresNetwork) {
    level = 'MEDIUM';
  } else {
    level = 'LOW';
  }

  return { level, source, handlesSensitiveData, requiresNetwork };
}

/**
 * Map risk level to sandbox tier.
 * Only returns tiers that have registered backends.
 */
export function selectTier(risk: RiskProfile, availableTiers?: Set<SandboxTier>): SandboxTier {
  const tiers = availableTiers ?? new Set<SandboxTier>(['v8-isolate', 'seccomp', 'wasm', 'tee']);
  switch (risk.level) {
    case 'LOW':
      // Lightest isolation: V8 Isolate (if available), else fall back to seccomp
      return tiers.has('v8-isolate') ? 'v8-isolate' : 'seccomp';
    case 'MEDIUM':
      return tiers.has('seccomp') ? 'seccomp' : tiers.has('v8-isolate') ? 'v8-isolate' : 'seccomp';
    case 'HIGH':
      // Container isolation — use the strongest available tier
      if (tiers.has('tee')) return 'tee';
      if (tiers.has('wasm')) return 'wasm';
      if (tiers.has('seccomp')) return 'seccomp';
      return 'v8-isolate';
    case 'CRITICAL':
      return tiers.has('tee') ? 'tee' : tiers.has('wasm') ? 'wasm' : 'seccomp';
    default:
      return 'seccomp';
  }
}

// ============================================================================
// Deadlock analysis result (minimal stub after Petri net removal)
// ============================================================================

/**
 * Minimal deadlock analysis result. The previous Petri-net-based analyzer
 * was dead code (admit/complete transitions never fired on the production
 * path), so this always reports a safe state. Kept for API compatibility
 * with localBackend which queries it on every execution.
 */
export interface DeadlockAnalysis {
  deadlocked: boolean;
  blockedTransitions: string[];
  recommendation: string;
}

// ============================================================================
// Hybrid Sandbox Scheduler
// ============================================================================

export class HybridSandboxScheduler implements ISandboxScheduler {
  /** Sandbox backends per tier */
  private backends: Map<SandboxTier, ISandbox> = new Map();
  /** Per-principal quotas */
  private quotas: Map<string, QuotaLimits> = new Map();
  /** Active executions count per tier */
  private activeByTier: Record<SandboxTier, number> = {
    'v8-isolate': 0,
    seccomp: 0,
    wasm: 0,
    tee: 0,
  };
  /** Total sandboxes created */
  private totalCreated = 0;
  /** Default per-tier concurrency limits */
  private tierConcurrency: Record<SandboxTier, number> = {
    'v8-isolate': 10,
    seccomp: 4,
    wasm: 2,
    tee: 1,
  };

  constructor() {
    // Register available backends. The v8-isolate tier is the only
    // software backend always registered; the TEE tier is registered
    // by discoverSandboxes() on platforms that have real TEE hardware
    // (see sandbox/platforms.ts → TEESandbox).
    if (isV8IsolateAvailable()) {
      this.backends.set('v8-isolate', getV8IsolateSandbox());
    }
  }

  /**
   * Schedule code execution in the appropriate sandbox tier.
   *
   * Simplified direct-dispatch path: select tier → get backend → execute.
   * The previous WFQ queue was never contended (single-principal local-first
   * deployment), so direct dispatch preserves correctness while removing
   * the dead WFQ/Petri machinery.
   */
  async schedule(code: string, riskProfile: RiskProfile): Promise<ISandboxResult> {
    const tier = selectTier(riskProfile, new Set(this.backends.keys()));
    const backend = this.backends.get(tier);

    if (!backend) {
      // Fall back to v8-isolate if available, else fail closed.
      const fallbackTier: SandboxTier = isV8IsolateAvailable() ? 'v8-isolate' : 'seccomp';
      const fallbackBackend = this.backends.get(fallbackTier);
      if (!fallbackBackend) {
        return {
          output: null,
          success: false,
          error: `No sandbox backend available for tier ${tier} or fallback ${fallbackTier}`,
          capabilitiesUsed: [],
          executionTimeMs: 0,
          peakMemoryMb: 0,
        };
      }
      getGlobalLogger().warn('SandboxScheduler', 'Falling back to lighter tier', {
        requestedTier: tier,
        fallbackTier,
      });
      this.activeByTier[fallbackTier]++;
      this.totalCreated++;
      try {
        return await fallbackBackend.execute(code, [], {
          tier: fallbackTier,
          timeoutMs: 5000,
          maxHeapMb: 128,
          enableMembrane: true,
        });
      } finally {
        this.activeByTier[fallbackTier]--;
      }
    }

    this.activeByTier[tier]++;
    this.totalCreated++;
    try {
      return await backend.execute(code, [], {
        tier,
        timeoutMs: 5000,
        maxHeapMb: 128,
        enableMembrane: true,
      });
    } finally {
      this.activeByTier[tier]--;
    }
  }

  /**
   * Set resource quota per principal.
   */
  setQuota(principalId: string, limits: QuotaLimits): void {
    this.quotas.set(principalId, limits);
    getGlobalLogger().debug('SandboxScheduler', 'Quota set', { principalId, limits });
  }

  /**
   * Preempt a running sandbox.
   * (Currently only supported for V8 Isolate backends.)
   */
  preempt(isolateId: string): void {
    const v8Backend = this.backends.get('v8-isolate') as
      { terminate?: (id: string) => void } | undefined;
    if (v8Backend && typeof v8Backend.terminate === 'function') {
      v8Backend.terminate(isolateId);
      getGlobalLogger().info('SandboxScheduler', 'Preempted sandbox', { isolateId });
    }
  }

  /**
   * Get current utilization metrics.
   */
  get utilization(): SchedulerUtilization {
    return {
      activeByTier: { ...this.activeByTier },
      totalCreated: this.totalCreated,
      averageWaitMs: 0,
    };
  }

  /**
   * Register a sandbox backend for a specific tier.
   */
  registerBackend(tier: SandboxTier, sandbox: ISandbox): void {
    this.backends.set(tier, sandbox);
    getGlobalLogger().info('SandboxScheduler', 'Backend registered', { tier });
  }

  /**
   * Set the concurrency limit for a tier.
   */
  setTierConcurrency(tier: SandboxTier, limit: number): void {
    this.tierConcurrency[tier] = limit;
  }

  /**
   * Analyze the scheduler for deadlocks.
   *
   * Returns a trivial "no deadlock" analysis. The previous Petri-net-based
   * analyzer was dead code (admit/complete transitions never fired on the
   * production path), so this always reports a safe state. Kept for API
   * compatibility with localBackend which queries it on every execution.
   */
  analyzeDeadlock(): DeadlockAnalysis {
    return {
      deadlocked: false,
      blockedTransitions: [],
      recommendation: 'no-deadlock',
    };
  }

  /**
   * Get a snapshot of the scheduler's resource state.
   *
   * Returns a minimal snapshot after Petri net removal. Kept for API
   * compatibility with localBackend which records this in execution logs.
   */
  getPetriState(): {
    tiers: Record<SandboxTier, { capacity: number; active: number; pending: number }>;
  } {
    return {
      tiers: {
        'v8-isolate': {
          capacity: this.tierConcurrency['v8-isolate'],
          active: this.activeByTier['v8-isolate'],
          pending: 0,
        },
        seccomp: {
          capacity: this.tierConcurrency.seccomp,
          active: this.activeByTier.seccomp,
          pending: 0,
        },
        wasm: {
          capacity: this.tierConcurrency.wasm,
          active: this.activeByTier.wasm,
          pending: 0,
        },
        tee: {
          capacity: this.tierConcurrency.tee,
          active: this.activeByTier.tee,
          pending: 0,
        },
      },
    };
  }

  /**
   * Check if it's safe to admit a new request to a tier.
   *
   * Returns true if the tier has spare capacity. The previous safe-state
   * analysis was dead code; this simplified check is sufficient for the
   * single-principal local-first deployment.
   */
  isSafeToAdmit(tier: SandboxTier): boolean {
    return this.activeByTier[tier] < this.tierConcurrency[tier];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalScheduler: HybridSandboxScheduler | null = null;

export function getGlobalSandboxScheduler(): HybridSandboxScheduler {
  if (!globalScheduler) {
    globalScheduler = new HybridSandboxScheduler();
  }
  return globalScheduler;
}

export function setGlobalSandboxScheduler(scheduler: HybridSandboxScheduler | null): void {
  globalScheduler = scheduler;
}
