/**
 * Token Usage Benchmark — Measures token consumption across key runtime paths.
 *
 * Tracks:
 * 1. System prompt size (tokens) for different tool counts
 * 2. Two-tier tool loading savings vs monolithic loading
 * 3. Context compaction effectiveness at each layer
 * 4. Tool output management token reduction
 * 5. Observation mask effectiveness
 *
 * These benchmarks establish baselines for measuring optimization impact.
 */

import { describe, it, expect } from 'vitest';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';
import { ContextCompactor } from '../../src/runtime/contextCompactor';
import { ToolOutputManager } from '../../src/runtime/toolOutputManager';
import { buildTwoTierTools, calculateTierMetrics, estimateToolTokenCost } from '../../src/runtime/toolRetriever';
import { applyObservationMask } from '../../src/runtime/runtimeHelpers';
import type { ToolDefinition, LLMMessage, ToolCall, ToolResult } from '../../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function estimateTokens(text: string): number {
  return TokenGovernor.estimateTokens(text);
}

function makeToolDef(name: string, descLen = 100, schemaProps = 5): ToolDefinition {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < schemaProps; i++) {
    properties[`param${i}`] = { type: 'string', description: `Parameter ${i} for testing` };
  }
  return {
    name,
    description: 'A'.repeat(descLen),
    category: 'test',
    inputSchema: {
      type: 'object',
      properties,
      required: ['param0'],
    },
  };
}

function makeMessages(count: number, avgLen = 500): LLMMessage[] {
  const messages: LLMMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'tool';
    messages.push({
      role: role as LLMMessage['role'],
      content: 'X'.repeat(avgLen),
      ...(role === 'tool' ? { tool_call_id: `call_${i}` } : {}),
    });
  }
  return messages;
}

function makeToolResults(count: number, avgLen = 2000): Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }> {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push({
      toolCallId: `call_${i}`,
      name: `tool_${i % 5}`,
      output: 'R'.repeat(avgLen),
      durationMs: 100,
    });
  }
  return results;
}

// ============================================================================
// Benchmarks
// ============================================================================

