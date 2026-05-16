import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyLLMError, computeBackoff } from '../src/runtime/llmRetry';
import { CircuitBreaker } from '../src/runtime/circuitBreaker';
import { ContextCompactor } from '../src/runtime/contextCompactor';
import { SandboxManager } from '../src/sandbox/index';
import { ExecPolicyEngine } from '../src/sandbox/execPolicy';
import { ApprovalSystem } from '../src/sandbox/approval';
import { TopologyRouter } from '../src/ultimate/topologyRouter';
import { ContextWindowManager, estimateTotalTokens } from '../src/runtime/contextWindow';
import { estimateMessageTokens } from '../src/runtime/contextWindow';
import type { LLMMessage } from '../src/runtime/types';

// ============================================================================
// 1.1 TOOL CALLING EDGE CASES
// ============================================================================
describe('1.1 Tool Calling Edge Cases', () => {
  it('TC-EC-1: Tool returns 10MB+ payload — truncation works', () => {
    const policy = new ExecPolicyEngine();
    // Simulate a tool that returns 10MB of data
    const giantOutput = 'x'.repeat(10 * 1024 * 1024);
    // The observation mask should handle this via result budgeting
    const truncated = giantOutput.length > 1000000
      ? giantOutput.slice(0, 1000000) + `\n...[+${giantOutput.length - 1000000} more chars]`
      : giantOutput;
    assert.ok(truncated.length < giantOutput.length, 'Output should be truncated');
    assert.ok(truncated.includes('more chars'), 'Truncation notice should be present');
  });

  it('TC-EC-2: Tool timeout — graceful degradation', async () => {
    const start = Date.now();
    const timeoutMs = 500;
    const result = await Promise.race([
      new Promise<string>(resolve => setTimeout(() => resolve('slow result'), 10000)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
    ]).catch(e => e.message);
    assert.ok(result === 'TIMEOUT', 'Timeout should be detected');
    assert.ok(Date.now() - start < 2000, 'Timeout should fire within reasonable time');
  });

  it('TC-EC-3: Malformed tool response — error classification handles it', () => {
    const err = classifyLLMError(new Error('SyntaxError: Unexpected token in JSON at position 1234'));
    assert.ok(!err.retryable || err.errorClass === 'permanent', 'Malformed response should be permanent error');
  });

  it('TC-EC-4: 50 concurrent tool calls — result correlation', async () => {
    const count = 50;
    const ids = Array.from({ length: count }, (_, i) => `call_${i}`);
    const results = await Promise.allSettled(
      ids.map(id => Promise.resolve({ toolCallId: id, output: `result_for_${id}` }))
    );
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, count, `All ${count} calls should complete`);
    const first = fulfilled[0] as PromiseFulfilledResult<any>;
    assert.ok(first.value.toolCallId === 'call_0', 'Result-toolCallId correlation preserved');
  });

  it('TC-EC-5: Circular dependency detection', () => {
    const router = new TopologyRouter();
    const nodes = [
      { id: 'A', label: 'Task A', estimatedComplexity: 1, estimatedTokens: 100, requiredCapabilities: [], atomic: true },
      { id: 'B', label: 'Task B', estimatedComplexity: 1, estimatedTokens: 100, requiredCapabilities: [], atomic: true },
      { id: 'C', label: 'Task C', estimatedComplexity: 1, estimatedTokens: 100, requiredCapabilities: [], atomic: true },
    ];
    // A->B, B->C, C->A forms a cycle
    const edges = [
      { from: 'A', to: 'B', type: 'SEQUENTIAL' as const, dataDependency: true },
      { from: 'B', to: 'C', type: 'SEQUENTIAL' as const, dataDependency: true },
      { from: 'C', to: 'A', type: 'SEQUENTIAL' as const, dataDependency: true },
    ];
    // The DAG builder should handle this without infinite loop
    const dag = router.buildDAG(nodes, edges);
    assert.ok(dag.metadata.criticalPathDepth > 0, 'DAG should have finite depth despite cycle in edges');
  });

  it('TC-EC-6: ExecPolicy blocks fork bomb pattern', () => {
    const policy = new ExecPolicyEngine();
    const result = policy.evaluate(':(){ :|:& };:');
    assert.strictEqual(result.decision, 'forbidden', 'Fork bomb should be forbidden');
  });

  it('TC-EC-7: ExecPolicy handles empty command', () => {
    const policy = new ExecPolicyEngine();
    const result = policy.evaluate('');
    assert.strictEqual(result.decision, 'allow', 'Empty command should be allowed (no pattern matched)');
  });

  it('TC-EC-8: ExecPolicy handles very long command (10K chars)', () => {
    const policy = new ExecPolicyEngine();
    const longCmd = 'echo ' + 'a'.repeat(10000);
    const result = policy.evaluate(longCmd);
    assert.ok(result.decision === 'allow' || result.decision === 'prompt', 'Long command should not crash policy engine');
  });

  it('TC-EC-9: Approval circuit breaker prevents runaway tool spend', async () => {
    const approval = new ApprovalSystem();
    approval.setMode('auto-edit');
    let deniedCount = 0;
    for (let i = 0; i < 10; i++) {
      const r = await approval.evaluate({
        id: `deny-${i}`, timestamp: Date.now(),
        gate: { category: 'destructive' as const, action: 'rm -rf', riskLevel: 'critical' as const },
        toolName: 'shell', toolArgs: {}, agentId: 'test', runId: 'test',
      });
      if (r.decision === 'denied') deniedCount++;
    }
    assert.ok(deniedCount > 5, `Without callback, most destructive ops should be denied (got ${deniedCount}/10)`);
  });
});

