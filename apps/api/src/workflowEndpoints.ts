import { Router } from 'express';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWriteFileSync, readJsonFileSafe } from './atomicWrite';
import type { Request, Response, NextFunction } from 'express';
import { hasRole } from './userStore';

// ── Types ───────────────────────────────────────────────────────────────────

export type WorkflowNodeType = 'start' | 'agent' | 'tool' | 'condition' | 'end';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
  tenantId?: string;
  ownerId?: string;
}

// ── Persistence ─────────────────────────────────────────────────────────────

const WORKFLOWS_DIR = path.resolve(process.cwd(), '.commander');
const WORKFLOWS_FILE = path.join(WORKFLOWS_DIR, 'workflows.json');

let cache: WorkflowDefinition[] | null = null;

function loadFromDisk(): WorkflowDefinition[] {
  // REL-4: 损坏或错形均隔离，禁止 silent [] → 下次写入抹掉 workflows。
  const parsed = readJsonFileSafe<unknown>(WORKFLOWS_FILE, null, Array.isArray);
  return parsed === null ? [] : (parsed as WorkflowDefinition[]);
}

function saveToDisk(workflows: WorkflowDefinition[]): void {
  try {
    // REL-3: atomic write so a crash mid-write cannot truncate workflows.
    atomicWriteFileSync(WORKFLOWS_FILE, JSON.stringify(workflows, null, 2));
  } catch (err) {
    process.stderr.write(`[workflowStore] Failed to write workflows.json: ${err}\n`);
  }
}

function getWorkflows(): WorkflowDefinition[] {
  if (cache === null) {
    cache = loadFromDisk();
  }
  return cache;
}

function persist(workflows: WorkflowDefinition[]): void {
  cache = workflows;
  saveToDisk(workflows);
}

// ── Validation schemas ──────────────────────────────────────────────────────

const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['start', 'agent', 'tool', 'condition', 'end']),
  position: positionSchema,
  data: z.record(z.unknown()).default({}),
});

const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
  condition: z.string().max(500).optional(),
});

const workflowBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  nodes: z.array(nodeSchema).min(1).max(200),
  edges: z.array(edgeSchema).max(500),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function findWorkflow(id: string): WorkflowDefinition | undefined {
  return getWorkflows().find((w) => w.id === id);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

function principalId(req: Request): string | undefined {
  return req.user?.id ?? req.apiKeyId;
}

function principalTenant(req: Request): string | undefined {
  return req.user?.tenantId ?? req.tenantId;
}

function canAccessWorkflow(req: Request, workflow: WorkflowDefinition): boolean {
  if (req.user && hasRole(req.user.role, 'super_admin')) return true;
  const principal = principalId(req);
  const tenant = principalTenant(req);
  if (!principal || !tenant) return false;
  const workflowTenant = workflow.tenantId ?? process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local';
  return (
    workflowTenant === tenant &&
    (req.user?.role === 'admin' || !workflow.ownerId || workflow.ownerId === principal)
  );
}

function workflowForRequest(req: Request, res: Response): WorkflowDefinition | undefined {
  const workflow = findWorkflow(String(req.params.id));
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return undefined;
  }
  if (!canAccessWorkflow(req, workflow)) {
    // Avoid leaking whether another tenant owns the workflow.
    res.status(404).json({ error: 'Workflow not found' });
    return undefined;
  }
  return workflow;
}

/**
 * Topologically sort agent/tool nodes using edges. Falls back to node order
 * if the graph contains cycles.
 */