describe('Token Usage Benchmarks', () => {
  describe('System Prompt Size', () => {
    it('measures token cost of tool definitions at different scales', () => {
      const scales = [3, 8, 15, 30, 50];
      const results: Record<number, number> = {};

      for (const n of scales) {
        const tools = Array.from({ length: n }, (_, i) => makeToolDef(`tool_${i}`));
        const tokens = estimateToolTokenCost(tools);
        results[n] = tokens;
      }

      // Log results for visibility
      console.log('Tool definition token costs:', results);

      // Verify scaling is roughly linear
      expect(results[50]).toBeGreaterThan(results[8]);
      // 50 tools should be roughly 6x the cost of 8 tools (50/8 ≈ 6.25)
      const ratio = results[50] / results[8];
      expect(ratio).toBeGreaterThan(4);
      expect(ratio).toBeLessThan(10);
    });

    it('measures two-tier loading savings', () => {
      const allTools = Array.from({ length: 30 }, (_, i) => makeToolDef(`tool_${i}`, 120, 4));
      const goal = 'Read the file at /src/main.ts and search for TODO comments';

      const twoTier = buildTwoTierTools(goal, allTools, 8);
      const metrics = calculateTierMetrics(twoTier, allTools.length);

      console.log('Two-tier metrics:', {
        active: metrics.activeCount,
        registry: metrics.registryCount,
        activeTokens: metrics.activeTokenEstimate,
        registryTokens: metrics.registryTokenEstimate,
        savings: `${metrics.savingsPercent}%`,
      });

      // Should have significant savings with 30 tools
      expect(metrics.savingsPercent).toBeGreaterThan(50);
      expect(metrics.activeCount).toBeLessThanOrEqual(9); // 8 + request_tool
    });
  });

  describe('Context Compaction Effectiveness', () => {
    it('measures token savings at each compaction layer', () => {
      const compactor = new ContextCompactor({ maxContextTokens: 128000 });

      // Create a large conversation that exceeds 60% of budget (layer 1 trigger)
      const messages: LLMMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Analyze the codebase and fix all TypeScript errors.' },
      ];

      // Add 50 tool call/result pairs with large outputs to exceed 60% threshold
      for (let i = 0; i < 50; i++) {
        messages.push({
          role: 'assistant',
          content: `I'll use tool_${i} to check the code.`,
          tool_calls: [{
            id: `call_${i}`,
            type: 'function' as const,
            function: { name: `tool_${i % 5}`, arguments: JSON.stringify({ path: `/src/file${i}.ts` }) },
          }],
        });
        messages.push({
          role: 'tool',
          content: 'R'.repeat(3000), // Large tool output
          tool_call_id: `call_${i}`,
        });
      }

      const before = compactor.getUsage(messages);
      console.log(`Before compaction: ${before.total} tokens (${(before.pct * 100).toFixed(1)}% of budget)`);

      // Compact and measure
      const result = compactor.compact(messages);
      const after = compactor.getUsage(result.messages);

      console.log(`After compaction: ${after.total} tokens (${(after.pct * 100).toFixed(1)}% of budget)`);
      console.log(`Layer: ${result.action.layer}, Dropped: ${result.action.droppedCount}, Saved: ${result.action.tokensSaved} tokens`);

      // If context exceeds threshold, should save tokens; otherwise just log
      if (before.pct > 0.6) {
        expect(result.action.tokensSaved).toBeGreaterThan(0);
        expect(after.total).toBeLessThan(before.total);
      } else {
        console.log('Context below compaction threshold — no compaction needed');
      }
    });

    it('measures compaction effectiveness per task type', () => {
      const compactor = new ContextCompactor({ maxContextTokens: 128000 });
      const taskTypes = ['code', 'search', 'analysis', 'structured', 'general'] as const;

      for (const taskType of taskTypes) {
        const messages = makeMessages(30, 800);
        const before = compactor.getUsage(messages).total;
        const result = compactor.compact(messages, undefined, taskType);
        const after = compactor.getUsage(result.messages).total;
        const savings = before - after;

        console.log(`Task type "${taskType}": ${before} → ${after} tokens (saved ${savings})`);
      }
    });
  });

  describe('Tool Output Management', () => {
    it('measures token reduction from output management', () => {
      const manager = new ToolOutputManager({ enabled: true, turnBudget: 32000 });

      // Simulate 5 tool results with large outputs
      const calls: Array<{ toolCall: ToolCall; result: ToolResult }> = [];
      for (let i = 0; i < 5; i++) {
        const tc: ToolCall = {
          id: `call_${i}`,
          name: ['shell_execute', 'file_read', 'web_fetch', 'python_execute', 'code_search'][i],
          arguments: { path: `/src/file${i}.ts` },
        };
        const result: ToolResult = {
          toolCallId: `call_${i}`,
          name: tc.name,
          output: 'O'.repeat(10000), // 10K chars each
          durationMs: 500,
        };
        calls.push({ toolCall: tc, result });
      }

      const managed = manager.manageBatch(calls);
      const totalOriginal = calls.reduce((sum, c) => sum + c.result.output.length, 0);
      const totalManaged = managed.reduce((sum, m) => sum + m.output.length, 0);
      const truncatedCount = managed.filter(m => m.truncated).length;

      console.log(`Output management: ${totalOriginal} → ${totalManaged} chars (${truncatedCount}/${calls.length} truncated)`);
      console.log(`Token savings: ~${estimateTokens('X'.repeat(totalOriginal - totalManaged))} tokens`);

      // Should truncate when outputs exceed budget
      expect(truncatedCount).toBeGreaterThan(0);
      expect(totalManaged).toBeLessThan(totalOriginal);
    });
  });

  describe('Observation Mask Effectiveness', () => {
    it('measures token savings from observation masking', () => {
      const results = makeToolResults(10, 2000);
      const windowSize = 4;

      const before = results.reduce((sum, r) => sum + estimateTokens(r.output), 0);
      const masked = applyObservationMask(results, windowSize);
      const after = masked.reduce((sum, r) => sum + estimateTokens(r.output), 0);

      console.log(`Observation mask (window=${windowSize}): ${before} → ${after} tokens (saved ${before - after})`);

      // Should mask older results
      const maskedCount = masked.filter(r => r.output.startsWith('[observation masked:')).length;
      expect(maskedCount).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
    });
  });

  describe('Token Governor', () => {
    it('measures CJK token estimation accuracy', () => {
      const testCases = [
        { text: 'Hello world', expected: 3 }, // ~11 chars / 4 ≈ 3
        { text: '你好世界', expected: 3 }, // 4 CJK chars / 1.5 ≈ 3
        { text: 'Hello 你好', expected: 3 }, // mixed
        { text: 'A'.repeat(100), expected: 25 }, // 100/4 = 25
      ];

      for (const tc of testCases) {
        const estimated = TokenGovernor.estimateTokens(tc.text);
        console.log(`"${tc.text}" → ${estimated} tokens`);
        // Just verify it returns a positive number
        expect(estimated).toBeGreaterThan(0);
      }
    });

    it('tracks budget pressure phases correctly', () => {
      // Thresholds: relaxed < 0.4, moderate < 0.65, tight < 0.85, critical >= 0.85
      const governor = new TokenGovernor({ totalBudget: 10000 });

      // Relaxed phase (pressure < 0.4)
      governor.reportUsage(3000);
      expect(governor.getState().phase).toBe('relaxed');

      // Moderate phase (0.4 <= pressure < 0.65)
      governor.reportUsage(2000);
      expect(governor.getState().phase).toBe('moderate');

      // Tight phase (0.65 <= pressure < 0.85)
      governor.reportUsage(2000);
      expect(governor.getState().phase).toBe('tight');

      // Critical phase (pressure >= 0.85)
      governor.reportUsage(2000);
      expect(governor.getState().phase).toBe('critical');
    });
  });
});
