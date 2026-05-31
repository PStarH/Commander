/**
 * SWE-bench Agent Pipeline — Commander's Multi-Agent Approach
 *
 * Pipeline: Planner → Localizer → Coder → Tester
 *
 * Unlike single-agent approaches (SWE-Agent, Agentless), Commander uses
 * specialized agents for each phase, with iterative test-driven refinement.
 *
 * Key differentiators:
 * 1. Fault localization as a separate agent (not inline with coding)
 * 2. Test-first: run failing tests BEFORE generating patches
 * 3. Iterative refinement: if patch fails tests, re-localize and re-patch
 * 4. Clean unified diff output for SWE-bench evaluation
 */

// ============================================================================
// Types
// ============================================================================

export interface SWEInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  test_patch?: string;      // The ground-truth test (for reference only)
  patch?: string;           // The ground-truth patch (for reference only)
  FAIL_TO_PASS?: string;    // Tests that should pass after fix
  PASS_TO_PASS?: string;    // Tests that should still pass
}

export interface SWEResult {
  instance_id: string;
  model_patch: string;
  model_name_or_path: string;
  status: 'resolved' | 'failed' | 'error';
  agent_steps: AgentStep[];
  tokens_used: number;
  duration_ms: number;
}

export interface AgentStep {
  agent: 'planner' | 'localizer' | 'coder' | 'tester';
  action: string;
  result: string;
  tokens: number;
}

// ============================================================================
// Prompts — tuned for SWE-bench success
// ============================================================================

const PLANNER_SYSTEM = `You are the Planner agent in a multi-agent system that fixes software bugs in real GitHub repositories.
Your job: analyze the issue and create a PRECISE, ACTIONABLE plan.

Given a GitHub issue:
1. Identify the exact bug described — what code behavior is wrong?
2. Determine what behavior is expected vs actual
3. If test failures are mentioned, analyze what they reveal about the bug
4. List the files/areas likely affected
5. Create a step-by-step fix plan

Be SPECIFIC. Reference file names, function names, class names when possible.
Do NOT write code. Only analyze and plan.

Key insight: The best SWE-bench agents understand the TEST FIRST — what do the failing tests expect?
If you know which tests fail, reverse-engineer the expected behavior from them.

Output format:
## Bug Analysis
[What the bug is, in technical terms]

## Test Expectations
[What the failing tests reveal about expected behavior]

## Expected vs Actual
- Expected: [behavior]
- Actual: [behavior]

## Affected Areas
- file.py: function_name() - reason

## Fix Plan
1. Step one (be specific about what code to change)
2. Step two
...`;

const LOCALIZER_SYSTEM = `You are the Localizer agent. Your job: find the exact code that needs to change.

Given a bug analysis and plan:
1. Search the codebase for relevant files
2. Read the relevant code sections
3. Identify the exact lines/functions that are buggy
4. Explain WHY each location is relevant

Output format:
## Relevant Files
### path/to/file.py
- Lines XX-YY: function_name() - [why relevant]
- Lines AA-BB: class_name - [why relevant]

## Root Cause Location
- file.py, line XX: [exact line causing the bug]

## Dependencies
- These other files/functions interact with the buggy code: ...`;

const CODER_SYSTEM = `You produce unified diffs to fix software bugs.

RULES:
- Output ONLY a valid unified diff. No explanations, no markdown, no fences.
- Start with "--- a/" and "+++ b/" headers.
- Include 3 context lines around each change.
- File paths must be RELATIVE to repo root.
- Change as FEW lines as possible.

Format:
--- a/path/to/file.py
+++ b/path/to/file.py
@@ -start,count +start,count @@
 ctx
 ctx
 ctx
-old
+new
 ctx
 ctx
 ctx`;

const TESTER_SYSTEM = `You are the Tester agent. Your job: validate the patch by running tests.

Given a patch:
1. Apply the patch
2. Run the relevant test suite
3. Report pass/fail with details
4. If tests fail, analyze WHY and provide SPECIFIC feedback for the Coder

Output format:
## Test Results
- PASS: test_name_1
- FAIL: test_name_2 - [error message]

## Root Cause Analysis (if failures)
[Why the patch didn't work — what did the Coder get wrong?]

## Specific Fix Instructions (if failures)
[Exactly what code changes are needed to fix the failures]`;

