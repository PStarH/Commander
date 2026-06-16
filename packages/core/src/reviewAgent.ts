/**
 * Review Agent — Codex / Claude Code-inspired structured code review.
 *
 * Analyzes git changes, spawns a review sub-agent, and returns structured
 * P0-P3 findings with confidence scores. Supports custom review guidelines
 * from AGENTS.md or CLI arguments, and JSON output for CI integration.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from './logging';

// ============================================================================
// Types
// ============================================================================

/**
 * Severity level for a review finding.
 * Mapping convention: P0=Critical, P1=High, P2=Medium, P3=Low.
 */
export type FindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export type ReviewScope = 'uncommitted' | 'branch' | 'commit';

export interface ReviewFinding {
  severity: FindingSeverity;
  title: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
  confidence: number; // 0.0 – 1.0
}

export interface ReviewReport {
  passed: boolean;
  summary: string;
  findings: ReviewFinding[];
  filesReviewed: number;
  linesAdded: number;
  linesRemoved: number;
  scope: ReviewScope;
  baseRef?: string;
  guidelinesUsed: string[];
  durationMs: number;
}

export interface ReviewConfig {
  baseRef?: string;
  commitSha?: string;
  guidelines?: string[];
  outputFormat?: 'text' | 'json';
  scope: ReviewScope;
}

// ============================================================================
// Constants
// ============================================================================

const SEVERITY_ORDER: FindingSeverity[] = ['P0', 'P1', 'P2', 'P3'];

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  P0: 'Critical',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

// ============================================================================
// Git helpers
// ============================================================================

interface GitDiff {
  files: string[];
  totalAdditions: number;
  totalDeletions: number;
  patch: string;
}

/**
 * Get git diff for the given scope.
 * Returns structured diff info including file list, line counts, and patch text.
 */
function getGitDiff(scope: ReviewScope, baseRef?: string, commitSha?: string): GitDiff {
  let diffRef: string;
  let nameRef: string;
  let statRef: string;

  switch (scope) {
    case 'uncommitted':
      diffRef = 'HEAD';
      nameRef = 'HEAD';
      statRef = 'HEAD';
      break;
    case 'branch': {
      const ref = baseRef ?? 'main';
      diffRef = `origin/${ref}...HEAD`;
      nameRef = `origin/${ref}...HEAD`;
      statRef = `origin/${ref}...HEAD`;
      break;
    }
    case 'commit': {
      const sha = commitSha ?? '';
      diffRef = `${sha}^..${sha}`;
      nameRef = `${sha}^..${sha}`;
      statRef = `${sha}^..${sha}`;
      break;
    }
    default:
      diffRef = 'HEAD';
      nameRef = 'HEAD';
      statRef = 'HEAD';
  }

  const patch = execFileSync('git', ['diff', diffRef, '--unified=5'], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });

  let files: string[];
  try {
    const filesOutput = execFileSync('git', ['diff', nameRef, '--name-only'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    files = filesOutput.split('\n').filter(Boolean);
  } catch (e) {
    // Git diff may fail if ref doesn't exist — fallback to empty
    files = [];
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  try {
    const stat = execFileSync('git', ['diff', statRef, '--shortstat'], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    const addMatch = stat.match(/(\d+) insertion/i);
    const delMatch = stat.match(/(\d+) deletion/i);
    totalAdditions = addMatch ? parseInt(addMatch[1], 10) : 0;
    totalDeletions = delMatch ? parseInt(delMatch[1], 10) : 0;
  } catch {
    // stat parse failure is non-fatal
  }

  return { files, totalAdditions, totalDeletions, patch };
}

// ============================================================================
// Finding parser — parse structured review output from LLM
// ============================================================================

/**
 * Parse structured findings from LLM review output.
 * Supports both markdown bullet format and JSON format.
 */
export function parseFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Try JSON array first
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item.title && item.severity) {
          findings.push({
            severity: normalizeSeverity(item.severity),
            title: item.title,
            message: item.message ?? '',
            file: item.file,
            line: item.line,
            suggestion: item.suggestion,
            confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
          });
        }
      }
      if (findings.length > 0) return findings;
    }
  } catch {
    // Not JSON — try markdown parsing
  }

  // Try JSON embedded in code fences
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.title && item.severity) {
            findings.push({
              severity: normalizeSeverity(item.severity),
              title: item.title,
              message: item.message ?? '',
              file: item.file,
              line: item.line,
              suggestion: item.suggestion,
              confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
            });
          }
        }
        if (findings.length > 0) return findings;
      }
    } catch {
      // fall through to markdown parsing
    }
  }

  // Markdown bullet format: **P1** Title — message
  const severityPattern = /\*{0,2}(P[0-3])\*{0,2}\**\s*(.+?)(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = severityPattern.exec(text)) !== null) {
    const severity = normalizeSeverity(match[1]);
    const title = match[2].replace(/[—–\-:].*$/, '').trim();
    const message = match[2].includes('—') || match[2].includes('–') || match[2].includes(':')
      ? match[2].replace(/^[^—–\-:]*[—–\-:]\s*/, '').trim()
      : match[2].trim();

    // Try to extract file reference
    const fileMatch = message.match(/`([^`]+)`/);
    const file = fileMatch ? fileMatch[1] : undefined;

    // Try to extract line number
    const lineMatch = message.match(/line[:\s]*(\d+)/i);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

    // Try to extract suggestion
    const suggestionMatch = text.match(new RegExp(
      `suggestion[:\s]*(.+?)(?=\n\\*{0,2}P[0-3]|\n##|\n$|$)`, 'si'
    ));

    findings.push({
      severity,
      title: title || 'Review finding',
      message,
      file,
      line,
      suggestion: suggestionMatch?.[1]?.trim(),
      confidence: 0.7,
    });
  }

  return findings;
}

