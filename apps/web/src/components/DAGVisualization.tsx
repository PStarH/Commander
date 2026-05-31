import { useMemo, useCallback, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type ColorMode,
  Position,
} from '@xyflow/react';
// @ts-expect-error dagre ships no types
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import type { Mission, AgentWorkload, MissionStatus } from '../types';

// ============================================================================
// Types
// ============================================================================

interface DAGVisualizationProps {
  missions: Mission[];
  agents: AgentWorkload[];
  agentNameById: Map<string, string>;
}

interface MissionNodeData {
  label: string;
  status: MissionStatus;
  priority: string;
  agentName: string;
  riskLevel: string;
  [key: string]: unknown;
}

// ============================================================================
// Status colors matching Commander design system
// ============================================================================

const STATUS_COLORS: Record<MissionStatus, { bg: string; border: string; text: string }> = {
  PLANNED: { bg: '#0a1628', border: '#4d9eff', text: '#4d9eff' },
  RUNNING: { bg: '#0a1e14', border: '#4de98c', text: '#4de98c' },
  BLOCKED: { bg: '#2a1a0a', border: '#ffcc66', text: '#ffcc66' },
  DONE: { bg: '#0a0a14', border: '#a78bfa', text: '#a78bfa' },
};

const STATUS_ICONS: Record<MissionStatus, string> = {
  PLANNED: '○',
  RUNNING: '●',
  BLOCKED: '⚠',
  DONE: '✓',
};

const PRIORITY_BADGE: Record<string, { bg: string; text: string }> = {
  LOW: { bg: 'rgba(77, 158, 255, 0.15)', text: '#4d9eff' },
  MEDIUM: { bg: 'rgba(77, 233, 140, 0.15)', text: '#4de98c' },
  HIGH: { bg: 'rgba(255, 204, 102, 0.15)', text: '#ffcc66' },
  CRITICAL: { bg: 'rgba(255, 139, 157, 0.15)', text: '#ff8b9d' },
};

// ============================================================================
// Dagre layout
// ============================================================================

const NODE_WIDTH = 260;
const NODE_HEIGHT = 100;

function getLayoutedElements(
  nodes: Node<MissionNodeData>[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): { nodes: Node<MissionNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const layoutedNodes = nodes.map(node => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });

  return { nodes: layoutedNodes, edges };
}

// ============================================================================
// Derive edges from mission data
// ============================================================================

function deriveEdges(missions: Mission[]): Edge[] {
  const edges: Edge[] = [];
  const byAgent = new Map<string, Mission[]>();

  // Group missions by agent
  for (const m of missions) {
    if (!m.assignedAgentId) continue;
    const list = byAgent.get(m.assignedAgentId) ?? [];
    list.push(m);
    byAgent.set(m.assignedAgentId, list);
  }

  const statusOrder: Record<MissionStatus, number> = {
    PLANNED: 0,
    RUNNING: 1,
    BLOCKED: 2,
    DONE: 3,
  };

  // For each agent, create sequential edges ordered by status progression
  for (const [, agentMissions] of byAgent) {
    const sorted = [...agentMissions].sort(
      (a, b) => statusOrder[a.status] - statusOrder[b.status],
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      // Only connect if there's a logical progression
      if (statusOrder[sorted[i].status] < statusOrder[sorted[i + 1].status]) {
        edges.push({
          id: `e-${sorted[i].id}-${sorted[i + 1].id}`,
          source: sorted[i].id,
          target: sorted[i + 1].id,
          animated: sorted[i].status === 'RUNNING',
          style: { stroke: '#4d9eff', strokeWidth: 1.5 },
        });
      }
    }
  }

  // BLOCKED missions depend on the first RUNNING mission (if any)
  const running = missions.filter(m => m.status === 'RUNNING');
  const blocked = missions.filter(m => m.status === 'BLOCKED');
  if (running.length > 0 && blocked.length > 0) {
    for (const b of blocked) {
      // Don't duplicate edges
      const alreadyConnected = edges.some(e => e.target === b.id);
      if (!alreadyConnected) {
        edges.push({
          id: `e-${running[0].id}-${b.id}`,
          source: running[0].id,
          target: b.id,
          animated: true,
          style: { stroke: '#ffcc66', strokeWidth: 1.5, strokeDasharray: '6 4' },
        });
      }
    }
  }

  return edges;
}

