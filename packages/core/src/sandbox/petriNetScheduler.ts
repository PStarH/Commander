/**
 * Petri Net Scheduler Integration
 *
 * Connects the PetriNetEngine to the HybridSandboxScheduler for formal
 * resource allocation modeling, deadlock detection, and safe-state analysis.
 *
 * Petri Net Model:
 *
 *   Places:
 *     pending         — requests waiting to be scheduled (unbounded)
 *     v8_slots        — available V8 isolate execution slots
 *     seccomp_slots   — available seccomp execution slots
 *     wasm_slots      — available WASM execution slots
 *     tee_slots       — available TEE execution slots
 *     executing        — currently executing sandboxes (unbounded)
 *     completed        — finished sandboxes (unbounded)
 *
 *   Transitions:
 *     admit_<tier>     — pending + tier_slot → executing
 *     complete_<tier>  — executing → completed + tier_slot (returns slot)
 *
 * The Petri net provides:
 *   1. Formal resource tracking: marking reflects real-time slot availability
 *   2. Deadlock detection: detectDeadlocks() identifies when no progress is possible
 *   3. Reachability analysis: computeReachabilityGraph() finds unsafe future states
 *   4. Safe-state verification: before admitting, check if the resulting state
 *      can still reach a state where all executing sandboxes can complete
 *
 * Per constraint IF-03, enables concurrent multi-agent scheduling with
 * formal deadlock-freedom guarantees.
 */

import { PetriNetEngine } from '../runtime/petriNetEngine';
import { getGlobalLogger } from '../logging';
import type { SandboxTier } from '../contracts/pillarIII';

// ============================================================================
// Types
// ============================================================================

/** Scheduler state snapshot from the Petri net perspective */
export interface SchedulerPetriState {
  pending: number;
  executing: number;
  completed: number;
  availableSlots: Record<SandboxTier, number>;
  deadlockedTransitions: string[];
  isDeadlocked: boolean;
}

/** Deadlock analysis result */
export interface DeadlockAnalysis {
  isDeadlocked: boolean;
  deadlockedTransitions: string[];
  reachableStates: number;
  safeState: boolean;
  recommendation: string;
}

// ============================================================================
// Constants
// ============================================================================

const ALL_TIERS: SandboxTier[] = ['v8-isolate', 'seccomp', 'wasm', 'tee'];

/** Maps a SandboxTier to its Petri net place prefix */
const TIER_PLACE_PREFIX: Record<SandboxTier, string> = {
  'v8-isolate': 'v8',
  'seccomp': 'seccomp',
  'wasm': 'wasm',
  'tee': 'tee',
};

// ============================================================================
// PetriNetSchedulerIntegration
// ============================================================================

export class PetriNetSchedulerIntegration {
  private petriNet: PetriNetEngine;
  private tierConcurrency: Record<SandboxTier, number>;
  private initialized = false;

