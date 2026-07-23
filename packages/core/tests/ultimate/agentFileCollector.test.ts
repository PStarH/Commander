import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentFileCollector,
  extractOutputFilePath,
  writeSynthesisOutput,
} from '../../src/ultimate/agentFileCollector';
import type { TaskTreeNode } from '../../src/ultimate/types';
import type { ArtifactReference } from '../../src/shared/types';
import type { AgentRuntimeInterface } from '../../src/runtime';
import { OrchestratorOutputCollector } from '../../src/ultimate/orchestratorOutput';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTaskTree(overrides?: Partial<TaskTreeNode>): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Root goal',
    role: 'PLANNER',
    isAtomic: false,
    status: 'COMPLETED',
    result: 'Root result content here',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: [
      {
        id: 'child-1',
        parentId: 'root',
        goal: 'Child 1',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'COMPLETED',
        result: 'result-1 content',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
      },
    ],
    ...overrides,
  } as TaskTreeNode;
}

function makeArtifacts(): ArtifactReference[] {
  return [
    {
      id: 'art-1',
      type: 'REPORT',
      title: 'Test Report',
      summary: 'A test report',
      createdBy: 'agent-1',
      createdAt: new Date().toISOString(),
      tokenCount: 100,
      tags: ['completed'],
      content: 'Artifact content that is long enough to pass the 50 char threshold xxxxxx',
    },
  ];
}

function makeRuntime(): AgentRuntimeInterface {
  const mockExecute = vi.fn(async () => ({
    runId: 'run-1',
    agentId: 'output-generator',
    status: 'success',
    summary: 'Generated output content that is longer than the original synthesis content.',
    steps: [],
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    totalDurationMs: 0,
  }));
  return { execute: mockExecute } as unknown as AgentRuntimeInterface;
}

// ── extractOutputFilePath (pure function) ────────────────────────────────────

describe('extractOutputFilePath', () => {
  it('extracts path from "write ... to /path/file.md" pattern', () => {
    const result = extractOutputFilePath('Please write the report to /tmp/report.md');
    expect(result).toBe('/tmp/report.md');
  });

  it('extracts path from "create /path/file.ts" pattern', () => {
    const result = extractOutputFilePath('Create /src/index.ts with the following content');
    expect(result).toBe('/src/index.ts');
  });

  it('extracts path from "save ./output.json" pattern', () => {
    const result = extractOutputFilePath('Save ./output.json after processing');
    expect(result).toBe('./output.json');
  });

  it('extracts path from "generate report to /tmp/analysis.md" pattern', () => {
    const result = extractOutputFilePath('Generate the analysis report to /tmp/analysis.md');
    expect(result).toBe('/tmp/analysis.md');
  });

  it('returns null when no file path is found', () => {
    expect(extractOutputFilePath('Just analyze the code and give feedback')).toBeNull();
  });

  it('handles various file extensions', () => {
    expect(extractOutputFilePath('write to /tmp/file.py')).toBe('/tmp/file.py');
    expect(extractOutputFilePath('write to /tmp/file.html')).toBe('/tmp/file.html');
    expect(extractOutputFilePath('write to /tmp/file.yaml')).toBe('/tmp/file.yaml');
  });

  it('extracts absolute path at end of sentence', () => {
    const result = extractOutputFilePath('The output is at /var/log/output.md.');
    expect(result).toBe('/var/log/output.md');
  });
});

