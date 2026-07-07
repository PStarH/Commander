import { useEffect, useState, useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
  Panel,
  useReactFlow,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Workflow,
  Plus,
  Save,
  Play,
  Trash2,
  X,
  Edit2,
  Check,
  AlertTriangle,
  LayoutGrid,
  ArrowRight,
} from 'lucide-react';
import {
  fetchWorkflows,
  fetchWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  executeWorkflow,
  type Workflow as WorkflowDef,
  type WorkflowSummary,
  type WorkflowNodeType,
} from '../api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';

const NODE_TYPES: {
  type: WorkflowNodeType;
  label: string;
  color: string;
  icon: typeof Workflow;
}[] = [
  { type: 'start', label: 'Start', color: '#4de98c', icon: Play },
  { type: 'agent', label: 'Agent', color: '#4d9eff', icon: Workflow },
  { type: 'tool', label: 'Tool', color: '#a78bfa', icon: LayoutGrid },
  { type: 'condition', label: 'Condition', color: '#ffcc66', icon: ArrowRight },
  { type: 'end', label: 'End', color: '#ff8b9d', icon: Check },
];

const NODE_WIDTH = 160;
const NODE_HEIGHT = 60;

function CustomNode({ data, selected }: { data: Record<string, unknown>; selected?: boolean }) {
  const nodeType = (data.type as WorkflowNodeType) || 'agent';
  const config = NODE_TYPES.find((n) => n.type === nodeType) ?? NODE_TYPES[1];
  const Icon = config.icon;
  return (
    <div className={`wf-node ${selected ? 'selected' : ''}`} style={{ borderColor: config.color }}>
      <Handle type="target" position={Position.Top} className="wf-handle" />
      <div className="wf-node-icon" style={{ color: config.color }}>
        <Icon size={14} />
      </div>
      <div className="wf-node-content">
        <div className="wf-node-label">{(data.name as string) || config.label}</div>
        <div className="wf-node-type">{config.label}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className="wf-handle" />
    </div>
  );
}

const nodeTypes = { custom: CustomNode };

function generateId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function toFlowNodes(nodes: WorkflowDef['nodes']): Node[] {
  return nodes.map((n) => ({
    id: n.id,
    type: 'custom',
    position: n.position,
    data: { ...n.data, type: n.type },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));
}

function toFlowEdges(edges: WorkflowDef['edges']): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    data: { condition: e.condition },
    animated: true,
  }));
}

interface EditorProps {
  workflow: WorkflowDef | null;
  onSaved: () => void;
  onCancel: () => void;
}

