/**
 * Temporal Graph — Simple temporal relation chain for semantic memory.
 *
 * Supports directed "before"/"after" relations between events and answers
 * transitive chain queries (event A happened before event B before event C).
 *
 * All edges are internally normalized to a canonical "before" direction so
 * that `getChain`, `before`, and `after` can be computed with a single
 * adjacency model.
 */

export interface TemporalEvent {
  /** Unique identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Optional numeric timestamp */
  timestamp?: number;
  /** Optional longer description */
  description?: string;
}

export interface TemporalRelation {
  fromId: string;
  toId: string;
  type: 'before' | 'after';
}

interface NormalizedEdge {
  fromId: string;
  toId: string;
}

interface TemporalGraphJSON {
  events: TemporalEvent[];
  edges: NormalizedEdge[];
}

export class TemporalGraph {
  private events = new Map<string, TemporalEvent>();
  // Normalized "before" adjacency: from -> set of events that happen after it
  private beforeEdges = new Map<string, Set<string>>();
  // Reverse adjacency: to -> set of events that happen before it
  private reverseEdges = new Map<string, Set<string>>();
  private idCounter = 0;

  /**
   * Add an event node. If `id` is omitted, a stable id is generated.
   */
  addEvent(event: Omit<TemporalEvent, 'id'> & { id?: string }): TemporalEvent {
    const id = event.id ?? this.nextId();
    const evt: TemporalEvent = {
      label: event.label,
      timestamp: event.timestamp,
      description: event.description,
      id,
    };
    this.events.set(id, evt);
    this.beforeEdges.set(id, this.beforeEdges.get(id) ?? new Set());
    this.reverseEdges.set(id, this.reverseEdges.get(id) ?? new Set());
    return evt;
  }

  /**
   * Add a temporal relation between two events.
   * Type 'before' means `fromId` happened before `toId`.
   * Type 'after' is normalized to the reverse "before" edge.
   */
  addRelation(fromId: string, toId: string, type: 'before' | 'after' = 'before'): TemporalRelation {
    if (!this.events.has(fromId) || !this.events.has(toId)) {
      throw new Error(`Cannot add relation: unknown event(s) ${fromId}, ${toId}`);
    }
    if (fromId === toId) {
      throw new Error('Self-referential temporal relations are not allowed');
    }

    const normalized: NormalizedEdge =
      type === 'before' ? { fromId, toId } : { fromId: toId, toId: fromId };

    this.ensureSet(this.beforeEdges, normalized.fromId).add(normalized.toId);
    this.ensureSet(this.reverseEdges, normalized.toId).add(normalized.fromId);

    return { fromId, toId, type };
  }

  /** Retrieve an event by id. */
  getEvent(id: string): TemporalEvent | undefined {
    return this.events.get(id);
  }

  /**
   * Return the event chain from `fromId` to `toId` following normalized
   * "before" edges. Returns an empty array when no chain exists.
   */
  getChain(fromId: string, toId: string): TemporalEvent[] {
    if (!this.events.has(fromId) || !this.events.has(toId)) return [];

    const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (id === toId && path.length > 1) {
        return path.map((pid) => this.events.get(pid)!).filter((e): e is TemporalEvent => !!e);
      }
      if (visited.has(id)) continue;
      visited.add(id);

      const next = this.beforeEdges.get(id);
      if (!next) continue;
      for (const neighbor of next) {
        if (!path.includes(neighbor)) {
          queue.push({ id: neighbor, path: [...path, neighbor] });
        }
      }
    }

    return [];
  }

  /**
   * Return all events that happened before `eventId`, ordered from nearest to
   * most distant predecessor.
   */
  before(eventId: string): TemporalEvent[] {
    return this.collectReachable(eventId, this.reverseEdges);
  }

  /**
   * Return all events that happened after `eventId`, ordered from nearest to
   * most distant successor.
   */
  after(eventId: string): TemporalEvent[] {
    return this.collectReachable(eventId, this.beforeEdges);
  }

  /** Return all events sorted by timestamp (missing timestamp => +Infinity). */
  getTimeline(): TemporalEvent[] {
    return Array.from(this.events.values()).sort((a, b) => {
      const ta = a.timestamp ?? Number.POSITIVE_INFINITY;
      const tb = b.timestamp ?? Number.POSITIVE_INFINITY;
      return ta - tb;
    });
  }

  /** Detect cycles in the normalized "before" graph. */
  hasCycle(): boolean {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();

    for (const id of this.events.keys()) color.set(id, WHITE);

    const dfs = (id: string): boolean => {
      color.set(id, GRAY);
      for (const neighbor of this.beforeEdges.get(id) ?? []) {
        if (color.get(neighbor) === GRAY) return true;
        if (color.get(neighbor) === WHITE && dfs(neighbor)) return true;
      }
      color.set(id, BLACK);
      return false;
    };

    for (const id of this.events.keys()) {
      if (color.get(id) === WHITE && dfs(id)) return true;
    }
    return false;
  }

  /** Export the graph as a plain JSON object. */
  toJSON(): TemporalGraphJSON {
    const edges: NormalizedEdge[] = [];
    for (const [fromId, targets] of this.beforeEdges) {
      for (const toId of targets) {
        edges.push({ fromId, toId });
      }
    }
    return {
      events: Array.from(this.events.values()),
      edges,
    };
  }

  /** Restore a graph from its JSON representation. */
  static fromJSON(json: TemporalGraphJSON): TemporalGraph {
    const graph = new TemporalGraph();
    for (const evt of json.events) {
      graph.addEvent(evt);
    }
    for (const edge of json.edges) {
      graph.addRelation(edge.fromId, edge.toId, 'before');
    }
    return graph;
  }

  /** Total number of events. */
  get size(): number {
    return this.events.size;
  }

  private nextId(): string {
    return `temp-${++this.idCounter}`;
  }

  private ensureSet(map: Map<string, Set<string>>, key: string): Set<string> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }

  private collectReachable(startId: string, adjacency: Map<string, Set<string>>): TemporalEvent[] {
    if (!this.events.has(startId)) return [];

    const result: TemporalEvent[] = [];
    const visited = new Set<string>();
    const queue: string[] = [startId];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (id !== startId) {
        const evt = this.events.get(id);
        if (evt) result.push(evt);
      }
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }

    return result;
  }
}
