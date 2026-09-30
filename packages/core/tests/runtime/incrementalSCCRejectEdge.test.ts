/**
 * Regression for IP-03 (incrementalSCC.addEdge):
 *
 * The documented contract is "if the edge would create a cycle and
 * rejectCyclicEdges is true, the edge is rejected and a DeadlockAlert is
 * returned". The implementation called `mergeAndAlert` FIRST — which mutates
 * the component map and writes the trigger edge — and only then checked
 * `rejectCyclicEdges`. A rejected edge therefore stayed in the graph and the
 * merged component survived, so `agentHandoff` (which treats an alert as "the
 * edge was NOT added") proceeded on a false graph and a repeat request could
 * slip through. The same-component / self-loop branch also wrote the edge
 * unconditionally.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalSCCDetector, type SCCEdge } from '../../src/runtime/incrementalSCC';

let edgeSeq = 0;
/** SCCEdge requires a timestamp; keep it deterministic per test process. */
function edge(from: string, to: string, reason: string): SCCEdge {
  return { from, to, reason, timestamp: ++edgeSeq };
}

function graphHasEdge(scc: IncrementalSCCDetector, from: string, to: string): boolean {
  return scc.getGraph().edges.some((e) => e.from === from && e.to === to);
}

describe('IncrementalSCC — a rejected cyclic edge never mutates the graph', () => {
  it('rejects a back edge and leaves the graph unchanged', () => {
    const scc = new IncrementalSCCDetector({ rejectCyclicEdges: true, publishAlerts: false });
    scc.addEdge(edge('A', 'B', 'wait-A'));

    const alert = scc.addEdge(edge('B', 'A', 'wait-B'));
    assert.notEqual(alert, null, 'the cyclic edge must be rejected with an alert');

    assert.equal(graphHasEdge(scc, 'B', 'A'), false, 'the rejected edge must be absent');
    assert.equal(graphHasEdge(scc, 'A', 'B'), true, 'the pre-existing edge must survive');
    assert.equal(scc.getCyclicComponents().length, 0, 'no component may be merged on rejection');
  });

  it('rejects the same cyclic edge again (no phantom edge to satisfy it)', () => {
    const scc = new IncrementalSCCDetector({ rejectCyclicEdges: true, publishAlerts: false });
    scc.addEdge(edge('A', 'B', 'wait-A'));

    assert.notEqual(scc.addEdge(edge('B', 'A', 'wait-B')), null);
    assert.notEqual(
      scc.addEdge(edge('B', 'A', 'wait-B-again')),
      null,
      'a repeated cyclic request must still be rejected',
    );
    assert.equal(graphHasEdge(scc, 'B', 'A'), false);
    assert.equal(scc.getCyclicComponents().length, 0);
  });

  it('rejects a self-loop without writing it', () => {
    const scc = new IncrementalSCCDetector({ rejectCyclicEdges: true, publishAlerts: false });
    const alert = scc.addEdge(edge('A', 'A', 'wait-self'));
    assert.notEqual(alert, null);
    assert.equal(graphHasEdge(scc, 'A', 'A'), false);
    assert.equal(scc.getCyclicComponents().length, 0);
  });

  it('still accepts an acyclic edge after a rejection', () => {
    const scc = new IncrementalSCCDetector({ rejectCyclicEdges: true, publishAlerts: false });
    scc.addEdge(edge('A', 'B', 'wait-A'));
    scc.addEdge(edge('B', 'A', 'wait-B'));

    assert.equal(scc.addEdge(edge('B', 'C', 'wait-C')), null);
    assert.equal(graphHasEdge(scc, 'B', 'C'), true);
    assert.equal(scc.getCyclicComponents().length, 0);
  });

  it('still merges the SCC when rejectCyclicEdges is false', () => {
    const scc = new IncrementalSCCDetector({ rejectCyclicEdges: false, publishAlerts: false });
    scc.addEdge(edge('A', 'B', 'wait-A'));
    const alert = scc.addEdge(edge('B', 'A', 'wait-B'));

    assert.notEqual(alert, null, 'the cycle must still be reported');
    assert.equal(graphHasEdge(scc, 'B', 'A'), true, 'non-rejecting config keeps the edge');
    const cyclic = scc.getCyclicComponents();
    assert.equal(cyclic.length, 1);
    assert.deepEqual([...cyclic[0].nodes].sort(), ['A', 'B']);
  });
});