function normalizeSeverity(s: string): FindingSeverity {
  const upper = s.toUpperCase().trim();
  if (upper === 'P0' || upper === 'CRITICAL' || upper === '0') return 'P0';
  if (upper === 'P1' || upper === 'HIGH' || upper === '1') return 'P1';
  if (upper === 'P2' || upper === 'MEDIUM' || upper === '2') return 'P2';
  if (upper === 'P3' || upper === 'LOW' || upper === '3') return 'P3';
  return 'P2';
}

// ============================================================================
// Core review logic
// ============================================================================

/**
 * Build a review prompt for the LLM sub-agent.
 */
function buildReviewPrompt(
  diff: GitDiff,
  guidelines: string[],
): string {
  const guidelineSection = guidelines.length > 0
    ? `\n## Review Guidelines\n${guidelines.map(g => `- ${g}`).join('\n')}`
    : '';

  return `You are a senior code reviewer. Review the following code changes and provide structured feedback.

## Task
Analyze the diff below and identify issues. For each finding, include:
- **Severity**: P0 (critical — must fix), P1 (high — should fix), P2 (medium — consider fixing), P3 (low — nice to have)
- **Title**: Short description
- **Message**: What the issue is and why it matters
- **File**: The file path if applicable
- **Line**: The line number if applicable
- **Suggestion**: How to fix it
- **Confidence**: 0.0–1.0

## Changes
${diff.files.length} files changed, ${diff.totalAdditions} insertions, ${diff.totalDeletions} deletions

### Diff
\`\`\`diff
${diff.patch.slice(0, 15000)}
\`\`\`

${guidelineSection}

## Output Format
Return your findings as a JSON array. Example:
[
  {
    "severity": "P1",
    "title": "Missing input validation",
    "message": "The new API endpoint does not validate user input, which could lead to injection attacks.",
    "file": "src/api/users.ts",
    "line": 42,
    "suggestion": "Add zod schema validation for the request body.",
    "confidence": 0.9
  }
]

If no issues found, return an empty array []. Do NOT include any other text outside the JSON array.`;
}

/**
 * Determine if the review passes based on findings.
 * Returns pass=true when there are no P0 findings.
 */