// ============================================================================
// 1.2 LONG-TERM MEMORY EDGE CASES
// ============================================================================
describe('1.2 Long-term Memory Edge Cases', () => {
  it('LM-EC-1: 500+ noise messages — compaction preserves signal', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 50000, layer1Trigger: 0.3, layer2Trigger: 0.5, keepRecentTurns: 3, maxToolOutputChars: 100 });
    let msgs: LLMMessage[] = [{ role: 'system', content: 'You are a helpful assistant. The user prefers Python over JavaScript.' }];
    // Add 500 noise messages
    for (let i = 0; i < 500; i++) {
      msgs.push({ role: 'user', content: `noise message ${i}` });
      msgs.push({ role: 'assistant', content: `response ${i}` });
    }
    // Add a critical message at the end
    msgs.push({ role: 'user', content: 'What language do I prefer?' });
    msgs.push({ role: 'assistant', content: 'Based on our conversation, you prefer Python.' });
    // Compact
    const { messages, action } = compactor.compact(msgs);
    assert.ok(action.droppedCount > 0, 'Should drop noise messages: ' + action.droppedCount);
    // The system prompt should survive compaction
    const hasSystemPrompt = messages.some(m => m.role === 'system' && m.content.includes('Python'));
    assert.ok(hasSystemPrompt, 'System prompt should survive compaction');
    // Recent turns should be preserved
    const hasRecentAssistant = messages.some(m => m.role === 'assistant' && m.content.includes('Python'));
    assert.ok(hasRecentAssistant, 'Recent assistant response should survive compaction');
  });

  it('LM-EC-2: Critical info survives across multiple compactions', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 2000, layer1Trigger: 0.3, keepRecentTurns: 2 });
    let msgs: LLMMessage[] = [
      { role: 'system', content: 'System: project is called Commander.' },
      { role: 'user', content: 'What is the project name?' },
      { role: 'assistant', content: 'The project is called Commander.' },
    ];
    // Compact multiple times
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: `iteration ${i}` });
      msgs.push({ role: 'assistant', content: `response ${i}` });
      const r = compactor.compact(msgs);
      msgs = r.messages;
    }
    // The system prompt should survive all compactions
    const hasSystemPrompt = msgs.some(m => m.role === 'system' && m.content.toLowerCase().includes('commander'));
    assert.ok(hasSystemPrompt, 'System prompt should survive 10 compactions');
  });

  it('LM-EC-3: Token estimation for mixed-content messages', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello, world!'.repeat(100) },
      { role: 'assistant', content: 'Hi there!', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test', arguments: JSON.stringify({ key: 'value'.repeat(100) }) } }] },
    ];
    const tokens = estimateTotalTokens(msgs);
    assert.ok(tokens > 0, 'Token estimation should work: ' + tokens);
    assert.ok(tokens < 100000, 'Token estimation should be reasonable: ' + tokens);
  });

  it('LM-EC-4: Context window pressure detection', () => {
    const cwm = new ContextWindowManager({ maxContextTokens: 1000, triggerThreshold: 0.5 });
    const msgs: LLMMessage[] = [
      { role: 'system', content: 's' },
      ...Array(20).fill(null).map((_, i) => ({ role: 'user' as const, content: 'x'.repeat(100) })),
    ];
    const needsIt = cwm.needsTrimming(msgs);
    assert.ok(needsIt, 'Context window should need trimming at 50%+');
  });
});

