import { describe, it, expect } from 'vitest';
import { TemporalGraph } from '../../src/memory/temporalGraph';

describe('TemporalGraph', () => {
  it('adds events and returns ids', () => {
    const graph = new TemporalGraph();
    const a = graph.addEvent({ label: 'A' });
    expect(a.id).toBeTruthy();
    expect(graph.getEvent(a.id)?.label).toBe('A');
  });

  it('links events with a before relation', () => {
    const graph = new TemporalGraph();
    const a = graph.addEvent({ label: 'A', timestamp: 1 });
    const b = graph.addEvent({ label: 'B', timestamp: 2 });
    graph.addRelation(a.id, b.id, 'before');

    const chain = graph.getChain(a.id, b.id);
    expect(chain.map((e) => e.label)).toEqual(['A', 'B']);
  });

  it('follows transitive before chains', () => {
    const graph = new TemporalGraph();
    const a = graph.addEvent({ label: 'A', timestamp: 1 });
    const b = graph.addEvent({ label: 'B', timestamp: 2 });
    const c = graph.addEvent({ label: 'C', timestamp: 3 });
    graph.addRelation(a.id, b.id, 'before');
    graph.addRelation(b.id, c.id, 'before');

    expect(graph.getChain(a.id, c.id).map((e) => e.label)).toEqual(['A', 'B', 'C']);
    expect(graph.before(c.id).map((e) => e.label)).toEqual(['B', 'A']);
    expect(graph.after(a.id).map((e) => e.label)).toEqual(['B', 'C']);
  });

  it('returns a sorted timeline', () => {
    const graph = new TemporalGraph();
    graph.addEvent({ label: 'Later', timestamp: 20 });
    graph.addEvent({ label: 'Earlier', timestamp: 10 });

    expect(graph.getTimeline().map((e) => e.label)).toEqual(['Earlier', 'Later']);
  });

  it('detects cycles', () => {
    const graph = new TemporalGraph();
    const a = graph.addEvent({ label: 'A' });
    const b = graph.addEvent({ label: 'B' });
    const c = graph.addEvent({ label: 'C' });
    graph.addRelation(a.id, b.id, 'before');
    graph.addRelation(b.id, c.id, 'before');
    graph.addRelation(c.id, a.id, 'before');

    expect(graph.hasCycle()).toBe(true);
  });

  it('exports and imports graph state', () => {
    const graph = new TemporalGraph();
    const a = graph.addEvent({ label: 'A', timestamp: 1 });
    const b = graph.addEvent({ label: 'B', timestamp: 2 });
    graph.addRelation(a.id, b.id, 'before');

    const json = graph.toJSON();
    const restored = TemporalGraph.fromJSON(json);
    expect(restored.getChain(a.id, b.id).map((e) => e.label)).toEqual(['A', 'B']);
  });
});