function WorkflowEditor({ workflow, onSaved, onCancel }: EditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState(workflow?.name ?? 'New Workflow');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    if (workflow) {
      setNodes(toFlowNodes(workflow.nodes));
      setEdges(toFlowEdges(workflow.edges));
      setName(workflow.name);
      setDescription(workflow.description ?? '');
    } else {
      setNodes([
        {
          id: 'start',
          type: 'custom',
          position: { x: 250, y: 50 },
          data: { name: 'Start', type: 'start' },
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        },
      ]);
      setEdges([]);
      setName('New Workflow');
      setDescription('');
    }
  }, [workflow, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge({ ...connection, animated: true }, eds)),
    [setEdges],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow') as WorkflowNodeType;
      if (!type || !reactFlowWrapper.current || !reactFlowInstance) return;

      const position = screenToFlowPosition({
        x: event.clientX - reactFlowWrapper.current.getBoundingClientRect().left,
        y: event.clientY - reactFlowWrapper.current.getBoundingClientRect().top,
      });

      const config = NODE_TYPES.find((n) => n.type === type)!;
      const newNode: Node = {
        id: generateId(type),
        type: 'custom',
        position,
        data: { name: config.label, type },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, screenToFlowPosition, setNodes],
  );

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  function updateSelectedNodeData(key: string, value: unknown) {
    if (!selectedNode) return;
    const next = { ...selectedNode.data, [key]: value };
    setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: next } : n)));
    setSelectedNode({ ...selectedNode, data: next });
  }

  function removeSelectedNode() {
    if (!selectedNode) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
    setEdges((eds) =>
      eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id),
    );
    setSelectedNode(null);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('Workflow name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.data.type as WorkflowNodeType) ?? 'agent',
          position: n.position,
          data: n.data,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label: typeof e.label === 'string' ? e.label : undefined,
          condition: e.data?.condition as string | undefined,
        })),
      };
      if (workflow) {
        await updateWorkflow(workflow.id, payload);
      } else {
        await createWorkflow(payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  }

  async function handleExecute() {
    if (!workflow) {
      setError('Save the workflow before executing');
      return;
    }
    setExecuting(true);
    setError(null);
    try {
      await executeWorkflow(workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute workflow');
    } finally {
      setExecuting(false);
    }
  }

  return (
    <div className="workflow-editor">
      {error && (
        <div className="banner error" style={{ marginBottom: 12 }}>
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="workflow-toolbar">
        <div className="workflow-meta">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workflow name"
            className="workflow-name-input"
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="workflow-desc-input"
          />
        </div>
        <div className="workflow-actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {workflow && (
            <Button variant="secondary" onClick={handleExecute} disabled={executing}>
              <Play size={16} />
              {executing ? 'Running...' : 'Run'}
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving}>
            <Save size={16} />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="workflow-canvas-wrap" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setReactFlowInstance}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          fitView
          attributionPosition="bottom-right"
        >
          <Background gap={16} size={1} color="#1d2535" />
          <Controls />
          <MiniMap nodeStrokeWidth={3} className="wf-minimap" />
          <Panel position="top-left" className="wf-palette">
            <div className="wf-palette-title">Nodes</div>
            {NODE_TYPES.map((node) => (
              <div
                key={node.type}
                className="wf-palette-item"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/reactflow', node.type);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                style={{ borderLeftColor: node.color }}
              >
                <node.icon size={14} style={{ color: node.color }} />
                <span>{node.label}</span>
              </div>
            ))}
          </Panel>
        </ReactFlow>

        {selectedNode && (
          <div className="wf-inspector">
            <div className="wf-inspector-head">
              <h3>Node Config</h3>
              <button type="button" className="icon-btn" onClick={() => setSelectedNode(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="wf-inspector-body">
              <div className="form-row">
                <label>Name</label>
                <Input
                  value={(selectedNode.data.name as string) || ''}
                  onChange={(e) => updateSelectedNodeData('name', e.target.value)}
                />
              </div>
              {selectedNode.id !== 'start' && selectedNode.data.type !== 'end' && (
                <>
                  <div className="form-row">
                    <label>Agent ID</label>
                    <Input
                      value={(selectedNode.data.agentId as string) || ''}
                      onChange={(e) => updateSelectedNodeData('agentId', e.target.value)}
                      placeholder="agent-default"
                    />
                  </div>
                  <div className="form-row">
                    <label>Prompt / Input</label>
                    <textarea
                      className="inp wf-textarea"
                      rows={4}
                      value={(selectedNode.data.prompt as string) || ''}
                      onChange={(e) => updateSelectedNodeData('prompt', e.target.value)}
                      placeholder="Enter instructions or context for this step..."
                    />
                  </div>
                </>
              )}
              {selectedNode.data.type === 'tool' && (
                <div className="form-row">
                  <label>Tool Name</label>
                  <Input
                    value={(selectedNode.data.tool as string) || ''}
                    onChange={(e) => updateSelectedNodeData('tool', e.target.value)}
                    placeholder="e.g. web_search"
                  />
                </div>
              )}
              {selectedNode.data.type === 'condition' && (
                <div className="form-row">
                  <label>Condition Expression</label>
                  <Input
                    value={(selectedNode.data.condition as string) || ''}
                    onChange={(e) => updateSelectedNodeData('condition', e.target.value)}
                    placeholder="e.g. score > 0.8"
                  />
                </div>
              )}
              <Button variant="danger" size="sm" onClick={removeSelectedNode}>
                <Trash2 size={14} />
                Delete Node
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingWorkflow, setEditingWorkflow] = useState<WorkflowDef | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  async function loadWorkflows() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkflows();
      setWorkflows(data.workflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWorkflows();
  }, []);

  async function handleEdit(wf: WorkflowSummary) {
    try {
      const data = await fetchWorkflow(wf.id);
      setEditingWorkflow(data.workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflow');
    }
  }

  async function handleDelete(wf: WorkflowSummary) {
    if (!confirm(`Delete workflow "${wf.name}"?`)) return;
    try {
      await deleteWorkflow(wf.id);
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete workflow');
    }
  }

  function handleSaved() {
    setEditingWorkflow(null);
    setIsCreating(false);
    loadWorkflows();
  }

  function handleCancel() {
    setEditingWorkflow(null);
    setIsCreating(false);
  }

  if (isCreating || editingWorkflow) {
    return (
      <WorkflowEditor workflow={editingWorkflow} onSaved={handleSaved} onCancel={handleCancel} />
    );
  }

  return (
    <div className="workflows-page">
      <div className="page-header">
        <div className="page-header-title">
          <Workflow size={20} />
          <h1>Workflows</h1>
        </div>
        <Button onClick={() => setIsCreating(true)}>
          <Plus size={16} />
          New Workflow
        </Button>
      </div>

      {error && (
        <div className="banner error" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <Card>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Nodes</th>
                <th>Edges</th>
                <th>Updated</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && workflows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <div className="loading-inline">Loading workflows...</div>
                  </td>
                </tr>
              ) : workflows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    No workflows yet. Create one to start visual orchestration.
                  </td>
                </tr>
              ) : (
                workflows.map((wf) => (
                  <tr key={wf.id}>
                    <td className="font-medium">{wf.name}</td>
                    <td>{wf.description || '—'}</td>
                    <td>{wf.nodeCount}</td>
                    <td>{wf.edgeCount}</td>
                    <td>{new Date(wf.updatedAt).toLocaleString()}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="Edit"
                        onClick={() => handleEdit(wf)}
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Run"
                        onClick={() => executeWorkflow(wf.id).catch(() => {})}
                      >
                        <Play size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Delete"
                        onClick={() => handleDelete(wf)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
