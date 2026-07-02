import type { TraceEvent, ExecutionTrace } from '../../../runtime/types';

interface PromptVersion {
  versionId: string;
  promptHash: string;
  promptPreview: string;
  firstSeen: string;
  lastSeen: string;
  runCount: number;
  avgTokens: number;
  avgDurationMs: number;
  successRate: number;
}

interface PromptVersionDiff {
  versionA: string;
  versionB: string;
  similarity: number;
  tokenDelta: number;
  costDelta: number;
}

function hashPrompt(prompt: string): string {
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    const char = prompt.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function extractPrompt(event: TraceEvent): string | undefined {
  if (event.type !== 'llm_call') return undefined;
  if (typeof event.data.input === 'string') return event.data.input;
  if (event.data.input && typeof event.data.input === 'object') {
    const req = event.data.input as Record<string, unknown>;
    if (typeof req['messages'] === 'string') return req['messages'];
    if (Array.isArray(req['messages'])) return JSON.stringify(req['messages']);
  }
  return undefined;
}

export class PromptVersionTracker {
  private versions: Map<string, PromptVersion> = new Map();
  private eventVersions: Map<string, string> = new Map();

  recordEvent(event: TraceEvent): void {
    const prompt = extractPrompt(event);
    if (!prompt) return;

    const hash = hashPrompt(prompt);
    const versionId = `v-${hash}`;
    const preview = prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt;

    let version = this.versions.get(versionId);
    if (!version) {
      version = {
        versionId,
        promptHash: hash,
        promptPreview: preview,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        runCount: 0,
        avgTokens: 0,
        avgDurationMs: 0,
        successRate: 0,
      };
      this.versions.set(versionId, version);
    }

    version.lastSeen = event.timestamp;
    version.runCount++;

    const tokens = event.data.tokenUsage?.totalTokens ?? 0;
    version.avgTokens = (version.avgTokens * (version.runCount - 1) + tokens) / version.runCount;
    version.avgDurationMs =
      (version.avgDurationMs * (version.runCount - 1) + event.durationMs) / version.runCount;

    this.eventVersions.set(event.spanId, versionId);
  }

  recordFromTrace(trace: ExecutionTrace): void {
    for (const event of trace.events) this.recordEvent(event);
  }

  getVersion(versionId: string): PromptVersion | undefined {
    return this.versions.get(versionId);
  }

  getAllVersions(): PromptVersion[] {
    return Array.from(this.versions.values()).sort((a, b) => b.runCount - a.runCount);
  }

  getVersionForEvent(spanId: string): PromptVersion | undefined {
    const versionId = this.eventVersions.get(spanId);
    return versionId ? this.versions.get(versionId) : undefined;
  }

  compareVersions(versionIdA: string, versionIdB: string): PromptVersionDiff | undefined {
    const a = this.versions.get(versionIdA);
    const b = this.versions.get(versionIdB);
    if (!a || !b) return undefined;

    const shorter = Math.min(a.promptPreview.length, b.promptPreview.length);
    let matches = 0;
    for (let i = 0; i < shorter; i++) {
      if (a.promptPreview[i] === b.promptPreview[i]) matches++;
    }
    const similarity = shorter > 0 ? matches / shorter : 0;

    return {
      versionA: versionIdA,
      versionB: versionIdB,
      similarity,
      tokenDelta: b.avgTokens - a.avgTokens,
      costDelta: 0,
    };
  }

  getSummary(): {
    totalVersions: number;
    totalEvents: number;
    mostUsedVersion: PromptVersion | undefined;
    avgTokensByVersion: Array<{ versionId: string; avgTokens: number; runCount: number }>;
  } {
    const versions = this.getAllVersions();
    const totalEvents = versions.reduce((sum, v) => sum + v.runCount, 0);
    return {
      totalVersions: versions.length,
      totalEvents,
      mostUsedVersion: versions[0],
      avgTokensByVersion: versions.map((v) => ({
        versionId: v.versionId,
        avgTokens: v.avgTokens,
        runCount: v.runCount,
      })),
    };
  }
}

let globalTracker: PromptVersionTracker | null = null;

export function getPromptVersionTracker(): PromptVersionTracker {
  if (!globalTracker) globalTracker = new PromptVersionTracker();
  return globalTracker;
}

export function resetPromptVersionTracker(): void {
  globalTracker = null;
}
