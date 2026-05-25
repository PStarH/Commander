/**
 * Unified Verification Pipeline (UVP)
 *
 * Tiered verification: zero-cost patterns first, LLM verification only when needed.
 *
 * Key improvements over naive verification:
 * - Context-aware error detection (avoids false positives on normal language)
 * - Task-type-aware verification strictness
 * - Actionable feedback with problem snippets so LLM fixes in one attempt
 * - Budget-gated LLM verification
 */

import type { LLMProvider } from './types';
import { HallucinationDetector } from '../hallucinationDetector';
import { getGlobalLogger } from '../logging';

interface SchemaProperty {
  required?: boolean;
  type?: string;
  description?: string;
}

interface SchemaDefinition {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

// ============================================================================
// Types
// ============================================================================

export type TaskType = 'code' | 'search' | 'analysis' | 'creative' | 'structured' | 'general';

export interface VerificationSignal {
  stage: 0 | 1 | 2;
  source: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  location?: string;
  snippet?: string;
  suggestion?: string;
}

export interface VerificationReport {
  passed: boolean;
  confidence: number;
  signals: VerificationSignal[];
  tokensUsed: number;
  stagesRun: number[];
  taskType: TaskType;
  skipped: boolean;
  skipReason?: string;
}

export interface UVPTaskContext {
  goal: string;
  output: string;
  language?: string;
  schema?: Record<string, unknown>;
  toolsUsed?: string[];
  tokenBudgetRemaining?: number;
  previousFailures?: string[];
}

export interface UVPConfig {
  enabled: boolean;
  confidenceSkipThreshold: number;
  budgetFloorTokens: number;
  llmVerificationBudget: number;
  llmVerificationModel?: string;
  enableLearning: boolean;
}

const DEFAULT_UVP_CONFIG: UVPConfig = {
  enabled: true,
  confidenceSkipThreshold: 0.85,
  budgetFloorTokens: 2000,
  llmVerificationBudget: 300,
  enableLearning: true,
};

// ============================================================================
// Task type detection
// ============================================================================

interface TypedPattern {
  type: TaskType;
  weight: number;
  pattern: RegExp;
}

const SCORED_PATTERNS: TypedPattern[] = [
  // Code (high weight — code blocks and language keywords are strong signal)
  { type: 'code', weight: 3, pattern: /\b(def|class|function|const|let|var|import|export)\s+\w+\s*\(/ },
  { type: 'code', weight: 2, pattern: /\b(python|javascript|typescript|bash|shell|sql)\s+(code|script)\b/i },
  { type: 'code', weight: 2, pattern: /```[\s\S]*?```/ },
  { type: 'code', weight: 2, pattern: /\b(run|execute|compile|debug|fix|refactor)\b.*\b(code|script|function|module|bug|error)\b/i },
  { type: 'code', weight: 1, pattern: /\b(generate|write|create|implement)\b.*\b(function|class|program|script|module)\b/i },

  // Structured output
  { type: 'structured', weight: 3, pattern: /\b(return|output)\b.{0,60}\b(as|in)\s+(json|structured|xml|yaml|table)\b/i },
  { type: 'structured', weight: 2, pattern: /\b(json|csv|xml|yaml|tsv)\s+(format|output|response|schema)\b/i },
  { type: 'structured', weight: 1, pattern: /\b(format|convert|transform)\s+(as|to|into)\s+(json|csv|xml|yaml)\b/i },

  // Search / fact retrieval
  { type: 'search', weight: 3, pattern: /\b(search|look\s+up|find|retrieve|fetch|browse|scrape)\b.*\b(web|url|http|site|website|page|article)\b/i },
  { type: 'search', weight: 3, pattern: /\bhttps?:\/\/\S+/i },
  { type: 'search', weight: 2, pattern: /\b(what\s+is|who\s+is|where\s+is|when\s+(was|did)|how\s+many)\b.+\?/i },
  { type: 'search', weight: 2, pattern: /\b(population|capital|located|founded|invented|discovered|president|prime minister)\b/i },
  { type: 'search', weight: 1, pattern: /\b(fact|data|information|details|news|latest|current|recent)\b/i },

  // Analysis
  { type: 'analysis', weight: 3, pattern: /\b(analyze|analyse|evaluate|assess|compare|contrast)\b/i },
  { type: 'analysis', weight: 2, pattern: /\b(determine|identify|classify|categorize|diagnose)\b/i },
  { type: 'analysis', weight: 1, pattern: /\b(pros\s+(and|&)\s+cons|advantage|disadvantage|cause|impact|effect)\b/i },

  // Calculation — must check before general since many calculation tasks have numbers
  { type: 'code', weight: 2, pattern: /\b(calculate|compute|sum|total|average|percentage?|multiply|divide|subtract|add)\b/i },
  { type: 'analysis', weight: 1, pattern: /\b(statistics|metrics|trends|correlation|distribution)\b/i },

  // Chit-chat / self-reference — offset broad question patterns (what is, who is) that would
  // otherwise misclassify philosophical/personal questions as 'search'
  { type: 'general', weight: 3, pattern: /\b(meaning of life|favorite|yourself|joke|poem)\b/i },
];

/**
 * Detect task type using scored pattern matching.
 * Each matched pattern contributes its weight to the associated type.
 * The type with the highest cumulative score wins.
 * This is more accurate than first-match-wins binary matching.
 */
export function detectTaskType(goal: string): TaskType {
  const g = goal.toLowerCase();
  const scores: Record<string, number> = { code: 0, search: 0, analysis: 0, structured: 0, general: 0 };
  let totalWeight = 0;

  for (const { type, weight, pattern } of SCORED_PATTERNS) {
    if (pattern.test(g)) {
      scores[type] += weight;
      totalWeight += weight;
    }
  }

  // If no patterns matched, return general
  if (totalWeight === 0) return 'general';

  // Find type with highest score
  let bestType: TaskType = 'general';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type as TaskType;
    }
  }