function buildExecutionOrder(workflow: WorkflowDefinition): string[] {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of workflow.nodes) {
    if (node.type === 'start' || node.type === 'end') continue;
    inDegree.set(node.id, 0);
  }

  for (const edge of workflow.edges) {
    const sourceNode = workflow.nodes.find((n) => n.id === edge.source);
    const targetNode = workflow.nodes.find((n) => n.id === edge.target);
    if (!sourceNode || !targetNode) continue;
    if (sourceNode.type === 'start' || sourceNode.type === 'end') continue;
    if (targetNode.type === 'start' || targetNode.type === 'end') continue;

    const list = adj.get(sourceNode.id) ?? [];
    list.push(targetNode.id);
    adj.set(sourceNode.id, list);
    inDegree.set(targetNode.id, (inDegree.get(targetNode.id) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const next of adj.get(id) ?? []) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  if (result.length < inDegree.size) {
    // Cycle detected — fall back to document order, skipping start/end.
    return workflow.nodes.filter((n) => n.type !== 'start' && n.type !== 'end').map((n) => n.id);
  }

  return result;
}

// ── Router ──────────────────────────────────────────────────────────────────

export function createWorkflowRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/workflows
  router.get('/api/workflows', (req, res) => {
    const workflows = getWorkflows()
      .filter((workflow) => canAccessWorkflow(req, workflow))
      .map(({ nodes, edges, ...meta }) => ({
        ...meta,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      }));
    res.json({ workflows });
  });

  // POST /api/workflows
  router.post('/api/workflows', (req, res) => {
    const tenantId = principalTenant(req);
    if (!tenantId) {
      res.status(403).json({ error: 'Tenant-bound identity required' });
      return;
    }
    const parsed = workflowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const now = new Date().toISOString();
    const workflow: WorkflowDefinition = {
      id: randomUUID(),
      ...parsed.data,
      createdAt: now,
      updatedAt: now,
      tenantId,
      ownerId: principalId(req),
    };

    const workflows = getWorkflows();
    workflows.push(workflow);
    persist(workflows);
    res.status(201).json({ workflow });
  });

  // GET /api/workflows/:id
  router.get('/api/workflows/:id', (req, res) => {
    const workflow = workflowForRequest(req, res);
    if (!workflow) return;
    res.json({ workflow });
  });

  // PUT /api/workflows/:id
  router.put('/api/workflows/:id', (req, res) => {
    const parsed = workflowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const workflow = workflowForRequest(req, res);
    if (!workflow) return;
    const workflows = getWorkflows();
    const index = workflows.findIndex((w) => w.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    workflows[index] = {
      ...workflows[index],
      ...parsed.data,
      updatedAt: new Date().toISOString(),
    };
    persist(workflows);
    res.json({ workflow: workflows[index] });
  });

  // DELETE /api/workflows/:id
  router.delete('/api/workflows/:id', (req, res) => {
    const workflows = getWorkflows();
    const index = workflows.findIndex((w) => w.id === req.params.id);
    if (index === -1 || !canAccessWorkflow(req, workflows[index])) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    workflows.splice(index, 1);
    persist(workflows);
    res.json({ success: true });
  });

  // POST /api/workflows/:id/execute
  router.post('/api/workflows/:id/execute', (req, res) => {
    const workflow = workflowForRequest(req, res);
    if (!workflow) return;

    const order = buildExecutionOrder(workflow);
    const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
    const steps = order
      .map((id) => nodeById.get(id))
      .filter((n): n is WorkflowNode => n !== undefined)
      .map((n) => {
        if (n.type === 'agent') {
          return {
            id: n.id,
            agentId: (n.data.agentId as string) || 'agent-default',
            name: (n.data.name as string) || 'Agent Step',
            input: (n.data.prompt as string) || '',
          };
        }
        if (n.type === 'tool') {
          return {
            id: n.id,
            agentId: 'agent-default',
            name: (n.data.name as string) || 'Tool Step',
            input: JSON.stringify({
              tool: n.data.tool,
              arguments: n.data.arguments,
            }),
          };
        }
        return null;
      })
      .filter(Boolean);

    res.json({
      workflowId: workflow.id,
      pipeline: {
        id: `wf-${workflow.id}`,
        name: workflow.name,
        steps,
      },
    });
  });

  return router;
}
