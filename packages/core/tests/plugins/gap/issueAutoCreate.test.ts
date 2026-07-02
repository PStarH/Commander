// packages/core/tests/plugins/gap/issueAutoCreate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IssueAutoCreate } from '../../../src/plugins/builtin/gap/issueAutoCreate';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('IssueAutoCreate', () => {
  it('skips creation in dryRun mode', async () => {
    const creator = new IssueAutoCreate({
      repo: 'owner/repo',
      token: 'tok',
      defaultLabels: [],
      titlePrefix: '[test]',
      dedupEnabled: false,
      dryRun: true,
    });
    const result = await creator.create({ title: 'Test', body: 'b', labels: [] });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('creates issue via GitHub API', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ number: 42, html_url: 'https://github.com/x/y/issues/42' }),
      });

    const creator = new IssueAutoCreate({
      repo: 'owner/repo',
      token: 'tok',
      defaultLabels: ['gap'],
      titlePrefix: '[test]',
      dedupEnabled: true,
      dryRun: false,
    });
    const result = await creator.create({ title: 'Test', body: 'b', labels: ['l'] });
    expect(result?.id).toBe(42);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('skips when duplicate found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ number: 99, title: '[test] Test', state: 'open' }],
    });
    const creator = new IssueAutoCreate({
      repo: 'owner/repo',
      token: 'tok',
      defaultLabels: [],
      titlePrefix: '[test]',
      dedupEnabled: true,
      dryRun: false,
    });
    const result = await creator.create({ title: 'Test', body: 'b', labels: [] });
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