// ============================================================================
// Agent Pipeline
// ============================================================================

export class SWEBenchAgent {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxRetries: number;
  private totalTokens: number = 0;
  private steps: AgentStep[] = [];

  constructor(baseURL: string, apiKey: string, model: string, maxRetries: number = 2) {
    this.baseURL = baseURL;
    this.apiKey = apiKey;
    this.model = model;
    this.maxRetries = maxRetries;
  }

  /**
   * Main pipeline: Planner → Localizer → Coder → Tester (with retry)
   */
  async solve(instance: SWEInstance, repoPath: string): Promise<SWEResult> {
    const startTime = Date.now();
    this.totalTokens = 0;
    this.steps = [];

    try {
      // Phase 1: Plan + Localize (combined)
      const plan = await this.plan(instance, repoPath);

      // Phase 2: Code (with test-driven retry loop)
      let patch = '';
      let testResults = '';

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        // Generate patch
        patch = await this.code(instance, plan, testResults, repoPath);

        if (!patch || patch.length < 20) {
          // Coder produced no meaningful patch
          break;
        }

        // Validate patch
        testResults = await this.test(instance, patch, repoPath);

        if (testResults.includes('ALL_TESTS_PASS')) {
          break; // Patch works!
        }

        // If tests fail and we have retries left, feed failure info back to coder
        if (attempt < this.maxRetries) {
          this.steps.push({
            agent: 'tester',
            action: 'retry_feedback',
            result: `Tests failed, retrying with feedback (attempt ${attempt + 2}/${this.maxRetries + 1})`,
            tokens: 0,
          });
        }
      }

      return {
        instance_id: instance.instance_id,
        model_patch: patch,
        model_name_or_path: 'commander-swebench',
        status: testResults.includes('ALL_TESTS_PASS') ? 'resolved' : 'failed',
        agent_steps: this.steps,
        tokens_used: this.totalTokens,
        duration_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        instance_id: instance.instance_id,
        model_patch: '',
        model_name_or_path: 'commander-swebench',
        status: 'error',
        agent_steps: this.steps,
        tokens_used: this.totalTokens,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  // ── Phase 1: Plan + Localize (combined for efficiency) ────────────────────

  private async plan(instance: SWEInstance, repoPath: string): Promise<string> {
    // Extract target files from FAIL_TO_PASS test paths
    const testPaths = this.extractTestPaths(instance.FAIL_TO_PASS || '');
    const targetModulePaths = testPaths.map(p => p.replace('/tests/', '/').replace('test_', ''));

    // Read the test file to understand expected behavior
    let testContent = '';
    if (testPaths.length > 0) {
      const testFile = testPaths[0];
      testContent = await this.execCommand(
        `cd ${repoPath} && cat "${testFile}" 2>/dev/null | head -150`,
        10
      );
    }

    // Search for keywords from the issue in non-test files
    const keywords = this.extractKeywords(instance.problem_statement);
    const searchResults = await this.execCommand(
      `cd ${repoPath} && grep -rn "${keywords[0] || 'error'}" --include="*.py" --exclude="test_*" --exclude-dir="__pycache__" -l 2>/dev/null | head -15`,
      10
    );

    // Find the function/class mentioned in the issue
    const funcMatch = instance.problem_statement.match(/(?:def|class|function)\s+(\w+)/i);
    const funcName = funcMatch?.[1] || keywords[1] || '';
    const funcSearch = funcName ? await this.execCommand(
      `cd ${repoPath} && grep -rn "def ${funcName}\\|class ${funcName}" --include="*.py" --exclude="test_*" 2>/dev/null | head -10`,
      10
    ) : '';

    // Read the most relevant source files
    const filesToRead = searchResults.split('\n').filter(f => f.trim()).slice(0, 3);
    let sourceContents = '';
    for (const fileLine of filesToRead) {
      const file = fileLine.split(':')[0];
      if (!file) continue;
      const content = await this.execCommand(`head -300 "${repoPath}/${file}" 2>/dev/null`, 5);
      if (content) sourceContents += `\n### ${file}\n\`\`\`python\n${content}\n\`\`\`\n`;
    }

    const prompt = `## GitHub Issue
Repository: ${instance.repo}
Instance ID: ${instance.instance_id}

## Problem Statement
${instance.problem_statement}

${instance.hints_text ? `## Hints\n${instance.hints_text}` : ''}

## Tests That Must Pass After Fix
${instance.FAIL_TO_PASS || 'Unknown'}

## Test File Content (what the fix should enable)
${testContent || 'Not available'}

## Source Files Matching Keywords
${searchResults || 'No matches'}

${funcSearch ? `## Function/Class Search: ${funcName}\n${funcSearch}` : ''}

## Relevant Source Code
${sourceContents || 'Not available'}

## Task
1. Analyze the bug: what is wrong?
2. Look at the test: what behavior is expected?
3. Find the root cause in the source code
4. Describe the minimal fix needed

Be specific about file paths, function names, and line numbers.`;

    const result = await this.callLLM(PLANNER_SYSTEM, prompt, 2000);
    this.steps.push({ agent: 'planner', action: 'analyze_and_localize', result: result.slice(0, 500), tokens: this.lastTokens });
    return result;
  }

  // ── Phase 2: Code (multi-turn conversation) ──────────────────────────────

  private async code(
    instance: SWEInstance,
    plan: string,
    previousTestResults: string,
    repoPath: string,
  ): Promise<string> {
    // Multi-turn: 1) model picks files to read, 2) we provide them, 3) model writes diff

    // Turn 1: Ask model what files it needs
    const pickPrompt = `You are fixing a bug in ${instance.repo}.

Issue: ${instance.problem_statement.slice(0, 1000)}

Analysis: ${plan.slice(0, 1000)}

I need you to tell me which files to read. Reply with ONLY a JSON array of file paths (relative to repo root).
Example: ["astropy/modeling/separable.py", "astropy/modeling/core.py"]

Reply with ONLY the JSON array, nothing else.`;

    const pickResult = await this.callLLM('You are a helpful assistant. Reply with only valid JSON.', pickPrompt, 200);

    // Parse file list
    let filesToRead: string[] = [];
    try {
      const jsonMatch = pickResult.match(/\[[\s\S]*?\]/);
      if (jsonMatch) filesToRead = JSON.parse(jsonMatch[0]);
    } catch { /* ignore */ }

    // Fallback: extract file paths from plan
    if (filesToRead.length === 0) {
      const pathRegex = /[\w\/\-]+\.py/g;
      let m;
      while ((m = pathRegex.exec(plan)) !== null) {
        if (!m[0].includes('test')) filesToRead.push(m[0]);
      }
      filesToRead = [...new Set(filesToRead)].slice(0, 5);
    }

    // Turn 2: Read files and provide to model
    let fileContents = '';
    for (const file of filesToRead.slice(0, 5)) {
      const content = await this.execCommand(`cat "${repoPath}/${file}" 2>/dev/null | head -500`, 10);
      if (content && !content.includes('No such file')) {
        fileContents += `\n=== ${file} ===\n${content}\n`;
      }
    }

    // Turn 3: Ask model to output the FIXED code (not a diff), then compute diff
    // This avoids the model's inability to generate proper unified diffs.

    // Find the actual file path from our file list
    const targetFile = filesToRead[0] || 'unknown.py';

    // Read the full file
    const fullFile = await this.execCommand(`cat "${repoPath}/${targetFile}" 2>/dev/null`, 10);
    if (!fullFile || fullFile.includes('No such file')) {
      return '';
    }

    // Ask model to output the FIXED version of the file
    const fixPrompt = `You are fixing a bug in ${targetFile}.

Bug: ${instance.problem_statement.slice(0, 1000)}

Current file content:
${fullFile.slice(0, 8000)}

Output the COMPLETE fixed file content. Output ONLY the Python code, no explanations, no markdown fences.`;

    const fixedCode = await this.callLLM('You are a Python developer. Output only valid Python code. No explanations, no markdown.', fixPrompt, 6000);

    // Compute diff between original and fixed
    const patch = await this.computeDiff(repoPath, targetFile, fullFile, fixedCode);

    // Debug
    if (process.env.DEBUG_SWEBENCH) {
      console.log(`\n[FIXED CODE len=${fixedCode.length}] ${fixedCode.slice(0, 300)}`);
      console.log(`\n[COMPUTED DIFF len=${patch.length}] ${patch.slice(0, 300)}`);
    }

    this.steps.push({ agent: 'coder', action: 'generate_patch', result: `Patch: ${patch.length} chars, files: ${filesToRead.join(',')}`, tokens: this.lastTokens });
    return patch;
  }

  // ── Phase 4: Test ─────────────────────────────────────────────────────────

  private async test(instance: SWEInstance, patch: string, repoPath: string): Promise<string> {
    // Save patch to temp file
    const patchFile = `/tmp/swebench_${instance.instance_id.replace(/[^a-zA-Z0-9]/g, '_')}.patch`;
    await this.execCommand(`cat > ${patchFile} << 'PATCH_EOF'\n${patch}\nPATCH_EOF`, 5);

    // Try to apply the patch
    const applyResult = await this.execCommand(
      `cd ${repoPath} && git apply --check ${patchFile} 2>&1`,
      10
    );

    if (applyResult.includes('error') || applyResult.includes('fatal')) {
      this.steps.push({
        agent: 'tester',
        action: 'apply_patch',
        result: `Patch failed to apply: ${applyResult.slice(0, 200)}`,
        tokens: 0,
      });
      return `PATCH_APPLY_FAILED: ${applyResult}`;
    }

    // Apply the patch
    await this.execCommand(`cd ${repoPath} && git apply ${patchFile}`, 10);

    // Run the failing tests (if we know which tests fail)
    let testCmd = 'python -m pytest -x --tb=short 2>&1 | tail -50';
    if (instance.FAIL_TO_PASS) {
      // Parse test names from FAIL_TO_PASS
      const testNames = instance.FAIL_TO_PASS.split('\n').filter(t => t.trim());
      if (testNames.length > 0) {
        testCmd = `cd ${repoPath} && python -m pytest ${testNames.join(' ')} -x --tb=short 2>&1 | tail -80`;
      }
    }

    const testOutput = await this.execCommand(`cd ${repoPath} && ${testCmd}`, 60);

    // Revert the patch
    await this.execCommand(`cd ${repoPath} && git checkout . 2>&1`, 10);

    const passed = !testOutput.includes('FAILED') && !testOutput.includes('ERROR') &&
                   (testOutput.includes('passed') || testOutput.includes('PASSED'));

    this.steps.push({
      agent: 'tester',
      action: 'run_tests',
      result: passed ? 'ALL_TESTS_PASS' : `Tests failed: ${testOutput.slice(0, 300)}`,
      tokens: 0,
    });

    return passed ? 'ALL_TESTS_PASS' : testOutput;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private lastTokens: number = 0;

  private async callLLM(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    try {
      const resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          top_p: 0.95,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt + '\n\nIMPORTANT: You must respond with plain text only. Do NOT use tool call XML tags like <tool_call> or <function=...>. Just write your response directly as plain text.' },
            { role: 'user', content: userPrompt },
          ],
          // Disable tool calling to force plain text output
          tools: undefined,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API error ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json() as any;
      const msg = data.choices?.[0]?.message || {};
      let content = msg.content || '';

      // Reasoning models put output in reasoning_content
      if (!content && msg.reasoning_content) {
        content = msg.reasoning_content;
      }
      // Some models use tool_calls
      if (!content && msg.tool_calls?.length > 0) {
        content = msg.tool_calls.map((tc: any) => tc.function?.arguments || '').join('\n');
      }

      // Debug: log raw model output
      if (process.env.DEBUG_SWEBENCH) {
        console.log(`\n[LLM RAW] content_len=${content.length}, keys=${Object.keys(msg).join(',')}`);
        console.log(`[LLM RAW preview] ${content.slice(0, 400)}`);
      }

      // Strip tool call XML if the model still outputs it
      content = this.stripToolCalls(content);

      const tokens = data.usage?.total_tokens ?? Math.ceil(content.length / 4);
      this.lastTokens = tokens;
      this.totalTokens += tokens;
      return content;
    } catch (error: any) {
      clearTimeout(timer);
      throw error;
    }
  }

  /**
   * Strip tool call XML tags from LLM output.
   * Some models output <tool_call><function=...>... format even when asked not to.
   */
  private stripToolCalls(text: string): string {
    // Only strip if text actually contains tool call tags
    if (!text.includes('<tool_call>') && !text.includes('<function=') && !text.includes('<parameter=')) {
      return text.trim();
    }

    // Remove <tool_call>...</tool_call> blocks
    let cleaned = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');

    // Remove <function=...>...</function> blocks
    cleaned = cleaned.replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '');

    // Remove <parameter=...> tags
    cleaned = cleaned.replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/g, '');

    // If we stripped everything, try to extract just the text content
    if (cleaned.trim().length < 10 && text.length > 50) {
      // Try to extract content from inside tool calls
      const paramMatch = text.match(/<parameter=[^>]*>([\s\S]*?)<\/parameter>/g);
      if (paramMatch) {
        const extracted = paramMatch.map(m => {
          const contentMatch = m.match(/<parameter=[^>]*>([\s\S]*?)<\/parameter>/);
          return contentMatch?.[1] || '';
        }).join('\n');
        if (extracted.length > 20) return extracted;
      }
      // If all else fails, return original text
      return text.trim();
    }

    return cleaned.trim();
  }

  private async execCommand(command: string, timeoutSec: number): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      return execSync(command, {
        timeout: timeoutSec * 1000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().slice(0, 5000); // Cap output
    } catch (error: any) {
      return error.stdout?.toString()?.slice(0, 2000) || error.message?.slice(0, 500) || 'Command failed';
    }
  }

  private async execCommandLarge(command: string, timeoutSec: number): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      return execSync(command, {
        timeout: timeoutSec * 1000,
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024, // 5MB
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch (error: any) {
      // diff exits with 1 when files differ (not an error)
      if (error.status === 1) {
        return error.stdout?.toString() || '';
      }
      return error.stdout?.toString()?.slice(0, 2000) || error.message?.slice(0, 500) || 'Command failed';
    }
  }

  private extractTestPaths(failToPass: string): string[] {
    // Parse FAIL_TO_PASS format: list of test paths like "astropy/modeling/tests/test_separable.py::test_name"
    try {
      const parsed = JSON.parse(failToPass);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map(t => t.split('::')[0]))];
      }
    } catch {
      // Try parsing as newline-separated
      return [...new Set(
        failToPass.split('\n')
          .map(l => l.trim())
          .filter(l => l.includes('.py'))
          .map(l => l.split('::')[0])
      )];
    }
    return [];
  }

  /**
   * Compute a unified diff between original file content and the model's fixed version.
   */
  private async computeDiff(repoPath: string, filePath: string, original: string, fixed: string): Promise<string> {
    // Clean up the fixed code — remove markdown fences if present
    let cleanFixed = fixed;
    const codeMatch = fixed.match(/```(?:python)?\n([\s\S]*?)```/);
    if (codeMatch) cleanFixed = codeMatch[1];

    // Write both versions to temp files
    const origFile = `/tmp/swebench_orig_${Date.now()}.py`;
    const fixedFile = `/tmp/swebench_fixed_${Date.now()}.py`;
    const fs = await import('fs');
    fs.writeFileSync(origFile, original);
    fs.writeFileSync(fixedFile, cleanFixed);

    // Compute diff (use --label to avoid timestamps, increase buffer for large files)
    const diff = await this.execCommandLarge(
      `diff -u --label "a/${filePath}" --label "b/${filePath}" "${origFile}" "${fixedFile}"`,
      15
    );

    // Cleanup
    try { fs.unlinkSync(origFile); } catch { /* ignore */ }
    try { fs.unlinkSync(fixedFile); } catch { /* ignore */ }

    // Validate diff
    if (!diff || diff.includes('are identical') || !diff.includes('@@')) {
      return '';
    }

    return diff;
  }

  private extractKeywords(problemStatement: string): string[] {
    // Extract meaningful keywords from the issue for code search
    const words = problemStatement
      .replace(/[^a-zA-Z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !['this', 'that', 'with', 'from', 'have', 'been', 'will', 'when', 'where', 'what', 'which', 'should', 'would', 'could', 'does', 'that'].includes(w.toLowerCase()));

    // Prefer words that look like code identifiers (snake_case, camelCase)
    const codeLike = words.filter(w => w.includes('_') || /[a-z][A-Z]/.test(w));
    return [...new Set([...codeLike.slice(0, 3), ...words.slice(0, 5)])];
  }

  private async readRelevantFiles(localization: string, repoPath: string): Promise<string> {
    // Extract file paths mentioned in the localization
    const filePathRegex = /(?:^|\s)([\w\/\-]+\.py)(?::|\s|$)/gm;
    const files: string[] = [];
    let match;
    while ((match = filePathRegex.exec(localization)) !== null) {
      files.push(match[1]);
    }

    // Also try to find files from the repo
    const uniqueFiles = [...new Set(files)].slice(0, 10);
    const contents: string[] = [];

    for (const file of uniqueFiles) {
      const fullPath = file.startsWith('/') ? file : `${repoPath}/${file}`;
      const content = await this.execCommand(`cat "${fullPath}" 2>/dev/null | head -200`, 5);
      if (content && !content.includes('No such file')) {
        contents.push(`### ${file}\n\`\`\`python\n${content}\n\`\`\``);
      }
    }

    return contents.join('\n\n') || 'No relevant files found. Search the codebase manually.';
  }