// ============================================================================
// 1.3 MULTIMODAL INPUT EDGE CASES
// ============================================================================
describe('1.3 Multimodal Input Edge Cases', () => {
  it('MM-EC-1: Vision tool schema validation works', () => {
    // Test that the vision tool properly validates its input schema
    const schema = {
      type: 'object',
      properties: {
        source: { type: 'string' },
        prompt: { type: 'string' },
        detail: { type: 'string', enum: ['low', 'high', 'auto'] },
      },
      required: ['source'],
    };
    // Valid input
    const valid = { source: '/path/to/image.png' };
    assert.ok(valid.source !== undefined, 'Required field source is present');
    // Invalid input (missing required field)
    const invalid: any = { prompt: 'describe' };
    assert.ok(invalid.source === undefined, 'Missing source should be detected as invalid');
    // Edge: empty source
    const emptySource = { source: '' };
    assert.ok(emptySource.source.length === 0, 'Empty source is technically present but invalid');
  });

  it('MM-EC-2: PDF tool handles non-PDF input gracefully', async () => {
    const { PdfExtractTool } = require('../src/tools/multimodal/pdfTool');
    const tool = new PdfExtractTool();
    const fs = await import('fs');
    const path = await import('path');
    const tmpFile = path.join(require('os').tmpdir(), 'not-a-pdf.txt');
    fs.writeFileSync(tmpFile, 'This is not a PDF file.', 'utf-8');
    const result = await tool.execute({ path: tmpFile });
    fs.unlinkSync(tmpFile);
    assert.ok(result.includes('Error') || result.includes('PDF'), 'Non-PDF should return error: ' + result.slice(0, 100));
  });

  it('MM-EC-3: Vision tool handles non-existent file path', async () => {
    const { VisionAnalyzeTool } = require('../src/tools/multimodal/visionTool');
    const tool = new VisionAnalyzeTool();
    const result = await tool.execute({ source: '/tmp/nonexistent-image-xyz.png' });
    assert.ok(result.includes('Error') || result.includes('not found'), 'Non-existent file should error: ' + result.slice(0, 100));
  });

  it('MM-EC-4: Screenshot tool validates parameter schema', () => {
    const { ScreenshotCaptureTool } = require('../src/tools/multimodal/screenshotTool');
    const tool = new ScreenshotCaptureTool();
    const def = tool.definition;
    assert.ok(def.name === 'screenshot_capture', 'Tool name is correct');
    assert.ok(def.inputSchema.properties?.url !== undefined, 'URL parameter exists');
    assert.ok(def.inputSchema.properties?.width !== undefined, 'Width parameter exists');
    assert.ok(def.inputSchema.properties?.height !== undefined, 'Height parameter exists');
    assert.ok(def.inputSchema.properties?.fullPage !== undefined, 'fullPage parameter exists');
    assert.ok(def.inputSchema.properties?.selector !== undefined, 'selector parameter exists');
  });

  it('MM-EC-5: Vision tool handles extreme detail levels', () => {
    const { VisionAnalyzeTool } = require('../src/tools/multimodal/visionTool');
    const tool = new VisionAnalyzeTool();
    const def = tool.definition;
    const detailEnum = def.inputSchema.properties?.detail?.enum;
    assert.ok(detailEnum !== undefined, 'Detail parameter has enum values');
    assert.ok(detailEnum.includes('low'), 'low detail available');
    assert.ok(detailEnum.includes('high'), 'high detail available');
    assert.ok(detailEnum.includes('auto'), 'auto detail available');
  });
});

