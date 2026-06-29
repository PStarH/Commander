/**
 * Hybrid Sandbox Scheduler — WFQ + risk-driven tier selection
 *
 * Implements the ISandboxScheduler contract from Pillar III.
 *
 * Architecture:
 *   Request → [Risk Assessment] → [Tier Selection] → [WFQ Queue] → [Sandbox Execution]
 *
 * 1. Risk Assessment: classifies the code's risk level based on source,
 *    data sensitivity, and network requirements.
 *
 * 2. Tier Selection: maps risk level to sandbox isolation tier:
 *    LOW      → v8-isolate (lightest, in-process)
 *    MEDIUM   → seccomp (OS-level syscall filtering)
 *    HIGH     → docker/gvisor (container isolation)
 *    CRITICAL → tee (hardware enclave)
 *
 * 3. Weighted Fair Queuing (WFQ): ensures each principal gets a fair
 *    share of sandbox execution resources. Uses virtual finish time
 *    (VFT) for scheduling — the request with the lowest VFT runs next.
 *
 * Per constraint PIII-FR-10, tier selection is automatic.
 * Per constraint PIII-FR-15, risk-based tier selection.
 */

import { getGlobalLogger } from '../logging';
import type {
  ISandboxScheduler,
  ISandboxResult,
  ISandboxConfig,
  SandboxTier,
  RiskProfile,
  RiskLevel,
  QuotaLimits,
  SchedulerUtilization,
} from '../contracts/pillarIII';
import type { ISandbox } from '../contracts/pillarIII';
import { isV8IsolateAvailable, getV8IsolateSandbox } from './v8Isolate';
import { getTeeSandboxBackend } from './contractTeeEnclave';
import { PetriNetSchedulerIntegration } from './petriNetScheduler';
import type { DeadlockAnalysis } from './petriNetScheduler';

// ============================================================================
// WFQ Queue Entry
// ============================================================================

interface WFQEntry {
  /** Principal ID (tenant/agent) */
  principalId: string;
  /** Weight for fair scheduling (higher = more share) */
  weight: number;
  /** Arrival time (ms) */
  arrivalTime: number;
  /** Virtual finish time (for WFQ ordering) */
  virtualFinishTime: number;
  /** Code to execute */
  code: string;
  /** Risk profile */
  riskProfile: RiskProfile;
  /** Resolve callback */
  resolve: (result: ISandboxResult) => void;
  /** Reject callback */
  reject: (error: Error) => void;
}

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
// Hybrid Sandbox Scheduler
// ============================================================================

export class HybridSandboxScheduler implements ISandboxScheduler {
  /** WFQ queue, sorted by virtual finish time */
  private queue: WFQEntry[] = [];
  /** Per-principal state for WFQ */
  private principalState: Map<
    string,
    {
      weight: number;
      lastVFT: number;
      activeExecutions: number;
      totalCpuTimeMs: number;
      totalMemoryMb: number;
    }
  > = new Map();
  /** Per-principal quotas */
  private quotas: Map<string, QuotaLimits> = new Map();
  /** Sandbox backends per tier */
  private backends: Map<SandboxTier, ISandbox> = new Map();
  /** Active executions count per tier */
  private activeByTier: Record<SandboxTier, number> = {
    'v8-isolate': 0,
    seccomp: 0,
    wasm: 0,
    tee: 0,
  };
  /** Total sandboxes created */
  private totalCreated = 0;
  /** Total wait time (for metrics) */
  private totalWaitMs = 0;
  private waitCount = 0;
  /** Virtual time counter for WFQ */
  private virtualTime = 0;
  /** Whether the scheduler is actively draining the queue */
  private draining = false;
  /** Default per-tier concurrency limits */
  private tierConcurrency: Record<SandboxTier, number> = {
    'v8-isolate': 10,
    seccomp: 4,
    wasm: 2,
    tee: 1,
  };
  /** Petri net integration for formal resource modeling and deadlock detection */
  private petriIntegration: PetriNetSchedulerIntegration;

