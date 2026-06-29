/**
 * Petri Net Engine — Predicate/Transition (PrT) Net implementation
 *
 * Implements the IPetriNetEngine contract from Pillar I.
 *
 * Formalism: N = (P, T, F, Σ, L, M₀, c)
 *   P = places, T = transitions, F = flow relation
 *   Σ = signature, L = labeling, M₀ = initial marking, c = capacity
 *
 * Supports:
 * - Place/transition registration with capacity constraints
 * - Guard-based transition firing
 * - Token consumption/production per arc weights
 * - Reachability graph computation for deadlock detection
 * - Reset to initial marking
 *
 * Per constraint IF-03, enables concurrent multi-agent scheduling.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { IPetriNetEngine, IPlace, ITransition } from '../contracts/pillarI';

// ============================================================================
// PetriNetEngine Implementation
// ============================================================================

export class PetriNetEngine implements IPetriNetEngine {
  private places: Map<string, IPlace> = new Map();
  private transitions: Map<string, ITransition> = new Map();
  private initialMarking: Map<string, number> = new Map();
  private firingHistory: string[] = [];

  /**
   * Register a place in the net.
   * Throws if a place with the same ID already exists.
   */
  addPlace(place: IPlace): void {
    if (this.places.has(place.id)) {
      throw new Error(`Place '${place.id}' already exists`);
    }
    if (place.capacity < 0) {
      throw new Error(`Place '${place.id}' capacity must be non-negative`);
    }
    if (place.marking < 0) {
      throw new Error(`Place '${place.id}' initial marking must be non-negative`);
    }
    if (place.capacity !== Infinity && place.marking > place.capacity) {
      throw new Error(
        `Place '${place.id}' initial marking ${place.marking} exceeds capacity ${place.capacity}`,
      );
    }
    this.places.set(place.id, { ...place });
    this.initialMarking.set(place.id, place.marking);
  }

  /**
   * Register a transition in the net.
   * Throws if a transition with the same ID already exists.
   */
  addTransition(transition: ITransition): void {
    if (this.transitions.has(transition.id)) {
      throw new Error(`Transition '${transition.id}' already exists`);
    }
    // Validate that input/output places exist
    for (const [placeId] of transition.inputs) {
      if (!this.places.has(placeId)) {
        throw new Error(
          `Transition '${transition.id}' references unknown input place '${placeId}'`,
        );
      }
    }
    for (const [placeId] of transition.outputs) {
      if (!this.places.has(placeId)) {
        throw new Error(
          `Transition '${transition.id}' references unknown output place '${placeId}'`,
        );
      }
    }
    this.transitions.set(transition.id, {
      ...transition,
      inputs: new Map(transition.inputs),
      outputs: new Map(transition.outputs),
    });
  }

  /**
   * Check if a transition is enabled:
   * 1. Guard condition (if present) must return true
   * 2. All input places must have enough tokens (>= arc weight)
   * 3. All output places must have capacity for produced tokens
   */
  isEnabled(transitionId: string, context?: unknown): boolean {
    const transition = this.transitions.get(transitionId);
    if (!transition) {
      getGlobalLogger().warn('PetriNetEngine', `Unknown transition '${transitionId}'`);
      return false;
    }

    // Check guard condition
    if (transition.guard && !transition.guard(context)) {
      return false;
    }

    // Check input places have enough tokens
    for (const [placeId, arcWeight] of transition.inputs) {
      const place = this.places.get(placeId);
      if (!place || place.marking < arcWeight) {
        return false;
      }
    }

    // Check output places have capacity for produced tokens
    for (const [placeId, arcWeight] of transition.outputs) {
      const place = this.places.get(placeId);
      if (!place) continue;
      if (place.capacity !== Infinity) {
        // Net change for this place: tokens consumed by inputs - tokens produced by outputs
        const consumed = transition.inputs.get(placeId) ?? 0;
        const produced = arcWeight;
        const netChange = produced - consumed;
        if (place.marking + netChange > place.capacity) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Fire a transition: consume tokens from input places, produce tokens in output places.
   * Returns true if the transition fired successfully, false if not enabled.
   */
  fire(transitionId: string, context?: unknown): boolean {
    if (!this.isEnabled(transitionId, context)) {
      return false;
    }

    const transition = this.transitions.get(transitionId)!;

    // Consume tokens from input places
    for (const [placeId, arcWeight] of transition.inputs) {
      const place = this.places.get(placeId)!;
      place.marking -= arcWeight;
    }

    // Produce tokens in output places
    for (const [placeId, arcWeight] of transition.outputs) {
      const place = this.places.get(placeId)!;
      place.marking += arcWeight;
    }

    this.firingHistory.push(transitionId);
    getGlobalLogger().debug('PetriNetEngine', 'Transition fired', {
      transitionId,
      marking: this.getMarking(),
    });

    return true;
  }

  /**
   * Get the current marking of all places.
   */
  getMarking(): Map<string, number> {
    const marking = new Map<string, number>();
    for (const [id, place] of this.places) {
      marking.set(id, place.marking);
    }
    return marking;
  }

  /**
   * Compute the reachability graph via BFS exploration.
   *
   * Each node is a marking state (serialized as a canonical key).
   * Each edge represents a transition firing that leads to a new state.
   * Returns a map of state → set of reachable states.
   */
  computeReachabilityGraph(): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    const visited = new Set<string>();
    const queue: string[] = [];

    const serializeMarking = (marking: Map<string, number>): string => {
      const entries = [...marking.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      return entries.map(([k, v]) => `${k}:${v}`).join('|');
    };

    const initialState = serializeMarking(this.getMarking());
    queue.push(initialState);
    visited.add(initialState);

    const maxStates = 10000; // Safety limit to prevent infinite exploration
    let stateCount = 0;

    while (queue.length > 0 && stateCount < maxStates) {
      const currentKey = queue.shift()!;
      stateCount++;

      // Deserialize marking
      const currentMarking = new Map<string, number>();
      if (currentKey) {
        for (const part of currentKey.split('|')) {
          const [placeId, tokens] = part.split(':');
          currentMarking.set(placeId, parseInt(tokens, 10));
        }
      }

      if (!graph.has(currentKey)) {
        graph.set(currentKey, new Set());
      }

      // Try firing each transition
      for (const [transitionId, transition] of this.transitions) {
        // Temporarily apply current marking to check if enabled
        const savedMarking = new Map<string, number>();
        for (const [pid, place] of this.places) {
          savedMarking.set(pid, place.marking);
          place.marking = currentMarking.get(pid) ?? place.marking;
        }

        const canFire = this.isEnabled(transitionId);

        if (canFire) {
          // Fire to get next state
          this.fire(transitionId);
          const nextKey = serializeMarking(this.getMarking());

          graph.get(currentKey)!.add(nextKey);

          if (!visited.has(nextKey)) {
            visited.add(nextKey);
            queue.push(nextKey);
          }

          // Restore marking (undo the fire)
          for (const [pid] of this.places) {
            this.places.get(pid)!.marking = currentMarking.get(pid) ?? 0;
          }
        }

        // Restore saved marking
        for (const [pid, tokens] of savedMarking) {
          this.places.get(pid)!.marking = tokens;
        }
      }
    }

    if (stateCount >= maxStates) {
      getGlobalLogger().warn('PetriNetEngine', 'Reachability graph computation hit state limit', {
        maxStates,
        truncated: true,
      });
    }

    return graph;
  }

  /**
   * Reset all places to their initial marking.
   */
  reset(): void {
    for (const [id, place] of this.places) {
      place.marking = this.initialMarking.get(id) ?? 0;
    }
    this.firingHistory = [];
    getGlobalLogger().debug('PetriNetEngine', 'Reset to initial marking');
  }

  /**
   * Get the firing history (ordered list of fired transition IDs).
   */
  getFiringHistory(): string[] {
    return [...this.firingHistory];
  }

  /**
   * Detect deadlocks: a state where no transition is enabled.
   */
  detectDeadlocks(): string[] {
    const deadlockedTransitions: string[] = [];
    for (const [transitionId] of this.transitions) {
      if (!this.isEnabled(transitionId)) {
        deadlockedTransitions.push(transitionId);
      }
    }
    return deadlockedTransitions;
  }

  /**
   * Check if a specific place is currently marked (has tokens).
   */
  isMarked(placeId: string): boolean {
    const place = this.places.get(placeId);
    return place ? place.marking > 0 : false;
  }

  /**
   * Get a place by ID.
   */
  getPlace(placeId: string): IPlace | undefined {
    const place = this.places.get(placeId);
    return place ? { ...place } : undefined;
  }

  /**
   * Set the marking of a place directly.
   *
   * This is used by external integrations (e.g., PetriNetSchedulerIntegration)
   * to reflect state changes not modeled as transition firings — such as
   * new request arrivals from outside the net.
   *
   * Validates capacity constraints.
   */
  setMarking(placeId: string, marking: number): void {
    const place = this.places.get(placeId);
    if (!place) {
      throw new Error(`Unknown place '${placeId}'`);
    }
    if (marking < 0) {
      throw new Error(`Marking for '${placeId}' must be non-negative, got ${marking}`);
    }
    if (place.capacity !== Infinity && marking > place.capacity) {
      throw new Error(`Marking ${marking} for '${placeId}' exceeds capacity ${place.capacity}`);
    }
    place.marking = marking;
  }

  /**
   * Get the total number of transitions in the net.
   */
  getTransitionCount(): number {
    return this.transitions.size;
  }

  /**
   * Get a transition by ID.
   */
  getTransition(transitionId: string): ITransition | undefined {
    const transition = this.transitions.get(transitionId);
    if (!transition) return undefined;
    return {
      ...transition,
      inputs: new Map(transition.inputs),
      outputs: new Map(transition.outputs),
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalPetriNetEngine: PetriNetEngine | null = null;

export function getGlobalPetriNetEngine(): PetriNetEngine {
  if (!globalPetriNetEngine) {
    globalPetriNetEngine = new PetriNetEngine();
  }
  return globalPetriNetEngine;
}