  return bestType;
}

// ============================================================================
// Provision intent classification (shared with provisionTools)
// ============================================================================

export interface ProvisionIntentScores {
  calculation: number;
  web_search: number;
  file_read: number;
  code_exec: number;
}

export function classifyProvisionIntent(goal: string): { bestIntent: keyof ProvisionIntentScores | null; scores: ProvisionIntentScores } {
  const lower = goal.toLowerCase();
  const scores: ProvisionIntentScores = { calculation: 0, web_search: 0, file_read: 0, code_exec: 0 };

  if (/\b(calculate|compute|sum|total|average|percentage?|multiply|divide|subtract|add|count)\b/i.test(lower)) scores.calculation += 3;
  if (/\b(distance|area|volume|rate|speed|perimeter|probability)\b/i.test(lower)) scores.calculation += 2;
  if (/how (many|much|far|long|tall|fast)\b/i.test(lower)) scores.calculation += 1;
  if (/\b\d+\s*[+\-*/.()]\s*\d+/.test(goal)) scores.calculation += 3;

  if (/\b(search|look\s+up|find|retrieve|fetch|browse|scrape)\b/i.test(lower)) scores.web_search += 3;
  if (/\b(what\s+is|who\s+is|where\s+is|when\s+(was|did)|which)\b/i.test(lower)) scores.web_search += 2;
  if (/\b(population|capital|located|founded|invented|discovered|latest|news|current)\b/i.test(lower)) scores.web_search += 2;
  if (/\?$/.test(goal.trim()) && !scores.calculation && !lower.includes('code') && !/\b(you|your|meaning|opinion|think|believe|feel)\b/i.test(lower)) scores.web_search += 1;

  if (/\b(read|open|load|parse|analyze|examine)\b.*\b(file|data|csv|json|xml|txt|log|config)\b/i.test(lower)) scores.file_read += 3;
  if (/\b(contents? of|list|show me|display)\b.*\b(file|directory|folder|path)\b/i.test(lower)) scores.file_read += 2;
  if (/\.\w{2,4}\b/.test(goal) && /file|read|open|load/i.test(lower)) scores.file_read += 2;

  if (/\b(run|execute|test|debug)\b.*\b(code|script|program|function|module)\b/i.test(lower)) scores.code_exec += 3;
  if (/\b(compile|build|deploy)\b/i.test(lower)) scores.code_exec += 2;

  // Chit-chat deprioritization: self-referential phrases like "find yourself"
  // shouldn't trigger provision tools even if individual keywords match
  if (/\b(yourself)\b/i.test(lower)) {
    for (const key of Object.keys(scores) as (keyof ProvisionIntentScores)[]) {
      scores[key] = 0;
    }
  }

  let bestIntent: keyof ProvisionIntentScores | null = null;
  let bestScore = 0;
  for (const [intent, score] of Object.entries(scores) as [keyof ProvisionIntentScores, number][]) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  return { bestIntent: bestScore >= 3 ? bestIntent : null, scores };
}

