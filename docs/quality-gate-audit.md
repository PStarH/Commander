# Quality Gate System Audit Report
**Date**: 2026-05-31
**Auditor**: Quality Gate & Governance System Lead

## Executive Summary

Commander has 9 quality gate modules spanning hallucination detection, content security, governance, conflict detection, consistency monitoring, self-assessment, confidence reporting, LLM evaluation, and consensus verification. The system is well-architected but has significant gaps in accuracy, test coverage (1/9 modules tested), and detection sophistication.

## Module Inventory

| # | Module | Location | Lines | Test Coverage |
|---|--------|----------|-------|---------------|
| 1 | HallucinationDetector | packages/core/src/ | 379 | ✅ Basic (7 tests) |
| 2 | ContentScanner | packages/core/src/ | 420 | ❌ None |
| 3 | GovernanceCheckpoint | apps/api/src/ | 527 | ❌ None |
| 4 | GovernanceObserver | apps/api/src/ | 131 | ❌ None |
| 5 | ConflictDetection | apps/api/src/ | 557 | ❌ None |
| 6 | ConsistencyMonitor | apps/api/src/ | 640 | ❌ None |
| 7 | SelfAssessment | apps/api/src/ | 207 | ❌ None |
| 8 | ConfidenceReporter | apps/api/src/ | 349 | ❌ None |
| 9 | Evaluation (LLM-as-Judge) | apps/api/src/ | 614 | ❌ None |
| 10 | ConsensusCheck | packages/core/src/ | 484 | ❌ None |

---

## Gate 1: HallucinationDetector

### Design
- 8 detection signals: overconfidence, unsupported_specificity, fabricated_reference, temporal_impossibility, inconsistency, numeric_anomaly, self-contradiction, confidence_inconsistency
- Zero-cost first pass (no LLM calls)
- Risk score: weighted sum of signal severities (low=0.1, medium=0.3, high=0.5)
- Thresholds: pass <0.3, flag_for_review 0.3-0.6, reject ≥0.6

### False Positive Scenarios (误报)
1. **Legitimate citations flagged**: "According to a study published in Nature..." → triggers fabricated_reference even when real
2. **Hedged specificity flagged**: "approximately 42.5% of users" → triggers unsupported_specificity
3. **Temporal context false alarm**: "As of May 2026, the latest version..." → triggers temporal_impossibility if knowledge cutoff is old
4. **Chinese overconfidence too broad**: "确定" (confirm) matches everyday usage, not just overconfidence
5. **Output expansion false positive**: Technical explanations legitimately 5x longer than brief inputs

### False Negative Scenarios (漏报)
1. **Subtle hallucination undetected**: "The API returns 200 on success" (when it actually returns 201) — no pattern match
2. **Plausible but wrong numbers**: "The library has 15,000 GitHub stars" — exact numbers that look reasonable
3. **Fabricated function names**: "Use `processData()` method" — when method doesn't exist
4. **Wrong version numbers**: "Since version 3.2.1, this feature..." — plausible but fabricated
5. **Cross-lingual hallucination**: Mixed language outputs where hallucinated content is in a different language

### Accuracy Estimate: ~60% (high false positive rate on legitimate citations, misses subtle factual errors)

---

## Gate 2: ContentScanner

### Design
- 8 threat types: hidden_html, css_injection, metadata_command, unicode_obfuscation, prompt_injection, multi_language_confusion, invisible_characters, data_exfil_channel
- Multi-language prompt injection patterns (EN/ZH/RU/AR/JA/KO)
- Risk scoring: LOW=5, MEDIUM=15, HIGH=35, CRITICAL=45

### False Positive Scenarios
1. **Code examples flagged**: HTML/CSS in documentation or code snippets
2. **Legitimate Unicode**: CJK text with zero-width joiners for proper rendering
3. **Data attributes in web content**: Legitimate `data-*` attributes in HTML

### False Negative Scenarios
1. **Encoded injection**: Base64-encoded prompt injection not detected
2. **Homoglyph attacks**: Cyrillic characters that look like Latin (а vs a)
3. **Indirect injection via markdown**: `[click here](javascript:alert(1))`
4. **Unicode confusables**: Lookalike characters from different scripts

### Accuracy Estimate: ~75% (good on common patterns, misses encoded/sophisticated attacks)

---

## Gate 3: GovernanceCheckpoint

### Design
- 3 governance modes: AUTO, GUARDED, MANUAL
- Risk score calculation: base (risk level) + mode adjustment + operation risk + data sensitivity
- Checkpoint types: automatic, conditional, mandatory
- Approval workflow with timeout and fallback

### Issues
1. **Risk score too simplistic**: Only 4 factors, no historical context
2. **No audit trail persistence**: Evidence stored in-memory only
3. **Timeout fallback risky**: AUTO mode proceeds on timeout (could be dangerous)
4. **No multi-level approval**: Single approver model

### Accuracy Estimate: ~70% (risk scoring is crude, approval flow works but lacks sophistication)

---

## Gate 4: ConflictDetection

### Design
- 4 conflict types: GOAL, RESOURCE, POLICY, INTERPRETATION
- Proactive (pre-action) and reactive (monitoring) detection
- Severity assessment based on priority levels

