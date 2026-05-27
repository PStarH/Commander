import type { TaskType, ProvisionIntentScores } from './unifiedVerificationTypes';

// ============================================================================
// Task type detection via scored pattern matching
// ============================================================================

interface TypedPattern {
  type: TaskType;
  weight: number;
  pattern: RegExp;
}

const SCORED_PATTERNS: TypedPattern[] = [
  { type: 'code', weight: 3, pattern: /\b(def|class|function|const|let|var|import|export)\s+\w+\s*\(/ },
  { type: 'code', weight: 2, pattern: /\b(python|javascript|typescript|bash|shell|sql)\s+(code|script)\b/i },
  { type: 'code', weight: 2, pattern: /```[\s\S]*?```/ },
  { type: 'code', weight: 2, pattern: /\b(run|execute|compile|debug|fix|refactor)\b.*\b(code|script|function|module|bug|error)\b/i },
  { type: 'code', weight: 1, pattern: /\b(generate|write|create|implement)\b.*\b(function|class|program|script|module)\b/i },
  { type: 'structured', weight: 3, pattern: /\b(return|output)\b.{0,60}\b(as|in)\s+(json|structured|xml|yaml|table)\b/i },
  { type: 'structured', weight: 2, pattern: /\b(json|csv|xml|yaml|tsv)\s+(format|output|response|schema)\b/i },
  { type: 'structured', weight: 1, pattern: /\b(format|convert|transform)\s+(as|to|into)\s+(json|csv|xml|yaml)\b/i },
  { type: 'search', weight: 3, pattern: /\b(search|look\s+up|find|retrieve|fetch|browse|scrape)\b.*\b(web|url|http|site|website|page|article)\b/i },
  { type: 'search', weight: 3, pattern: /\bhttps?:\/\/\S+/i },
  { type: 'search', weight: 2, pattern: /\b(what\s+is|who\s+is|where\s+is|when\s+(was|did)|how\s+many)\b.+\?/i },
  { type: 'search', weight: 2, pattern: /\b(population|capital|located|founded|invented|discovered|president|prime minister)\b/i },
  { type: 'search', weight: 1, pattern: /\b(fact|data|information|details|news|latest|current|recent)\b/i },
  { type: 'analysis', weight: 3, pattern: /\b(analyze|analyse|evaluate|assess|compare|contrast)\b/i },
  { type: 'analysis', weight: 2, pattern: /\b(determine|identify|classify|categorize|diagnose)\b/i },
  { type: 'analysis', weight: 1, pattern: /\b(pros\s+(and|&)\s+cons|advantage|disadvantage|cause|impact|effect)\b/i },
  { type: 'code', weight: 2, pattern: /\b(calculate|compute|sum|total|average|percentage?|multiply|divide|subtract|add)\b/i },
  { type: 'analysis', weight: 1, pattern: /\b(statistics|metrics|trends|correlation|distribution)\b/i },
  { type: 'general', weight: 3, pattern: /\b(meaning of life|favorite|yourself|joke|poem)\b/i },
];

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

  if (totalWeight === 0) return 'general';

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

export function classifyProvisionIntent(goal: string): { bestIntent: keyof ProvisionIntentScores | null; scores: ProvisionIntentScores } {
  const lower = goal.toLowerCase();
  const scores: ProvisionIntentScores = { calculation: 0, web_search: 0, file_read: 0, code_exec: 0, code_search: 0 };

  if (/\b(calculate|compute|sum|total|average|percentage?|multiply|divide|subtract|add)\b/i.test(lower)) scores.calculation += 3;
  if (/\b(distance|area|volume|rate|speed|perimeter|probability)\b/i.test(lower)) scores.calculation += 2;
  if (/how (many|much|far|long|tall|fast)\b/i.test(lower)) scores.calculation += 1;
  if (/\b\d+\s*[+\-*/.()]\s*\d+/.test(goal)) scores.calculation += 3;

  if (/\b(search|look\s+up|retrieve|fetch|browse|scrape)\b/i.test(lower)) scores.web_search += 3;
  if (/\b(what\s+is|who\s+is|where\s+is|when\s+(was|did)|which)\b/i.test(lower)) scores.web_search += 2;
  if (/\b(population|capital|located|founded|invented|discovered|latest|news|current)\b/i.test(lower)) scores.web_search += 2;
  if (/\?$/.test(goal.trim()) && !scores.calculation && !lower.includes('code') && !/\b(you|your|meaning|opinion|think|believe|feel)\b/i.test(lower)) scores.web_search += 1;

  if (/\b(read|open|load|parse|analyze|examine)\b.*\b(file|data|csv|json|xml|txt|log|config)\b/i.test(lower)) scores.file_read += 3;
  if (/\b(contents? of|list|show me|display)\b.*\b(file|directory|folder|path)\b/i.test(lower)) scores.file_read += 2;
  if (/\.\w{2,4}\b/.test(goal) && /file|read|open|load/i.test(lower)) scores.file_read += 2;

  if (/\b(run|execute|test|debug)\b.*\b(code|script|program|function|module)\b/i.test(lower)) scores.code_exec += 3;
  if (/\b(compile|build|deploy)\b/i.test(lower)) scores.code_exec += 2;

  if (/(TODO|FIXME|HACK|XXX|comment)/i.test(lower)) scores.code_search += 4;
  if (/\b(find|search|locate|count|list)\b.*\b(comment|code|pattern|symbol|function|class|import)\b/i.test(lower)) scores.code_search += 3;
  if (/\b(count|search|find)\b.*\b(TODO|FIXME|HACK)\b/i.test(lower)) scores.code_search += 4;
  if (/\b(search|find|look for)\b.*\b(code|in code|in the code|repository)\b/i.test(lower)) scores.code_search += 3;

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