// ============================================================================
// Stage 0: Zero-cost pattern checks (context-aware)
// ============================================================================

// Hallucination patterns — these are reliable signals
const HALLUCINATION_PATTERNS = {
  overconfidence: [
    /\b(100% (certain|sure|confident|guaranteed))\b/i,
    /\b(without (a |any )?doubt)\b/i,
    /\b(guaranteed? to (be|work|succeed))\b/i,
    /[我确]定无疑/, /百分之百/,
  ],
  fabricatedRef: [
    /\b(?:a |the )?(?:recent |20\d{2} )?(?:study|research|paper)\s+(?:by|from|conducted by)\b/i,
    /\b(?:Dr\.|Professor)\s+[A-Z][a-z]+\s+(?:et al\.?|and (?:colleagues|team))?\s+(?:found|showed|discovered)\b/i,
    /\baccording\s+to\s+(?:a\s+)?(?:recent\s+)?(?:study|survey|report|analysis)\s+(?:by|from)\b/i,
  ],
  temporalIssue: [
    /\b(?:as of|since|until|after|in)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20[3-9]\d\b/i,
  ],
  numericAnomaly: [
    /\b\d{10,}\b/,
  ],
  // GAIA-specific: unrealistic population, area, or statistical values
  unrealisticFact: [
    /\b(population|area|distance|speed|weight|height)\s+(is|was|equals?|:)\s+\d{1,3}\b(?!\s*(million|billion|thousand|km|mi|kg|lb))/i,
    /\b\d+(?:\.\d+)?\s*(?:million|billion|trillion)\s+(?:people|dollars|users|population)\b(?!\s*(?:in|of|across|worldwide|global))/i,
  ],
};

