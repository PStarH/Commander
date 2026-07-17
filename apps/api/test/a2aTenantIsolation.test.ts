import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Application } from 'express';
import type { AddressInfo } from 'node:net';

import { tenantContextMiddleware } from '../src/tenantContextMiddleware';
import { createA2ARouter } from '../src/a2aEndpoints';
import { TaskManager, ArtifactManager, type Task } from '../src/a2aTask';
import { AgentCardRegistry } from '../src/agentCard';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

const A2A_AUTH = 'test-a2a-auth-token-16';

function a2aHeaders(tenantId?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${A2A_AUTH}`,
    ...(tenantId ? { 'X-Tenant-ID': tenantId } : {}),
    ...extra,
  };
}

async function startServer(): Promise<TestServer> {
  const app: Application = express();
  app.use(express.json());
  app.use(tenantContextMiddleware);

  const taskManager = new TaskManager();
  const artifactManager = new ArtifactManager();
  const cardRegistry = new AgentCardRegistry();
  app.use(
    '/a2a',
    createA2ARouter(taskManager, artifactManager, cardRegistry, {
      authToken: A2A_AUTH,
    }),
  );

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function createTask(
  baseUrl: string,
  tenantId: string,
  description: string,
): Promise<Task> {
  const res = await fetch(`${baseUrl}/a2a/tasks`, {
    method: 'POST',
    headers: a2aHeaders(tenantId, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ clientId: 'client-1', description }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Task;
}

describe('A2A REST tenant isolation', () => {
  it('tenant A task cannot be read by tenant B', async () => {
    const server = await startServer();
    try {
      const task = await createTask(server.baseUrl, 'tenant-a', 'secret task');
      assert.equal(task.tenantId, 'tenant-a');

      const resB = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}`, {
        headers: a2aHeaders('tenant-b'),
      });
      assert.equal(resB.status, 403);
      const bodyB = (await resB.json()) as { error: string };
      assert.equal(bodyB.error, 'Forbidden');

      const resA = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}`, {
        headers: a2aHeaders('tenant-a'),
      });
      assert.equal(resA.status, 200);
      const bodyA = (await resA.json()) as Task;
      assert.equal(bodyA.id, task.id);
      assert.equal(bodyA.tenantId, 'tenant-a');
    } finally {
      await server.close();
    }
  });

  it('LIST_TASKS returns only current tenant tasks', async () => {
    const server = await startServer();
    try {
      await createTask(server.baseUrl, 'tenant-a', 'task-a1');
      await createTask(server.baseUrl, 'tenant-a', 'task-a2');
      await createTask(server.baseUrl, 'tenant-b', 'task-b1');

      const resA = await fetch(`${server.baseUrl}/a2a/tasks`, {
        headers: a2aHeaders('tenant-a'),
      });
      assert.equal(resA.status, 200);
      const bodyA = (await resA.json()) as { tasks: Task[]; count: number };
      assert.equal(bodyA.count, 2);
      assert.ok(bodyA.tasks.every((t) => t.tenantId === 'tenant-a'));

      const resB = await fetch(`${server.baseUrl}/a2a/tasks`, {
        headers: a2aHeaders('tenant-b'),
      });
      assert.equal(resB.status, 200);
      const bodyB = (await resB.json()) as { tasks: Task[]; count: number };
      assert.equal(bodyB.count, 1);
      assert.equal(bodyB.tasks[0].tenantId, 'tenant-b');
    } finally {
      await server.close();
    }
  });

  it('CANCEL_TASK cross-tenant returns 403', async () => {
    const server = await startServer();
    try {
      const task = await createTask(server.baseUrl, 'tenant-a', 'cancellable task');

      const resB = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/cancel`, {
        method: 'POST',
        headers: a2aHeaders('tenant-b'),
      });
      assert.equal(resB.status, 403);
      const bodyB = (await resB.json()) as { error: string };
      assert.equal(bodyB.error, 'Forbidden');

      const resA = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/cancel`, {
        method: 'POST',
        headers: a2aHeaders('tenant-a'),
      });
      assert.equal(resA.status, 200);
      const bodyA = (await resA.json()) as Task;
      assert.equal(bodyA.status, 'cancelled');
    } finally {
      await server.close();
    }
  });

  it('falls back to default tenant without a tenant header', async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.baseUrl}/a2a/tasks`, {
        method: 'POST',
        headers: a2aHeaders(undefined, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ clientId: 'client-default', description: 'default task' }),
      });
      assert.equal(res.status, 201);
      const task = (await res.json()) as Task;
      assert.equal(task.tenantId, '__default__');

      const resGet = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}`, {
        headers: a2aHeaders(),
      });
      assert.equal(resGet.status, 200);
      const body = (await resGet.json()) as Task;
      assert.equal(body.tenantId, '__default__');
    } finally {
      await server.close();
    }
  });
});