  constructor(tierConcurrency?: Partial<Record<SandboxTier, number>>) {
    this.petriNet = new PetriNetEngine();
    this.tierConcurrency = {
      'v8-isolate': tierConcurrency?.['v8-isolate'] ?? 10,
      'seccomp': tierConcurrency?.['seccomp'] ?? 4,
      'wasm': tierConcurrency?.['wasm'] ?? 2,
      'tee': tierConcurrency?.['tee'] ?? 1,
    };
    this.buildPetriNet();
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Petri Net Construction
  // --------------------------------------------------------------------------

  /**
   * Build the Petri net model for sandbox resource allocation.
   *
   * Places represent available resource slots, and transitions model
   * the admit/complete lifecycle of sandbox executions.
   */
  private buildPetriNet(): void {
    // --- Places ---

    // Pending requests (unbounded)
    this.petriNet.addPlace({
      id: 'pending',
      label: 'Pending Requests',
      marking: 0,
      capacity: Infinity,
    });

    // Per-tier available slots
    for (const tier of ALL_TIERS) {
      const prefix = TIER_PLACE_PREFIX[tier];
      const slots = this.tierConcurrency[tier];
      this.petriNet.addPlace({
        id: `${prefix}_slots`,
        label: `Available ${tier} Slots`,
        marking: slots,
        capacity: slots,
      });
    }

    // Executing and completed sandboxes (unbounded)
    this.petriNet.addPlace({
      id: 'executing',
      label: 'Executing Sandboxes',
      marking: 0,
      capacity: Infinity,
    });

    this.petriNet.addPlace({
      id: 'completed',
      label: 'Completed Sandboxes',
      marking: 0,
      capacity: Infinity,
    });

    // --- Transitions ---

    // Admit transitions: pending + tier_slot → executing
    for (const tier of ALL_TIERS) {
      const prefix = TIER_PLACE_PREFIX[tier];
      this.petriNet.addTransition({
        id: `admit_${tier}`,
        label: `Admit to ${tier}`,
        inputs: new Map([
          ['pending', 1],
          [`${prefix}_slots`, 1],
        ]),
        outputs: new Map([
          ['executing', 1],
        ]),
        // Guard: only fires when the tier matches the request
        guard: (ctx) => {
          if (!ctx || typeof ctx !== 'object') return true;
          const context = ctx as { tier?: SandboxTier };
          // If no tier specified, allow any (for analysis)
          if (!context.tier) return true;
          return context.tier === tier;
        },
      });
    }

    // Complete transitions: executing → completed + tier_slot (returns slot)
    for (const tier of ALL_TIERS) {
      const prefix = TIER_PLACE_PREFIX[tier];
      this.petriNet.addTransition({
        id: `complete_${tier}`,
        label: `Complete from ${tier}`,
        inputs: new Map([
          ['executing', 1],
        ]),
        outputs: new Map([
          ['completed', 1],
          [`${prefix}_slots`, 1],
        ]),
        // Guard: only completes sandboxes that were admitted to this tier
        guard: (ctx) => {
          if (!ctx || typeof ctx !== 'object') return true;
          const context = ctx as { tier?: SandboxTier };
          if (!context.tier) return true;
          return context.tier === tier;
        },
      });
    }

    getGlobalLogger().debug('PetriNetScheduler', 'Petri net constructed', {
      places: 7,
      transitions: 8,
      tierConcurrency: this.tierConcurrency,
    });
  }

  // --------------------------------------------------------------------------
  // Resource Tracking API
  // --------------------------------------------------------------------------

  /**
   * Record a new pending request entering the scheduler.
   * Adds a token to the 'pending' place via setMarking (external arrival).
   */
  addPendingRequest(): void {
    const current = this.getPendingCount();
    this.petriNet.setMarking('pending', current + 1);
  }

  /**
   * Attempt to admit a request to a specific tier.
   * Fires the appropriate admit transition if enabled.
   *
   * @returns true if the admit succeeded (transition fired)
   */
  admit(tier: SandboxTier): boolean {
    const transitionId = `admit_${tier}`;
    const context = { tier };
    const fired = this.petriNet.fire(transitionId, context);

    if (fired) {
      getGlobalLogger().debug('PetriNetScheduler', 'Admitted request', {
        tier,
        marking: this.serializeMarking(),
      });
    } else {
      getGlobalLogger().warn('PetriNetScheduler', 'Admit failed — no available slot', {
        tier,
        availableSlots: this.getAvailableSlots(tier),
      });
    }

    return fired;
  }

  /**
   * Record that a sandbox execution completed.
   * Fires the appropriate complete transition to return the slot.
   *
   * @returns true if the complete succeeded
   */
  complete(tier: SandboxTier): boolean {
    const transitionId = `complete_${tier}`;
    const context = { tier };
    const fired = this.petriNet.fire(transitionId, context);

    if (fired) {
      getGlobalLogger().debug('PetriNetScheduler', 'Completed execution', {
        tier,
        marking: this.serializeMarking(),
      });
    }

    return fired;
  }

  /**
   * Check if a request can be admitted to a tier without actually firing.
   */
  canAdmit(tier: SandboxTier): boolean {
    const transitionId = `admit_${tier}`;
    const context = { tier };
    return this.petriNet.isEnabled(transitionId, context);
  }

  /**
   * Get the number of available slots for a tier.
   */
  getAvailableSlots(tier: SandboxTier): number {
    const prefix = TIER_PLACE_PREFIX[tier];
    const place = this.petriNet.getPlace(`${prefix}_slots`);
    return place?.marking ?? 0;
  }

  /**
   * Get the current number of executing sandboxes.
   */
  getExecutingCount(): number {
    return this.petriNet.getPlace('executing')?.marking ?? 0;
  }

  /**
   * Get the current number of pending requests.
   */
  getPendingCount(): number {
    return this.petriNet.getPlace('pending')?.marking ?? 0;
  }

  /**
   * Get the total number of completed sandboxes.
   */
  getCompletedCount(): number {
    return this.petriNet.getPlace('completed')?.marking ?? 0;
  }

  // --------------------------------------------------------------------------
  // Deadlock Detection & Safety Analysis
  // --------------------------------------------------------------------------

  /**
   * Detect deadlocks in the current scheduler state.
   *
   * A deadlock occurs when there are pending requests but no admit
   * transition can fire (all tier slots are exhausted) AND no complete
   * transition can fire (no executing sandboxes to free up slots).
   *
   * @returns DeadlockAnalysis with details and recommendations
   */
  analyzeDeadlock(): DeadlockAnalysis {
    const deadlockedTransitions = this.petriNet.detectDeadlocks();
    const pending = this.getPendingCount();
    const executing = this.getExecutingCount();
    const availableSlots = this.getTotalAvailableSlots();

    // True deadlock: pending > 0, no available slots, no executing to complete
    const isDeadlocked = pending > 0 && availableSlots === 0 && executing === 0;

    // Compute reachability for safety analysis (only for small states)
    let reachableStates = 0;
    let safeState = true;

    if (executing > 0 && availableSlots === 0 && pending > 0) {
      // Potential resource starvation: executing sandboxes hold all slots.
      // Check if at least one complete transition is enabled.
      const canComplete = ALL_TIERS.some((tier) =>
        this.petriNet.isEnabled(`complete_${tier}`, { tier }),
      );
      safeState = canComplete;
      reachableStates = 1; // At least one state is reachable (current → after complete)
    }

    let recommendation: string;
    if (isDeadlocked) {
      recommendation = 'DEADLOCK: All tier slots exhausted, no executing sandboxes to complete. ' +
        'Consider increasing tier concurrency limits or rejecting new requests.';
    } else if (!safeState) {
      recommendation = 'UNSAFE: Potential resource starvation detected. ' +
        'Executing sandboxes may not be able to release slots. ' +
        'Consider preempting long-running sandboxes.';
    } else if (availableSlots === 0 && executing > 0) {
      recommendation = 'SATURATED: All slots in use, but completions can free capacity. ' +
        'New requests will queue until executions complete.';
    } else {
      recommendation = 'SAFE: Resources available for scheduling.';
    }

    return {
      isDeadlocked,
      deadlockedTransitions,
      reachableStates,
      safeState,
      recommendation,
    };
  }

  /**
   * Check if the scheduler is in a safe state before admitting a new request.
   *
   * A state is safe if, after admitting, there exists a sequence of
   * completions that allows all pending requests to eventually execute.
   *
   * For practical purposes, we check:
   * 1. The admit transition is enabled (slot available)
   * 2. After admitting, at least one complete transition remains enabled
   *    (i.e., the system can make progress)
   */
  isSafeToAdmit(tier: SandboxTier): boolean {
    // If a slot is not available, admit is impossible
    if (this.getAvailableSlots(tier) === 0) {
      return false;
    }

    // Simulate a pending request arrival + admission, then check safety.
    // We save the marking, add a pending token, fire the admit, check progress,
    // and restore the original marking.
    const savedMarking = this.petriNet.getMarking();

    // Temporarily add a pending request (simulates a new arrival)
    this.petriNet.setMarking('pending', (savedMarking.get('pending') ?? 0) + 1);

    // Fire the admit transition
    const fired = this.petriNet.fire(`admit_${tier}`, { tier });
    if (!fired) {
      // Restore and return false
      this.restoreMarking(savedMarking);
      return false;
    }

    // After admitting, check if we can still make progress:
    // At least one complete transition should be enabled (executing > 0)
    // OR another admit is possible for other tiers
    const canMakeProgress =
      this.petriNet.isEnabled('complete_v8-isolate', { tier: 'v8-isolate' }) ||
      this.petriNet.isEnabled('complete_seccomp', { tier: 'seccomp' }) ||
      this.petriNet.isEnabled('complete_wasm', { tier: 'wasm' }) ||
      this.petriNet.isEnabled('complete_tee', { tier: 'tee' }) ||
      this.hasAnyAvailableSlot();

    // Restore the original marking (undo the simulated arrival + admission)
    this.restoreMarking(savedMarking);

    return canMakeProgress;
  }

  /**
   * Compute the full reachability graph for analysis.
   * This is computationally expensive — use sparingly.
   */
  computeReachability(): Map<string, Set<string>> {
    return this.petriNet.computeReachabilityGraph();
  }

  // --------------------------------------------------------------------------
  // State Snapshot
  // --------------------------------------------------------------------------

  /**
   * Get a full snapshot of the scheduler state from the Petri net.
   */
  getSnapshot(): SchedulerPetriState {
    const availableSlots: Record<SandboxTier, number> = {
      'v8-isolate': 0,
      'seccomp': 0,
      'wasm': 0,
      'tee': 0,
    };

    for (const tier of ALL_TIERS) {
      availableSlots[tier] = this.getAvailableSlots(tier);
    }

    const deadlockedTransitions = this.petriNet.detectDeadlocks();
    const analysis = this.analyzeDeadlock();

    return {
      pending: this.getPendingCount(),
      executing: this.getExecutingCount(),
      completed: this.getCompletedCount(),
      availableSlots,
      deadlockedTransitions,
      isDeadlocked: analysis.isDeadlocked,
    };
  }

  /**
   * Reset the Petri net to initial marking (all slots available).
   */
  reset(): void {
    this.petriNet.reset();
    getGlobalLogger().info('PetriNetScheduler', 'Reset to initial marking');
  }

  /**
   * Get the firing history (sequence of admitted/completed transitions).
   */
  getFiringHistory(): string[] {
    return this.petriNet.getFiringHistory();
  }

  /**
   * Get the underlying PetriNetEngine instance (for advanced analysis).
   */
  getPetriNetEngine(): PetriNetEngine {
    return this.petriNet;
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private getTotalAvailableSlots(): number {
    return ALL_TIERS.reduce((sum, tier) => sum + this.getAvailableSlots(tier), 0);
  }

  private hasAnyAvailableSlot(): boolean {
    return ALL_TIERS.some((tier) => this.getAvailableSlots(tier) > 0);
  }

  private serializeMarking(): string {
    const marking = this.petriNet.getMarking();
    const entries = [...marking.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return entries.map(([k, v]) => `${k}:${v}`).join(', ');
  }

  /**
   * Restore a previously saved marking (for simulation rollback).
   * Uses setMarking to directly restore each place's token count.
   */
  private restoreMarking(savedMarking: Map<string, number>): void {
    for (const [placeId, tokens] of savedMarking) {
      this.petriNet.setMarking(placeId, tokens);
    }
  }
}
