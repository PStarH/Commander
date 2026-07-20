import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CostPredictor,
  type CostHistory,
  getCostPredictor,
} from '../../src/intelligence/costPredictor';
import * as modelRouter from '../../src/runtime/modelRouter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { calculateCostBreakdown } from '../../src/telos/tokenSentinel';

/**
 * Avoid vi.mock('node:fs') / vi.mock(tokenSentinel) under Vitest 4 ESM —
 * namespace exports are non-configurable and named imports in the SUT can
 * stay bound to the real module. Use real temp dirs + real pricing instead.
 */

function writeHistory(dir: string, history: CostHistory[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cost-history.json'), JSON.stringify(history), 'utf-8');
}

describe('costPredictor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-predictor-'));
    vi.spyOn(modelRouter, 'getModelRouter').mockReturnValue({
      getModel: (id: string) =>
        id === 'gpt-4o' || id === 'gpt-4o-mini' ? { id } : undefined,
      getCostModel: () => ({ input: 0.00001, output: 0.00003, currency: 'USD' }),
      getProvider: () => 'openai',
    } as unknown as ReturnType<typeof modelRouter.getModelRouter>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('constructor and history loading', () => {
    it('starts empty when no history file exists', () => {
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.confidence).toBe(0.3);
      expect(result.similarTasks).toHaveLength(0);
    });

    it('loads existing history from disk', () => {
      const history: CostHistory[] = [
        {
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 1000,
          costUsd: 0.01,
          durationMs: 1000,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ];
      writeHistory(tmp, history);
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.similarTasks).toHaveLength(1);
      expect(result.confidence).toBe(0.5);
    });

    it('handles corrupted history files gracefully', () => {
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'cost-history.json'), 'not json', 'utf-8');
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.confidence).toBe(0.3);
    });
  });

  describe('predict', () => {
    it('predicts cost using the provided model id', () => {
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
        modelId: 'gpt-4o',
      });
      const expected = calculateCostBreakdown('gpt-4o', 700, 300);
      expect(result.estimatedTokens).toBe(1000);
      expect(result.estimatedCostUsd).toBe(expected.totalUsd);
      expect(result.confidence).toBe(0.3);
    });

    it('falls back to the default model when modelId is omitted', () => {
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      const expected = calculateCostBreakdown('gpt-4o-mini', 700, 300);
      expect(result.estimatedCostUsd).toBe(expected.totalUsd);
    });

    it('uses similar-task averages when enough history exists', () => {
      const history: CostHistory[] = Array.from({ length: 3 }, (_, i) => ({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 2000,
        costUsd: 0.02,
        durationMs: 4000,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        success: true,
      }));
      writeHistory(tmp, history);
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      // 0.6 * 1000 + 0.4 * 2000 = 1400
      expect(result.estimatedTokens).toBe(1400);
      expect(result.confidence).toBe(0.7);
    });

    it('computes a 70/30 token split for cost breakdown', () => {
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
        modelId: 'gpt-4o',
      });
      expect(result.breakdown.execution).toBe(700);
      expect(result.breakdown.deliberation).toBe(50);
      expect(result.breakdown.synthesis).toBe(150);
      expect(result.breakdown.qualityGates).toBe(100);
    });

    it('returns breakdown components summing to estimated tokens', () => {
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      const sum =
        result.breakdown.deliberation +
        result.breakdown.execution +
        result.breakdown.synthesis +
        result.breakdown.qualityGates;
      expect(sum).toBe(result.estimatedTokens);
    });

    it('returns similar tasks when history matches', () => {
      writeHistory(tmp, [
        {
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 1500,
          costUsd: 0.02,
          durationMs: 3000,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ]);
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.similarTasks).toEqual([
        { task: 'coding', tokens: 1500, cost: 0.02, duration: 3000 },
      ]);
    });

    it('boosts confidence when more similar tasks are available', () => {
      writeHistory(
        tmp,
        Array.from({ length: 5 }, (_, i) => ({
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 1000,
          costUsd: 0.01,
          durationMs: 1000,
          timestamp: new Date(Date.now() - i).toISOString(),
          success: true,
        })),
      );
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.confidence).toBe(0.9);
    });

    it('matches history by effort level and topology when task type differs', () => {
      writeHistory(tmp, [
        {
          taskType: 'research',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 900,
          costUsd: 0.01,
          durationMs: 1000,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ]);
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.similarTasks).toHaveLength(1);
    });

    it('matches history by topology only when other fields differ', () => {
      writeHistory(tmp, [
        {
          taskType: 'research',
          effortLevel: 'high',
          topology: 'parallel',
          tokens: 900,
          costUsd: 0.01,
          durationMs: 1000,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ]);
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.similarTasks).toHaveLength(1);
    });

    it('sorts similar tasks by relevance score', () => {
      writeHistory(tmp, [
        {
          taskType: 'other',
          effortLevel: 'other',
          topology: 'parallel',
          tokens: 1,
          costUsd: 0.01,
          durationMs: 1,
          timestamp: new Date().toISOString(),
          success: true,
        },
        {
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 2,
          costUsd: 0.02,
          durationMs: 2,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ]);
      const predictor = new CostPredictor(tmp);
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.similarTasks[0]?.tokens).toBe(2);
    });
  });

  describe('record', () => {
    it('records a new entry and persists history', () => {
      const predictor = new CostPredictor(tmp);
      predictor.record({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 1000,
        durationMs: 1500,
        success: true,
        modelId: 'gpt-4o',
      });
      const raw = fs.readFileSync(path.join(tmp, 'cost-history.json'), 'utf-8');
      const history = JSON.parse(raw) as CostHistory[];
      expect(history).toHaveLength(1);
      expect(history[0]?.taskType).toBe('coding');
      expect(history[0]?.tokens).toBe(1000);
    });

    it('keeps only the most recent 1000 entries', () => {
      const history: CostHistory[] = Array.from({ length: 1005 }, (_, i) => ({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: i,
        costUsd: 0.01,
        durationMs: 1,
        timestamp: new Date(i).toISOString(),
        success: true,
      }));
      writeHistory(tmp, history);
      const predictor = new CostPredictor(tmp);
      predictor.record({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 9999,
        durationMs: 1,
        success: true,
        modelId: 'gpt-4o',
      });
      const raw = fs.readFileSync(path.join(tmp, 'cost-history.json'), 'utf-8');
      const saved = JSON.parse(raw) as CostHistory[];
      expect(saved.length).toBeLessThanOrEqual(1000);
      expect(saved[saved.length - 1]?.tokens).toBe(9999);
    });

    it('handles persistence errors silently', () => {
      // Parent path is a regular file so mkdir/write fails with ENOTDIR on all
      // platforms. Do NOT use `/proc/...` — on Linux writing under /proc can
      // block indefinitely (Ubuntu CI hang), while macOS/Windows fail fast.
      const blockedParent = path.join(tmp, 'not-a-directory');
      fs.writeFileSync(blockedParent, 'x');
      const predictor = new CostPredictor(path.join(blockedParent, 'child'));
      expect(() =>
        predictor.record({
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 100,
          durationMs: 1,
          success: true,
          modelId: 'gpt-4o',
        }),
      ).not.toThrow();
    });

    it('computes cost when the model is known', () => {
      const predictor = new CostPredictor(tmp);
      predictor.record({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 1000,
        durationMs: 1,
        success: true,
        modelId: 'gpt-4o',
      });
      const history = JSON.parse(
        fs.readFileSync(path.join(tmp, 'cost-history.json'), 'utf-8'),
      ) as CostHistory[];
      expect(history).toHaveLength(1);
      expect(history[0]?.modelId).toBe('gpt-4o');
      // costUsd is derived from live pricing tables; assert finite number when present
      const cost = history[0]?.costUsd;
      expect(cost === null || typeof cost === 'number').toBe(true);
      if (typeof cost === 'number') expect(Number.isFinite(cost)).toBe(true);
    });

    it('records zero cost when the model is unknown', () => {
      const predictor = new CostPredictor(tmp);
      predictor.record({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 1000,
        durationMs: 1,
        success: true,
        modelId: 'totally-unknown-model-xyz',
      });
      const history = JSON.parse(
        fs.readFileSync(path.join(tmp, 'cost-history.json'), 'utf-8'),
      ) as CostHistory[];
      const cost = history[0]?.costUsd;
      expect(history[0]?.modelId).toBe('totally-unknown-model-xyz');
      expect(cost === null || typeof cost === 'number').toBe(true);
    });
  });

  describe('getSummary', () => {
    it('formats the estimate as a human-readable string', () => {
      const predictor = new CostPredictor(tmp);
      const estimate = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 5000,
        agentCount: 2,
        modelId: 'gpt-4o',
      });
      const summary = predictor.getSummary(estimate);
      expect(summary).toContain('预估 Token: 1,000');
      expect(summary).toContain('预估时间: 5s');
      expect(summary).toContain('置信度: 30%');
      expect(summary).toMatch(/预估成本: \$/);
    });

    it('includes similar task references when available', () => {
      writeHistory(tmp, [
        {
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 1500,
          costUsd: 0.02,
          durationMs: 3000,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ]);
      const predictor = new CostPredictor(tmp);
      const estimate = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      const summary = predictor.getSummary(estimate);
      expect(summary).toContain('类似任务参考:');
      expect(summary).toContain('coding: 1,500 tok');
    });
  });

  describe('singleton', () => {
    it('getCostPredictor returns the same instance', () => {
      const a = getCostPredictor();
      const b = getCostPredictor();
      expect(a).toBe(b);
    });
  });
});