// Error signals that indicate actual tool/execution errors, not normal language.
// These require prefix context to avoid false positives on sentences like
// "The function cannot handle this case" which is valid analysis.
const TOOL_ERROR_PATTERNS = [
  /(?:^|\n)\s*(?:error|Error|ERROR)\s*[:\-]/m,
  /(?:^|\n)\s*(?:Traceback|traceback)\s+(?:\(most recent|call)/m,
  /(?:^|\n)\s*(?:Exception|EXCEPTION)\s*[:\(]/m,
  /\btool_error\b/,
  /\bTOOL_TIMEOUT\b/,
  /\bTOOL_NOT_FOUND\b/,
  /\bExit code [1-9]\d*\b/,
  /\bcommand not found\b/i,
  /\bPermissionError\b/,
  /\bFileNotFoundError\b/,
  /\bModuleNotFoundError\b/,
  /\bSyntaxError\b/,
  /\bTypeError\b/,
  /\bNameError\b/,
  /\bKeyError\b/,
  /\bValueError\b/,
];

// Weak error signals — only flag if surrounded by tool-output context
const WEAK_ERROR_SIGNALS = [
  'failed', 'cannot', 'unable to', 'not found', 'timeout', 'denied',
];

function runStage0(ctx: UVPTaskContext, taskType: TaskType): { signals: VerificationSignal[]; confidence: number } {
  const signals: VerificationSignal[] = [];
  let confidence = 1.0;

  // --- Hallucination detection ---
  for (const [type, patterns] of Object.entries(HALLUCINATION_PATTERNS)) {
    for (const pattern of patterns) {
      const match = ctx.output.match(pattern);
      if (match) {
        const severity = type === 'fabricatedRef' || type === 'temporalIssue' || type === 'unrealisticFact' ? 'high' : 'medium';
        signals.push({
          stage: 0,
          source: `hallucination:${type}`,
          severity,
          message: `${type}: "${match[0]}"`,
          snippet: ctx.output.slice(Math.max(0, (match.index ?? 0) - 20), (match.index ?? 0) + match[0].length + 20),
          suggestion: type === 'overconfidence'
            ? 'Replace with hedged language: "I believe", "likely", "based on available information"'
            : type === 'fabricatedRef'
              ? 'Remove unverifiable reference or add actual citation'
              : 'Verify temporal/numeric claims against known facts',
        });
        confidence -= severity === 'high' ? 0.3 : 0.15;
        break;
      }
    }
  }

  // --- Advanced hallucination detection via standalone detector (richer signal analysis) ---
  try {
    const detector = new HallucinationDetector();
    const hReport = detector.analyze(ctx.goal, ctx.output);
    if (hReport.signals.length > 0) {
      for (const hs of hReport.signals) {
        const sev = hs.severity === 'high' ? 'high' as const : hs.severity === 'medium' ? 'medium' as const : 'low' as const;
        signals.push({
          stage: 0,
          source: `hallucination_detector:${hs.type}`,
          severity: sev,
          message: hs.evidence,
          snippet: ctx.output.slice(0, 100),
          suggestion: hs.suggestion,
        });
        confidence -= sev === 'high' ? 0.25 : sev === 'medium' ? 0.15 : 0.05;
      }
    }
    if (hReport.recommendation === 'reject') {
      confidence = Math.min(confidence, 0.15);
    } else if (hReport.recommendation === 'flag_for_review') {
      confidence = Math.min(confidence, 0.5);
    }
  } catch {
    getGlobalLogger().debug('UnifiedVerification', 'Hallucination detection failed');
  }

  // --- Tool error detection (context-aware) ---
  if (ctx.toolsUsed && ctx.toolsUsed.length > 0) {
    // Strong signals: patterns that are almost always real errors
    for (const pattern of TOOL_ERROR_PATTERNS) {
      const match = ctx.output.match(pattern);
      if (match) {
        const idx = match.index ?? 0;
        const snippet = ctx.output.slice(Math.max(0, idx - 10), idx + 80).replace(/\n/g, ' ').trim();
        signals.push({
          stage: 0,
          source: 'tool_error',
          severity: 'high',
          message: `Tool error detected: "${snippet}"`,
          snippet,
          suggestion: 'Fix the tool error before returning the result',
        });
        confidence -= 0.3;
        break;
      }
    }

    // Weak signals: only flag if in tool-output-like context (short lines, stack-trace style)
    if (signals.length === 0 || signals[signals.length - 1]?.source !== 'tool_error') {
      const lines = ctx.output.split('\n');
      for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        // Only flag weak signals in lines that look like tool output (short, no prose)
        if (trimmed.length < 120 && !trimmed.includes('.') && WEAK_ERROR_SIGNALS.some(s => trimmed.startsWith(s) || trimmed.includes(`: ${s}`))) {
          signals.push({
            stage: 0,
            source: 'tool_error_weak',
            severity: 'medium',
            message: `Possible tool error: "${line.trim().slice(0, 80)}"`,
            snippet: line.trim().slice(0, 100),
            suggestion: 'Verify this is not an unrecovered tool error',
          });
          confidence -= 0.1;
          break;
        }
      }
    }
  }

  // --- Syntax issues (code tasks only) ---
  if (taskType === 'code') {
    const codeBlockCount = (ctx.output.match(/```/g) ?? []).length;
    if (codeBlockCount > 0 && codeBlockCount % 2 !== 0) {
      signals.push({
        stage: 0,
        source: 'syntax',
        severity: 'medium',
        message: 'Unclosed code block (odd number of ``` markers)',
        suggestion: 'Add closing ``` delimiter',
      });
      confidence -= 0.2;
    }
    for (const q of ["'''", '"""']) {
      const count = (ctx.output.match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
      if (count % 2 !== 0) {
        signals.push({
          stage: 0,
          source: 'syntax',
          severity: 'medium',
          message: `Unclosed ${q} string delimiter`,
          suggestion: `Add closing ${q}`,
        });
        confidence -= 0.2;
      }
    }
  }

  // --- Numeric plausibility check (catch off-by-magnitude errors) ---
  if ((taskType === 'code' || taskType === 'analysis' || taskType === 'general') &&
      /\b(calculate|compute|sum|average|total|count|how many|percentage?|what is|find|determine)\b/i.test(ctx.goal) &&
      /^\s*-?\d+[.,]?\d*\s*$/.test(ctx.output.trim())) {
    // Extract numbers from the goal
    const goalNums = ctx.goal.match(/\b\d+[.,]?\d*\b/g)?.map(n => parseFloat(n.replace(',', ''))) || [];
    const outputNum = parseFloat(ctx.output.trim().replace(',', ''));
    if (goalNums.length > 0 && !isNaN(outputNum) && outputNum > 0) {
      // Check if output is an order of magnitude different from goal numbers
      for (const gn of goalNums) {
        if (gn > 0) {
          const ratio = outputNum / gn;
          if ((ratio > 0 && ratio < 0.1) || ratio > 10) {
            signals.push({
              stage: 0,
              source: 'numeric_anomaly',
              severity: 'high',
              message: `Numeric result (${outputNum}) differs from input (${gn}) by ${ratio.toFixed(1)}x — potential calculation error`,
              snippet: ctx.output.trim(),
              suggestion: 'Verify calculation: result should be proportional to inputs',
            });
            confidence -= 0.3;
            break;
          }
        }
      }
    }
  }

  // --- Relevance check (task-type-aware) ---
  const goalWords = ctx.goal.split(/\s+/).length;
  const outputWords = ctx.output.split(/\s+/).length;
  // Different multipliers per task type
  const maxMultiplier: Record<TaskType, number> = {
    code: 15,       // Code + explanation can be legitimately long
    analysis: 10,   // Analysis requires detail
    search: 6,      // Search results are usually concise
    creative: 20,   // Creative output can be long
    structured: 5,  // Structured output is usually compact
    general: 8,
  };
  const mult = maxMultiplier[taskType] ?? 8;
  if (outputWords > goalWords * mult && goalWords > 10 && !ctx.goal.includes('?')) {
    signals.push({
      stage: 0,
      source: 'relevance',
      severity: 'low',
      message: `Output (${outputWords} words) is ${Math.round(outputWords / Math.max(goalWords, 1))}x longer than goal (${goalWords} words)`,
      suggestion: 'Verify expanded content is grounded in the goal',
    });
    confidence -= 0.05; // Lower penalty — long output is often legitimate
  }

  return { signals, confidence: Math.max(0, confidence) };
}

