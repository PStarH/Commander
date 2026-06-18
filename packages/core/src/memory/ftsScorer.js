"use strict";
/**
 * FTS5-style BM25 Scorer for In-Memory Memory Stores
 *
 * Implements Okapi BM25 ranking without requiring SQLite.
 * Used by JsonMemoryStore and ThreeLayerMemory for high-quality
 * full-text search across memory entries.
 *
 * BM25 formula:
 *   score(D, Q) = Σ IDF(qi) * (f(qi, D) * (k1 + 1)) / (f(qi, D) + k1 * (1 - b + b * |D| / avgdl))
 *
 * Where:
 *   - IDF(qi) = log((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
 *   - f(qi, D) = term frequency of qi in document D
 *   - |D| = document length (in tokens)
 *   - avgdl = average document length
 *   - k1 = 1.2 (term frequency saturation)
 *   - b = 0.75 (length normalization)
 *
 * Reference: SQLite FTS5 bm25() function, Robertson & Zaragoza (2009)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BM25Scorer = void 0;
exports.tokenizeForBM25 = tokenizeForBM25;
const DEFAULT_BM25_CONFIG = {
    k1: 1.2,
    b: 0.75,
    minTokenLength: 2,
};
// ============================================================================
// Stop Words (English + common programming terms)
// ============================================================================
const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'need',
    'must',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'they',
    'them',
    'their',
    'we',
    'our',
    'you',
    'your',
    'he',
    'him',
    'his',
    'she',
    'her',
    'i',
    'me',
    'my',
    'not',
    'no',
    'nor',
    'and',
    'but',
    'or',
    'if',
    'then',
    'for',
    'of',
    'in',
    'on',
    'at',
    'to',
    'by',
    'with',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'out',
    'off',
    'over',
    'under',
    'again',
    'further',
    'about',
    'up',
    'down',
    'here',
    'there',
    'when',
    'where',
    'why',
    'how',
    'all',
    'each',
    'every',
    'both',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'only',
    'own',
    'same',
    'so',
    'than',
    'too',
    'very',
]);
// ============================================================================
// Tokenizer
// ============================================================================
/**
 * Tokenize text for BM25 indexing.
 * Handles English, CJK (Chinese/Japanese/Korean), and programming terms.
 */
function tokenizeForBM25(text, minLength = 2) {
    const lower = text.toLowerCase();
    // Split on non-alphanumeric, preserving CJK characters individually
    const tokens = [];
    let current = '';
    for (let i = 0; i < lower.length; i++) {
        const ch = lower[i];
        const code = ch.charCodeAt(0);
        // CJK characters (individual tokens)
        if (code >= 0x4e00 && code <= 0x9fff) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            tokens.push(ch);
            continue;
        }
        // Alphanumeric (build token)
        if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || ch === '-' || ch === '_') {
            current += ch;
        }
        else {
            if (current) {
                tokens.push(current);
                current = '';
            }
        }
    }
    if (current)
        tokens.push(current);
    // Filter by length and stop words (CJK characters are always kept regardless of length)
    return tokens.filter((t) => {
        if (STOP_WORDS.has(t))
            return false;
        // CJK characters (single-char tokens) are always kept
        if (t.length === 1 && t.charCodeAt(0) >= 0x4e00 && t.charCodeAt(0) <= 0x9fff)
            return true;
        return t.length >= minLength;
    });
}
/**
 * In-memory BM25 scorer for fast full-text search.
 * Indexes documents and scores queries using Okapi BM25.
 */
