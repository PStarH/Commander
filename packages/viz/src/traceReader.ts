/**
 * traceReader.ts — Reads execution trace data from .commander_traces/ NDJSON files
 * and from the in-memory ExecutionTraceRecorder.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExecutionData, TraceEvent } from './topology';

// ---------------------------------------------------------------------------
// File Reader — reads .commander_traces/{runId}.ndjson
// ---------------------------------------------------------------------------

export interface TraceFileInfo {
  runId: string;
  filePath: string;
  size: number;
  modifiedAt: Date;
}

/**
 * List available trace files from the .commander_traces/ directory.
 */
export function listTraceFiles(tracesDir?: string): TraceFileInfo[] {
  const dir = tracesDir || path.join(process.cwd(), '.commander_traces');
  try {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: TraceFileInfo[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.ndjson')) {
        const fp = path.join(dir, entry.name);
        const stat = fs.statSync(fp);
        files.push({
          runId: entry.name.replace(/\.ndjson$/, ''),
          filePath: fp,
          size: stat.size,
          modifiedAt: stat.mtime,
        });
      }
    }
    return files.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  } catch {
    return [];
  }
}

/**
 * Read a single trace file and parse its NDJSON events into ExecutionData.
 */
export function readTraceFile(filePath: string): ExecutionData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const events: TraceEvent[] = [];
    let runId = '';
    let agentId = 'unknown';
    let startedAt = '';
    let completedAt = '';

    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.runId && !runId) runId = ev.runId;
        if (ev.agentId && agentId === 'unknown') agentId = ev.agentId;
        if (ev.timestamp) {
          if (!startedAt || ev.timestamp < startedAt) startedAt = ev.timestamp;
          if (!completedAt || ev.timestamp > completedAt) completedAt = ev.timestamp;
        }
      } catch {
        // skip malformed lines
      }
    }

    if (events.length === 0) return null;

    return {
      runId,
      agentId,
      startedAt,
      completedAt,
      events,
      summary: computeSummary(events),
    };
  } catch {
    return null;
  }
}

/**
 * Read the most recent trace file.
 */
export function readLatestTrace(tracesDir?: string): ExecutionData | null {
  const files = listTraceFiles(tracesDir);
  if (files.length === 0) return null;
  return readTraceFile(files[0].filePath);
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

export function computeSummary(events: TraceEvent[]): ExecutionData['summary'] {
  let totalDurationMs = 0;
  let totalTokens = 0;
  let llmCalls = 0;
  let toolExecutions = 0;
  let errors = 0;
  const models = new Set<string>();

  for (const ev of events) {
    totalDurationMs += ev.durationMs || 0;
    if (ev.type === 'llm_call') {
      llmCalls++;
      totalTokens += ev.data?.tokenUsage?.totalTokens ?? 0;
      if (ev.data?.modelInfo?.model) models.add(ev.data.modelInfo.model);
    } else if (ev.type === 'tool_execution') {
      toolExecutions++;
    } else if (ev.type === 'error') {
      errors++;
    }
  }

  return {
    totalEvents: events.length,
    totalDurationMs,
    totalTokens,
    llmCalls,
    toolExecutions,
    errors,
    modelUsed: Array.from(models).join(', '),
  };
}
