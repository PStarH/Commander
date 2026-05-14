/**
 * MemoryPoisoningDetector - RAG Source Credibility Assessment
 * 
 * Detects potential memory poisoning attacks in agent memory systems
 * Based on arXiv:2510.23883v2 research: "Memory poisoning >80% success @ <0.1% data pollution"
 * 
 * Key detection mechanisms:
 * - Source credibility scoring (domain reputation, provenance tracking)
 * - Embedding distribution anomaly detection
 * - Contradiction detection (new vs existing memories)
 * - Temporal consistency checking
 */

export interface MemorySource {
  id: string;
  content: string;
  timestamp: Date;
  source: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

export interface CredibilityScore {
  score: number; // 0-1, where 1 is highly credible
  factors: CredibilityFactor[];
  recommendation: 'accept' | 'quarantine' | 'reject';
}

export interface CredibilityFactor {
  name: string;
  score: number;
  weight: number;
  description: string;
}

export interface PoisoningIndicator {
  type: 'embedding_anomaly' | 'temporal_inconsistency' | 'source_untrusted' | 'contradiction';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string;
}

export class MemoryPoisoningDetector {
  private readonly trustedDomains: Set<string>;
  private readonly suspiciousDomains: Set<string>;
  private readonly embeddingHistory: number[][] = [];
  private readonly maxHistorySize: number = 100;

  constructor() {
    // Initialize trusted and suspicious domains
    this.trustedDomains = new Set([
      'wikipedia.org',
      'github.com',
      'stackoverflow.com',
      'docs.python.org',
      'arxiv.org',
      'nature.com',
      'science.org',
      'ieee.org',
      'acm.org',
      'nist.gov',
    ]);

    this.suspiciousDomains = new Set([
      // Add known suspicious domains from research
      // This would be updated based on threat intelligence
    ]);
  }

  /**
   * Assess credibility of a memory source before storing
   */
  async assessCredibility(source: MemorySource): Promise<CredibilityScore> {
    const factors: CredibilityFactor[] = [];

    // Factor 1: Domain reputation
    const domainScore = this.assessDomainReputation(source.source);
    factors.push({
      name: 'domain_reputation',
      score: domainScore,
      weight: 0.3,
      description: `Source domain: ${source.source}`,
    });

    // Factor 2: Content quality
    const contentScore = this.assessContentQuality(source.content);
    factors.push({
      name: 'content_quality',
      score: contentScore,
      weight: 0.2,
      description: 'Content coherence and structure',
    });

    // Factor 3: Embedding consistency (if available)
    if (source.embedding) {
      const embeddingScore = this.assessEmbeddingConsistency(source.embedding);
      factors.push({
        name: 'embedding_consistency',
        score: embeddingScore,
        weight: 0.25,
        description: 'Embedding distribution anomaly detection',
      });
    }

    // Factor 4: Temporal consistency
    const temporalScore = this.assessTemporalConsistency(source);
    factors.push({
      name: 'temporal_consistency',
      score: temporalScore,
      weight: 0.15,
      description: 'Timestamp and versioning checks',
    });

    // Factor 5: Provenance completeness
    const provenanceScore = this.assessProvenance(source);
    factors.push({
      name: 'provenance_completeness',
      score: provenanceScore,
      weight: 0.1,
      description: 'Metadata and provenance tracking',
    });

    // Calculate weighted average
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const weightedScore = factors.reduce((sum, f) => sum + f.score * f.weight, 0) / totalWeight;

    // Determine recommendation
    let recommendation: 'accept' | 'quarantine' | 'reject';
    if (weightedScore >= 0.7) {
      recommendation = 'accept';
    } else if (weightedScore >= 0.4) {
      recommendation = 'quarantine';
    } else {
      recommendation = 'reject';
    }

    return {
      score: weightedScore,
      factors,
      recommendation,
    };
  }

