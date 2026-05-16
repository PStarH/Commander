import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedVerificationPipeline, detectTaskType } from '../../src/runtime/unifiedVerification';
import type { UVPTaskContext, VerificationReport } from '../../src/runtime/unifiedVerification';

describe('detectTaskType', () => {
  it('detects code tasks', () => {
    assert.equal(detectTaskType('def hello(): print("hi")'), 'code');
    assert.equal(detectTaskType('Fix the bug in the JavaScript code'), 'code');
    assert.equal(detectTaskType('Run the python script to process data'), 'code');
  });

  it('detects search tasks', () => {
    assert.equal(detectTaskType('Look up the latest news about AI'), 'search');
    assert.equal(detectTaskType('Find information about climate change'), 'search');
    assert.equal(detectTaskType('Fetch the content from https://example.com'), 'search');
  });

  it('detects analysis tasks', () => {
    assert.equal(detectTaskType('Analyze the data and summarize findings'), 'analysis');
    assert.equal(detectTaskType('Compare the two approaches and evaluate which is better'), 'analysis');
  });

  it('detects structured tasks', () => {
    assert.equal(detectTaskType('Return the result as JSON'), 'structured');
    assert.equal(detectTaskType('Output the data in CSV format'), 'structured');
  });

  it('defaults to general', () => {
    assert.equal(detectTaskType('Hello, how are you?'), 'general');
    assert.equal(detectTaskType('Tell me a joke'), 'general');
  });
});

describe('UnifiedVerificationPipeline', () => {
  const createPipeline = () => new UnifiedVerificationPipeline({ enabled: true });

  it('passes clean output with high confidence', async () => {
    const pipeline = createPipeline();
    const ctx: UVPTaskContext = {
      goal: 'Summarize the article',
      output: 'The article discusses climate change impacts on coastal cities.',
    };
    const report = await pipeline.verify(ctx);
    assert.equal(report.passed, true);
    assert.ok(report.confidence > 0.8);
    assert.equal(report.signals.length, 0);
  });

  it('detects fabricated references', async () => {
    const pipeline = createPipeline();
    const ctx: UVPTaskContext = {
      goal: 'Explain quantum computing',
      output: 'According to a recent study by Professor Smith et al., quantum computing will revolutionize cryptography.',
    };
    const report = await pipeline.verify(ctx);
    assert.ok(report.signals.some(s => s.source === 'hallucination:fabricatedRef'));
    assert.ok(report.confidence < 0.8);
  });

  it('detects overconfidence markers', async () => {
    const pipeline = createPipeline();
    const ctx: UVPTaskContext = {
      goal: 'Is Python good for beginners?',
      output: 'Without a doubt, Python is the best language for beginners.',
    };
    const report = await pipeline.verify(ctx);
    assert.ok(report.signals.some(s => s.source === 'hallucination:overconfidence'));
  });

  it('does not false-positive on normal "cannot" usage', async () => {
    const pipeline = createPipeline();
    const ctx: UVPTaskContext = {
      goal: 'Explain the limitations of the API',
      output: 'The API cannot handle more than 1000 requests per second. It also cannot process binary data.',
    };
    const report = await pipeline.verify(ctx);
    // Should not flag "cannot" as a tool error in normal prose
    assert.ok(!report.signals.some(s => s.source === 'tool_error'));
  });

  it('detects real tool errors with proper context', async () => {
    const pipeline = createPipeline();
    const ctx: UVPTaskContext = {
      goal: 'Run the script',
      output: 'Here are the results:\nError: FileNotFoundError: /tmp/data.csv not found\nThe script failed.',
      toolsUsed: ['shell_execute'],
    };
    const report = await pipeline.verify(ctx);
    assert.ok(report.signals.some(s => s.source === 'tool_error'));
  });

  it('detects unclosed code blocks in code tasks', async () => {
    const pipeline = createPipeline();
    const ctx: UVPTaskContext = {
      goal: 'Write a Python function',
      output: 'Here is the code:\n```python\ndef hello():\n    print("hello")',
    };
    const report = await pipeline.verify(ctx);
    assert.ok(report.signals.some(s => s.source === 'syntax'));
  });

  it('skips when disabled', async () => {
    const pipeline = new UnifiedVerificationPipeline({ enabled: false });
    const ctx: UVPTaskContext = {
      goal: 'Test',
      output: 'Without a doubt, this is 100% certain.',
    };
    const report = await pipeline.verify(ctx);
    assert.equal(report.skipped, true);
    assert.equal(report.passed, true);
  });

  it('returns task type in report', async () => {
    const pipeline = createPipeline();
    const ctx: UVPTaskContext = {
      goal: 'Write a Python function',
      output: 'def add(a, b): return a + b',
    };
    const report = await pipeline.verify(ctx);
    assert.equal(report.taskType, 'code');
  });

  it('generates actionable feedback with snippets', async () => {
    const pipeline = createPipeline();
    const report: VerificationReport = {
      passed: false,
      confidence: 0.3,
      signals: [
        { stage: 0, source: 'tool_error', severity: 'high', message: 'Error in output', snippet: 'Error: file not found', suggestion: 'Fix the file path' },
      ],
      tokensUsed: 0,
      stagesRun: [0],
      taskType: 'code',
      skipped: false,
    };
    const feedback = pipeline.toFeedback(report);
    assert.ok(feedback);
    assert.ok(feedback.includes('Error in output'));
    assert.ok(feedback.includes('Fix the file path'));
    assert.ok(feedback.includes('Problem:'));
  });

  it('returns null feedback when passed', async () => {
    const pipeline = createPipeline();
    const report: VerificationReport = {
      passed: true,
      confidence: 0.9,
      signals: [],
      tokensUsed: 0,
      stagesRun: [0],
      taskType: 'general',
      skipped: false,
    };
    assert.equal(pipeline.toFeedback(report), null);
  });

  it('handles schema validation', async () => {
    // Use low confidenceSkipThreshold so Stage 1 always runs
    const pipeline = new UnifiedVerificationPipeline({ enabled: true, confidenceSkipThreshold: 0.99 });
    const ctx: UVPTaskContext = {
      goal: 'Return user data',
      output: '{"name": "Alice"}',
      schema: {
        properties: {
          name: { type: 'string', required: true },
          age: { type: 'number', required: true },
        },
      },
    };
    const report = await pipeline.verify(ctx);
    assert.ok(report.signals.some(s => s.message.includes('age')));
  });

  it('validates JSON types in schema', async () => {
    const pipeline = new UnifiedVerificationPipeline({ enabled: true, confidenceSkipThreshold: 0.99 });
    const ctx: UVPTaskContext = {
      goal: 'Return data',
      output: '{"count": "not a number"}',
      schema: {
        properties: {
          count: { type: 'number', required: true },
        },
      },
    };
    const report = await pipeline.verify(ctx);
    assert.ok(report.signals.some(s => s.message.includes('count')));
  });

  it('adjusts relevance threshold by task type', async () => {
    const pipeline = createPipeline();
    // Code tasks allow longer output
    const longCodeOutput = 'x '.repeat(2000);
    const ctx: UVPTaskContext = {
      goal: 'Write a Python function to process data',
      output: longCodeOutput,
    };
    const report = await pipeline.verify(ctx);
    // Should not penalize as heavily as it would for a search task
    const relevanceSignal = report.signals.find(s => s.source === 'relevance');
    if (relevanceSignal) {
      assert.equal(relevanceSignal.severity, 'low');
    }
  });
});
