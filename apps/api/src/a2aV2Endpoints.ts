import express, { Router } from 'express';
import {
  canTransition,
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_VERSION_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  A2A_METHODS,
} from '@commander/core';
import type {
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2ATaskState,
  A2AMessage,
} from '@commander/core';

function v1AgentCard(): A2AAgentCard {
  return {
    name: 'Commander TELOS',
    description: 'Token-Efficient Low-waste Orchestration System',
    version: '2.0.0',
    supportedInterfaces: [
      { url: '/a2a', protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      { id: 'orchestrate', name: 'Orchestrate', description: 'Plan and execute multi-agent missions', tags: ['plan', 'execute'] },
      { id: 'research', name: 'Research', description: 'Deep research with subagents', tags: ['research', 'subagent'] },
    ],
    provider: { organization: 'TELOS', url: 'https://github.com/sampan/commander' },
  };
}

const tasks = new Map<string, A2ATask>();
let taskIdCounter = 0;

export function createA2AV2Router(): Router {
  const router = express.Router();
  router.use(express.json());

  // Well-known Agent Card (v1.0)
  router.get(AGENT_CARD_WELL_KNOWN_PATH, (_req, res) => {
    res.json(v1AgentCard());
  });

  // JSON-RPC 2.0 single endpoint for all A2A methods
  router.post('/', async (req, res) => {
    const rpcReq = req.body as A2AJsonRpcRequest;
    if (!rpcReq || rpcReq.jsonrpc !== '2.0') {
      return res.status(400).json(errorResponse(rpcReq?.id ?? null, -32600, 'Invalid Request'));
    }

    try {
      const response = await handleMethod(rpcReq);
      res.json(response);
    } catch (err) {
      res.json(errorResponse(rpcReq.id, -32603, err instanceof Error ? err.message : 'Internal error'));
    }
  });

  // SSE streaming endpoint
  router.post('/stream', async (req, res) => {
    const rpcReq = req.body as A2AJsonRpcRequest;
    if (rpcReq.method !== A2A_METHODS.SEND_MESSAGE_STREAM) {
      return res.status(400).json(errorResponse(rpcReq?.id ?? null, -32600, 'Only message/stream supported'));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'A2A-Version': A2A_PROTOCOL_VERSION,
    });

    const task = createTask('WORKING');
    res.write(`data: ${JSON.stringify(ssr('task', task))}\n\n`);

    setTimeout(() => {
      task.status = { state: 'COMPLETED', timestamp: new Date().toISOString() };
      task.artifacts = [{ artifactId: 'art-1', parts: [{ type: 'text', text: 'Task completed.' }] }];
      res.write(`data: ${JSON.stringify(ssr('task', task))}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcReq.id, result: { task } })}\n\n`);
      res.end();
    }, 100);
  });

  return router;
}

async function handleMethod(req: A2AJsonRpcRequest): Promise<A2AJsonRpcResponse> {
  switch (req.method) {
    case A2A_METHODS.SEND_MESSAGE: {
      const params = req.params as any;
      const task = createTask('WORKING');
      tasks.set(task.id, task);
      setTimeout(() => {
        task.status = { state: 'COMPLETED', timestamp: new Date().toISOString() };
      }, 50);
      return { jsonrpc: '2.0', id: req.id, result: { task } };
    }

    case A2A_METHODS.GET_TASK: {
      const params = req.params as any;
      const task = tasks.get(params.id);
      if (!task) return errorResponse(req.id, A2A_ERROR.TASK_NOT_FOUND, 'Task not found');
      return { jsonrpc: '2.0', id: req.id, result: { task } };
    }

    case A2A_METHODS.LIST_TASKS: {
      return {
        jsonrpc: '2.0', id: req.id,
        result: { tasks: Array.from(tasks.values()), pageSize: 50, totalSize: tasks.size },
      };
    }

    case A2A_METHODS.CANCEL_TASK: {
      const params = req.params as any;
      const task = tasks.get(params.id);
      if (!task) return errorResponse(req.id, A2A_ERROR.TASK_NOT_FOUND, 'Task not found');
      if (!canTransition(task.status.state, 'CANCELED')) {
        return errorResponse(req.id, A2A_ERROR.TASK_NOT_CANCELABLE, 'Task cannot be canceled');
      }
      task.status = { state: 'CANCELED', timestamp: new Date().toISOString() };
      return { jsonrpc: '2.0', id: req.id, result: { task } };
    }

    case A2A_METHODS.GET_AGENT_CARD:
      return { jsonrpc: '2.0', id: req.id, result: v1AgentCard() };

    default:
      return errorResponse(req.id, -32601, `Method not found: ${req.method}`);
  }
}

function createTask(initialState: A2ATaskState): A2ATask {
  const id = `task-${++taskIdCounter}-${Date.now()}`;
  return {
    id,
    contextId: 'default',
    status: { state: initialState, timestamp: new Date().toISOString() },
  };
}

function ssr(type: string, data: unknown): { jsonrpc: string; id: string | number | null; result: Record<string, unknown> } {
  return { jsonrpc: '2.0', id: null, result: { [type]: data } };
}

function errorResponse(id: string | number | null, code: number, message: string): A2AJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
