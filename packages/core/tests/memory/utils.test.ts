import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveMemoryStoreType,
  fromProjectMemoryItem,
  toProjectMemoryItem,
} from '../../src/memory/utils';

describe('memory utils', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  describe('resolveMemoryStoreType', () => {
    it('prefers explicit config over environment', () => {
      process.env.COMMANDER_MEMORY_STORE = 'postgres';
      expect(resolveMemoryStoreType({ memoryStoreType: 'in-memory' })).toBe('in-memory');
    });

    it('respects COMMANDER_MEMORY_STORE=postgres', () => {
      process.env.COMMANDER_MEMORY_STORE = 'postgres';
      expect(resolveMemoryStoreType({})).toBe('postgres');
    });

    it('respects COMMANDER_MEMORY_STORE=in-memory', () => {
      process.env.COMMANDER_MEMORY_STORE = 'in-memory';
      expect(resolveMemoryStoreType({})).toBe('in-memory');
    });

    it('defaults to in-memory when COMMANDER_MEMORY_STORE is invalid', () => {
      process.env.COMMANDER_MEMORY_STORE = 'invalid';
      process.env.VITEST = 'true';
      expect(resolveMemoryStoreType({})).toBe('in-memory');
    });

    it('uses in-memory under VITEST=true', () => {
      process.env.VITEST = 'true';
      expect(resolveMemoryStoreType({})).toBe('in-memory');
    });

    it('uses in-memory under NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      expect(resolveMemoryStoreType({})).toBe('in-memory');
    });

    it('uses postgres when COMMANDER_POSTGRES_URL is set in production', () => {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      process.env.COMMANDER_POSTGRES_URL = 'postgres://localhost:5432/test';
      expect(resolveMemoryStoreType({})).toBe('postgres');
    });

    it('uses postgres when DATABASE_URL is set in production', () => {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgres://localhost:5432/test';
      expect(resolveMemoryStoreType({})).toBe('postgres');
    });

    it('falls back to in-memory (Local-First) in production without Postgres DSN', () => {
      delete process.env.VITEST;
      delete process.env.COMMANDER_MEMORY_STORE;
      delete process.env.COMMANDER_POSTGRES_URL;
      delete process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';

      expect(resolveMemoryStoreType({})).toBe('in-memory');
    });

    it('falls back to in-memory (Local-First) when NODE_ENV is undefined without Postgres', () => {
      delete process.env.VITEST;
      delete process.env.COMMANDER_MEMORY_STORE;
      delete process.env.COMMANDER_POSTGRES_URL;
      delete process.env.DATABASE_URL;
      delete process.env.NODE_ENV;

      expect(resolveMemoryStoreType({})).toBe('in-memory');
    });
  });

  describe('fromProjectMemoryItem', () => {
    it('converts project memory item to episodic memory item with defaults', () => {
      const input = {
        id: 'mem-1',
        projectId: 'proj-1',
        missionId: 'mission-1',
        agentId: 'agent-1',
        kind: 'LESSON' as const,
        title: 'Test',
        content: 'Content',
        tags: ['tag1'],
        createdAt: '2026-01-01T00:00:00.000Z',
        duration: 'EPISODIC' as const,
      };

      const result = fromProjectMemoryItem(input);

      expect(result).toEqual({
        ...input,
        priority: 50,
        lastAccessedAt: '2026-01-01T00:00:00.000Z',
        confidence: 0.8,
      });
    });

    it('defaults duration to EPISODIC when not provided', () => {
      const input = {
        id: 'mem-1',
        projectId: 'proj-1',
        kind: 'LESSON' as const,
        title: 'Test',
        content: 'Content',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      const result = fromProjectMemoryItem(input);

      expect(result.duration).toBe('EPISODIC');
    });
  });

  describe('toProjectMemoryItem', () => {
    it('converts episodic memory item to project memory item', () => {
      const input = {
        id: 'mem-1',
        projectId: 'proj-1',
        missionId: 'mission-1',
        agentId: 'agent-1',
        kind: 'LESSON' as const,
        title: 'Test',
        content: 'Content',
        tags: ['tag1'],
        createdAt: '2026-01-01T00:00:00.000Z',
        duration: 'EPISODIC' as const,
        priority: 50,
        lastAccessedAt: '2026-01-01T00:00:00.000Z',
        confidence: 0.8,
      };

      const result = toProjectMemoryItem(input);

      expect(result).toEqual({
        id: 'mem-1',
        projectId: 'proj-1',
        missionId: 'mission-1',
        agentId: 'agent-1',
        kind: 'LESSON',
        title: 'Test',
        content: 'Content',
        tags: ['tag1'],
        createdAt: '2026-01-01T00:00:00.000Z',
        duration: 'EPISODIC',
      });
    });

    it('excludes lastAccessedAt, priority, and confidence from output', () => {
      const input = {
        id: 'mem-1',
        projectId: 'proj-1',
        kind: 'LESSON' as const,
        title: 'Test',
        content: 'Content',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        duration: 'EPISODIC' as const,
        priority: 50,
        lastAccessedAt: '2026-01-01T00:00:00.000Z',
        confidence: 0.8,
      };

      const result = toProjectMemoryItem(input);

      expect(result).not.toHaveProperty('priority');
      expect(result).not.toHaveProperty('lastAccessedAt');
      expect(result).not.toHaveProperty('confidence');
    });
  });
});