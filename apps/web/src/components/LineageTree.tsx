/**
 * LineageTree — visualizes the parent→child agent lineage for a run.
 *
 * Pulls the reconstructed lineage tree from `/api/lineage/runs/:runId` (GAP-05).
 * The Core `AgentLineage` class tracks every spawn / handoff / termination;
 * this panel renders that tree as an indented outline where each node shows
 * the agentId, role, depth, and number of tool calls attributed to it.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  GitBranch,
  Network,
  Wrench,
  CornerDownRight,
  CircleDot,
  AlertTriangle,
  Activity,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { Badge, MetricCard } from './ui';
import { fetchLineage, fetchReplayRuns } from '../api';
import type { LineageNodeEntry, LineageSummaryResponse, ReplayRun } from '../types';

const COLORS = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
  blue: '#4d9eff',
  purple: '#a78bfa',
  surface: '#050913',
  border: '#151c23',
  text: '#7f8c86',
  textPrimary: '#e5f0da',
};

interface TreeNode {
  node: LineageNodeEntry;
  children: TreeNode[];
}

/**
 * Build a forest of TreeNodes from the flat nodes list. Roots are nodes with
 * no parent (or whose parent is not present in the set). Children are sorted
 * by spawnedAt for stable rendering.
 */
function buildForest(nodes: LineageNodeEntry[]): TreeNode[] {
  const byInstanceId = new Map<string, LineageNodeEntry>();
  for (const n of nodes) {
    byInstanceId.set(n.instanceId, n);
  }

  const childrenByParent = new Map<string | null, LineageNodeEntry[]>();
  for (const n of nodes) {
    const parentKey =
      n.parentInstanceId && byInstanceId.has(n.parentInstanceId) ? n.parentInstanceId : null;
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(n);
    childrenByParent.set(parentKey, list);
  }

  function toTreeNode(node: LineageNodeEntry): TreeNode {
    const childNodes = childrenByParent.get(node.instanceId) ?? [];
    childNodes.sort((a, b) => (a.spawnedAt || '').localeCompare(b.spawnedAt || ''));
    return {
      node,
      children: childNodes.map(toTreeNode),
    };
  }

  const roots = childrenByParent.get(null) ?? [];
  roots.sort((a, b) => (a.spawnedAt || '').localeCompare(b.spawnedAt || ''));
  return roots.map(toTreeNode);
}

function nodeStatusVariant(node: LineageNodeEntry): 'success' | 'warning' | 'error' {
  if (node.revokedAt) return 'error';
  if (node.toolCallCount === 0) return 'warning';
  return 'success';
}

function nodeStatusLabel(node: LineageNodeEntry): string {
  if (node.revokedAt) return 'revoked';
  if (node.toolCallCount === 0) return 'idle';
  return 'active';
}

interface LineageNodeRowProps {
  treeNode: TreeNode;
  isLast: boolean;
  prefix: boolean[];
}

