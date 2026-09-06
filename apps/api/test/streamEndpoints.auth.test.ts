import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import { createStreamRouter } from '../src/streamEndpoints';
import { TestUserRepository } from './authRepositories';
import { _resetUserStoreForTests, findUserById, setUserRepository } from '../src/userStore';

class UnavailableUserRepository extends TestUserRepository {
  override async findUserById(): Promise<never> {
    throw new Error('sensitive database endpoint');
  }
}

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('streamEndpoints auth', () => {
  it('rejects unauthenticated SSE connections with 401', async () => {
    const app = express();
    app.use(createStreamRouter());
    const { port, close } = await listen(app);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`);
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'Authentication required');
    } finally {
      await close();
    }
  });

  it('rejects tenant-wide aliases for non-admin API keys', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next) => {
      req.apiKeyId = 'test-key';
      next();
    });
    app.use(createStreamRouter());
    const { port, close } = await listen(app);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/messages/stream`, {
        headers: { Accept: 'text/event-stream' },
      });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('allows SSE when req.user is set by upstream JWT auth', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next) => {
      req.user = {
        id: 'u1',
        username: 'alice',
        role: 'admin',
        tenantId: 'tenant-a',
      } as Request['user'];
      req.tenantId = 'tenant-a';
      next();
    });
    app.use(
      createStreamRouter({
        resolveProject: (projectId) =>
          projectId === 'p1' ? { id: 'p1', tenantId: 'tenant-a' } : undefined,
      }),
    );
    const { port, close } = await listen(app);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/projects/p1/events`, {
        headers: { Accept: 'text/event-stream' },
      });
      assert.equal(res.status, 200);
      await res.body?.cancel();
    } finally {
      await close();
    }
  });

  it('binds legacy projects without ownership metadata to the local tenant only', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next) => {
      req.user = { id: 'local-user', username: 'local', role: 'viewer', tenantId: 'local' };
      req.tenantId = 'local';
      next();
    });
    app.use(createStreamRouter({ resolveProject: () => ({ id: 'legacy-project' }) }));
    const { port, close } = await listen(app);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/projects/legacy-project/events`, {
        headers: { Accept: 'text/event-stream' },
      });
      assert.equal(res.status, 200);
      await res.body?.cancel();
    } finally {
      await close();
    }
  });

  it('rejects tenant-wide aliases for a project-limited EventSource JWT', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-sse-access-token';
    const { signAccessToken } = await import('../src/jwtMiddleware');
    const users = new TestUserRepository();
    setUserRepository(users);
    const created = await users.createUser({
      username: 'bob',
      email: 'bob@example.test',
      password: 'test-password',
      role: 'viewer',
    });
    assert.ok(!('error' in created));
    const user = await findUserById(created.user.id);
    assert.ok(user);
    const token = signAccessToken(user);

    const app = express();
    app.use(createStreamRouter());
    const { port, close } = await listen(app);

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/events?access_token=${encodeURIComponent(token)}`,
        { headers: { Accept: 'text/event-stream' } },
      );
      assert.equal(res.status, 403);
    } finally {
      await close();
      _resetUserStoreForTests();
    }
  });

  it('returns a generic 503 when EventSource token authority is unavailable', async () => {
    const users = new TestUserRepository();
    const created = await users.createUser({
      username: 'unavailable-authority-user',
      email: 'unavailable@example.test',
      password: 'test-password',
      role: 'viewer',
    });
    assert.ok(!('error' in created));
    const user = await users.findUserById(created.user.id);
    assert.ok(user);
    const { signAccessToken } = await import('../src/jwtMiddleware');
    const token = signAccessToken(user);
    setUserRepository(new UnavailableUserRepository());

    const app = express();
    app.use(createStreamRouter());
    const { port, close } = await listen(app);

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/events?access_token=${encodeURIComponent(token)}`,
      );
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: { code: 'AUTHORITY_UNAVAILABLE' } });
    } finally {
      await close();
      _resetUserStoreForTests();
    }
  });

  it('allows tenant-wide aliases for a tenant admin', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next) => {
      req.user = {
        id: 'admin-1',
        username: 'admin',
        role: 'admin',
        tenantId: 'tenant-a',
      };
      req.tenantId = 'tenant-a';
      next();
    });
    app.use(createStreamRouter());
    const { port, close } = await listen(app);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        headers: { Accept: 'text/event-stream' },
      });
      assert.equal(res.status, 200);
      await res.body?.cancel();
    } finally {
      await close();
    }
  });
});