// ============================================================================
// Custom node component
// ============================================================================

function MissionNode({ data }: { data: MissionNodeData }) {
  const colors = STATUS_COLORS[data.status] || STATUS_COLORS.PLANNED;
  const icon = STATUS_ICONS[data.status] || '○';
  const priorityBadge = PRIORITY_BADGE[data.priority] || PRIORITY_BADGE.MEDIUM;

  return (
    <div
      style={{
        background: colors.bg,
        border: `1.5px solid ${colors.border}`,
        borderRadius: '8px',
        padding: '12px 16px',
        width: NODE_WIDTH - 8,
        fontFamily: 'var(--font-sans, system-ui)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ color: colors.text, fontSize: 14 }}>{icon}</span>
        <span
          style={{
            color: '#e2e8f0',
            fontSize: 13,
            fontWeight: 600,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {data.label}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            background: colors.bg,
            border: `1px solid ${colors.border}`,
            color: colors.text,
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: '3px',
            textTransform: 'uppercase',
          }}
        >
          {data.status}
        </span>
        <span
          style={{
            background: priorityBadge.bg,
            color: priorityBadge.text,
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: '3px',
          }}
        >
          {data.priority}
        </span>
        {data.riskLevel !== 'LOW' && (
          <span
            style={{
              background: 'rgba(255,139,157,0.15)',
              color: '#ff8b9d',
              fontSize: 10,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: '3px',
            }}
          >
            {data.riskLevel}
          </span>
        )}
      </div>
      {data.agentName && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'rgba(148, 163, 184, 0.7)',
            fontFamily: 'var(--font-mono, monospace)',
          }}
        >
          {data.agentName}
        </div>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  mission: MissionNode as any,
};

// ============================================================================
// Main component
// ============================================================================

export function DAGVisualization({ missions, agents, agentNameById }: DAGVisualizationProps) {
  const { initialNodes, initialEdges } = useMemo(() => {
    const nodes: Node<MissionNodeData>[] = missions.map(m => ({
      id: m.id,
      type: 'mission',
      position: { x: 0, y: 0 },
      data: {
        label: m.title,
        status: m.status,
        priority: m.priority,
        agentName: agentNameById.get(m.assignedAgentId) || 'Unassigned',
        riskLevel: m.riskLevel,
      },
    }));

    const edges = deriveEdges(missions);
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(nodes, edges);

    return { initialNodes: layoutedNodes, initialEdges: layoutedEdges };
  }, [missions, agentNameById]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync when upstream data changes
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const colorMode: ColorMode = 'dark';

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    // Could navigate to mission detail in the future
    console.log('Mission selected:', node.id);
  }, []);

  if (missions.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'rgba(148, 163, 184, 0.5)',
          fontFamily: 'var(--font-sans, system-ui)',
          fontSize: 14,
        }}
      >
        No missions to visualize. Create missions to see the task graph.
      </div>
    );
  }

  // Stats
  const statusCounts = missions.reduce(
    (acc, m) => {
      acc[m.status] = (acc[m.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Stats overlay */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          zIndex: 10,
          display: 'flex',
          gap: 12,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11,
        }}
      >
        {Object.entries(statusCounts).map(([status, count]) => {
          const colors = STATUS_COLORS[status as MissionStatus];
          if (!colors) return null;
          return (
            <span key={status} style={{ color: colors.text, opacity: 0.8 }}>
              {STATUS_ICONS[status as MissionStatus]} {count} {status.toLowerCase()}
            </span>
          );
        })}
        <span style={{ color: 'rgba(148, 163, 184, 0.5)' }}>
          {edges.length} edges
        </span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#02040a' }}
      >
        <Background color="rgba(77, 158, 255, 0.06)" gap={24} size={1} />
        <Controls
          style={{
            background: '#050913',
            border: '1px solid rgba(77, 158, 255, 0.2)',
            borderRadius: 6,
          }}
        />
        <MiniMap
          nodeColor={n => {
            const data = n.data as MissionNodeData;
            return STATUS_COLORS[data?.status]?.border || '#4d9eff';
          }}
          style={{
            background: '#04070f',
            border: '1px solid rgba(77, 158, 255, 0.15)',
            borderRadius: 6,
          }}
          maskColor="rgba(2, 4, 10, 0.7)"
        />
      </ReactFlow>
    </div>
  );
}