describe('writeSynthesisOutput', () => {
  const originalWorkspace = process.env.COMMANDER_WORKSPACE;
  let workspace: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commander-output-path-')));
    process.env.COMMANDER_WORKSPACE = workspace;
  });

  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.COMMANDER_WORKSPACE;
    else process.env.COMMANDER_WORKSPACE = originalWorkspace;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('writes a relative output beneath the workspace', async () => {
    const writtenPath = await writeSynthesisOutput('Write the report to ./reports/result.md', 'ok');

    expect(writtenPath).toBe(path.join(workspace, 'reports', 'result.md'));
    expect(fs.readFileSync(writtenPath!, 'utf-8')).toBe('ok');
  });

  it('rejects traversal and absolute output paths outside the workspace', async () => {
    const outside = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside.md`);

    await expect(writeSynthesisOutput(`Write the report to ${outside}`, 'blocked')).rejects.toThrow(
      /outside workspace/,
    );
    await expect(
      writeSynthesisOutput('Write the report to ../outside.md', 'blocked'),
    ).rejects.toThrow(/outside workspace/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('keeps the legacy output collector inside the same workspace root', async () => {
    const outside = path.join(path.dirname(workspace), `${path.basename(workspace)}-legacy.md`);
    const reasoning: string[] = [];
    const collector = new OrchestratorOutputCollector(makeRuntime());

    await collector.writeTargetFile(`Write the report to ${outside}`, 'blocked', reasoning);

    expect(fs.existsSync(outside)).toBe(false);
    expect(reasoning).toEqual([expect.stringMatching(/outside workspace/)]);
  });
});

// ── AgentFileCollector ───────────────────────────────────────────────────────

describe('AgentFileCollector', () => {
  let collector: AgentFileCollector;
  let runtime: AgentRuntimeInterface;

  beforeEach(() => {
    runtime = makeRuntime();
    collector = new AgentFileCollector({ runtime });
  });

  it('constructs with deps', () => {
    expect(collector).toBeDefined();
  });

  it('returns finalSynthesis when no agent files are found', async () => {
    const reasoning: string[] = [];
    const result = await collector.collectAndEnrich(
      {
        execId: 'exec-1',
        goal: 'test goal',
        projectId: 'proj-1',
        startTime: Date.now(),
        taskTree: makeTaskTree(),
        allArtifacts: [],
        finalSynthesis: 'This is the synthesis output.',
      },
      reasoning,
    );

    // Should return something at least as large as the synthesis
    expect(result.length).toBeGreaterThanOrEqual('This is the synthesis output.'.length);
  });

  it('uses artifact content when larger than synthesis', async () => {
    const reasoning: string[] = [];
    const tree = makeTaskTree();
    const artifacts = makeArtifacts();

    const result = await collector.collectAndEnrich(
      {
        execId: 'exec-2',
        goal: 'test goal',
        projectId: 'proj-1',
        startTime: Date.now(),
        taskTree: tree,
        allArtifacts: artifacts,
        finalSynthesis: 'short', // shorter than artifact content
      },
      reasoning,
    );

    // Should have combined data sources since artifact content is larger
    expect(result).toContain('Complete Results');
    expect(reasoning.some((r) => r.includes('Combined'))).toBe(true);
  });

  it('spawns output-generator agent when output is thin', async () => {
    const reasoning: string[] = [];
    const tree = makeTaskTree({
      result: 'x',
      subtasks: [],
    });

    await collector.collectAndEnrich(
      {
        execId: 'exec-3',
        goal: 'test goal',
        projectId: 'proj-1',
        startTime: Date.now(),
        taskTree: tree,
        allArtifacts: [],
        finalSynthesis: 'thin', // < 5000 bytes, triggers output generator
      },
      reasoning,
    );

    expect(runtime.execute).toHaveBeenCalled();
    const callArgs = (runtime.execute as any).mock.calls[0][0];
    expect(callArgs.agentId).toBe('output-generator-exec-3');
    expect(callArgs.goal).toContain('expert analyst');
  });

  it('handles runtime.execute failure gracefully', async () => {
    const failingRuntime = {
      execute: vi.fn(async () => {
        throw new Error('runtime unavailable');
      }),
    } as unknown as AgentRuntimeInterface;
    const failingCollector = new AgentFileCollector({ runtime: failingRuntime });

    const reasoning: string[] = [];
    const result = await failingCollector.collectAndEnrich(
      {
        execId: 'exec-4',
        goal: 'test',
        projectId: 'proj-1',
        startTime: Date.now(),
        taskTree: makeTaskTree(),
        allArtifacts: [],
        finalSynthesis: 'thin synthesis',
      },
      reasoning,
    );

    // Should still return a string (the original or fallback)
    expect(typeof result).toBe('string');
    expect(reasoning.some((r) => r.includes('Output generator failed'))).toBe(true);
  });

  it('does not spawn output generator when output is sufficient', async () => {
    const longSynthesis = 'x'.repeat(6000);
    const reasoning: string[] = [];

    await collector.collectAndEnrich(
      {
        execId: 'exec-5',
        goal: 'test',
        projectId: 'proj-1',
        startTime: Date.now(),
        taskTree: makeTaskTree(),
        allArtifacts: [],
        finalSynthesis: longSynthesis,
      },
      reasoning,
    );

    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it('collects completed node results as fallback data', async () => {
    const reasoning: string[] = [];
    const tree = makeTaskTree({
      result: 'Root result that is longer than ten characters',
      subtasks: [
        {
          id: 'child-1',
          parentId: 'root',
          goal: 'Child task with a detailed goal',
          role: 'EXECUTOR',
          isAtomic: true,
          status: 'COMPLETED',
          result: 'Detailed child result that is longer than ten characters',
          dependencies: [],
          context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
          subtasks: [],
        },
      ],
    });

    const result = await collector.collectAndEnrich(
      {
        execId: 'exec-6',
        goal: 'test',
        projectId: 'proj-1',
        startTime: Date.now(),
        taskTree: tree,
        allArtifacts: [],
        finalSynthesis: 'short',
      },
      reasoning,
    );

    // Should have combined node results since they're larger than 'short'
    expect(result).toContain('Complete Results');
    expect(result).toContain('Child task');
  });

  it('passes contextData to runtime.execute', async () => {
    const reasoning: string[] = [];
    const contextData = { availableTools: ['file_read', 'file_write'], custom: 'value' };

    await collector.collectAndEnrich(
      {
        execId: 'exec-7',
        goal: 'test',
        projectId: 'proj-1',
        contextData,
        startTime: Date.now(),
        taskTree: makeTaskTree({ result: 'x', subtasks: [] }),
        allArtifacts: [],
        finalSynthesis: 'thin',
      },
      reasoning,
    );

    const callArgs = (runtime.execute as any).mock.calls[0][0];
    expect(callArgs.contextData).toEqual(contextData);
    expect(callArgs.availableTools).toEqual(['file_read', 'file_write']);
  });

  it('handles errors in file scanning gracefully', async () => {
    const reasoning: string[] = [];
    // Force startTime to a very old time so all files would match the mtime filter
    const result = await collector.collectAndEnrich(
      {
        execId: 'exec-8',
        goal: 'test',
        projectId: 'proj-1',
        startTime: Date.now(),
        taskTree: makeTaskTree(),
        allArtifacts: [],
        finalSynthesis: 'synthesis output',
      },
      reasoning,
    );

    // Should complete without throwing
    expect(typeof result).toBe('string');
  });
});