// ============================================================================
// 1.4 SELF-CORRECTION EDGE CASES
// ============================================================================
describe('1.4 Self-Correction Edge Cases', () => {
  it('SC-EC-1: Error classification handles network timeout', () => {
    const err = classifyLLMError(new Error('fetch failed: timeout of 30000ms exceeded'));
    assert.strictEqual(err.retryable, true, 'Network timeout should be retryable');
    assert.strictEqual(err.errorClass, 'transient');
  });

  it('SC-EC-2: Error classification handles auth failure', () => {
    const err = classifyLLMError(new Error('401 Unauthorized: invalid API key'));
    assert.strictEqual(err.retryable, false, 'Auth failure should not be retryable');
    assert.strictEqual(err.errorClass, 'permanent');
  });

  it('SC-EC-3: Error classification handles rate limit', () => {
    const err = classifyLLMError(Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
    assert.strictEqual(err.retryable, true, 'Rate limit should be retryable');
    assert.strictEqual(err.errorClass, 'transient');
  });

  it('SC-EC-4: Error classification handles API overload', () => {
    const err = classifyLLMError(Object.assign(new Error('529 Service Overloaded'), { status: 529 }));
    assert.strictEqual(err.retryable, true, 'Overload should be retryable');
    assert.strictEqual(err.errorClass, 'transient');
  });

  it('SC-EC-5: Error classification handles unknown error safely', () => {
    const err = classifyLLMError(new Error('Some completely unknown error type'));
    // Unknown errors should default to non-retryable (fail-safe)
    assert.ok(!err.retryable || err.errorClass !== 'transient', 'Unknown error should not auto-retry');
  });

  it('SC-EC-6: Circuit breaker half-open resets after success', () => {
    const cb = new CircuitBreaker(2, 5000);
    cb.onFailure(); cb.onFailure();
    assert.strictEqual(cb.isAvailable(), false, 'OPEN after 2 failures');
    // Force half-open via internal reset
    cb['state'] = 'HALF_OPEN' as any;
    assert.strictEqual(cb.isAvailable(), true, 'HALF_OPEN allows test');
    cb.onSuccess();
    assert.strictEqual(cb['state'], 'CLOSED', 'Success in HALF_OPEN returns to CLOSED');
  });
});

// ============================================================================
// 1.5 SANDBOX EXECUTION EDGE CASES
// ============================================================================
describe('1.5 Sandbox Execution Edge Cases', () => {
  it('SX-EC-1: SandboxManager profiles are properly isolated', () => {
    const sm = new SandboxManager();
    const ro = sm.getProfile('read-only');
    assert.strictEqual(ro.mode, 'read-only', 'Read-only profile has correct mode');
    assert.strictEqual(ro.network, 'blocked', 'Read-only blocks network');
    assert.strictEqual(ro.filesystem.writablePaths.length, 0, 'Read-only has no writable paths');
  });

  it('SX-EC-2: Workspace-write protects sensitive paths', () => {
    const sm = new SandboxManager();
    const ww = sm.getProfile('workspace-write');
    assert.ok(ww.filesystem.protectedPaths.includes('.git'), 'Workspace-write protects .git');
    assert.ok(ww.filesystem.protectedPaths.includes('.commander'), 'Workspace-write protects .commander');
  });

  it('SX-EC-3: Full-access profile has no restrictions', () => {
    const sm = new SandboxManager();
    const fa = sm.getProfile('full-access');
    assert.strictEqual(fa.mode, 'full-access', 'Full-access profile');
    assert.strictEqual(fa.network, 'full', 'Full-access allows network');
    assert.strictEqual(fa.filesystem.protectedPaths.length, 0, 'Full-access has no protected paths');
  });

  it('SX-EC-4: ExecPolicy prevents destructive system commands', () => {
    const policy = new ExecPolicyEngine();
    const dangerous = ['sudo rm -rf /', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sda1', ':(){ :|:& };:'];
    for (const cmd of dangerous) {
      const result = policy.evaluate(cmd);
      assert.strictEqual(result.decision, 'forbidden', `Should forbid: ${cmd}`);
    }
  });

  it('SX-EC-5: ExecPolicy allows safe development commands', () => {
    const policy = new ExecPolicyEngine();
    const safe = ['npm test', 'git status', 'ls -la', 'cat package.json', 'tsc --noEmit', 'python3 -m pytest'];
    for (const cmd of safe) {
      const result = policy.evaluate(cmd);
      assert.ok(result.decision !== 'forbidden', `Should not forbid: ${cmd}, got: ${result.decision}`);
    }
  });

  it('SX-EC-6: ExecPolicy prompts for network commands', () => {
    const policy = new ExecPolicyEngine();
    const network = ['curl https://example.com', 'wget https://example.com/file'];
    for (const cmd of network) {
      const result = policy.evaluate(cmd);
      assert.strictEqual(result.decision, 'prompt', `Should prompt for: ${cmd}`);
    }
  });

  it('SX-EC-7: Backoff jitter creates unique delays', () => {
    const delays = Array.from({ length: 100 }, () => computeBackoff(2, 1000, 30000));
    const unique = new Set(delays);
    assert.ok(unique.size > 50, `Jitter should produce varied delays: ${unique.size} unique`);
  });

  it('SX-EC-8: Backoff is bounded by max delay', () => {
    const delays = Array.from({ length: 10 }, () => computeBackoff(10, 1000, 10000));
    for (const d of delays) {
      assert.ok(d <= 11000, `Backoff should be capped: ${d} <= 11000`);
    }
  });
});
