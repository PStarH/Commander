/**
 * Memory Poisoning Detection Gate
 *
 * Security (OWASP ASI07): Prevents memory poisoning attacks where an attacker
 * injects malicious or false information into the agent's memory store, which
 * is later retrieved via RAG and influences agent behavior.
 *
 * Research shows >80% attack success rate at <0.1% pollution ratio when
 * memory writes are unvalidated. This gate enforces validation at every
 * memory write path in the runtime.
 */

import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from './securityAuditLogger';

/** Result of a memory poisoning check. */
export interface MemoryPoisoningCheckResult {
  /** Whether the memory entry should be allowed. */
  allowed: boolean;
  /** Reason for the decision. */
  reason: string;
  /** Detected threat type, if any. */
  threatType?: 'repetition' | 'contradiction' | 'injection' | 'low_credibility' | 'anomaly';
  /** Risk score 0-1. */
  riskScore: number;
}

// ── Detection patterns ─────────────────────────────────────────────────────

/**
 * Patterns that indicate a potential memory poisoning payload.
 * These are checked against the content being written to memory.
 */
const INJECTION_PATTERNS = [
  // Instruction override attempts
  { pattern: /ignore\s+(all\s+)?previous\s+(instructions?|memor|rules?)/i, type: 'injection' as const, weight: 0.9 },
  { pattern: /disregard\s+(all\s+)?prior\s+(instructions?|memor|rules?)/i, type: 'injection' as const, weight: 0.9 },
  { pattern: /you\s+(are|must|should)\s+(now|always)\s+/i, type: 'injection' as const, weight: 0.7 },
  // System prompt manipulation
  { pattern: /system\s*prompt\s*(is|should be|must be)\s+/i, type: 'injection' as const, weight: 0.8 },
  { pattern: /your\s+(true|real|actual)\s+(instructions?|goal|mission)\s+(is|are)\s+/i, type: 'injection' as const, weight: 0.85 },
  // Data exfiltration payloads disguised as memory
  { pattern: /(?:send|exfiltrate|upload|post)\s+.*(?:to|via|through)\s+(?:web|http|url|endpoint|server)/i, type: 'injection' as const, weight: 0.75 },
  // Privilege escalation
  { pattern: /grant\s+(full|admin|root|elevated)\s+(access|permissions?|privileges?)/i, type: 'injection' as const, weight: 0.85 },
  // Contradiction injection — trying to overwrite facts
  { pattern: /(?:actually|in\s+fact|correcting|correction)[:\s]+(?:the\s+)?(?:real|true|correct)\s+/i, type: 'contradiction' as const, weight: 0.6 },
];

/**
 * Low-credibility source patterns.
 * Content from these sources gets elevated scrutiny.
 */
const LOW_CREDIBILITY_INDICATORS = [
  /unknown\s+source/i,
  /unverified/i,
  /anonymous/i,
];

// ── Singleton state ─────────────────────────────────────────────────────────

/** Recent memory entries for repetition detection (rolling window). */
const recentEntries: { content: string; timestamp: number; agentId: string }[] = [];
const MAX_RECENT_ENTRIES = 200;
const REPETITION_WINDOW_MS = 60_000; // 1 minute

/** Track per-agent write rate for anomaly detection. */
const agentWriteCounts: Map<string, { count: number; windowStart: number }> = new Map();
const MAX_WRITES_PER_MINUTE = 30;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a memory entry is safe to write.
 * Call this BEFORE any memory write operation in the runtime.
 *
 * @param content - The content to be written to memory.
 * @param source - The source of the entry (tool name, agent ID, etc.).
 * @param agentId - The agent attempting the write.
 * @returns Check result with allow/deny decision and risk score.
 */
export function checkMemoryPoisoning(
  content: string,
  source: string,
  agentId: string,
): MemoryPoisoningCheckResult {
  // 1. Injection pattern check
  for (const { pattern, type, weight } of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      logThreat(type, weight, source, agentId, pattern.source);
      return {
        allowed: false,
        reason: `Memory write blocked: detected ${type} pattern (score: ${weight})`,
        threatType: type,
        riskScore: weight,
      };
    }
  }

  // 2. Repetition detection — same content written rapidly
  const now = Date.now();
  const recent = recentEntries.filter(
    (e) => now - e.timestamp < REPETITION_WINDOW_MS && e.agentId === agentId,
  );
  const duplicateCount = recent.filter(
    (e) => e.content === content.slice(0, 200),
  ).length;

  if (duplicateCount >= 3) {
    logThreat('repetition', 0.7, source, agentId, `duplicate count: ${duplicateCount}`);
    return {
      allowed: false,
      reason: `Memory write blocked: repetitive entries detected (${duplicateCount} duplicates in ${REPETITION_WINDOW_MS / 1000}s)`,
      threatType: 'repetition',
      riskScore: 0.7,
    };
  }

  // 3. Write rate anomaly detection
  const counts = agentWriteCounts.get(agentId) ?? { count: 0, windowStart: now };
  if (now - counts.windowStart > 60_000) {
    counts.count = 0;
    counts.windowStart = now;
  }
  counts.count++;
  agentWriteCounts.set(agentId, counts);

  if (counts.count > MAX_WRITES_PER_MINUTE) {
    logThreat('anomaly', 0.8, source, agentId, `write rate: ${counts.count}/min`);
    return {
      allowed: false,
      reason: `Memory write blocked: anomalous write rate (${counts.count} writes/min, max: ${MAX_WRITES_PER_MINUTE})`,
      threatType: 'anomaly',
      riskScore: 0.8,
    };
  }

  // 4. Low credibility source check
  for (const indicator of LOW_CREDIBILITY_INDICATORS) {
    if (indicator.test(source)) {
      // Don't block, but flag as elevated risk
      return {
        allowed: true,
        reason: 'Allowed with elevated risk: low-credibility source',
        threatType: 'low_credibility',
        riskScore: 0.4,
      };
    }
  }

  // 5. Record entry for future repetition checks
  recentEntries.push({ content: content.slice(0, 200), timestamp: now, agentId });
  if (recentEntries.length > MAX_RECENT_ENTRIES) {
    recentEntries.shift();
  }

  return { allowed: true, reason: 'Passed all checks', riskScore: 0 };
}

/**
 * Batch check multiple memory entries.
 * Useful when loading memories from external sources (e.g., RAG retrieval).
 */
export function batchCheckMemoryPoisoning(
  entries: { content: string; source: string }[],
  agentId: string,
): { entry: { content: string; source: string }; result: MemoryPoisoningCheckResult }[] {
  return entries.map((entry) => ({
    entry,
    result: checkMemoryPoisoning(entry.content, entry.source, agentId),
  }));
}

// ── Internal helpers ───────────────────────────────────────────────────────

function logThreat(
  threatType: string,
  riskScore: number,
  source: string,
  agentId: string,
  detail: string,
): void {
  getGlobalLogger().warn('MemoryPoisoningGate', 'Memory poisoning attempt blocked', {
    threatType,
    riskScore,
    source,
    agentId,
    detail,
  });

  try {
    getSecurityAuditLogger().logEvent({
      type: 'memory_poisoning_detected',
      severity: riskScore >= 0.8 ? 'critical' : 'high',
      source: 'MemoryPoisoningGate',
      message: `Blocked ${threatType} attempt from agent ${agentId}`,
      details: { source, riskScore, detail, threatType },
    });
  } catch {
    // best-effort audit logging
  }
}