function LineageNodeRow({ treeNode, isLast, prefix }: LineageNodeRowProps) {
  const { node, children } = treeNode;
  const isActive = !node.revokedAt;
  const statusColor = node.revokedAt
    ? COLORS.red
    : node.toolCallCount > 0
      ? COLORS.green
      : COLORS.amber;

  return (
    <div className="lineage-row">
      <div className="lineage-line-cell">
        {/* Indent guides for ancestor depths */}
        {prefix.map((show, i) => (
          <span
            key={i}
            className="lineage-guide"
            style={{ visibility: show ? 'visible' : 'hidden' }}
          />
        ))}
        <span className="lineage-connector">
          {isLast ? <CornerDownRight size={14} /> : <CornerDownRight size={14} />}
        </span>
      </div>

      <div className="lineage-node-content" style={{ borderColor: statusColor }}>
        <div className="lineage-node-head">
          <CircleDot size={14} style={{ color: statusColor }} />
          <span className="lineage-agent-id" title={node.instanceId}>
            {node.agentId}
          </span>
          {node.role && <Badge variant="info">{node.role}</Badge>}
          <Badge variant={nodeStatusVariant(node)}>{nodeStatusLabel(node)}</Badge>
          <span className="lineage-depth" title="Depth in lineage tree">
            <Layers size={11} /> d{node.depth}
          </span>
          <span className="lineage-tools" title="Tool calls attributed to this agent">
            <Wrench size={11} /> {node.toolCallCount}
          </span>
        </div>

        {node.spawnedAt && (
          <div className="lineage-node-meta">
            <span>spawned {node.spawnedAt}</span>
            {!isActive && node.revokedAt && <span> · revoked {node.revokedAt}</span>}
          </div>
        )}
      </div>

      {children.length > 0 && (
        <div className="lineage-children">
          {children.map((child, i) => (
            <LineageNodeRow
              key={child.node.instanceId}
              treeNode={child}
              isLast={i === children.length - 1}
              prefix={[...prefix, !isLast]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface LineageTreeProps {
  /** Optional pre-selected runId. */
  runId?: string;
}

export function LineageTree({ runId: initialRunId }: LineageTreeProps) {
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>(initialRunId ?? '');
  const [summary, setSummary] = useState<LineageSummaryResponse | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load available runs once.
  useEffect(() => {
    let cancelled = false;
    async function loadRuns() {
      setLoadingRuns(true);
      try {
        const data = await fetchReplayRuns();
        if (!cancelled) {
          setRuns(data.runs);
          if (!initialRunId && data.runs.length > 0) {
            setSelectedRunId(data.runs[0].runId);
          }
        }
      } catch {
        if (!cancelled) setRuns([]);
      } finally {
        if (!cancelled) setLoadingRuns(false);
      }
    }
    loadRuns();
    return () => {
      cancelled = true;
    };
  }, [initialRunId]);

  // Load the lineage summary whenever the selected run changes.
  useEffect(() => {
    if (!selectedRunId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    async function loadSummary() {
      setLoadingSummary(true);
      setError(null);
      try {
        const data = await fetchLineage(selectedRunId);
        if (!cancelled) setSummary(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load agent lineage');
          setSummary(null);
        }
      } finally {
        if (!cancelled) setLoadingSummary(false);
      }
    }
    loadSummary();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const forest = useMemo(() => (summary ? buildForest(summary.nodes) : []), [summary]);

  return (
    <div className="confidence-panel">
      <div className="section-head">
        <div>
          <div className="section-label">Agent Lineage</div>
          <h2>Parent → child spawn tree</h2>
        </div>
        <div className="confidence-filters">
          <select
            className="sel"
            value={selectedRunId}
            onChange={(e) => setSelectedRunId(e.target.value)}
            disabled={loadingRuns || runs.length === 0}
          >
            {loadingRuns && <option value="">Loading runs...</option>}
            {!loadingRuns && runs.length === 0 && <option value="">No runs available</option>}
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId.slice(0, 12)} · {run.totalEvents} events
              </option>
            ))}
          </select>
          {selectedRunId && (
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => setSelectedRunId((current) => current && current)}
              title="Refresh"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      </div>

      {loadingSummary && <div className="narrative narrative-green">Loading agent lineage...</div>}

      {!loadingSummary && error && (
        <div className="narrative narrative-amber">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {!loadingSummary && !error && !summary && (
        <div className="narrative narrative-green">
          Select a run to view its agent lineage tree. Every sub-agent spawn and handoff is tracked
          as a parent→child edge, with tool call counts per node.
        </div>
      )}

      {!loadingSummary && !error && summary && summary.totalNodes === 0 && (
        <div className="narrative narrative-green">
          No agent lineage events found for this run. Either the run used a single root agent with
          no spawns, or no spawn / handoff events were recorded in the trace.
        </div>
      )}

      {!loadingSummary && !error && summary && summary.totalNodes > 0 && (
        <>
          {/* Metric Cards */}
          <div className="metric-row">
            <MetricCard
              label="Total nodes"
              value={String(summary.totalNodes)}
              icon={<Network size={14} />}
            />
            <MetricCard
              label="Active nodes"
              value={String(summary.activeNodes)}
              icon={<Activity size={14} />}
              trend={{
                value:
                  summary.activeNodes === summary.totalNodes
                    ? 'All active'
                    : `${summary.totalNodes - summary.activeNodes} revoked`,
                positive: summary.activeNodes === summary.totalNodes,
              }}
            />
            <MetricCard
              label="Max depth"
              value={String(summary.maxDepth)}
              icon={<Layers size={14} />}
            />
            <MetricCard
              label="Root agent"
              value={summary.root ? summary.root.agentId.slice(0, 14) : '—'}
              icon={<GitBranch size={14} />}
            />
          </div>

          {/* Tree */}
          <div className="lineage-tree">
            {forest.map((treeNode, i) => (
              <LineageNodeRow
                key={treeNode.node.instanceId}
                treeNode={treeNode}
                isLast={i === forest.length - 1}
                prefix={[]}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
