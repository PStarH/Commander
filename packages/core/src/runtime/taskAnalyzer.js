"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectTaskType = detectTaskType;
exports.classifyProvisionIntent = classifyProvisionIntent;
const SCORED_PATTERNS = [
    {
        type: 'code',
        weight: 3,
        pattern: /\b(def|class|function|const|let|var|import|export)\s+\w+\s*\(/,
    },
    {
        type: 'code',
        weight: 2,
        pattern: /\b(python|javascript|typescript|bash|shell|sql)\s+(code|script)\b/i,
    },
    { type: 'code', weight: 2, pattern: /```[\s\S]*?```/ },
    {
        type: 'code',
        weight: 2,
        pattern: /\b(run|execute|compile|debug|fix|refactor)\b.*\b(code|script|function|module|bug|error)\b/i,
    },
    {
        type: 'code',
        weight: 1,
        pattern: /\b(generate|write|create|implement)\b.*\b(function|class|program|script|module)\b/i,
    },
    {
        type: 'structured',
        weight: 3,
        pattern: /\b(return|output)\b.{0,60}\b(as|in)\s+(json|structured|xml|yaml|table)\b/i,
    },
    {
        type: 'structured',
        weight: 2,
        pattern: /\b(json|csv|xml|yaml|tsv)\s+(format|output|response|schema)\b/i,
    },
    {
        type: 'structured',
        weight: 1,
        pattern: /\b(format|convert|transform)\s+(as|to|into)\s+(json|csv|xml|yaml)\b/i,
    },
    {
        type: 'search',
        weight: 3,
        pattern: /\b(search|look\s+up|find|retrieve|fetch|browse|scrape)\b.*\b(web|url|http|site|website|page|article)\b/i,
    },
    { type: 'search', weight: 3, pattern: /\bhttps?:\/\/\S+/i },
    {
        type: 'search',
        weight: 2,
        pattern: /\b(what\s+is|who\s+is|where\s+is|when\s+(was|did)|how\s+many)\b.+\?/i,
    },
    {
        type: 'search',
        weight: 2,
        pattern: /\b(population|capital|located|founded|invented|discovered|president|prime minister)\b/i,
    },
    {
        type: 'search',
        weight: 1,
        pattern: /\b(fact|data|information|details|news|latest|current|recent)\b/i,
    },
    {
        type: 'analysis',
        weight: 3,
        pattern: /\b(analyze|analyse|evaluate|assess|compare|contrast)\b/i,
    },
    {
        type: 'analysis',
        weight: 2,
        pattern: /\b(determine|identify|classify|categorize|diagnose)\b/i,
    },
    {
        type: 'analysis',
        weight: 1,
        pattern: /\b(pros\s+(and|&)\s+cons|advantage|disadvantage|cause|impact|effect)\b/i,
    },
    {
        type: 'code',
        weight: 2,
        pattern: /\b(calculate|compute|sum|total|average|percentage?|multiply|divide|subtract|add)\b/i,
    },
    {
        type: 'analysis',
        weight: 1,
        pattern: /\b(statistics|metrics|trends|correlation|distribution)\b/i,
    },
    { type: 'general', weight: 3, pattern: /\b(meaning of life|favorite|yourself|joke|poem)\b/i },
];
function detectTaskType(goal) {
    const g = goal.toLowerCase();
    const scores = {
        code: 0,
        search: 0,
        analysis: 0,
        structured: 0,
        general: 0,
    };
    let totalWeight = 0;
    for (const { type, weight, pattern } of SCORED_PATTERNS) {
        if (pattern.test(g)) {
            scores[type] += weight;
            totalWeight += weight;
        }
    }
    if (totalWeight === 0)
        return 'general';
    let bestType = 'general';
    let bestScore = 0;
    for (const [type, score] of Object.entries(scores)) {
        if (score > bestScore) {
            bestScore = score;
            bestType = type;
        }
    }
    return bestType;
}
// ============================================================================
// Provision intent classification (shared with provisionTools)
// ============================================================================
// ============================================================================
// Precompiled regex for classifyProvisionIntent (avoid per-call RegExp creation)
// ============================================================================
const RE_CALC_BASIC = /\b(calculate|compute|sum|total|average|percentage?|multiply|divide|subtract|add)\b/i;
const RE_CALC_UNITS = /\b(distance|area|volume|rate|speed|perimeter|probability)\b/i;
const RE_CALC_HOW = /how (many|much|far|long|tall|fast)\b/i;
const RE_CALC_EXPR = /\b\d+\s*[+\-*/.()]\s*\d+/;
const RE_SEARCH_ACTION = /\b(search|look\s+up|retrieve|fetch|browse|scrape)\b/i;
const RE_SEARCH_WHAT = /\b(what\s+is|who\s+is|where\s+is|when\s+(was|did)|which)\b/i;
const RE_SEARCH_FACTS = /\b(population|capital|located|founded|invented|discovered|latest|news|current)\b/i;
const RE_SEARCH_OPINION = /\b(you|your|meaning|opinion|think|believe|feel)\b/i;
const RE_FILE_ACTION = /\b(read|open|load|parse|analyze|examine)\b.*\b(file|data|csv|json|xml|txt|log|config)\b/i;
const RE_FILE_CONTENTS = /\b(contents? of|list|show me|display)\b.*\b(file|directory|folder|path)\b/i;
const RE_FILE_EXT = /\.\w{2,4}\b/;
const RE_FILE_KEYWORDS = /file|read|open|load/i;
const RE_CODE_ACTION = /\b(run|execute|test|debug)\b.*\b(code|script|program|function|module)\b/i;
const RE_CODE_BUILD = /\b(compile|build|deploy)\b/i;
const RE_CODESEARCH_MARKER = /(TODO|FIXME|HACK|XXX|comment)/i;
const RE_CODESEARCH_ACTION = /\b(find|search|locate|count|list)\b.*\b(comment|code|pattern|symbol|function|class|import)\b/i;
const RE_CODESEARCH_SPECIFIC = /\b(count|search|find)\b.*\b(TODO|FIXME|HACK)\b/i;
const RE_CODESEARCH_REPO = /\b(search|find|look for)\b.*\b(code|in code|in the code|repository)\b/i;
const RE_YOURSELF = /\b(yourself)\b/i;
const RE_QUESTION_END = /\?$/;
function classifyProvisionIntent(goal) {
    const lower = goal.toLowerCase();
    const scores = {
        calculation: 0,
        web_search: 0,
        file_read: 0,
        code_exec: 0,
        code_search: 0,
    };
    if (RE_CALC_BASIC.test(lower))
        scores.calculation += 3;
    if (RE_CALC_UNITS.test(lower))
        scores.calculation += 2;
    if (RE_CALC_HOW.test(lower))
        scores.calculation += 1;
    if (RE_CALC_EXPR.test(goal))
        scores.calculation += 3;
    if (RE_SEARCH_ACTION.test(lower))
        scores.web_search += 3;
    if (RE_SEARCH_WHAT.test(lower))
        scores.web_search += 2;
    if (RE_SEARCH_FACTS.test(lower))
        scores.web_search += 2;
    if (RE_QUESTION_END.test(goal.trim()) &&
        !scores.calculation &&
        !lower.includes('code') &&
        !RE_SEARCH_OPINION.test(lower))
        scores.web_search += 1;
    if (RE_FILE_ACTION.test(lower))
        scores.file_read += 3;
    if (RE_FILE_CONTENTS.test(lower))
        scores.file_read += 2;
    if (RE_FILE_EXT.test(goal) && RE_FILE_KEYWORDS.test(lower))
        scores.file_read += 2;
    if (RE_CODE_ACTION.test(lower))
        scores.code_exec += 3;
    if (RE_CODE_BUILD.test(lower))
        scores.code_exec += 2;
    if (RE_CODESEARCH_MARKER.test(lower))
        scores.code_search += 4;
    if (RE_CODESEARCH_ACTION.test(lower))
        scores.code_search += 3;
    if (RE_CODESEARCH_SPECIFIC.test(lower))
        scores.code_search += 4;
    if (RE_CODESEARCH_REPO.test(lower))
        scores.code_search += 3;
    if (RE_YOURSELF.test(lower)) {
        for (const key of Object.keys(scores)) {
            scores[key] = 0;
        }
    }
    let bestIntent = null;
    let bestScore = 0;
    for (const [intent, score] of Object.entries(scores)) {
        if (score > bestScore) {
            bestScore = score;
            bestIntent = intent;
        }
    }
    return { bestIntent: bestScore >= 3 ? bestIntent : null, scores };
}