// ============================================================================
// Stage 1: Schema validation (zero-cost)
// ============================================================================

function runStage1(ctx: UVPTaskContext): { signals: VerificationSignal[]; confidence: number } {
  if (!ctx.schema) return { signals: [], confidence: 1.0 };

  const signals: VerificationSignal[] = [];
  let confidence = 1.0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.output);
  } catch {
    getGlobalLogger().debug('UnifiedVerification', 'JSON parse failed in stage 1');
    // Try to extract JSON from markdown code blocks
    const jsonMatch = ctx.output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1].trim());
      } catch {
        getGlobalLogger().debug('UnifiedVerification', 'JSON parse failed for extracted code block');
        // Fall through
      }
    }
    if (!parsed) {
      signals.push({
        stage: 1,
        source: 'schema',
        severity: 'high',
        message: 'Output is not valid JSON',
        snippet: ctx.output.slice(0, 100),
        suggestion: 'Return valid JSON (not markdown-wrapped)',
      });
      return { signals, confidence: 0.1 };
    }
  }

  const schema = ctx.schema as SchemaDefinition;
  if (!schema.properties) return { signals, confidence: 1.0 };

  const obj = parsed as Record<string, unknown>;
  for (const [key, def] of Object.entries(schema.properties)) {
    const defObj = def as Record<string, unknown>;
    if (defObj.required && obj[key] === undefined) {
      signals.push({
        stage: 1,
        source: 'schema',
        severity: 'high',
        location: key,
        message: `Missing required field: "${key}"`,
        suggestion: `Add "${key}" to the output`,
      });
      confidence -= 0.3;
    }
    if (obj[key] !== undefined && defObj.type) {
      const typeMap: Record<string, string> = {
        string: 'string', number: 'number', integer: 'number',
        boolean: 'boolean', array: 'object', object: 'object',
      };
      const expected = typeMap[defObj.type as string];
      if (expected && typeof obj[key] !== expected) {
        signals.push({
          stage: 1,
          source: 'schema',
          severity: 'medium',
          location: key,
          message: `"${key}": expected ${defObj.type}, got ${typeof obj[key]}`,
          suggestion: `Change "${key}" to type ${defObj.type}`,
        });
        confidence -= 0.15;
      }
    }
  }

  return { signals, confidence: Math.max(0, confidence) };
}

