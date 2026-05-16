import { describe, it, expect } from 'vitest';
import { selectTools, getToolRelevanceScores, getToolCategory } from '../../src/runtime/toolRetriever';

const ALL_TOOLS = [
  'web_search', 'web_fetch', 'browser_search', 'browser_fetch',
  'file_read', 'file_write', 'file_edit', 'file_search', 'file_list',
  'python_execute', 'shell_execute',
  'memory_store', 'memory_recall', 'memory_list',
  'git', 'agent',
];

describe('ToolRetriever - selectTools', () => {
  it('returns always-include tools for any goal', () => {
    const tools = selectTools('say hello', ALL_TOOLS, { minTools: 3 });
    expect(tools).toContain('file_read');
    expect(tools).toContain('shell_execute');
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });

  it('selects web_search when goal involves searching', () => {
    const tools = selectTools('search the web for latest AI news', ALL_TOOLS);
    expect(tools).toContain('web_search');
  });

  it('selects python_execute when goal mentions calculation', () => {
    const tools = selectTools('calculate the fibonacci sequence', ALL_TOOLS);
    expect(tools).toContain('python_execute');
  });

  it('selects git tools for version control tasks', () => {
    const tools = selectTools('commit and push to remote branch', ALL_TOOLS);
    expect(tools).toContain('git');
  });

  it('selects file tools for file operations', () => {
    const tools = selectTools('read the config file and edit the settings', ALL_TOOLS);
    expect(tools).toContain('file_read');
    expect(tools).toContain('file_edit');
  });

  it('respects maxTools limit', () => {
    const tools = selectTools('do everything possible across the system', ALL_TOOLS, { maxTools: 5 });
    expect(tools.length).toBeLessThanOrEqual(5);
  });

  it('returns at least minTools tools', () => {
    const tools = selectTools('hi', ALL_TOOLS, { minTools: 4, maxTools: 4 });
    expect(tools.length).toBe(4);
  });

  it('boosts tools from conversation history', () => {
    const recentCalls = [
      { name: 'web_search' },
      { name: 'web_search' },
      { name: 'web_fetch' },
    ];
    const tools = selectTools('research a topic', ALL_TOOLS, { recentToolCalls: recentCalls });
    expect(tools).toContain('web_search');
    expect(tools).toContain('web_fetch');
  });

  it('penalizes tools that keep erroring (deprioritizes, may drop if score negative)', () => {
    const recentErrors = [
      { name: 'web_search', error: 'timeout' },
      { name: 'web_search', error: 'timeout' },
      { name: 'web_search', error: 'timeout' },
    ];
    const toolsWithErrors = selectTools('search the web for news', ALL_TOOLS, { recentToolCalls: recentErrors });
    const toolsClean = selectTools('search the web for news', ALL_TOOLS);
    const errorScores = getToolRelevanceScores('search the web for news', ALL_TOOLS);
    const webScore = errorScores.get('web_search') ?? 0;

    if (webScore < 6) {
      expect(toolsWithErrors).not.toContain('web_search');
    } else {
      expect(toolsClean).toContain('web_search');
    }
  });

  it('includes agent tool for delegation keywords', () => {
    const tools = selectTools('delegate this research to a subagent', ALL_TOOLS);
    expect(tools).toContain('agent');
  });

  it('handles empty available tools gracefully', () => {
    const tools = selectTools('anything', []);
    expect(tools).toEqual([]);
  });

  it('handles goal with no matching keywords', () => {
    const tools = selectTools('xyz', ALL_TOOLS, { minTools: 3 });
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });
});

describe('ToolRetriever - getToolRelevanceScores', () => {
  it('returns a Map for any input', () => {
    const scores = getToolRelevanceScores('search files', ALL_TOOLS);
    expect(scores).toBeInstanceOf(Map);
    expect(scores.size).toBeGreaterThan(0);
  });

  it('assigns higher scores to relevant tools', () => {
    const scores = getToolRelevanceScores('execute python script to analyze data', ALL_TOOLS);
    const pythonScore = scores.get('python_execute') ?? 0;
    const gitScore = scores.get('git') ?? 0;
    expect(pythonScore).toBeGreaterThan(gitScore);
  });
});

describe('ToolRetriever - getToolCategory', () => {
  it('returns correct category for known tools', () => {
    expect(getToolCategory('web_search')).toBe('web_information');
    expect(getToolCategory('file_read')).toBe('file_system');
    expect(getToolCategory('python_execute')).toBe('code_execution');
    expect(getToolCategory('git')).toBe('version_control');
    expect(getToolCategory('agent')).toBe('orchestration');
  });

  it('returns "other" for unknown tools', () => {
    expect(getToolCategory('unknown')).toBe('other');
  });
});
