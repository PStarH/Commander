import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankToolsByTask,
  classifyTaskType,
  getCriticalTools,
  preferencesToScoreMap,
  type ToolPreference,
  type RankerContext,
} from '../../src/runtime/toolPreferenceRanker.js';

// ============================================================================
// Task type classification
// ============================================================================

describe('classifyTaskType', () => {
  it('classifies code editing tasks', () => {
    assert.strictEqual(classifyTaskType('Refactor the auth module to use a single source of truth'), 'code_edit');
    assert.strictEqual(classifyTaskType('Implement a new feature for user registration'), 'code_edit');
    assert.strictEqual(classifyTaskType('Fix the bug in the login handler'), 'code_edit');
    assert.strictEqual(classifyTaskType('Add a new middleware for rate limiting'), 'code_edit');
    assert.strictEqual(classifyTaskType('Migrate the database layer to use Prisma'), 'code_edit');
    assert.strictEqual(classifyTaskType('Run tsc and fix all type errors'), 'code_edit');
  });

  it('classifies code search tasks', () => {
    assert.strictEqual(classifyTaskType('Find all files that import the auth module'), 'code_search');
    assert.strictEqual(classifyTaskType('Where is the authenticate function defined?'), 'code_search');
    assert.strictEqual(classifyTaskType('grep for TODO comments in the codebase'), 'code_search');
    assert.strictEqual(classifyTaskType('Search for all test files'), 'code_search');
  });

  it('classifies research tasks', () => {
    assert.strictEqual(classifyTaskType('What is the best way to handle async errors in Express?'), 'research');
    assert.strictEqual(classifyTaskType('Research the difference between Zustand and Redux'), 'research');
    assert.strictEqual(classifyTaskType('Explain how garbage collection works in V8'), 'research');
  });

  it('classifies analysis tasks', () => {
    assert.strictEqual(classifyTaskType('Audit the security of the API endpoints'), 'analysis');
    assert.strictEqual(classifyTaskType('Analyze the performance of the database queries'), 'analysis');
    assert.strictEqual(classifyTaskType('Review the codebase for potential memory leaks'), 'analysis');
    assert.strictEqual(classifyTaskType('Profile the build pipeline for bottlenecks'), 'analysis');
  });

  it('classifies file management tasks', () => {
    assert.strictEqual(classifyTaskType('Organize the test files into subdirectories'), 'file_management');
    assert.strictEqual(classifyTaskType('Clean up old backup directories'), 'file_management');
    assert.strictEqual(classifyTaskType('List all directories in the project'), 'file_management');
    assert.strictEqual(classifyTaskType('Create a new directory for test fixtures'), 'file_management');
  });

  it('classifies git workflow tasks', () => {
    assert.strictEqual(classifyTaskType('Create a release branch from main'), 'git_workflow');
    assert.strictEqual(classifyTaskType('Merge the feature branch and push to origin'), 'git_workflow');
    assert.strictEqual(classifyTaskType('Rebase my branch onto main'), 'git_workflow');
  });

  it('classifies test run tasks', () => {
    assert.strictEqual(classifyTaskType('Run all unit tests and report failures'), 'test_run');
    assert.strictEqual(classifyTaskType('Execute the integration test suite'), 'test_run');
    assert.strictEqual(classifyTaskType('Add snapshot tests for the component'), 'test_run');
  });

  it('classifies verification tasks', () => {
    assert.strictEqual(classifyTaskType('Verify that all type errors are fixed'), 'verification');
    assert.strictEqual(classifyTaskType('Validate the lint config is working'), 'verification');
    assert.strictEqual(classifyTaskType('Check that the build passes on all platforms'), 'verification');
  });

  it('falls back to general for ambiguous tasks', () => {
    assert.strictEqual(classifyTaskType('hello'), 'general');
    assert.strictEqual(classifyTaskType('Tell me a joke'), 'general');
    assert.strictEqual(classifyTaskType('Do something useful'), 'general');
  });

  it('detects code_edit even with short goals', () => {
    assert.strictEqual(classifyTaskType('fix the bug'), 'code_edit');
    assert.strictEqual(classifyTaskType('update config'), 'code_edit');
  });
});

// ============================================================================
// Tool ranking
// ============================================================================