// ============================================================================
// Stage 2: LLM-based verification (budget-aware, context-rich)
// ============================================================================

async function runStage2(
  ctx: UVPTaskContext,
  taskType: TaskType,
  provider: LLMProvider,
  model: string,
  tokenBudget: number,
  existingSignals: VerificationSignal[],
): Promise<{ signals: VerificationSignal[]; confidence: number; tokensUsed: number }> {
  if (tokenBudget < 100) {
    return { signals: [], confidence: 0.5, tokensUsed: 0 };
  }

  const signals: VerificationSignal[] = [];

  // Build context-rich verification prompt
  // Include goal, output snippet, task type, and any existing signals
  const outputSnippet = ctx.output.length > 600
    ? ctx.output.slice(0, 300) + '\n...\n' + ctx.output.slice(-300)
    : ctx.output;

  const existingIssues = existingSignals.length > 0
    ? `\nKnown issues: ${existingSignals.map(s => s.message).join('; ')}`
    : '';

  const taskHint = taskType === 'code'
    ? 'Check: does the code compile? Are there logic errors? Does it solve the goal?'
    : taskType === 'structured'
      ? 'Check: is the output valid and complete per the schema?'
      : taskType === 'analysis'
        ? 'Check: are claims supported? Is reasoning sound?'
        : 'Check: does the output satisfy the goal?';

  const prompt = [
    `Task type: ${taskType}`,
    `Goal: ${ctx.goal.slice(0, 200)}`,
    `Output:\n${outputSnippet.slice(0, 500)}`,
    existingIssues,
    taskHint,
    `Reply JSON: {"pass":bool,"fix":"specific fix instruction or empty"}`,
  ].filter(Boolean).join('\n');

  try {
    const resp = await provider.call({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: Math.min(tokenBudget, 200),
      temperature: 0,
    });

    const tokensUsed = resp.usage?.totalTokens ?? 0;

    const jsonMatch = resp.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      if (result.pass === false) {
        signals.push({
          stage: 2,
          source: 'llm_verify',
          severity: 'high',
          message: result.fix || 'Output does not satisfy the goal',
          suggestion: result.fix || 'Revise the output to match the goal',
        });
      }
      const confidence = result.pass ? 0.9 : 0.3;
      return { signals, confidence, tokensUsed };
    }
  } catch {
    getGlobalLogger().debug('UnifiedVerification', 'LLM verification failed');
    // LLM verification failure is non-fatal
  }

  return { signals, confidence: 0.5, tokensUsed: 0 };
}

