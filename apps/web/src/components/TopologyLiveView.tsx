/**
 * TopologyLiveView — Real-time Commander topology visualization.
 *
 * Renders the 8 Commander topologies as animated DAG flows with indigo
 * design language. Each topology renders with distinct visual patterns:
 *   SINGLE        → single agent node
 *   SEQUENTIAL    → linear chain
 *   PARALLEL      → fan-out / fan-in
 *   HIERARCHICAL  → tree structure
 *   HYBRID        → mixed pattern
 *   DEBATE        → dual-agent ping-pong
 *   ENSEMBLE      → multi-agent vote
 *   EVALUATOR-OPT → loopback with gate
 *
 * Design: professional "Vercel/Datadog" style control panel with
 *   - Indigo color palette
 *   - Animated pulse rings on active nodes
 *   - Topology selector tabs
 *   - Agent-node detail cards
 */

import { useState, useMemo } from 'react';
import { Activity, GitBranch, GitMerge, Network, Layers } from 'lucide-react';

// ============================================================================
// Colors — Commander indigo design system
// ============================================================================

const COLORS = {
  indigo: '#4d9eff',
  green: '#4de98c',
  amber: '#ffcc66',
  coral: '#ff8b9d',
  purple: '#a78bfa',
  cyan: '#22d3ee',
  slate: '#64748b',
  surface: '#050913',
  surfaceRaised: '#080d1a',
  border: 'rgba(77, 158, 255, 0.15)',
  borderActive: 'rgba(77, 158, 255, 0.35)',
  text: '#7f8c86',
  textPrimary: '#e5f0da',
  textMuted: '#4a5568',
};

// ============================================================================
// Types
// ============================================================================

export type TopologyType =
  | 'SINGLE'
  | 'SEQUENTIAL'
  | 'PARALLEL'
  | 'HIERARCHICAL'
  | 'HYBRID'
  | 'DEBATE'
  | 'ENSEMBLE'
  | 'EVALUATOR_OPTIMIZER';

interface TopologyNode {
  id: string;
  label: string;
  role: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
}

interface TopologyEdge {
  from: string;
  to: string;
  label?: string;
}

interface TopologyLiveViewProps {
  /** Currently active topology */
  activeTopology?: TopologyType;
  /** Nodes in the current execution */
  nodes?: TopologyNode[];
  /** Agent count summary */
  agentCount?: number;
  runningCount?: number;
  completedCount?: number;
  failedCount?: number;
}

const ALL_TOPOLOGIES: TopologyType[] = [
  'SINGLE', 'SEQUENTIAL', 'PARALLEL', 'HIERARCHICAL',
  'HYBRID', 'DEBATE', 'ENSEMBLE', 'EVALUATOR_OPTIMIZER',
];

const TOPOLOGY_LABELS: Record<TopologyType, { label: string; desc: string; icon: typeof GitBranch }> = {
  SINGLE:              { label: 'Single',     desc: 'Single agent execution', icon: Activity },
  SEQUENTIAL:          { label: 'Sequential',  desc: 'Linear chain of agents', icon: GitBranch },
  PARALLEL:            { label: 'Parallel',    desc: 'Fan-out / fan-in broadcast', icon: GitMerge },
  HIERARCHICAL:        { label: 'Hierarchical', desc: 'Tree-structured delegation', icon: Layers },
  HYBRID:              { label: 'Hybrid',      desc: 'Mixed pattern execution', icon: Network },
  DEBATE:              { label: 'Debate',      desc: 'Dual-agent adversarial', icon: Activity },
  ENSEMBLE:            { label: 'Ensemble',    desc: 'Multi-agent voting', icon: Layers },
  EVALUATOR_OPTIMIZER: { label: 'Eval-Opt',    desc: 'Loopback with quality gate', icon: GitBranch },
};

const NODE_STATUS_COLORS: Record<string, string> = {
  idle: COLORS.slate,
  running: COLORS.indigo,
  completed: COLORS.green,
  failed: COLORS.coral,
};