describe('rankToolsByTask', () => {
  const ALL_TOOLS = [
    'file_read', 'file_write', 'file_edit', 'file_search', 'file_list',
    'code_search', 'shell_execute', 'python_execute', 'git',
    'web_search', 'web_fetch', 'memory_recall', 'memory_store',
    'verify', 'fix_code', 'refine_code', 'apply_patch',
  ];

  it('returns all tools with scores and priorities', () => {
    const result = rankToolsByTask('Refactor the auth module', ALL_TOOLS);
    assert.strictEqual(result.length, ALL_TOOLS.length);
    for (const p of result) {
      assert.ok(p.score >= 0 && p.score <= 1, `${p.toolName} score ${p.score} out of range`);
      assert.ok(p.priority >= 1 && p.priority <= 10, `${p.toolName} priority ${p.priority} out of range`);
      assert.ok(p.reasons.length > 0, `${p.toolName} has no reasons`);
    }
  });

  it('ranks code edit tools highest for code_edit tasks', () => {
    const result = rankToolsByTask('Implement a new API endpoint for user registration', ALL_TOOLS);
    const top3 = result.slice(0, 3).map(p => p.toolName);
    // file_read, file_edit, code_search should be in top 3 for code_edit
    assert.ok(top3.includes('file_read'), `Expected file_read in top 3, got ${top3.join(', ')}`);
    assert.ok(top3.includes('file_edit'), `Expected file_edit in top 3, got ${top3.join(', ')}`);
  });

  it('ranks git tool highest for git_workflow tasks', () => {
    const result = rankToolsByTask('Create a release branch and push to origin', ALL_TOOLS);
    // git should be #1
    assert.strictEqual(result[0].toolName, 'git');
    assert.ok(result[0].reasons.some(r => r.includes('critical tool')));
  });

  it('ranks web_search highest for research tasks', () => {
    const result = rankToolsByTask('What is the best way to handle async errors in Express?', ALL_TOOLS);
    // web_search should be #1 or #2 for research
    const top2 = result.slice(0, 2).map(p => p.toolName);
    assert.ok(top2.includes('web_search'), `Expected web_search in top 2, got ${top2.join(', ')}`);
  });

  it('ranks verify highest for verification tasks', () => {
    const result = rankToolsByTask('Verify all type errors are resolved', ALL_TOOLS);
    // verify should be #1 for verification
    assert.strictEqual(result[0].toolName, 'verify');
    assert.ok(result[0].reasons.some(r => r.includes('critical tool for verification')));
  });

  it('boosts verify when files have been modified', () => {
    const ctx: RankerContext = { hasModifiedFiles: true };
    const result = rankToolsByTask('Refactor the auth module', ALL_TOOLS, ctx);
    const verifyPref = result.find(p => p.toolName === 'verify');
    assert.ok(verifyPref, 'verify not found in results');
    assert.ok(verifyPref!.reasons.some(r => r.includes('files modified')), 'Expected verify to be boosted');
  });

  it('boosts fix_code when type errors are detected', () => {
    const ctx: RankerContext = { hasTypeErrors: true };
    const result = rankToolsByTask('Refactor the auth module', ALL_TOOLS, ctx);
    const fixPref = result.find(p => p.toolName === 'fix_code');
    assert.ok(fixPref, 'fix_code not found in results');
    assert.ok(fixPref!.reasons.some(r => r.includes('type errors detected')), 'Expected fix_code to be boosted');
  });

  it('demotes expensive tools under budget pressure', () => {
    const ctx: RankerContext = { budgetRemaining: 500 };
    const result = rankToolsByTask('What is the latest news?', ALL_TOOLS, ctx);
    const webPref = result.find(p => p.toolName === 'web_search');
    assert.ok(webPref, 'web_search not found in results');
    assert.ok(webPref!.reasons.some(r => r.includes('low budget')), 'Expected web_search to be demoted under budget pressure');
  });

  it('sorts by score descending then name ascending for stability', () => {
    const result1 = rankToolsByTask('refactor', ALL_TOOLS);
    const result2 = rankToolsByTask('refactor', ALL_TOOLS);
    // Deterministic output
    for (let i = 0; i < result1.length; i++) {
      assert.strictEqual(result1[i].toolName, result2[i].toolName);
      assert.strictEqual(result1[i].score, result2[i].score);
    }
  });

  it('handles empty tool list gracefully', () => {
    const result = rankToolsByTask('Do something', []);
    assert.strictEqual(result.length, 0);
  });

  it('handles single tool gracefully', () => {
    const result = rankToolsByTask('Fix the code', ['file_read']);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].toolName, 'file_read');
    assert.ok(result[0].score > 0);
  });

  it('handles unknown tools with minimal scores', () => {
    const result = rankToolsByTask('Refactor the auth module', ['unknown_tool']);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].toolName, 'unknown_tool');
    // Unknown tool has no category => priority 10 => catScore = 0
    assert.ok(result[0].score >= 0, 'Unknown tool should have non-negative score');
  });

  it('returns reasons for every tool', () => {
    const result = rankToolsByTask('Refactor the auth module', ALL_TOOLS);
    for (const p of result) {
      assert.ok(Array.isArray(p.reasons), `${p.toolName} reasons is not an array`);
      assert.ok(p.reasons.length > 0, `${p.toolName} has no reasons`);
    }
  });
});

// ============================================================================
// Critical tools
// ============================================================================

describe('getCriticalTools', () => {
  it('returns file_read and file_edit for code_edit tasks', () => {
    const critical = getCriticalTools('code_edit');
    assert.ok(critical.includes('file_read'), 'Expected file_read to be critical');
    assert.ok(critical.includes('file_edit'), 'Expected file_edit to be critical');
  });

  it('returns code_search for code_search tasks', () => {
    const critical = getCriticalTools('code_search');
    assert.ok(critical.includes('code_search'), 'Expected code_search to be critical');
  });

  it('returns git for git_workflow tasks', () => {
    const critical = getCriticalTools('git_workflow');
    assert.ok(critical.includes('git'), 'Expected git to be critical');
  });
});

// ============================================================================
// Score map conversion
// ============================================================================

describe('preferencesToScoreMap', () => {
  it('converts preferences to a Map with scaled scores', () => {
    const prefs: ToolPreference[] = [
      { toolName: 'file_read', score: 0.8, priority: 1, reasons: ['critical'] },
      { toolName: 'code_search', score: 0.5, priority: 3, reasons: ['useful'] },
    ];
    const map = preferencesToScoreMap(prefs);
    assert.strictEqual(map.get('file_read'), 8);
    assert.strictEqual(map.get('code_search'), 5);
  });

  it('handles empty preferences', () => {
    const map = preferencesToScoreMap([]);
    assert.strictEqual(map.size, 0);
  });

  it('handles zero-score preferences', () => {
    const prefs: ToolPreference[] = [
      { toolName: 'unknown', score: 0, priority: 10, reasons: ['no reason'] },
    ];
    const map = preferencesToScoreMap(prefs);
    assert.strictEqual(map.get('unknown'), 0);
  });
});