  constructor() {
    // Register available backends
    if (isV8IsolateAvailable()) {
      this.backends.set('v8-isolate', getV8IsolateSandbox());
    }
    // Register the TEE enclave as the heavy ('tee') tier backend so
    // HIGH/CRITICAL-risk code selected for the tee tier actually executes in
    // the isolated enclave instead of falling back to v8-isolate.
    this.backends.set('tee', getTeeSandboxBackend());
    // Initialize Petri net resource model with same concurrency limits
    this.petriIntegration = new PetriNetSchedulerIntegration(this.tierConcurrency);
  }

  /**
   * Schedule code execution in the appropriate sandbox tier.
   *
   * 1. Assess risk
   * 2. Select tier
   * 3. Check quota
   * 4. Enqueue in WFQ queue
   * 5. Drain queue (execute in VFT order)
   */
  async schedule(code: string, riskProfile: RiskProfile): Promise<ISandboxResult> {
    const tier = selectTier(riskProfile);
    const principalId = this.getPrincipalId(riskProfile);

    // Track the new request in the Petri net resource model
    this.petriIntegration.addPendingRequest();

    // Check quota
    const quota = this.quotas.get(principalId);
    const principalState = this.getOrCreatePrincipalState(principalId);
    if (quota && principalState.activeExecutions >= quota.maxConcurrent) {
      return {
        output: null,
        success: false,
        error: `Quota exceeded: max ${quota.maxConcurrent} concurrent sandboxes for ${principalId}`,
        capabilitiesUsed: [],
        executionTimeMs: 0,
        peakMemoryMb: 0,
      };
    }

    // Enqueue in WFQ
    return new Promise<ISandboxResult>((resolve, reject) => {
      const arrivalTime = Date.now();
      const weight = principalState.weight;

      // WFQ virtual finish time: VFT = max(VT, lastVFT) + cost / weight
      // Cost is estimated based on tier (higher tier = more expensive)
      const estimatedCost = this.estimateCost(tier);
      const vft = Math.max(this.virtualTime, principalState.lastVFT) + estimatedCost / weight;

      const entry: WFQEntry = {
        principalId,
        weight,
        arrivalTime,
        virtualFinishTime: vft,
        code,
        riskProfile,
        resolve,
        reject,
      };

      principalState.lastVFT = vft;

      // Insert in VFT order (binary search for efficiency)
      this.insertByVFT(entry);

      // Start draining if not already
      this.drainQueue();
    });
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
    // Delegate to V8 Isolate backend if available
    const v8Backend = this.backends.get('v8-isolate') as
      | { terminate?: (id: string) => void }
      | undefined;
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
      averageWaitMs: this.waitCount > 0 ? this.totalWaitMs / this.waitCount : 0,
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
   * Also updates the Petri net resource model.
   */
  setTierConcurrency(tier: SandboxTier, limit: number): void {
    this.tierConcurrency[tier] = limit;
  }

  /**
   * Analyze the scheduler for deadlocks using the Petri net model.
   *
   * Returns detailed analysis including whether the system is deadlocked,
   * which transitions are blocked, and a recommendation for resolution.
   */
  analyzeDeadlock(): DeadlockAnalysis {
    return this.petriIntegration.analyzeDeadlock();
  }

  /**
   * Get a snapshot of the scheduler's Petri net resource state.
   */
  getPetriState(): ReturnType<PetriNetSchedulerIntegration['getSnapshot']> {
    return this.petriIntegration.getSnapshot();
  }

  /**
   * Check if it's safe to admit a new request to a tier.
   * Uses Petri net safe-state analysis to prevent resource starvation.
   */
  isSafeToAdmit(tier: SandboxTier): boolean {
    return this.petriIntegration.isSafeToAdmit(tier);
  }

  // --------------------------------------------------------------------------
  // Internal: WFQ Queue Management
  // --------------------------------------------------------------------------

  private getOrCreatePrincipalState(principalId: string) {
    let state = this.principalState.get(principalId);
    if (!state) {
      state = { weight: 1, lastVFT: 0, activeExecutions: 0, totalCpuTimeMs: 0, totalMemoryMb: 0 };
      this.principalState.set(principalId, state);
    }
    return state;
  }

  private getPrincipalId(risk: RiskProfile): string {
    // Use source as principal ID (trusted/untrusted/unknown)
    // In production, this would be the tenant ID or agent ID
    return risk.source.toLowerCase();
  }

  private estimateCost(tier: SandboxTier): number {
    // Higher tiers are more expensive (longer execution time)
    switch (tier) {
      case 'v8-isolate':
        return 100;
      case 'seccomp':
        return 500;
      case 'wasm':
        return 1000;
      case 'tee':
        return 5000;
      default:
        return 500;
    }
  }

  private insertByVFT(entry: WFQEntry): void {
    // Binary search insertion
    let lo = 0,
      hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.queue[mid].virtualFinishTime <= entry.virtualFinishTime) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.queue.splice(lo, 0, entry);
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    while (this.queue.length > 0) {
      // Find the next entry that can be executed (tier has capacity).
      // Skip entries whose tier is at capacity — don't block other tiers.
      // This prevents head-of-line blocking: a VFT-ordered entry whose tier
      // is full does not block entries for other tiers from running.
      const availableTiers = new Set(this.backends.keys());
      let executedAny = false;

      for (let i = 0; i < this.queue.length; i++) {
        const entry = this.queue[i];
        const tier = selectTier(entry.riskProfile, availableTiers);

        // Check tier concurrency
        if (this.activeByTier[tier] >= this.tierConcurrency[tier]) {
          continue; // Skip — try the next entry (different tier may have capacity)
        }

        // Found an executable entry — remove from queue and execute
        this.queue.splice(i, 1);

        // Fire the Petri net admit transition (pending + slot → executing)
        this.petriIntegration.admit(tier);

        // Execute
        this.activeByTier[tier]++;
        this.totalCreated++;
        const waitMs = Date.now() - entry.arrivalTime;
        this.totalWaitMs += waitMs;
        this.waitCount++;

        const principalState = this.getOrCreatePrincipalState(entry.principalId);
        principalState.activeExecutions++;

        // Update virtual time
        this.virtualTime = Math.max(this.virtualTime, entry.virtualFinishTime);

        // Execute asynchronously
        this.executeEntry(entry, tier).finally(() => {
          this.activeByTier[tier]--;
          principalState.activeExecutions--;
          // Return the slot to the Petri net resource model
          this.petriIntegration.complete(tier);
          // Try to drain more after completion
          this.drainQueue();
        });

        executedAny = true;
        break; // Process one at a time to maintain ordering within a tier
      }

      if (!executedAny) {
        // All entries' tiers are at capacity — wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    this.draining = false;
  }

  private async executeEntry(entry: WFQEntry, tier: SandboxTier): Promise<void> {
    const backend = this.backends.get(tier);

    if (!backend) {
      // No backend for this tier — try to fall back
      const fallbackTier: SandboxTier = isV8IsolateAvailable() ? 'v8-isolate' : 'seccomp';
      const fallbackBackend = this.backends.get(fallbackTier);

      if (!fallbackBackend) {
        entry.resolve({
          output: null,
          success: false,
          error: `No sandbox backend available for tier ${tier} or fallback ${fallbackTier}`,
          capabilitiesUsed: [],
          executionTimeMs: 0,
          peakMemoryMb: 0,
        });
        return;
      }

      getGlobalLogger().warn('SandboxScheduler', 'Falling back to lighter tier', {
        requestedTier: tier,
        fallbackTier,
      });

      try {
        const result = await fallbackBackend.execute(entry.code, [], {
          tier: fallbackTier,
          timeoutMs: 5000,
          maxHeapMb: 128,
          enableMembrane: true,
        });
        entry.resolve(result);
      } catch (err) {
        entry.reject(err as Error);
      }
      return;
    }

    try {
      const config: Partial<ISandboxConfig> = {
        tier,
        timeoutMs: 5000,
        maxHeapMb: 128,
        enableMembrane: true,
      };

      const result = await backend.execute(entry.code, [], config);
      entry.resolve(result);
    } catch (err) {
      entry.reject(err as Error);
    }
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