function computeReviewResult(findings: ReviewFinding[]): { passed: boolean; summary: string } {
  const p0Count = findings.filter(f => f.severity === 'P0').length;
  const p1Count = findings.filter(f => f.severity === 'P1').length;
  const p2Count = findings.filter(f => f.severity === 'P2').length;
  const p3Count = findings.filter(f => f.severity === 'P3').length;

  const passed = p0Count === 0;

  let summary: string;
  if (findings.length === 0) {
    summary = 'No issues found — changes look clean.';
  } else if (passed) {
    summary = `Found ${findings.length} issue(s) (P1: ${p1Count}, P2: ${p2Count}, P3: ${p3Count}). No critical issues.`;
  } else {
    summary = `Found ${findings.length} issue(s) (P0: ${p0Count}, P1: ${p1Count}, P2: ${p2Count}, P3: ${p3Count}). ${p0Count} critical issue(s) must be fixed.`;
  }

  return { passed, summary };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Execute a code review on the current repository's changes.
 *
 * @param config  Review configuration (scope, baseRef, guidelines, etc.)
 * @returns       A ReviewReport with all findings and metadata.
 */
export async function executeReview(config: ReviewConfig): Promise<ReviewReport> {
  const startTime = Date.now();

  getGlobalLogger().info('ReviewAgent', 'Starting review', { scope: config.scope, baseRef: config.baseRef });

  // 1. Get git diff
  const diff = getGitDiff(config.scope, config.baseRef, config.commitSha);

  if (diff.files.length === 0) {
    return {
      passed: true,
      summary: 'No changes to review.',
      findings: [],
      filesReviewed: 0,
      linesAdded: 0,
      linesRemoved: 0,
      scope: config.scope,
      baseRef: config.baseRef,
      guidelinesUsed: config.guidelines ?? [],
      durationMs: Date.now() - startTime,
    };
  }

  // 2. Build review prompt
  const guidelines = config.guidelines ?? [];
  const prompt = buildReviewPrompt(diff, guidelines);

  // 3. Call LLM for review
  getGlobalLogger().info('ReviewAgent', 'Reviewing changes', {
    files: diff.files.length,
    additions: diff.totalAdditions,
    deletions: diff.totalDeletions,
  });

  // Use the configured provider to run the review
  const llmResult = await callLLMForReview(prompt);

  // 4. Parse findings
  const findings = parseFindings(llmResult);

  // 5. Compute result
  const { passed, summary } = computeReviewResult(findings);

  const report: ReviewReport = {
    passed,
    summary,
    findings: findings.sort((a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    ),
    filesReviewed: diff.files.length,
    linesAdded: diff.totalAdditions,
    linesRemoved: diff.totalDeletions,
    scope: config.scope,
    baseRef: config.baseRef,
    guidelinesUsed: guidelines,
    durationMs: Date.now() - startTime,
  };

  getGlobalLogger().info('ReviewAgent', 'Review complete', {
    passed: report.passed,
    findings: report.findings.length,
    durationMs: report.durationMs,
  });

  return report;
}

/**
 * Call the LLM for code review by directly invoking the provider.
 * Falls back to heuristic review when no provider is configured.
 * Plan and read-only approval modes skip LLM calls.
 */
async function callLLMForReview(prompt: string): Promise<string> {
  try {
    const { getApprovalSystem } = await import('./sandbox/approval');
    const approvalMode = getApprovalSystem().getMode();
    if (approvalMode === 'plan' || approvalMode === 'read-only') {
      getGlobalLogger().info('ReviewAgent', `Approval mode ${approvalMode}: using heuristic review`);
      return fallbackReview(prompt);
    }

    const { detectProvider } = await import('./config/commanderConfig');
    const providerInfo = detectProvider();
    if (!providerInfo) return fallbackReview(prompt);

    const llmRequest = {
      model: providerInfo.defaultModel,
      messages: [
        { role: 'system' as const, content: 'You are a senior code reviewer. Return ONLY a JSON array of findings, no other text.' },
        { role: 'user' as const, content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 4000,
    };

    // Call the appropriate provider
    if (providerInfo.apiType === 'anthropic') {
      const { AnthropicProvider } = await import('./runtime/providers/anthropicProvider');
      const provider = new AnthropicProvider({ apiKey: providerInfo.apiKey });
      const response = await provider.call(llmRequest);
      return response.content ?? '[]';
    } else {
      const { OpenAIProvider } = await import('./runtime/providers/openaiProvider');
      const provider = new OpenAIProvider({
        apiKey: providerInfo.apiKey,
        baseUrl: providerInfo.baseUrl,
      });
      const response = await provider.call(llmRequest);
      return response.content ?? '[]';
    }
  } catch (err) {
    getGlobalLogger().warn('ReviewAgent', 'LLM review failed, using fallback', {
      error: (err as Error)?.message,
    });
    return fallbackReview(prompt);
  }
}

/**
 * Simple heuristic-based fallback review when no LLM is available.
 * Catches common issues without requiring an API call.
 */
function fallbackReview(patch: string): string {
  const findings: ReviewFinding[] = [];

  // Check for console.log / debugger statements
  const consoleLogRegex = /^\+.*console\.(log|debug|trace)\(/gm;
  let match: RegExpExecArray | null;
  while ((match = consoleLogRegex.exec(patch)) !== null) {
    const lineNum = patch.slice(0, match.index).split('\n').length;
    findings.push({
      severity: 'P2',
      title: 'Debug logging left in code',
      message: `Console.${match[1]}() statement found. Remove before shipping.`,
      line: lineNum,
      suggestion: `Remove console.${match[1]}() or replace with a proper logger.`,
      confidence: 0.9,
    });
  }

  // Check for TODO/FIXME comments in added lines
  const todoRegex = /^\+.*\b(TODO|FIXME|HACK|XXX)\b/gi;
  while ((match = todoRegex.exec(patch)) !== null) {
    const lineNum = patch.slice(0, match.index).split('\n').length;
    findings.push({
      severity: 'P2',
      title: `${match[1]} marker found`,
      message: `A ${match[1]} comment was found in the added code.`,
      line: lineNum,
      suggestion: match[1] === 'FIXME'
        ? 'Address the issue before merging.'
        : 'Create a tracking task and link it in the comment.',
      confidence: 0.8,
    });
  }

  // Check for hardcoded secrets/tokens
  const secretRegex = /^\+.*['"](?:api_?key|secret|token|password|credential)['"]\s*[:=]\s*['"][^'"]+['"]/gi;
  while ((match = secretRegex.exec(patch)) !== null) {
    const lineNum = patch.slice(0, match.index).split('\n').length;
    findings.push({
      severity: 'P0',
      title: 'Hardcoded secret detected',
      message: 'A credential, API key, or token appears to be hardcoded.',
      line: lineNum,
      suggestion: 'Use environment variables or a secrets manager instead.',
      confidence: 0.95,
    });
  }

  // Check for large file changes
  const lines = patch.split('\n');
  const addedLines = lines.filter(l => l.startsWith('+')).length;
  if (addedLines > 500) {
    findings.push({
      severity: 'P2',
      title: 'Large change set',
      message: `This diff adds ${addedLines} lines. Consider splitting into smaller, focused commits.`,
      suggestion: 'Break the change into logical, reviewable chunks.',
      confidence: 0.7,
    });
  }

  return JSON.stringify(findings, null, 2);
}

// ============================================================================
// Output formatting
// ============================================================================

/**
 * Format a review report for human-readable CLI output.
 */
export function formatReviewOutput(report: ReviewReport): string {
  const lines: string[] = [];

  // Header
  const statusIcon = report.passed ? '✅' : '❌';
  lines.push('');
  lines.push(`${statusIcon}  Review ${report.passed ? 'PASSED' : 'FAILED'}`);
  lines.push('');
  lines.push(`  ${report.summary}`);
  lines.push(`  ${report.filesReviewed} file(s) · +${report.linesAdded}/-${report.linesRemoved} lines · ${report.durationMs}ms`);
  lines.push('');

  // Findings
  if (report.findings.length > 0) {
    lines.push('  Findings:');
    lines.push('');
    for (const f of report.findings) {
      const severityColors: Record<string, string> = {
        P0: '\x1b[31m', // red
        P1: '\x1b[33m', // yellow
        P2: '\x1b[34m', // blue
        P3: '\x1b[90m', // gray
      };
      const reset = '\x1b[0m';
      const bold = '\x1b[1m';
      const color = severityColors[f.severity] ?? '\x1b[37m';
      const confPct = Math.round(f.confidence * 100);

      lines.push(`  ${color}${bold}[${f.severity}]${reset} ${f.title} ${color}(${confPct}% confidence)${reset}`);
      lines.push(`         ${f.message}`);
      if (f.file) lines.push(`         ${'\x1b[90m'}File: ${f.file}${f.line ? `:${f.line}` : ''}${reset}`);
      if (f.suggestion) lines.push(`         ${'\x1b[2m'}Fix: ${f.suggestion}${reset}`);
      lines.push('');
    }
  }

  if (report.guidelinesUsed.length > 0) {
    lines.push(`  ${'\x1b[90m'}Guidelines used:${'\x1b[0m'}`);
    for (const g of report.guidelinesUsed) {
      lines.push(`    • ${g}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Serialize a review report to JSON.
 */
export function reviewReportToJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Load review guidelines from AGENTS.md or .review.md files.
 */
export function loadReviewGuidelines(): string[] {
  const guidelines: string[] = [];
  const candidates = [
    'AGENTS.md',
    '.review.md',
    'REVIEW.md',
    '.github/review.md',
    '.commander/review.md',
  ];

  for (const file of candidates) {
    try {
      const fullPath = path.join(process.cwd(), file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        // Extract bullet points as guidelines
        const bullets = content.match(/^\s*[-*]\s+(.+)$/gm);
        if (bullets) {
          for (const b of bullets) {
            guidelines.push(b.replace(/^\s*[-*]\s+/, '').trim());
          }
        }
        // Also look for ## Review Guidelines section
        const sectionMatch = content.match(/## Review Guidelines\s*\n([\s\S]*?)(?=\n## |$)/);
        if (sectionMatch) {
          const sectionBullets = sectionMatch[1].match(/^\s*[-*]\s+(.+)$/gm);
          if (sectionBullets) {
            for (const b of sectionBullets) {
              guidelines.push(b.replace(/^\s*[-*]\s+/, '').trim());
            }
          }
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return [...new Set(guidelines)]; // deduplicate
}
