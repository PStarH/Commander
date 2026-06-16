import type { ExecutionTrace, TraceEvent } from '@commander/core';
import { buildTimeline } from './timelineBuilder';
import type { TimelineView } from './types';

interface EventDiff {
  type: 'added' | 'removed' | 'unchanged' | 'modified';
  spanId: string;
  event?: TraceEvent;
  changes?: string[];
}

interface TraceComparison {
  runIdA: string;
  runIdB: string;
  summary: {
    totalEventsA: number;
    totalEventsB: number;
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
  eventDiffs: EventDiff[];
  costDelta: {
    totalCostA: number;
    totalCostB: number;
    deltaUsd: number;
    deltaPercent: number;
  };
  tokenDelta: {
    totalTokensA: number;
    totalTokensB: number;
    delta: number;
    deltaPercent: number;
  };
  durationDelta: {
    durationA: number;
    durationB: number;
    deltaMs: number;
    deltaPercent: number;
  };
}

function eventsMatch(a: TraceEvent, b: TraceEvent): boolean {
  return a.type === b.type && a.agentId === b.agentId;
}

function computeChanges(a: TraceEvent, b: TraceEvent): string[] {
  const changes: string[] = [];
  if (a.data.modelInfo?.model !== b.data.modelInfo?.model) {
    changes.push(`model: ${a.data.modelInfo?.model ?? 'none'} → ${b.data.modelInfo?.model ?? 'none'}`);
  }
  if (a.data.tokenUsage?.totalTokens !== b.data.tokenUsage?.totalTokens) {
    changes.push(`tokens: ${a.data.tokenUsage?.totalTokens ?? 0} → ${b.data.tokenUsage?.totalTokens ?? 0}`);
  }
  if (a.durationMs !== b.durationMs) {
    changes.push(`duration: ${a.durationMs}ms → ${b.durationMs}ms`);
  }
  if (a.data.error !== b.data.error) {
    changes.push(`error: ${a.data.error ?? 'none'} → ${b.data.error ?? 'none'}`);
  }
  return changes;
}

export function compareTraces(traceA: ExecutionTrace, traceB: ExecutionTrace): TraceComparison {
  const eventsA = traceA.events;
  const eventsB = traceB.events;

  const matchedB = new Set<number>();
  const eventDiffs: EventDiff[] = [];

  for (const a of eventsA) {
    let found = false;
    for (let j = 0; j < eventsB.length; j++) {
      if (matchedB.has(j)) continue;
      const b = eventsB[j];
      if (eventsMatch(a, b)) {
        matchedB.add(j);
        const changes = computeChanges(a, b);
        eventDiffs.push({
          type: changes.length > 0 ? 'modified' : 'unchanged',
          spanId: a.spanId,
          event: a,
          changes: changes.length > 0 ? changes : undefined,
        });
        found = true;
        break;
      }
    }
    if (!found) {
      eventDiffs.push({ type: 'removed', spanId: a.spanId, event: a });
    }
  }

  for (let j = 0; j < eventsB.length; j++) {
    if (!matchedB.has(j)) {
      eventDiffs.push({ type: 'added', spanId: eventsB[j].spanId, event: eventsB[j] });
    }
  }

  const added = eventDiffs.filter(d => d.type === 'added').length;
  const removed = eventDiffs.filter(d => d.type === 'removed').length;
  const modified = eventDiffs.filter(d => d.type === 'modified').length;
  const unchanged = eventDiffs.filter(d => d.type === 'unchanged').length;

  const timelineA = buildTimeline(traceA);
  const timelineB = buildTimeline(traceB);
  const costA = timelineA.summary.totalCost.totalCostUsd;
  const costB = timelineB.summary.totalCost.totalCostUsd;
  const tokensA = timelineA.summary.totalTokens.total;
  const tokensB = timelineB.summary.totalTokens.total;
  const durationA = timelineA.totalDurationMs;
  const durationB = timelineB.totalDurationMs;

  return {
    runIdA: traceA.runId,
    runIdB: traceB.runId,
    summary: {
      totalEventsA: eventsA.length,
      totalEventsB: eventsB.length,
      added, removed, modified, unchanged,
    },
    eventDiffs,
    costDelta: {
      totalCostA: costA,
      totalCostB: costB,
      deltaUsd: costB - costA,
      deltaPercent: costA > 0 ? ((costB - costA) / costA) * 100 : 0,
    },
    tokenDelta: {
      totalTokensA: tokensA,
      totalTokensB: tokensB,
      delta: tokensB - tokensA,
      deltaPercent: tokensA > 0 ? ((tokensB - tokensA) / tokensA) * 100 : 0,
    },
    durationDelta: {
      durationA,
      durationB,
      deltaMs: durationB - durationA,
      deltaPercent: durationA > 0 ? ((durationB - durationA) / durationA) * 100 : 0,
    },
  };
}