// ============================================================================
// Verification History (learning with time decay)
// ============================================================================

interface VerificationOutcome {
  outputPrefix: string;
  signalsCaught: number;
  wasRealIssue: boolean;
  strategy: string;
  timestamp: number;
}

class VerificationMemory {
  private outcomes: VerificationOutcome[] = [];
  private readonly maxSize = 300;
  private readonly decayHalfLifeMs = 30 * 60 * 1000; // 30 minutes

  record(outcome: VerificationOutcome): void {
    this.outcomes.push(outcome);
    if (this.outcomes.length > this.maxSize) {
      this.outcomes = this.outcomes.slice(-this.maxSize);
    }
  }

  /** Weighted precision: recent outcomes count more. */
  strategyPrecision(strategy: string): number {
    const relevant = this.outcomes.filter(o => o.strategy === strategy);
    if (relevant.length < 5) return 0.5;
    const now = Date.now();
    let weightedReal = 0;
    let totalWeight = 0;
    for (const o of relevant) {
      const age = now - o.timestamp;
      const weight = Math.exp(-age / this.decayHalfLifeMs);
      totalWeight += weight;
      if (o.wasRealIssue) weightedReal += weight;
    }
    return totalWeight > 0 ? weightedReal / totalWeight : 0.5;
  }

  shouldRunLLMVerification(outputPrefix: string): boolean {
    const similar = this.outcomes.filter(o =>
      o.strategy === 'llm_verify' && o.outputPrefix === outputPrefix.slice(0, 40),
    );
    if (similar.length < 3) return true;
    return similar.some(o => o.wasRealIssue);
  }
}

// ============================================================================
// Unified Verification Pipeline
// ============================================================================

export class UnifiedVerificationPipeline {
  private config: UVPConfig;
  private provider?: LLMProvider;
  private memory: VerificationMemory;
  private totalTokensUsed = 0;

  constructor(config?: Partial<UVPConfig>, provider?: LLMProvider) {
    this.config = { ...DEFAULT_UVP_CONFIG, ...config };
    this.provider = provider;
    this.memory = new VerificationMemory();
  }