### Issues
1. **Interpretation conflict too shallow**: Only checks metadata terminology, no semantic analysis
2. **Goal conflict relies on metadata**: Only triggers if `targetMissionId` is provided
3. **No resolution mechanism**: Detects conflicts but doesn't resolve them
4. **Resource conflict simplistic**: Only checks token/API budgets, not file locks or state

### Accuracy Estimate: ~55% (misses most semantic conflicts, good on resource contention)

---

## Gate 5: ConsistencyMonitor

### Design
- Jaccard similarity + length ratio for semantic similarity
- BFT consensus checking
- Consistency levels: high (>0.8), medium (0.5-0.8), low (0.2-0.5), conflicting (<0.2)

### Issues
1. **Jaccard similarity too crude**: "The cat sat on the mat" vs "A cat sat on a mat" = low similarity despite same meaning
2. **No embedding-based similarity**: Comments suggest using embeddings but doesn't
3. **BFT node count unrealistic**: Requires 4+ nodes but most missions have 1-2 agents
4. **No temporal consistency**: Doesn't check if outputs contradict earlier outputs

### Accuracy Estimate: ~45% (Jaccard misses semantic equivalence, too many false negatives)

---

## Gate 6: SelfAssessment

### Design
- Capability-based self-model with success/failure tracking
- Confidence calculation: overall * 0.6 + historical * 0.4
- Refuse threshold at 0.2
- Recommends reasoning mode based on confidence

### Issues
1. **Initial confidence too high** (0.8) for unknown agents
2. **No calibration mechanism**: Confidence doesn't map to actual accuracy
3. **Capability gap too binary**: Missing vs present, no partial capability
4. **No cross-task learning**: Skills don't transfer between similar tasks

### Accuracy Estimate: ~50% (overconfident initial state, poor calibration)

---

## Gate 7: ConfidenceReporter

### Design
- Aggregates confidence from ActionRationaleStore
- Trend detection (improving/declining/stable)
- Alert system for low-confidence decisions
- Statistical analysis (mean, median, stddev)

### Issues
1. **Depends on ActionRationaleStore**: If store is empty, no reporting
2. **Trend detection simplistic**: Only compares first/last windows
3. **No per-criterion breakdown**: Single confidence number per action
4. **Alert thresholds hardcoded**: No per-mission customization

### Accuracy Estimate: ~65% (reporting works but trend detection is unreliable)

---

## Gate 8: Evaluation (LLM-as-Judge)

### Design
- 7 criteria: relevance, completion, adherence, helpfulness, clarity, accuracy, safety
- 1-5 scoring with rubric
- Retry on low scores
- Score smoothing with EMA

### Issues
1. **No actual LLM integration**: generatePrompt creates prompts but evaluate() requires external llmCall
2. **Retry logic flawed**: Retries low scores but keeps original if retry is also low
3. **No cross-criterion correlation**: Safety and accuracy evaluated independently
4. **Score smoothing not connected**: ScoreSmoother not used by LLMEvaluator

### Accuracy Estimate: ~60% (framework exists but integration incomplete)

---

## Gate 9: ConsensusCheck

### Design
- Multi-model voting with confidence weighting
- Consensus levels: unanimous/strong/moderate/low/diverged
- Action mapping: proceed/discuss/rethink/escalate
- Auto-pruning of stale checks

### Issues
1. **Jaccard similarity too crude** (same as ConsistencyMonitor)
2. **Confidence weighting simplistic**: Just 0.7*similarity + 0.3*confidence
3. **No semantic clustering**: Decision grouping uses exact string match + Jaccard
4. **waitForVotes uses polling**: 100ms polling loop, should use events

### Accuracy Estimate: ~55% (similarity metric is the weak link)

---

## Cross-Cutting Issues

### 1. Similarity Metric Problem
Both ConsistencyMonitor and ConsensusCheck use Jaccard similarity as their core metric. This is fundamentally inadequate for semantic comparison. Need embedding-based similarity.

### 2. No Shared Quality State
Each gate operates independently. There's no unified quality dashboard or cross-gate correlation.

### 3. Test Coverage Critical Gap
Only 1 of 9 modules has dedicated tests. The existing test (hallucinationDetector) has only 7 basic tests.

### 4. In-Memory Only
All state (checkpoints, consistency reports, consensus checks) is in-memory. Lost on restart.

### 5. No Metrics/Observability
No Prometheus metrics, no structured logging, no quality trend tracking over time.

---

## Priority Improvements

### P0 (Critical)
1. Replace Jaccard similarity with embedding-based similarity in ConsistencyMonitor and ConsensusCheck
2. Add SelfCheckGPT-style multi-sample consistency to HallucinationDetector
3. Write tests for all 9 modules

### P1 (High)
4. Add encoded/homoglyph attack detection to ContentScanner
5. Improve risk scoring with historical data in GovernanceCheckpoint
6. Add calibration to SelfAssessment

### P2 (Medium)
7. Connect ScoreSmoother to LLMEvaluator
8. Add audit trail persistence to GovernanceCheckpoint
9. Improve trend detection in ConfidenceReporter