class BM25Scorer {
    constructor(config = {}) {
        /** Document frequency: term → number of documents containing it */
        this.df = new Map();
        /** All indexed documents */
        this.documents = new Map();
        /** Total document count */
        this.N = 0;
        /** Average document length */
        this.avgDocLength = 0;
        /** Total token count (for computing avgDocLength) */
        this.totalTokens = 0;
        /** Whether the index needs rebuilding */
        this.dirty = false;
        this.config = { ...DEFAULT_BM25_CONFIG, ...config };
    }
    /**
     * Index a document for BM25 search.
     */
    addDocument(id, text, fieldTexts) {
        var _a;
        const tokens = tokenizeForBM25(text, this.config.minTokenLength);
        const fieldTokens = new Map();
        if (fieldTexts) {
            for (const [field, fieldText] of fieldTexts) {
                fieldTokens.set(field, tokenizeForBM25(fieldText, this.config.minTokenLength));
            }
        }
        const doc = { id, tokens, fieldTokens };
        // Update document frequency
        const uniqueTerms = new Set(tokens);
        for (const term of uniqueTerms) {
            this.df.set(term, ((_a = this.df.get(term)) !== null && _a !== void 0 ? _a : 0) + 1);
        }
        // Update average document length
        this.totalTokens += tokens.length;
        this.N++;
        this.avgDocLength = this.totalTokens / this.N;
        this.documents.set(id, doc);
        this.dirty = true;
    }
    /**
     * Remove a document from the index.
     */
    removeDocument(id) {
        var _a;
        const doc = this.documents.get(id);
        if (!doc)
            return;
        // Update document frequency
        const uniqueTerms = new Set(doc.tokens);
        for (const term of uniqueTerms) {
            const count = (_a = this.df.get(term)) !== null && _a !== void 0 ? _a : 0;
            if (count <= 1) {
                this.df.delete(term);
            }
            else {
                this.df.set(term, count - 1);
            }
        }
        this.totalTokens -= doc.tokens.length;
        this.N--;
        this.avgDocLength = this.N > 0 ? this.totalTokens / this.N : 0;
        this.documents.delete(id);
        this.dirty = true;
    }
    /**
     * Score a query against all indexed documents using BM25.
     * Returns results sorted by score (highest first).
     */
    score(query, limit = 10) {
        const queryTerms = tokenizeForBM25(query, this.config.minTokenLength);
        if (queryTerms.length === 0)
            return [];
        const results = [];
        for (const [id, doc] of this.documents) {
            const score = this.scoreDocument(doc, queryTerms);
            if (score > 0) {
                results.push({ id, score });
            }
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }
    /**
     * Score a single document against query terms using BM25.
     */
    scoreDocument(doc, queryTerms) {
        var _a, _b, _c, _d, _e, _f;
        const { k1, b } = this.config;
        const docLen = doc.tokens.length;
        let score = 0;
        // Build term frequency map for O(1) lookups
        const tf = new Map();
        for (const token of doc.tokens) {
            tf.set(token, ((_a = tf.get(token)) !== null && _a !== void 0 ? _a : 0) + 1);
        }
        // Also count field tokens (with optional field boosting)
        const fieldTf = new Map();
        if (doc.fieldTokens) {
            for (const [field, tokens] of doc.fieldTokens) {
                const ft = new Map();
                for (const token of tokens) {
                    ft.set(token, ((_b = ft.get(token)) !== null && _b !== void 0 ? _b : 0) + 1);
                }
                fieldTf.set(field, ft);
            }
        }
        for (const term of queryTerms) {
            // Document frequency
            const n = (_c = this.df.get(term)) !== null && _c !== void 0 ? _c : 0;
            if (n === 0)
                continue;
            // IDF: log((N - n + 0.5) / (n + 0.5) + 1)
            const idf = Math.log((this.N - n + 0.5) / (n + 0.5) + 1);
            // Term frequency in main content
            const termFreq = (_d = tf.get(term)) !== null && _d !== void 0 ? _d : 0;
            // BM25 score for this term
            const tfNorm = (termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + (b * docLen) / this.avgDocLength));
            score += idf * tfNorm;
            // Field boosting: title matches get 2x weight
            if (doc.fieldTokens) {
                const titleFreq = (_f = (_e = fieldTf.get('title')) === null || _e === void 0 ? void 0 : _e.get(term)) !== null && _f !== void 0 ? _f : 0;
                if (titleFreq > 0) {
                    const titleTfNorm = (titleFreq * (k1 + 1)) / (titleFreq + k1 * (1 - b + (b * docLen) / this.avgDocLength));
                    score += idf * titleTfNorm * 1.0; // Additional boost for title
                }
            }
        }
        return score;
    }
    /**
     * Get index statistics.
     */
    getStats() {
        return {
            documents: this.N,
            terms: this.df.size,
            avgDocLength: Math.round(this.avgDocLength * 10) / 10,
        };
    }
    /**
     * Serialize the index for persistence.
     */
    serialize() {
        return {
            config: this.config,
            df: Array.from(this.df.entries()),
            documents: Array.from(this.documents.entries()).map(([id, doc]) => ({
                id,
                tokens: doc.tokens,
                fieldTokens: doc.fieldTokens
                    ? Array.from(doc.fieldTokens.entries()).map(([f, t]) => [f, t])
                    : undefined,
            })),
            N: this.N,
            totalTokens: this.totalTokens,
            avgDocLength: this.avgDocLength,
        };
    }
    /**
     * Deserialize a previously serialized index.
     */
    static deserialize(data) {
        const scorer = new BM25Scorer(data.config);
        scorer.df = new Map(data.df);
        scorer.N = data.N;
        scorer.totalTokens = data.totalTokens;
        scorer.avgDocLength = data.avgDocLength;
        for (const doc of data.documents) {
            const fieldTokens = doc.fieldTokens ? new Map(doc.fieldTokens) : undefined;
            scorer.documents.set(doc.id, {
                id: doc.id,
                tokens: doc.tokens,
                fieldTokens,
            });
        }
        return scorer;
    }
}
exports.BM25Scorer = BM25Scorer;