  async verify(ctx: UVPTaskContext): Promise<VerificationReport> {
    if (!this.config.enabled) {
      return {
        passed: true, confidence: 1.0, signals: [],
        tokensUsed: 0, stagesRun: [], taskType: 'general',
        skipped: true, skipReason: 'disabled',
      };
    }

    const taskType = detectTaskType(ctx.goal);
    const allSignals: VerificationSignal[] = [];
    const stagesRun: number[] = [];
    let tokensUsed = 0;
    let overallConfidence = 1.0;

    // Stage 0: Zero-cost pattern checks
    const s0 = runStage0(ctx, taskType);
    allSignals.push(...s0.signals);
    overallConfidence = Math.min(overallConfidence, s0.confidence);
    stagesRun.push(0);

    // Early exit on critical signals
    if (s0.signals.some(s => s.severity === 'critical')) {
      return this.buildReport(false, 0.1, allSignals, tokensUsed, stagesRun, taskType);
    }

    // Stage 1: Schema validation (always run when schema provided — zero cost, high value)
    if (ctx.schema) {
      const s1 = runStage1(ctx);
      allSignals.push(...s1.signals);
      overallConfidence = Math.min(overallConfidence, s1.confidence);
      stagesRun.push(1);
    }

    // Task-aware confidence adjustment: calculation tasks need stricter verification
    let effectiveThreshold = this.config.confidenceSkipThreshold;
    if (taskType === 'code' || taskType === 'analysis') {
      effectiveThreshold = Math.min(effectiveThreshold, 0.7); // Stricter for code/analysis
    }

    // Confidence-based skip: if zero-cost stages give high confidence, skip LLM verification
    if (overallConfidence >= effectiveThreshold) {
      if (this.config.enableLearning) {
        this.memory.record({
          outputPrefix: ctx.output.slice(0, 40),
          signalsCaught: allSignals.length,
          wasRealIssue: false,
          strategy: 'confidence_skip',
          timestamp: Date.now(),
        });
      }
      return this.buildReport(true, overallConfidence, allSignals, tokensUsed, stagesRun, taskType, 'high_confidence');
    }

    // Budget check
    const budgetRemaining = ctx.tokenBudgetRemaining ?? Infinity;
    if (budgetRemaining < this.config.budgetFloorTokens) {
      return this.buildReport(
        overallConfidence >= 0.5, overallConfidence, allSignals, tokensUsed, stagesRun, taskType, 'budget_exhausted',
      );
    }

    // Stage 2: LLM verification (only when ambiguous)
    const shouldRunLLM = this.provider
      && overallConfidence < 0.7
      && overallConfidence >= 0.2
      && budgetRemaining >= this.config.budgetFloorTokens;

    if (shouldRunLLM) {
      if (this.config.enableLearning && !this.memory.shouldRunLLMVerification(ctx.output)) {
        stagesRun.push(2);
        return this.buildReport(overallConfidence >= 0.5, overallConfidence, allSignals, tokensUsed, stagesRun, taskType, 'learning_skip');
      }

      const model = this.config.llmVerificationModel ?? 'gpt-4o-mini';
      const s2 = await runStage2(
        ctx, taskType, this.provider!, model,
        Math.min(this.config.llmVerificationBudget, budgetRemaining),
        allSignals,
      );
      allSignals.push(...s2.signals);
      overallConfidence = Math.min(overallConfidence, s2.confidence);
      tokensUsed += s2.tokensUsed;
      this.totalTokensUsed += s2.tokensUsed;
      stagesRun.push(2);
    }

    const passed = overallConfidence >= 0.5 && !allSignals.some(s => s.severity === 'critical');

    if (this.config.enableLearning) {
      this.memory.record({
        outputPrefix: ctx.output.slice(0, 40),
        signalsCaught: allSignals.length,
        wasRealIssue: !passed,
        strategy: 'full_pipeline',
        timestamp: Date.now(),
      });
    }

    return this.buildReport(passed, overallConfidence, allSignals, tokensUsed, stagesRun, taskType);
  }

  /**
   * Convert verification report into actionable feedback.
   * Includes the problematic snippet so the LLM knows exactly what to fix.
   * When confidence is very low, includes ALL signals (not just top 3).
   */
  toFeedback(report: VerificationReport): string | null {
    if (report.passed || report.signals.length === 0) return null;

    const sorted = [...report.signals].sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a.severity] - order[b.severity];
    });

    // When confidence is dangerously low, include ALL non-low signals
    const maxSignals = report.confidence < 0.3 ? 10 : 3;
    const topIssues = sorted.filter(s => s.severity !== 'low').slice(0, maxSignals);
    if (topIssues.length === 0) return null;

    const lines = topIssues.map(s => {
      const snippet = s.snippet ? `\n  Problem: "${s.snippet.slice(0, 60)}"` : '';
      const fix = s.suggestion ? `\n  Fix: ${s.suggestion}` : '';
      return `• [${s.source}] ${s.message}${snippet}${fix}`;
    });

    // Add task-type-specific instruction
    const taskHint = report.taskType === 'code'
      ? 'Fix the issues and return corrected code.'
      : report.taskType === 'structured'
        ? 'Fix the issues and return valid structured output.'
        : 'Fix the issues and return corrected output.';

    return `${taskHint}\n${lines.join('\n')}`;
  }

  getTotalTokensUsed(): number {
    return this.totalTokensUsed;
  }

  private buildReport(
    passed: boolean,
    confidence: number,
    signals: VerificationSignal[],
    tokensUsed: number,
    stagesRun: number[],
    taskType: TaskType,
    skipReason?: string,
  ): VerificationReport {
    return {
      passed,
      confidence: Math.max(0, Math.min(1, confidence)),
      signals,
      tokensUsed,
      stagesRun,
      taskType,
      skipped: !!skipReason,
      skipReason,
    };
  }
}
