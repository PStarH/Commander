"use strict";
/**
 * Hallucination Detector v2
 *
 * Multi-signal hallucination detection for LLM outputs.
 * Uses pattern analysis, confidence calibration, consistency checking,
 * and SelfCheckGPT-style multi-sample verification.
 *
 * Zero-cost first pass + optional multi-sample verification pass.
 *
 * Based on research:
 * - "A Survey on Hallucination in Large Language Models" (Huang et al., 2023)
 * - "SelfCheckGPT: Zero-Resource Black-Box Hallucination Detection" (Manakul et al., 2023)
 * - "FActScore: Fine-grained Atomic Evaluation of Factual Precision" (Min et al., 2023)
 * - "Chain-of-Verification Reduces Hallucination in LLMs" (Dhuliawala et al., 2023)
 * - Vectara HHEM (Hughes Hallucination Evaluation Model) methodology
 * - "Language Models Don't Always Say What They Think" (Turpin et al., 2023)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HallucinationDetector = void 0;
exports.getHallucinationDetector = getHallucinationDetector;
exports.resetHallucinationDetector = resetHallucinationDetector;
// ============================================================================
// Pattern Definitions
// ============================================================================
/** Self-contradiction markers — pairs of affirmative + negated claims */
const CONTRADICTION_PATTERNS = [
    /\b(?:however|but|yet|although|nevertheless)\b.*\b(?:on the other hand|conversely|in contrast)\b/i,
    /\b(?:always|never|all|none|every|no)\b.{0,60}?\b(?:sometimes|occasionally|some|few|rarely)\b/is,
    /\b(?:increases?|grows?|rises?|improves?)\b.{0,60}?\b(?:decreases?|shrinks?|falls?|declines?|worsens?)\b/is,
];
/** Confidence inconsistency — claims certitude while expressing uncertainty */
const CONFIDENCE_CONSISTENCY = [
    /\b(?:i('m| am) (?:absolutely |completely )?(?:certain|sure|confident)\b.{0,100}?\b(?:i('m| am) not sure|i('m| am) uncertain|i don't know|it's unclear)\b)/is,
    /\b(?:it is (?:clearly|definitely|undoubtedly)\b.{0,100}?\b(?:might be|could be|perhaps|maybe)\b)/is,
];
/** Overconfidence markers (multilingual) — refined to reduce false positives */
const OVERCONFIDENCE_PATTERNS = [
    // English — strong markers only
    /\b(100% (certain|sure|confident|guaranteed))\b/i,
    /\b(without (a |any )?doubt)\b/i,
    /\b(no doubt)\b/i,
    /\b(guaranteed? to (be|work|succeed))\b/i,
    /\b(there is no (way|chance|possibility) (that )?(this|it) (is|could|would) (wrong|false|incorrect))\b/i,
    // Chinese — strong markers
    /百分之百/,
    /绝对(?:正确|没错|不会错)/,
    /毫无疑问/,
    // Common LLM hallucination patterns
    /\b(as (an AI|a language model),? I (can|do) (confirm|verify|assure))\b/i,
    /\b(I can (guarantee|promise|assure) (you )?(that )?)\b/i,
    /\b(I know for a fact\b)/i,
    /\b(undeniably|irrefutably|incontestably)\b/i,
];
/** Overconfidence patterns that need context (higher false positive rate) */
const OVERCONFIDENCE_CONTEXTUAL_PATTERNS = [
    /\b(I('m| am) (absolutely |completely )?(certain|sure|confident))\b/i,
    /\b(this (is|will) definitely)\b/i,
    /\b(it is (in)?disputably\b)/i,
    /\b(this (is|has) been (widely |conclusively )?(proven|established|verified))\b/i,
    // Chinese contextual
    /[我确]定/,
    /(?:一定|肯定)(?:是|会|能)/,
];
/** Unsupported specificity — very precise claims without hedging */
const SPECIFICITY_PATTERNS = [
    // Exact dates/numbers without source
    /(?:on |dated? )\d{4}[-\/]\d{2}[-\/]\d{2}/,
    // Specific statistics without attribution
    /\b\d+(\.\d+)?%\s+(of|increase|decrease|growth|reduction)\b/i,
    // Named studies without citation
    /(?:according to|published in|study (by|from|in))\s+(?:the\s+)?[A-Z][a-z]+/g,
    // Numerical ranges that look fabricated (e.g., "between 42-47%")
    /\b(between\s+\d+\.?\d*\s*[-–]\s*\d+\.?\d*\s*(%|million|billion|thousand))\b/i,
    // Suspiciously round numbers in specific claims
    /\b(exactly\s+\d{4,}\b)/i,
];
/** Fabricated reference patterns */
const FABRICATED_REF_PATTERNS = [
    /\b(?:a |the )?(?:recent |20\d{2} )?(?:study|research|paper|report|survey)\s+(?:by|from|conducted by|published in)\s+\S+/i,
    /\b(?:Dr\.|Professor|Prof\.)\s+[A-Z][a-z]+\s+(?:et al\.?|and (?:colleagues|team|researchers))?\s+(?:found|showed|discovered|demonstrated|proved)\b/i,
    // Vague attribution without specifics
    /\b(studies show|research indicates|experts say|scientists believe|it is widely known)\b/i,
    // Hallucinated URLs (but not markdown links)
    /\bhttps?:\/\/(?:www\.)?[a-zA-Z0-9-]+\.(?:com|org|net)\/[^\s]{10,}\b(?![^<]*>)/gi,
    // Specific-looking paper titles (quoted, 5+ words)
    /["""](?:[A-Z][a-z]+ ){5,}["""]/g,
];
/** Well-known journal names that might be real citations */
const KNOWN_JOURNALS = new Set([
    'nature',
    'science',
    'lancet',
    'nejm',
    'ieee',
    'acm',
    'pnas',
    'cell',
    'jama',
    'bmj',
    'plos',
    'arxiv',
    'biorxiv',
]);
/** Temporal markers that might be impossible */
const TEMPORAL_PATTERNS = [
    /\b(?:as of|since|until|after|in)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/i,
    // Vague relative time references
    /\b(in recent (years|months|decades))\b/i,
    /\b(over the past (few |couple of )?(years|months|decades))\b/i,
    /\b(recently,?\s+it (has been|was))\b/i,
];
/** Relative time references that are always risky for LLMs */
const RELATIVE_TIME_PATTERNS = [/\b(?:yesterday|last week|last month|earlier today)\b/i];
/** Hedging language that should NOT trigger specificity/overconfidence flags */
const HEDGING_LANGUAGE = [
    /\b(?:approximately|roughly|around|about|nearly|close to|of the order of)\b/i,
    /\b(?:I (?:believe|think|expect|estimate|understand))\b/i,
    /\b(?:likely|probably|possibly|potentially|apparently)\b/i,
    /\b(?:based on (?:my |available )?(?:understanding|knowledge|information))\b/i,
    /\b(?:if I(?:'m| am) not (?:wrong|mistaken))\b/i,
    /\b(?:to (?:my |the best of )?(?:knowledge|understanding))\b/i,
];
/** Known entity patterns — detect fabricated names/IDs */
const ENTITY_PATTERNS = {
    /** Function/method names that look fabricated */
    functionCall: /\b(?:use|call|invoke|run|execute)\s+`[a-zA-Z_][a-zA-Z0-9_.]*\(\)`/gi,
    /** Package/library names with version */
    packageVersion: /\b(?:install|use|import)\s+[a-zA-Z][a-zA-Z0-9_-]*@\d+\.\d+/gi,
    /** API endpoints */
    apiEndpoint: /\b(?:GET|POST|PUT|DELETE|PATCH)\s+\/[a-zA-Z0-9/_-]+/gi,
};
// ============================================================================
// Detector
// ============================================================================
class HallucinationDetector {
    constructor(options) {
        var _a;
        this.knowledgeCutOffDate = (_a = options === null || options === void 0 ? void 0 : options.knowledgeCutOffDate) !== null && _a !== void 0 ? _a : new Date('2026-01-01');
    }
    /**
     * Analyze an LLM output for hallucination signals.
     * Zero-cost first pass — no additional LLM calls.
     */
    analyze(input, output) {
        const signals = [];
        // Check if output contains hedging (reduces severity of other signals)
        const hasHedging = this.detectHedging(output);
        // 1. Overconfidence detection (with hedging awareness)
        signals.push(...this.detectOverconfidence(output, hasHedging));
        // 2. Unsupported specificity (with hedging awareness)
        signals.push(...this.detectUnsupportedSpecificity(output, hasHedging));
        // 3. Fabricated references (with journal awareness)
        signals.push(...this.detectFabricatedReferences(output));
        // 4. Temporal impossibility
        signals.push(...this.detectTemporalIssues(output));
        // 5. Input-output entailment check
        signals.push(...this.checkEntailment(input, output));
        // 6. Relevance check (output length vs input)
        signals.push(...this.checkRelevance(input, output));
        // 7. Numeric anomalies
        signals.push(...this.detectNumericAnomalies(output));
        // 7. Self-contradiction detection
        signals.push(...this.detectContradictions(output));
        // 8. Confidence inconsistency
        signals.push(...this.detectConfidenceInconsistency(output));
        // 9. Hedged-as-fact detection (new)
        signals.push(...this.detectHedgedAsFact(output));
        // 10. Entity hallucination detection (new)
        signals.push(...this.detectEntityHallucination(output));
        // Calculate risk score (weighted by severity)
        const severityWeights = { low: 0.08, medium: 0.25, high: 0.45 };
        const rawScore = signals.reduce((sum, s) => sum + severityWeights[s.severity], 0);
        const riskScore = Math.min(rawScore, 1.0);
        // Determine recommendation
        // A single high-severity signal (0.45) should flag for review;
        // multiple signals or a high+medium should reject
        let recommendation;
        const hasHighSeverity = signals.some((s) => s.severity === 'high');
        if (riskScore >= 0.5 || (hasHighSeverity && riskScore >= 0.4))
            recommendation = 'reject';
        else if (riskScore >= 0.2)
            recommendation = 'flag_for_review';
        else
            recommendation = 'pass';
        return {
            riskScore,
            signals,
            summary: this.buildSummary(signals, riskScore),
            recommendation,
        };
    }
    /**
     * Multi-sample consistency check (SelfCheckGPT-style).
     * Takes multiple sampled outputs and checks sentence-level consistency.
     * This is the "second pass" that requires multiple LLM outputs.
     */
    analyzeMultiSample(originalOutput, sampledOutputs) {
        const sentences = this.splitSentences(originalOutput);
        if (sentences.length === 0) {
            return { sentences: [], consistencyScores: [], flaggedSentences: [], riskScore: 0 };
        }
        const consistencyScores = [];
        const flaggedSentences = [];
        for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            let supportCount = 0;
            for (const sample of sampledOutputs) {
                if (this.isSentenceSupported(sentence, sample)) {
                    supportCount++;
                }
            }
            const score = sampledOutputs.length > 0 ? supportCount / sampledOutputs.length : 1;
            consistencyScores.push(score);
            if (score < 0.5) {
                flaggedSentences.push({ sentence, score, index: i });
            }
        }
        // Risk score = fraction of flagged sentences, weighted by how inconsistent they are
        const avgScore = consistencyScores.length > 0
            ? consistencyScores.reduce((a, b) => a + b, 0) / consistencyScores.length
            : 1;
        const riskScore = 1 - avgScore;
        return { sentences, consistencyScores, flaggedSentences, riskScore };
    }
    /**
     * Decompose output into atomic claims for fine-grained checking.
     * Based on FActScore methodology.
     */
    decomposeClaims(output) {
        const claims = [];
        const sentences = this.splitSentences(output);
        for (const sentence of sentences) {
            // Split compound sentences on conjunctions
            const parts = sentence
                .split(/\s+(?:,\s*and\s+|\s+and\s+(?:it|the|this|that|these|those|its|their|a|an)\s+|,\s*but\s+|\s+but\s+|\s+while\s+|\s+whereas\s+)/i)
                .flatMap((p) => p.split(/\s+and\s+(?=[a-z])/i));
            for (const part of parts) {
                const trimmed = part.trim();
                if (trimmed.length > 10 && this.isClaimSentence(trimmed)) {
                    claims.push(trimmed);
                }
            }
        }
        return claims;
    }
    // ---------------------------------------------------------------------------
    // Detection Methods
    // ---------------------------------------------------------------------------
    detectOverconfidence(text, hasHedging) {
        const signals = [];
        // Strong overconfidence markers — always flag
        for (const pattern of OVERCONFIDENCE_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                signals.push({
                    type: 'overconfidence',
                    severity: hasHedging ? 'low' : 'medium',
                    evidence: `Overconfidence marker: "${match[0]}"`,
                    suggestion: 'Use hedging language: "I believe", "likely", "based on available information"',
                });
                break;
            }
        }
        // Contextual overconfidence — only flag if no hedging present
        if (!hasHedging && signals.length === 0) {
            for (const pattern of OVERCONFIDENCE_CONTEXTUAL_PATTERNS) {
                const match = text.match(pattern);
                if (match) {
                    signals.push({
                        type: 'overconfidence',
                        severity: 'low',
                        evidence: `Possible overconfidence: "${match[0]}"`,
                        suggestion: 'Consider adding hedging: "I believe", "likely", "based on available information"',
                    });
                    break;
                }
            }
        }
        return signals;
    }
    detectUnsupportedSpecificity(text, hasHedging) {
        var _a;
        const signals = [];
        // If the text contains hedging, reduce severity
        for (const pattern of SPECIFICITY_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                // Check if the specific claim is near hedging language
                const matchIndex = (_a = match.index) !== null && _a !== void 0 ? _a : 0;
                const contextWindow = text.substring(Math.max(0, matchIndex - 50), matchIndex + match[0].length + 50);
                const nearHedging = HEDGING_LANGUAGE.some((h) => h.test(contextWindow));
                if (!nearHedging) {
                    signals.push({
                        type: 'unsupported_specificity',
                        severity: hasHedging ? 'low' : 'low',
                        evidence: `Specific claim without source: "${match[0]}"`,
                        suggestion: 'Add attribution or hedge: "approximately", "around", "according to..."',
                    });
                }
            }
        }
        return signals;
    }
    detectFabricatedReferences(text) {
        const signals = [];
        for (const pattern of FABRICATED_REF_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                // Check if it references a known journal (lower severity)
                const matchText = match[0].toLowerCase();
                const isKnownJournal = [...KNOWN_JOURNALS].some((j) => matchText.includes(j));
                signals.push({
                    type: 'fabricated_reference',
                    severity: isKnownJournal ? 'medium' : 'high',
                    evidence: `Possible fabricated reference: "${match[0]}"`,
                    suggestion: isKnownJournal
                        ? 'Verify this specific citation exists. Known journal names are often used in hallucinated references.'
                        : 'Verify reference exists or remove. LLMs commonly hallucinate academic citations.',
                });
                break;
            }
        }
        return signals;
    }
    detectTemporalIssues(text) {
        const signals = [];
        // Absolute temporal references
        for (const pattern of TEMPORAL_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                const dateMatch = match[0].match(/20\d{2}/);
                if (dateMatch) {
                    const year = parseInt(dateMatch[0], 10);
                    if (year > this.knowledgeCutOffDate.getFullYear() + 1) {
                        signals.push({
                            type: 'temporal_impossibility',
                            severity: 'high',
                            evidence: `Future date referenced: "${match[0]}"`,
                            suggestion: 'Verify temporal claims against current date.',
                        });
                    }
                }
            }
        }
        // Relative time references — always risky
        for (const pattern of RELATIVE_TIME_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                signals.push({
                    type: 'temporal_impossibility',
                    severity: 'low',
                    evidence: `Relative time reference: "${match[0]}"`,
                    suggestion: 'LLMs cannot reliably track "now". Prefer absolute dates.',
                });
            }
        }
        return signals;
    }
    /**
     * Simple relevance check: if output is much longer than input with no new context
     */
    checkRelevance(input, output) {
        const signals = [];
        const inputTokens = input.split(/\s+/).length;
        const outputTokens = output.split(/\s+/).length;
        if (outputTokens > inputTokens * 5 && !input.includes('?') && inputTokens > 5) {
            signals.push({
                type: 'inconsistency',
                severity: 'low',
                evidence: `Output (${outputTokens} words) is ${Math.round(outputTokens / Math.max(inputTokens, 1))}x longer than input (${inputTokens} words)`,
                suggestion: 'Verify that expanded content is grounded in the input.',
            });
        }
        return signals;
    }
    /**
     * Simple entailment check: does the output contain claims not supported by input?
     * Lightweight NLI heuristic without LLM calls.
     */
    checkEntailment(input, output) {
        const signals = [];
        // Extract key nouns/entities from input
        const inputWords = new Set(input
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter((w) => w.length > 3));
        // Check output sentences for novel claims
        const outputSentences = this.splitSentences(output);
        let novelClaimCount = 0;
        for (const sentence of outputSentences) {
            if (!this.isClaimSentence(sentence))
                continue;
            const sentenceWords = sentence
                .toLowerCase()
                .replace(/[^\w\s]/g, '')
                .split(/\s+/)
                .filter((w) => w.length > 3);
            // How many content words in the sentence are NOT in the input?
            const novelWords = sentenceWords.filter((w) => !inputWords.has(w));
            const noveltyRatio = sentenceWords.length > 0 ? novelWords.length / sentenceWords.length : 0;
            // If >50% of content words are novel and sentence is a factual claim
            if (noveltyRatio > 0.5 && sentenceWords.length > 3) {
                novelClaimCount++;
            }
        }
        // Only flag if there are many novel claims (not just a few explanatory words)
        if (novelClaimCount >= 3) {
            signals.push({
                type: 'entailment_failure',
                severity: 'medium',
                evidence: `${novelClaimCount} output sentences contain claims not grounded in the input`,
                suggestion: 'Verify that expanded content is supported by the source. Consider adding citations.',
            });
        }
        return signals;
    }
    detectContradictions(text) {
        const signals = [];
        for (const pattern of CONTRADICTION_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                signals.push({
                    type: 'self_contradiction',
                    severity: 'high',
                    evidence: `Self-contradiction detected: "${match[0].slice(0, 100)}"`,
                    suggestion: 'Resolve contradictory statements before presenting to user.',
                });
                break;
            }
        }
        return signals;
    }
    detectConfidenceInconsistency(text) {
        const signals = [];
        for (const pattern of CONFIDENCE_CONSISTENCY) {
            const match = text.match(pattern);
            if (match) {
                signals.push({
                    type: 'confidence_inconsistency',
                    severity: 'medium',
                    evidence: `Confidence inconsistency: "${match[0].slice(0, 100)}"`,
                    suggestion: 'Align expressed confidence with certainty level.',
                });
                break;
            }
        }
        return signals;
    }
    detectNumericAnomalies(text) {
        const signals = [];
        // Detect percentages that sum to more than 100% — scoped per sentence
        const sentences = text.split(/[.!?\n]+/).filter((s) => s.trim().length > 0);
        for (const sentence of sentences) {
            const percentMatches = [...sentence.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
            if (percentMatches.length >= 3) {
                const sum = percentMatches.reduce((s, m) => s + parseFloat(m[1]), 0);
                if (sum > 105) {
                    // Small tolerance for rounding
                    signals.push({
                        type: 'numeric_anomaly',
                        severity: 'medium',
                        evidence: `Percentages sum to ${sum.toFixed(1)}% in one sentence: ${percentMatches.map((m) => m[0]).join(', ')}`,
                        suggestion: 'Verify numeric claims. Percentages summing >100% is a common hallucination.',
                    });
                }
            }
        }
        // Detect impossibly precise numbers (10+ digits in free text)
        const preciseNumbers = text.match(/\b\d{10,}\b/g);
        if (preciseNumbers && preciseNumbers.length > 0) {
            signals.push({
                type: 'numeric_anomaly',
                severity: 'low',
                evidence: `Impossibly precise number: ${preciseNumbers[0]}`,
                suggestion: 'Very precise numbers in free text are often hallucinated.',
            });
        }
        // Detect contradictory numbers (e.g., "increased by 50%... decreased by 30%")
        const increaseDecrease = text.match(/\b(?:increased?|grew|rose|improved?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%.*?\b(?:decreased?|fell|dropped?|declined?|reduced?)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/i);
        if (increaseDecrease) {
            signals.push({
                type: 'numeric_anomaly',
                severity: 'medium',
                evidence: `Contradictory trend numbers: "${increaseDecrease[0].slice(0, 80)}"`,
                suggestion: 'Verify that the numbers and trends are consistent.',
            });
        }
        return signals;
    }
    /**
     * NEW: Detect hedged claims presented as facts.
     * e.g., "This approach might work" followed by "This approach works perfectly"
     */
    detectHedgedAsFact(text) {
        const signals = [];
        // Pattern: hedged claim followed by unhedged version
        const hedgedThenFact = /\b(?:might|could|may|possibly|potentially)\s+\w+.{0,50}?\b(?:definitely|certainly|clearly|obviously|undoubtedly)\s+\w+/i;
        const match = text.match(hedgedThenFact);
        if (match) {
            signals.push({
                type: 'hedged_as_fact',
                severity: 'medium',
                evidence: `Hedged claim escalated to fact: "${match[0].slice(0, 80)}"`,
                suggestion: "Maintain consistent confidence level. Don't escalate uncertain claims to certainties.",
            });
        }
        return signals;
    }
    /**
     * NEW: Detect potentially hallucinated entity references.
     * Function names, package versions, API endpoints that look fabricated.
     */
    detectEntityHallucination(text) {
        const signals = [];
        // Check for function calls that look like they might not exist
        const funcMatches = [...text.matchAll(ENTITY_PATTERNS.functionCall)];
        if (funcMatches.length > 0) {
            // Only flag if there are multiple specific-looking function calls
            // (a single one might be real)
            const specificFuncs = funcMatches.filter((m) => {
                const funcName = m[0]
                    .replace(/(?:use|call|invoke|run|execute)\s+`?/, '')
                    .replace(/`?\(\)/, '');
                // Flag if function name is very long or has unusual patterns
                return funcName.length > 15 || /\.[A-Z][a-z]+[A-Z]/.test(funcName);
            });
            if (specificFuncs.length > 0) {
                signals.push({
                    type: 'entity_hallucination',
                    severity: 'low',
                    evidence: `Potentially fabricated function reference: "${specificFuncs[0][0]}"`,
                    suggestion: 'Verify that this function/method exists in the actual codebase.',
                });
            }
        }
        return signals;
    }
    // ---------------------------------------------------------------------------
    // Helper Methods
    // ---------------------------------------------------------------------------
    /**
     * Detect if the output contains hedging language.
     * Hedging reduces the severity of overconfidence/specificity signals.
     */
    detectHedging(text) {
        return HEDGING_LANGUAGE.some((pattern) => pattern.test(text));
    }
    /**
     * Split text into sentences.
     */
    splitSentences(text) {
        return text
            .split(/[.!?\n]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 5);
    }
    /**
     * Check if a sentence contains a factual claim (vs. explanation/hedging).
     */
    isClaimSentence(sentence) {
        const lower = sentence.toLowerCase();
        // Skip hedging/qualifying sentences
        if (/^(?:however|but|although|note that|keep in mind|remember|disclaimer)/i.test(lower)) {
            return false;
        }
        // Skip questions
        if (sentence.endsWith('?'))
            return false;
        // Skip very short sentences
        if (sentence.split(/\s+/).length < 4)
            return false;
        // Claim indicators — broad set to catch factual statements
        const claimIndicators = [
            /\b(?:is|are|was|were|has|have|had|will|would|can|could|uses?|supports?|handles?|stores?|runs?|provides?|returns?|sends?|creates?|generates?|processes?|executes?|performs?|implements?|enables?|allows?|requires?|needs?|depends?|consists?|comprises?|contains?|includes?|involves?)\b/i,
            /\b(?:according to|based on|per)\b/i,
            /\d+/, // Numbers suggest factual claims
        ];
        return claimIndicators.some((p) => p.test(sentence));
    }
    /**
     * Check if a sentence is supported by the sampled output.
     * Simple word-overlap heuristic (lightweight NLI).
     */
    isSentenceSupported(sentence, sample) {
        const sentenceWords = new Set(sentence
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter((w) => w.length > 3));
        const sampleLower = sample.toLowerCase();
        let matchCount = 0;
        for (const word of sentenceWords) {
            if (sampleLower.includes(word)) {
                matchCount++;
            }
        }
        // Consider supported if >60% of content words appear in sample
        // This is intentionally strict to catch semantic differences
        return sentenceWords.size > 0 && matchCount / sentenceWords.size > 0.6;
    }
    // ---------------------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------------------
    buildSummary(signals, riskScore) {
        if (signals.length === 0) {
            return 'No hallucination signals detected. Output appears grounded.';
        }
        const highCount = signals.filter((s) => s.severity === 'high').length;
        const medCount = signals.filter((s) => s.severity === 'medium').length;
        const lowCount = signals.filter((s) => s.severity === 'low').length;
        const parts = [];
        if (highCount > 0)
            parts.push(`${highCount} high-risk`);
        if (medCount > 0)
            parts.push(`${medCount} medium-risk`);
        if (lowCount > 0)
            parts.push(`${lowCount} low-risk`);
        return `Detected ${signals.length} hallucination signal(s): ${parts.join(', ')}. Risk score: ${(riskScore * 100).toFixed(0)}%.`;
    }
}
exports.HallucinationDetector = HallucinationDetector;
// ============================================================================
// Factory
// ============================================================================
let defaultDetector = null;
function getHallucinationDetector(options) {
    if (!defaultDetector) {
        defaultDetector = new HallucinationDetector(options);
    }
    return defaultDetector;
}
function resetHallucinationDetector() {
    defaultDetector = null;
}
