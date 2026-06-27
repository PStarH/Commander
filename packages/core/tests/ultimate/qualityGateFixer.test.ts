import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QualityGateFixer } from '../../src/ultimate/qualityGateFixer';
import type { TaskTreeNode, QualityGateConfig } from '../../src/ultimate/types';
import type { AgentRuntimeInterface } from '../../src/runtime';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTaskTree(): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Root goal',
    role: 'PLANNER',
    isAtomic: false,
    status: 'COMPLETED',
    result: 'Root result',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: [],
  } as TaskTreeNode;
}

function makeGates(overrides?: Partial<QualityGateConfig>[]): QualityGateConfig[] {
  const base: QualityGateConfig[] = [
    { name: 'hallucination', type: 'HALLUCINATION_CHECK', enabled: true, threshold: 0.8, autoFix: true },
    { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: true },
    { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
  ];
  if (overrides) {
    return [...base, ...(overrides as QualityGateConfig[])];
  }
  return base;
}

function makeRuntime(
  fixResultOverrides?: Partial<{ status: string; summary: string }>,
): AgentRuntimeInterface {
  const mockExecute = vi.fn(async () => ({
    runId: 'run-fix',
    agentId: 'quality-fixer',
    status: fixResultOverrides?.status ?? 'success',
    summary:
      fixResultOverrides?.summary ??
      'This is a fixed synthesis that is longer than fifty characters to pass the minimum length check.',
    steps: [],
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    totalDurationMs: 0,
  }));
  return { execute: mockExecute } as unknown as AgentRuntimeInterface;
}

function makeSynthesizer(gateResults: Array<{ gate: string; passed: boolean; score: number }>) {
  return {
    runQualityGatesStrict: vi.fn(async () => gateResults),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('QualityGateFixer', () => {
  let taskTree: TaskTreeNode;

  beforeEach(() => {
    taskTree = makeTaskTree();
  });

  it('constructs with deps', () => {
    const fixer = new QualityGateFixer({
      runtime: makeRuntime(),
      synthesizer: makeSynthesizer([]),
      qualityGates: makeGates(),
    });
    expect(fixer).toBeDefined();
  });

  it('skips fix loop when all gates pass', async () => {
    const runtime = makeRuntime();
    const synthesizer = makeSynthesizer([]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    const result = await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Original synthesis',
        initialQualityScore: 0.95,
        initialGateResults: [
          { gate: 'hallucination', passed: true, score: 0.9 },
          { gate: 'consistency', passed: true, score: 0.85 },
        ],
      },
      reasoning,
    );

    expect(runtime.execute).not.toHaveBeenCalled();
    expect(result.finalSynthesis).toBe('Original synthesis');
    expect(result.finalQualityScore).toBe(0.95);
  });

  it('skips fix loop when no failed gate has autoFix enabled', async () => {
    const runtime = makeRuntime();
    const synthesizer = makeSynthesizer([
      { gate: 'completeness', passed: false, score: 0.3 },
    ]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    const result = await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Original',
        initialQualityScore: 0.4,
        initialGateResults: [{ gate: 'completeness', passed: false, score: 0.3 }],
      },
      reasoning,
    );

    // completeness gate has autoFix: false, so no fix attempts
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(result.finalSynthesis).toBe('Original');
  });

  it('runs fix agent and re-checks gates on hallucination failure', async () => {
    const runtime = makeRuntime();
    // First check: hallucination fails. After fix: all pass.
    const synthesizer = makeSynthesizer([
      { gate: 'hallucination', passed: true, score: 0.9 },
      { gate: 'consistency', passed: true, score: 0.8 },
    ]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    const result = await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Original synthesis with hallucinated content',
        initialQualityScore: 0.3,
        initialGateResults: [{ gate: 'hallucination', passed: false, score: 0.3 }],
      },
      reasoning,
    );

    expect(runtime.execute).toHaveBeenCalledTimes(1);
    const callArgs = (runtime.execute as any).mock.calls[0][0];
    expect(callArgs.agentId).toBe('quality-fixer');
    expect(callArgs.goal).toContain('Remove unverified claims');
    expect(result.finalSynthesis).toContain('fixed synthesis');
    expect(reasoning.some((r) => r.includes('auto-fix attempt 1'))).toBe(true);
  });

  it('stops early when fix produces identical output', async () => {
    const identicalSynth = 'Original synthesis that is long enough to pass the minimum length check.';
    const runtime = makeRuntime({ summary: identicalSynth });
    const synthesizer = makeSynthesizer([
      { gate: 'hallucination', passed: false, score: 0.3 },
    ]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    const result = await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: identicalSynth,
        initialQualityScore: 0.3,
        initialGateResults: [{ gate: 'hallucination', passed: false, score: 0.3 }],
      },
      reasoning,
    );

    // Fix produced identical output, so it should not be accepted
    expect(result.finalSynthesis).toBe(identicalSynth);
    expect(reasoning.some((r) => r.includes('identical output'))).toBe(true);
  });

  it('stops early when fix does not improve score', async () => {
    let callCount = 0;
    const runtime = {
      execute: vi.fn(async () => {
        callCount++;
        return {
          runId: 'run-fix',
          agentId: 'quality-fixer',
          status: 'success',
          summary: `Fixed attempt ${callCount} with sufficient length content here.`,
          steps: [],
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: 0,
        };
      }),
    } as unknown as AgentRuntimeInterface;

    // After fix: score stays the same (0.3 → 0.3)
    const synthesizer = makeSynthesizer([
      { gate: 'hallucination', passed: false, score: 0.3 },
    ]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Original synthesis content here',
        initialQualityScore: 0.3,
        initialGateResults: [{ gate: 'hallucination', passed: false, score: 0.3 }],
      },
      reasoning,
    );

    // Should only run 1 fix attempt (score didn't improve → early exit)
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(reasoning.some((r) => r.includes('no score improvement'))).toBe(true);
  });

  it('handles runtime.execute failure gracefully', async () => {
    const runtime = {
      execute: vi.fn(async () => {
        throw new Error('runtime unavailable');
      }),
    } as unknown as AgentRuntimeInterface;
    const synthesizer = makeSynthesizer([]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    const result = await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Original',
        initialQualityScore: 0.3,
        initialGateResults: [{ gate: 'hallucination', passed: false, score: 0.3 }],
      },
      reasoning,
    );

    expect(result.finalSynthesis).toBe('Original');
    expect(reasoning.some((r) => r.includes('failed: runtime unavailable'))).toBe(true);
  });

  it('builds consistency-specific fix instructions', async () => {
    const runtime = makeRuntime();
    const synthesizer = makeSynthesizer([
      { gate: 'consistency', passed: true, score: 0.9 },
    ]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Original with contradictions',
        initialQualityScore: 0.4,
        initialGateResults: [{ gate: 'consistency', passed: false, score: 0.4 }],
      },
      reasoning,
    );

    const goal = (runtime.execute as any).mock.calls[0][0].goal;
    expect(goal).toContain('internally consistent');
  });

  it('builds completeness-specific fix instructions', async () => {
    const gates = makeGates([
      { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: true } as any,
    ]);
    // Override the default completeness gate to have autoFix: true
    const allGates = gates.map((g) =>
      g.name === 'completeness' ? { ...g, autoFix: true } : g,
    );
    const runtime = makeRuntime();
    const synthesizer = makeSynthesizer([
      { gate: 'completeness', passed: true, score: 0.8 },
    ]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: allGates,
    });

    const reasoning: string[] = [];
    await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Incomplete synthesis',
        initialQualityScore: 0.4,
        initialGateResults: [{ gate: 'completeness', passed: false, score: 0.4 }],
      },
      reasoning,
    );

    const goal = (runtime.execute as any).mock.calls[0][0].goal;
    expect(goal).toContain('all key aspects');
  });

  it('includes reflexion context on second attempt', async () => {
    let callCount = 0;
    const runtime = {
      execute: vi.fn(async () => {
        callCount++;
        return {
          status: 'success',
          summary: `Fixed attempt ${callCount} with different content that is long enough to pass.`,
          steps: [],
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: 0,
        };
      }),
    } as unknown as AgentRuntimeInterface;

    // Two gates: hallucination (autoFix) and consistency (autoFix).
    // Initial: both fail → score = 0
    // After first fix: consistency passes (0.8), hallucination still fails → score = 0.4 > 0 → continue
    // After second fix: both pass → score high
    let recheckCount = 0;
    const synthesizer = {
      runQualityGatesStrict: vi.fn(async () => {
        recheckCount++;
        if (recheckCount === 1) {
          return [
            { gate: 'hallucination', passed: false, score: 0.5 },
            { gate: 'consistency', passed: true, score: 0.8 },
          ];
        }
        return [
          { gate: 'hallucination', passed: true, score: 0.9 },
          { gate: 'consistency', passed: true, score: 0.85 },
        ];
      }),
    } as any;

    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });

    const reasoning: string[] = [];
    await fixer.runAutoFixLoop(
      {
        projectId: 'proj-1',
        taskTree,
        initialSynthesis: 'Original synthesis content here',
        initialQualityScore: 0,
        initialGateResults: [
          { gate: 'hallucination', passed: false, score: 0.3 },
          { gate: 'consistency', passed: false, score: 0.3 },
        ],
      },
      reasoning,
    );

    // Should have run 2 fix attempts
    expect(runtime.execute).toHaveBeenCalledTimes(2);
    // Second call should include reflexion context
    const secondGoal = (runtime.execute as any).mock.calls[1][0].goal;
    expect(secondGoal).toContain('Previous fix attempt');
    expect(secondGoal).toContain('Do NOT repeat');
  });

  it('passes contextData and projectId to runtime.execute', async () => {
    const runtime = makeRuntime();
    const synthesizer = makeSynthesizer([
      { gate: 'hallucination', passed: true, score: 0.9 },
    ]);
    const fixer = new QualityGateFixer({
      runtime,
      synthesizer,
      qualityGates: makeGates(),
    });
    const contextData = { files: ['a.ts'], custom: 'value' };

    const reasoning: string[] = [];
    await fixer.runAutoFixLoop(
      {
        projectId: 'proj-42',
        contextData,
        taskTree,
        initialSynthesis: 'Original',
        initialQualityScore: 0.3,
        initialGateResults: [{ gate: 'hallucination', passed: false, score: 0.3 }],
      },
      reasoning,
    );

    const callArgs = (runtime.execute as any).mock.calls[0][0];
    expect(callArgs.projectId).toBe('proj-42');
    expect(callArgs.contextData).toEqual(contextData);
  });
});