function buildTopologyGraph(topology: TopologyType): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const n = (id: string, label: string, role: string, status: TopologyNode['status'] = 'idle'): TopologyNode =>
    ({ id, label, role, status });
  const e = (from: string, to: string, label?: string): TopologyEdge => ({ from, to, label });

  switch (topology) {
    case 'SINGLE':
      return {
        nodes: [n('agent-1', 'Main Agent', 'executor', 'running')],
        edges: [],
      };
    case 'SEQUENTIAL':
      return {
        nodes: [
          n('planner', 'Planner', 'planning', 'completed'),
          n('coder', 'Coder', 'coding', 'running'),
          n('verifier', 'Verifier', 'verification', 'idle'),
        ],
        edges: [e('planner', 'coder', 'plan'), e('coder', 'verifier', 'verify')],
      };
    case 'PARALLEL':
      return {
        nodes: [
          n('dispatcher', 'Dispatcher', 'routing', 'running'),
          n('worker-a', 'Worker A', 'execution', 'idle'),
          n('worker-b', 'Worker B', 'execution', 'idle'),
          n('worker-c', 'Worker C', 'execution', 'idle'),
          n('merger', 'Merger', 'synthesis', 'idle'),
        ],
        edges: [
          e('dispatcher', 'worker-a'), e('dispatcher', 'worker-b'),
          e('dispatcher', 'worker-c'),
          e('worker-a', 'merger'), e('worker-b', 'merger'), e('worker-c', 'merger'),
        ],
      };
    case 'HIERARCHICAL':
      return {
        nodes: [
          n('orchestrator', 'Orchestrator', 'root', 'running'),
          n('sub-a', 'Sub-agent A', 'planner', 'completed'),
          n('sub-b', 'Sub-agent B', 'coder', 'running'),
          n('leaf-1', 'Leaf 1', 'executor', 'idle'),
          n('leaf-2', 'Leaf 2', 'executor', 'idle'),
        ],
        edges: [e('orchestrator', 'sub-a'), e('orchestrator', 'sub-b'), e('sub-b', 'leaf-1'), e('sub-b', 'leaf-2')],
      };
    case 'HYBRID':
      return {
        nodes: [
          n('root', 'Root', 'planning', 'completed'),
          n('seq-a', 'Seq A', 'sequential', 'running'),
          n('seq-b', 'Seq B', 'sequential', 'idle'),
          n('par-pool', 'Pool', 'parallel', 'running'),
        ],
        edges: [e('root', 'seq-a'), e('root', 'seq-b'), e('root', 'par-pool')],
      };
    case 'DEBATE':
      return {
        nodes: [
          n('proposer', 'Proposer', 'advocate', 'running'),
          n('opponent', 'Opponent', 'critic', 'running'),
          n('judge', 'Judge', 'arbiter', 'idle'),
        ],
        edges: [e('proposer', 'judge', 'argument'), e('opponent', 'judge', 'counter')],
      };
    case 'ENSEMBLE':
      return {
        nodes: [
          n('task', 'Task', 'input', 'completed'),
          n('model-a', 'GPT-5', 'model', 'running'),
          n('model-b', 'Claude', 'model', 'running'),
          n('model-c', 'Gemini', 'model', 'running'),
          n('synthesizer', 'Synthesizer', 'vote', 'idle'),
        ],
        edges: [
          e('task', 'model-a'), e('task', 'model-b'), e('task', 'model-c'),
          e('model-a', 'synthesizer'), e('model-b', 'synthesizer'), e('model-c', 'synthesizer'),
        ],
      };
    case 'EVALUATOR_OPTIMIZER':
      return {
        nodes: [
          n('generator', 'Generator', 'generate', 'running'),
          n('evaluator', 'Evaluator', 'score', 'idle'),
          n('gate', 'Quality Gate', 'gate', 'idle'),
        ],
        edges: [
          e('generator', 'evaluator', 'output'),
          e('evaluator', 'gate', 'score'),
          e('gate', 'generator', 'reject loop'),
        ],
      };
  }
}

// ============================================================================
// Component
// ============================================================================

export function TopologyLiveView({
  activeTopology = 'SINGLE',
  nodes: liveNodes,
  agentCount = 0,
  runningCount = 0,
  completedCount = 0,
  failedCount = 0,
}: TopologyLiveViewProps) {
  const [selectedTopo, setSelectedTopo] = useState<TopologyType>(activeTopology);

  const { nodes, edges } = useMemo(() => buildTopologyGraph(selectedTopo), [selectedTopo]);

  const displayNodes = liveNodes && liveNodes.length > 0 ? liveNodes : nodes;

  return (
    <div className="topology-live-view">
      <div className="section-head">
        <div>
          <div className="section-label">Topology</div>
          <h2>Execution Topology</h2>
        </div>
        {agentCount > 0 && (
          <span className="section-tag">
            {agentCount} agents · {runningCount} running · {completedCount} done{failedCount > 0 ? ` · ${failedCount} failed` : ''}
          </span>
        )}
      </div>

      {/* Topology Selector */}
      <div className="topology-tabs">
        {ALL_TOPOLOGIES.map(topo => {
          const info = TOPOLOGY_LABELS[topo];
          const Icon = info.icon;
          const isActive = selectedTopo === topo;
          return (
            <button
              key={topo}
              className={`topology-tab ${isActive ? 'active' : ''}`}
              onClick={() => setSelectedTopo(topo)}
              title={info.desc}
            >
              <Icon size={12} />
              <span>{info.label}</span>
            </button>
          );
        })}
      </div>

      {/* Node grid — indigo-themed card layout */}
      <div className="topology-graph" style={{ marginTop: 16 }}>
        {/* Edges rendered as connecting lines between node cards */}
        <div className="topology-nodes">
          {displayNodes.map((node, i) => (
            <div
              key={node.id}
              className={`topology-node ${node.status}`}
              style={{
                borderColor: node.status === 'idle' ? COLORS.border : NODE_STATUS_COLORS[node.status],
              }}
            >
              {/* Status indicator ring */}
              <div
                className={`node-status-ring ${node.status === 'running' ? 'pulse' : ''}`}
                style={{ background: NODE_STATUS_COLORS[node.status] }}
              />
              <div className="node-content">
                <div className="node-label">{node.label}</div>
                <div className="node-role">{node.role}</div>
              </div>
              {/* Edge connectors */}
              {edges.filter(e => e.from === node.id).length > 0 && (
                <div className="node-edges">
                  {edges.filter(e => e.from === node.id).map(e => (
                    <div key={`${e.from}-${e.to}`} className="edge-label" title={`→ ${e.to}`}>
                      {e.label ? `${e.label} →` : '→'}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Edges rendered as visual connectors between nodes */}
          {edges.length > 0 && (
            <div className="topology-edge-list">
              {edges.map(edge => (
                <div key={`edge-${edge.from}-${edge.to}`} className="topology-edge-item">
                  <span className="edge-from">{nodes.find(n => n.id === edge.from)?.label ?? edge.from}</span>
                  <span className="edge-arrow">→</span>
                  <span className="edge-to">{nodes.find(n => n.id === edge.to)?.label ?? edge.to}</span>
                  {edge.label && <span className="edge-label-text">{edge.label}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