  /**
   * Detect poisoning indicators in a batch of memories
   */
  async detectPoisoning(
    newMemories: MemorySource[],
    existingMemories: MemorySource[]
  ): Promise<PoisoningIndicator[]> {
    const indicators: PoisoningIndicator[] = [];

    // Check each new memory
    for (const newMemory of newMemories) {
      // Check for contradictions with existing memories
      const contradictions = this.detectContradictions(newMemory, existingMemories);
      indicators.push(...contradictions);

      // Check for embedding anomalies
      if (newMemory.embedding) {
        const anomalies = this.detectEmbeddingAnomalies(newMemory.embedding, existingMemories);
        indicators.push(...anomalies);
      }
    }

    // Check for temporal inconsistencies across the batch
    const temporalIssues = this.detectTemporalInconsistencies(newMemories, existingMemories);
    indicators.push(...temporalIssues);

    return indicators;
  }

  /**
   * Assess domain reputation (0-1)
   */
  private assessDomainReputation(sourceUrl: string): number {
    try {
      const url = new URL(sourceUrl);
      const domain = url.hostname.replace('www.', '');

      if (this.trustedDomains.has(domain)) {
        return 0.95;
      }

      if (this.suspiciousDomains.has(domain)) {
        return 0.1;
      }

      // Unknown domain - moderate trust
      return 0.5;
    } catch {
      // Invalid URL - lower trust
      return 0.3;
    }
  }

