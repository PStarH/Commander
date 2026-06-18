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
export type HallucinationSignalType = 'overconfidence' | 'unsupported_specificity' | 'inconsistency' | 'fabricated_reference' | 'temporal_impossibility' | 'numeric_anomaly' | 'self_contradiction' | 'confidence_inconsistency' | 'entailment_failure' | 'claim_unverifiable' | 'multi_sample_inconsistency' | 'entity_hallucination' | 'hedged_as_fact';
export interface HallucinationSignal {
    type: HallucinationSignalType;
    severity: 'low' | 'medium' | 'high';
    evidence: string;
    suggestion: string;
}
export interface HallucinationReport {
    riskScore: number;
    signals: HallucinationSignal[];
    summary: string;
    recommendation: 'pass' | 'flag_for_review' | 'reject';
    /** Atomic claims decomposed from the output */
    claims?: string[];
    /** Per-claim consistency scores from multi-sample check */
    claimScores?: Array<{
        claim: string;
        score: number;
        flagged: boolean;
    }>;
}
/**
 * Multi-sample verification result (SelfCheckGPT-style)
 */
export interface MultiSampleResult {
    /** Original output sentences */
    sentences: string[];
    /** Per-sentence consistency score (0-1, higher = more consistent) */
    consistencyScores: number[];
    /** Sentences flagged as inconsistent */
    flaggedSentences: Array<{
        sentence: string;
        score: number;
        index: number;
    }>;
    /** Overall multi-sample risk score */
    riskScore: number;
}
export declare class HallucinationDetector {
    private knowledgeCutOffDate;
    constructor(options?: {
        knowledgeCutOffDate?: Date;
    });
    /**
     * Analyze an LLM output for hallucination signals.
     * Zero-cost first pass — no additional LLM calls.
     */
    analyze(input: string, output: string): HallucinationReport;
    /**
     * Multi-sample consistency check (SelfCheckGPT-style).
     * Takes multiple sampled outputs and checks sentence-level consistency.
     * This is the "second pass" that requires multiple LLM outputs.
     */
    analyzeMultiSample(originalOutput: string, sampledOutputs: string[]): MultiSampleResult;
    /**
     * Decompose output into atomic claims for fine-grained checking.
     * Based on FActScore methodology.
     */
    decomposeClaims(output: string): string[];
    private detectOverconfidence;
    private detectUnsupportedSpecificity;
    private detectFabricatedReferences;
    private detectTemporalIssues;
    /**
     * Simple relevance check: if output is much longer than input with no new context
     */
    private checkRelevance;
    /**
     * Simple entailment check: does the output contain claims not supported by input?
     * Lightweight NLI heuristic without LLM calls.
     */
    private checkEntailment;
    private detectContradictions;
    private detectConfidenceInconsistency;
    private detectNumericAnomalies;
    /**
     * NEW: Detect hedged claims presented as facts.
     * e.g., "This approach might work" followed by "This approach works perfectly"
     */
    private detectHedgedAsFact;
    /**
     * NEW: Detect potentially hallucinated entity references.
     * Function names, package versions, API endpoints that look fabricated.
     */
    private detectEntityHallucination;
    /**
     * Detect if the output contains hedging language.
     * Hedging reduces the severity of overconfidence/specificity signals.
     */
    private detectHedging;
    /**
     * Split text into sentences.
     */
    private splitSentences;
    /**
     * Check if a sentence contains a factual claim (vs. explanation/hedging).
     */
    private isClaimSentence;
    /**
     * Check if a sentence is supported by the sampled output.
     * Simple word-overlap heuristic (lightweight NLI).
     */
    private isSentenceSupported;
    private buildSummary;
}
export declare function getHallucinationDetector(options?: {
    knowledgeCutOffDate?: Date;
}): HallucinationDetector;
export declare function resetHallucinationDetector(): void;
//# sourceMappingURL=hallucinationDetector.d.ts.map