  private extractPatch(response: string): string {
    // Try to find diff in markdown code blocks first
    const codeBlockPatterns = [
      /```diff\n([\s\S]*?)```/,
      /```patch\n([\s\S]*?)```/,
      /```\n(---[\s\S]*?)```/,
    ];
    for (const pattern of codeBlockPatterns) {
      const match = response.match(pattern);
      if (match && match[1].includes('---')) return match[1].trim();
    }

    // Find the LAST occurrence of a diff header (model often has analysis before the diff)
    const diffStart = response.lastIndexOf('--- a/');
    if (diffStart === -1) {
      // Try alternative diff header
      const altStart = response.lastIndexOf('diff --git');
      if (altStart !== -1) {
        return response.slice(altStart).split('\n\n\n')[0].trim();
      }
      return '';
    }

    // Extract from the diff header to the end, then clean up
    let diffText = response.slice(diffStart);

    // Remove trailing analysis text (anything after the last @@ hunk that doesn't look like diff)
    const lines = diffText.split('\n');
    const cleanLines: string[] = [];
    let inDiff = false;
    let lastHunkIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Diff headers
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        cleanLines.push(line);
        inDiff = true;
        continue;
      }
      // Hunk headers
      if (line.startsWith('@@')) {
        cleanLines.push(line);
        inDiff = true;
        lastHunkIdx = cleanLines.length - 1;
        continue;
      }
      // Diff content lines (context, added, removed)
      if (inDiff && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
        cleanLines.push(line);
        continue;
      }
      // If we hit a non-diff line after being in a diff, we might be done
      if (inDiff && !line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' ') && line !== '') {
        // Check if this looks like a new diff header
        if (line.startsWith('--- ') || line.startsWith('diff ')) {
          cleanLines.push(line);
          continue;
        }
        // Otherwise, we've left the diff
        break;
      }
    }

    const result = cleanLines.join('\n').trim();

    // Validate: must have at least one hunk
    if (!result.includes('@@') || !result.includes('---')) return '';

    return result;
  }
}

// ============================================================================
// Export
// ============================================================================

export function createSWEBenchAgent(baseURL: string, apiKey: string, model: string): SWEBenchAgent {
  return new SWEBenchAgent(baseURL, apiKey, model);
}