  /**
   * Assess content quality (0-1)
   */
  private assessContentQuality(content: string): number {
    let score = 0.5; // Base score

    // Check for meaningful content length
    if (content.length > 100 && content.length < 10000) {
      score += 0.1;
    }

    // Check for structured content
    if (content.includes('\n') && content.split('\n').length > 2) {
      score += 0.1;
    }

    // Check for references or citations
    if (/\[\d+\]|\(\d{4}\)|https?:\/\//.test(content)) {
      score += 0.15;
    }

    // Penalize suspicious patterns
    if (/ignore\s+(all\s+)?previous/i.test(content)) {
      score -= 0.3;
    }

    if (/you\s+must\s+now/i.test(content)) {
      score -= 0.3;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Assess embedding consistency (0-1)
   */
  private assessEmbeddingConsistency(embedding: number[]): number {
    if (this.embeddingHistory.length === 0) {
      // First embedding - moderate trust
      this.addToHistory(embedding);
      return 0.6;
    }

    // Calculate average distance to historical embeddings
    const avgDistance = this.calculateAverageDistance(embedding);

    // Detect outliers (> 2 standard deviations)
    const stdDev = this.calculateStdDev(this.embeddingHistory.map(e => 
      this.calculateAverageDistance(e)
    ));

    const historicalAvg = this.embeddingHistory.reduce((sum, e) => 
      sum + this.calculateAverageDistance(e), 0
    ) / this.embeddingHistory.length;

    if (avgDistance > historicalAvg + 2 * stdDev) {
      // Anomalous embedding
      return 0.2;
    }

    this.addToHistory(embedding);
    return 0.8;
  }

  /**
   * Assess temporal consistency (0-1)
   */
  private assessTemporalConsistency(source: MemorySource): number {
    const now = new Date();
    const age = now.getTime() - source.timestamp.getTime();
    const ageHours = age / (1000 * 60 * 60);

    // Fresher content is more trustworthy
    if (ageHours < 24) {
      return 0.9;
    } else if (ageHours < 168) { // 1 week
      return 0.7;
    } else if (ageHours < 720) { // 1 month
      return 0.5;
    } else {
      return 0.3;
    }
  }

  /**
   * Assess provenance completeness (0-1)
   */
  private assessProvenance(source: MemorySource): number {
    let score = 0;

    // Has source URL
    if (source.source) {
      score += 0.3;
    }

    // Has timestamp
    if (source.timestamp) {
      score += 0.3;
    }

    // Has metadata
    if (source.metadata && Object.keys(source.metadata).length > 0) {
      score += 0.2;
    }

    // Has embedding
    if (source.embedding) {
      score += 0.2;
    }

    return score;
  }

  /**
   * Detect contradictions between new and existing memories
   */
  private detectContradictions(
    newMemory: MemorySource,
    existingMemories: MemorySource[]
  ): PoisoningIndicator[] {
    const indicators: PoisoningIndicator[] = [];

    // Simple keyword-based contradiction detection
    // In production, this would use semantic similarity
    const contradictionPatterns = [
      { pattern: /always/i, opposite: /never/i },
      { pattern: /true/i, opposite: /false/i },
      { pattern: /correct/i, opposite: /incorrect/i },
      { pattern: /enabled/i, opposite: /disabled/i },
    ];

    for (const existing of existingMemories) {
      for (const { pattern, opposite } of contradictionPatterns) {
        if (pattern.test(newMemory.content) && opposite.test(existing.content)) {
          indicators.push({
            type: 'contradiction',
            severity: 'high',
            description: 'Potential contradiction detected',
            evidence: `New: "${newMemory.content.substring(0, 50)}..." vs Existing: "${existing.content.substring(0, 50)}..."`,
          });
        }
      }
    }

    return indicators;
  }

  /**
   * Detect embedding anomalies
   */
  private detectEmbeddingAnomalies(
    newEmbedding: number[],
    existingMemories: MemorySource[]
  ): PoisoningIndicator[] {
    const indicators: PoisoningIndicator[] = [];

    if (existingMemories.length === 0) {
      return indicators;
    }

    // Calculate distances to all existing embeddings
    const distances = existingMemories
      .filter(m => m.embedding)
      .map(m => this.cosineDistance(newEmbedding, m.embedding!));

    if (distances.length === 0) {
      return indicators;
    }

    const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
    const maxDistance = Math.max(...distances);

    // Detect outliers
    if (maxDistance > 0.8) { // Threshold based on research
      indicators.push({
        type: 'embedding_anomaly',
        severity: 'high',
        description: 'Embedding significantly different from existing memories',
        evidence: `Max distance: ${maxDistance.toFixed(3)}, Avg: ${avgDistance.toFixed(3)}`,
      });
    }

    return indicators;
  }

  /**
   * Detect temporal inconsistencies
   */
  private detectTemporalInconsistencies(
    newMemories: MemorySource[],
    existingMemories: MemorySource[]
  ): PoisoningIndicator[] {
    const indicators: PoisoningIndicator[] = [];

    // Check for future-dated memories
    const now = new Date();
    for (const memory of newMemories) {
      if (memory.timestamp > now) {
        indicators.push({
          type: 'temporal_inconsistency',
          severity: 'critical',
          description: 'Memory timestamp is in the future',
          evidence: `Timestamp: ${memory.timestamp.toISOString()}, Current: ${now.toISOString()}`,
        });
      }
    }

    return indicators;
  }

  /**
   * Helper: Calculate cosine distance between two embeddings
   */
  private cosineDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) return 1.0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 1.0;

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return 1 - similarity; // Convert to distance
  }

  /**
   * Helper: Calculate average distance to historical embeddings
   */
  private calculateAverageDistance(embedding: number[]): number {
    if (this.embeddingHistory.length === 0) return 0;

    const distances = this.embeddingHistory.map(h => 
      this.cosineDistance(embedding, h)
    );

    return distances.reduce((a, b) => a + b, 0) / distances.length;
  }

  /**
   * Helper: Calculate standard deviation
   */
  private calculateStdDev(values: number[]): number {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  /**
   * Helper: Add embedding to history
   */
  private addToHistory(embedding: number[]): void {
    this.embeddingHistory.push(embedding);
    if (this.embeddingHistory.length > this.maxHistorySize) {
      this.embeddingHistory.shift();
    }
  }
}

/**
 * Export singleton instance
 */
export const memoryPoisoningDetector = new MemoryPoisoningDetector();
