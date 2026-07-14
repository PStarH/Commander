import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CostPredictor,
  type CostHistory,
  getCostPredictor,
} from '../../src/intelligence/costPredictor';
import * as tokenSentinel from '../../src/telos/tokenSentinel';
import * as fs from 'node:fs';
import * as modelRouter from '../../src/runtime/modelRouter';

vi.mock('../../src/telos/tokenSentinel', () => ({
  calculateCostBreakdown: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('costPredictor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(tokenSentinel.calculateCostBreakdown).mockReturnValue({
      totalUsd: 0.012,
      inputUsd: 0.007,
      outputUsd: 0.005,
      currency: 'USD',
    });
    vi.spyOn(modelRouter, 'getModelRouter').mockReturnValue({
      getModel: () => ({ id: 'gpt-4o' }),
      getCostModel: () => ({ input: 0.00001, output: 0.00003, currency: 'USD' }),
      getProvider: () => 'openai',
    } as unknown as ReturnType<typeof modelRouter.getModelRouter>);
  });

  describe('constructor and history loading', () => {
    it('starts empty when no history file exists', () => {
      const predictor = new CostPredictor('/tmp/test-empty');
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
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-load');
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

    it('handles corrupted history files gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not json');
      const predictor = new CostPredictor('/tmp/test-corrupt');
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
      const predictor = new CostPredictor('/tmp/test-predict');
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
        modelId: 'gpt-4o',
      });
      expect(result.estimatedTokens).toBe(1000);
      expect(result.estimatedCostUsd).toBe(0.012);
      expect(result.confidence).toBe(0.3);
      expect(tokenSentinel.calculateCostBreakdown).toHaveBeenCalledWith('gpt-4o', 700, 300);
    });

    it('falls back to the default model when modelId is omitted', () => {
      const predictor = new CostPredictor('/tmp/test-default');
      const result = predictor.predict({
        taskType: 'research',
        effortLevel: 'deep',
        topology: 'hierarchical',
        estimatedTokens: 2000,
        estimatedDurationMs: 5000,
        agentCount: 5,
      });
      expect(result.estimatedCostUsd).toBe(0.012);
      expect(tokenSentinel.calculateCostBreakdown).toHaveBeenCalledWith(
        'gpt-4o-mini',
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('uses similar-task averages when enough history exists', () => {
      const history: CostHistory[] = Array.from({ length: 5 }, () => ({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 2000,
        costUsd: 0.02,
        durationMs: 3000,
        timestamp: new Date().toISOString(),
        success: true,
        modelId: 'gpt-4o',
      }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-similar');
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      // 60% estimate + 40% average => 1000*0.6 + 2000*0.4 = 1400
      expect(result.estimatedTokens).toBe(1400);
      // 2000*0.6 + 3000*0.4 = 2400
      expect(result.estimatedDurationMs).toBe(2400);
      expect(result.confidence).toBe(0.9);
    });

    it('computes a 70/30 token split for cost breakdown', () => {
      const predictor = new CostPredictor('/tmp/test-split');
      predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
        modelId: 'gpt-4o',
      });
      expect(tokenSentinel.calculateCostBreakdown).toHaveBeenCalledWith('gpt-4o', 700, 300);
    });

    it('returns breakdown components summing to estimated tokens', () => {
      const predictor = new CostPredictor('/tmp/test-breakdown');
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
      const history: CostHistory[] = [
        {
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 1500,
          costUsd: 0.015,
          durationMs: 2500,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-similar-list');
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.similarTasks).toHaveLength(1);
      expect(result.similarTasks[0].task).toBe('coding');
    });

    it('boosts confidence when more similar tasks are available', () => {
      const history: CostHistory[] = Array.from({ length: 3 }, () => ({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 1000,
        costUsd: 0.01,
        durationMs: 1000,
        timestamp: new Date().toISOString(),
        success: true,
      }));
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-confidence');
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.confidence).toBe(0.7);
    });

    it('matches history by effort level and topology when task type differs', () => {
      const history: CostHistory[] = [
        {
          taskType: 'research',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 2500,
          costUsd: 0.025,
          durationMs: 3500,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-partial-match');
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

    it('matches history by topology only when other fields differ', () => {
      const history: CostHistory[] = [
        {
          taskType: 'research',
          effortLevel: 'deep',
          topology: 'parallel',
          tokens: 4000,
          costUsd: 0.04,
          durationMs: 5000,
          timestamp: new Date().toISOString(),
          success: false,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-topology-only');
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

    it('sorts similar tasks by relevance score', () => {
      const history: CostHistory[] = [
        {
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'hierarchical',
          tokens: 2000,
          costUsd: 0.02,
          durationMs: 2000,
          timestamp: new Date().toISOString(),
          success: true,
        },
        {
          taskType: 'research',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 3000,
          costUsd: 0.03,
          durationMs: 3000,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-sort');
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      // First entry matches taskType + effortLevel (score 5), second matches effortLevel + topology (score 3)
      expect(result.similarTasks[0].task).toBe('coding');
      expect(result.similarTasks[1].task).toBe('research');
    });
  });

  describe('record', () => {
    it('records a new entry and persists history', () => {
      const predictor = new CostPredictor('/tmp/test-record');
      predictor.record({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 1200,
        durationMs: 2200,
        success: true,
        modelId: 'gpt-4o',
      });
      const result = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 2000,
        agentCount: 2,
      });
      expect(result.similarTasks).toHaveLength(1);
      expect(result.similarTasks[0].tokens).toBe(1200);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('keeps only the most recent 1000 entries', () => {
      const predictor = new CostPredictor('/tmp/test-trim');
      for (let i = 0; i < 1002; i++) {
        predictor.record({
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: i,
          durationMs: 1000,
          success: true,
        });
      }
      // Verify by checking the written history is trimmed
      const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
      const saved = JSON.parse(written);
      expect(saved).toHaveLength(1000);
    });

    it('handles persistence errors silently', () => {
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('disk full');
      });
      const predictor = new CostPredictor('/tmp/test-error');
      expect(() =>
        predictor.record({
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 100,
          durationMs: 100,
          success: true,
        }),
      ).not.toThrow();
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

    it('computes cost when the model is known', () => {
      const predictor = new CostPredictor('/tmp/test-record-cost');
      predictor.record({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 1000,
        durationMs: 1000,
        success: true,
        modelId: 'gpt-4o',
      });
      expect(tokenSentinel.calculateCostBreakdown).toHaveBeenCalled();
    });

    it('records zero cost when the model is unknown', () => {
      const calculateCostBreakdown = vi.mocked(tokenSentinel.calculateCostBreakdown);
      vi.spyOn(modelRouter, 'getModelRouter').mockReturnValue({
        getModel: () => undefined,
        getCostModel: () => ({ input: 0.00001, output: 0.00003, currency: 'USD' }),
        getProvider: () => 'openai',
      } as unknown as ReturnType<typeof modelRouter.getModelRouter>);
      const predictor = new CostPredictor('/tmp/test-record-zero');
      predictor.record({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        tokens: 1000,
        durationMs: 1000,
        success: true,
        modelId: 'unknown',
      });
      expect(calculateCostBreakdown).not.toHaveBeenCalled();
    });
  });

  describe('getSummary', () => {
    it('formats the estimate as a human-readable string', () => {
      const predictor = new CostPredictor('/tmp/test-summary');
      const estimate = predictor.predict({
        taskType: 'coding',
        effortLevel: 'moderate',
        topology: 'parallel',
        estimatedTokens: 1000,
        estimatedDurationMs: 5000,
        agentCount: 2,
      });
      const summary = predictor.getSummary(estimate);
      expect(summary).toContain('预估 Token: 1,000');
      expect(summary).toContain('预估成本: $0.0120');
      expect(summary).toContain('预估时间: 5s');
      expect(summary).toContain('置信度: 30%');
    });

    it('includes similar task references when available', () => {
      const history: CostHistory[] = [
        {
          taskType: 'coding',
          effortLevel: 'moderate',
          topology: 'parallel',
          tokens: 1500,
          costUsd: 0.015,
          durationMs: 2500,
          timestamp: new Date().toISOString(),
          success: true,
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(history));
      const predictor = new CostPredictor('/tmp/test-summary-similar');
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
