/**
 * DeterminismCapture + EventSourcingEngine integration tests.
 *
 * Verifies:
 * 1. captureLLMResponse/captureToolResponse → hasCaptures() returns true
 * 2. restoreFromWAL rebuilds in-memory state after simulated crash
 * 3. EventSourcingEngine.getEventsByCorrelationId retrieves by runId
 * 4. EventSourcingEngine.getWriteLatencyP95 reports append latency
 * 5. RunRecovery Path A activates after restoreFromWAL
 * 6. eventSourcingHealth includes p95 write latency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  EventSourcingEngine,
  getGlobalEventSourcingEngine,
  resetGlobalEventSourcingEngine,
} from '../../src/runtime/eventSourcingEngine';
import {
  DeterminismCapture,
  getGlobalDeterminismCapture,
  resetGlobalDeterminismCapture,
} from '../../src/runtime/determinismCapture';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { RunRecovery } from '../../src/runtime/runRecovery';
import { LeaseManager } from '../../src/atr/leaseManager';
import { checkEventSourcingHealth } from '../../src/runtime/eventSourcingHealth';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;
let walPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detcap-test-'));
  walPath = path.join(tmpDir, 'event-sourcing.wal');
  // Reset singletons for isolation
  resetGlobalEventSourcingEngine();
  resetGlobalDeterminismCapture();
  // Initialize engine with a tmp WAL path
  getGlobalEventSourcingEngine({ walPath });
});

afterEach(() => {
  resetGlobalEventSourcingEngine();
  resetGlobalDeterminismCapture();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DeterminismCapture', () => {
  it('hasCaptures returns false for unknown run', () => {
    const capture = getGlobalDeterminismCapture();
    expect(capture.hasCaptures('run-unknown')).toBe(false);
  });

  it('captureLLMResponse makes hasCaptures return true', () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-1', 1, { content: 'hello' });
    expect(capture.hasCaptures('run-1')).toBe(true);
    expect(capture.getCaptureCount('run-1')).toBe(1);
  });

  it('captureToolResponse makes hasCaptures return true', () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureToolResponse('run-2', 1, { output: 'result' });
    expect(capture.hasCaptures('run-2')).toBe(true);
  });

  it('clearRun removes in-memory captures', () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-3', 1, { content: 'x' });
    expect(capture.hasCaptures('run-3')).toBe(true);
    capture.clearRun('run-3');
    expect(capture.hasCaptures('run-3')).toBe(false);
  });

  it('buildReplayContext returns recorded values', () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-4', 1, { content: 'response-1' });
    capture.captureToolResponse('run-4', 2, { output: 'tool-1' });

    const ctx = capture.buildReplayContext('run-4');
    expect(ctx).not.toBeNull();
    expect(ctx!.isReplay).toBe(true);
    expect(ctx!.size()).toBe(2);
    expect(ctx!.has('llmResponse', 1)).toBe(true);
    expect(ctx!.has('toolResponse', 2)).toBe(true);
    expect(ctx!.getLLMResponse(1)).toEqual({ content: 'response-1' });
    expect(ctx!.getToolResponse(2)).toEqual({ output: 'tool-1' });
  });

  it('nextStep returns monotonically increasing step numbers', () => {
    const capture = getGlobalDeterminismCapture();
    expect(capture.nextStep('run-5')).toBe(1);
    expect(capture.nextStep('run-5')).toBe(2);
    expect(capture.nextStep('run-5')).toBe(3);
  });
});

describe('DeterminismCapture.restoreFromWAL', () => {
  it('rebuilds in-memory captures from WAL after simulated crash', async () => {
    const engine = getGlobalEventSourcingEngine();
    await engine.init();

    // Phase 1: capture during normal execution
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-crash', 1, { content: 'llm-1' });
    capture.captureToolResponse('run-crash', 2, { output: 'tool-1' });
    capture.captureLLMResponse('run-crash', 3, { content: 'llm-2' });
    expect(capture.hasCaptures('run-crash')).toBe(true);

    // Wait for async WAL writes to complete
    await new Promise((r) => setTimeout(r, 50));

    // Phase 2: simulate crash — clear in-memory state
    capture.clearRun('run-crash');
    expect(capture.hasCaptures('run-crash')).toBe(false);

    // Phase 3: restore from WAL
    const restored = capture.restoreFromWAL('run-crash');
    expect(restored).toBe(3);
    expect(capture.hasCaptures('run-crash')).toBe(true);

    // Verify restored data matches
    const ctx = capture.buildReplayContext('run-crash');
    expect(ctx).not.toBeNull();
    expect(ctx!.size()).toBe(3);
    expect(ctx!.getLLMResponse(1)).toEqual({ content: 'llm-1' });
    expect(ctx!.getToolResponse(2)).toEqual({ output: 'tool-1' });
    expect(ctx!.getLLMResponse(3)).toEqual({ content: 'llm-2' });
  });

  it('returns 0 for run with no captures in WAL', () => {
    const capture = getGlobalDeterminismCapture();
    const restored = capture.restoreFromWAL('run-nonexistent');
    expect(restored).toBe(0);
    expect(capture.hasCaptures('run-nonexistent')).toBe(false);
  });

  it('is idempotent — calling twice does not duplicate', async () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-idem', 1, { content: 'x' });
    await new Promise((r) => setTimeout(r, 50));

    capture.clearRun('run-idem');
    const first = capture.restoreFromWAL('run-idem');
    const second = capture.restoreFromWAL('run-idem');
    expect(first).toBe(second);
    expect(capture.getCaptureCount('run-idem')).toBe(1);
  });
});

describe('EventSourcingEngine.getEventsByCorrelationId', () => {
  it('returns events matching the correlationId', async () => {
    const engine = getGlobalEventSourcingEngine();
    await engine.init();

    await engine.append({
      type: 'test.event',
      payload: { a: 1 },
      correlationId: 'run-A',
    });
    await engine.append({
      type: 'test.event',
      payload: { b: 2 },
      correlationId: 'run-B',
    });
    await engine.append({
      type: 'test.event2',
      payload: { c: 3 },
      correlationId: 'run-A',
    });

    const eventsA = engine.getEventsByCorrelationId('run-A');
    expect(eventsA.length).toBe(2);
    expect(eventsA[0].payload).toEqual({ a: 1 });
    expect(eventsA[1].payload).toEqual({ c: 3 });

    const eventsB = engine.getEventsByCorrelationId('run-B');
    expect(eventsB.length).toBe(1);
  });

  it('returns empty array for unknown correlationId', () => {
    const engine = getGlobalEventSourcingEngine();
    expect(engine.getEventsByCorrelationId('unknown')).toEqual([]);
  });
});

describe('EventSourcingEngine.getWriteLatencyP95', () => {
  it('returns null when no writes recorded', () => {
    const engine = new EventSourcingEngine();
    expect(engine.getWriteLatencyP95()).toBeNull();
  });

  it('returns a number after appends', async () => {
    const engine = new EventSourcingEngine();
    await engine.init();
    await engine.append({ type: 't', payload: {} });
    await engine.append({ type: 't', payload: {} });
    await engine.append({ type: 't', payload: {} });
    const p95 = engine.getWriteLatencyP95();
    expect(p95).not.toBeNull();
    expect(typeof p95).toBe('number');
    expect(p95!).toBeGreaterThanOrEqual(0);
  });
});

describe('RunRecovery Path A (event replay)', () => {
  let checkpointer: StateCheckpointer;
  let leaseManager: LeaseManager;
  let recovery: RunRecovery;

  beforeEach(() => {
    checkpointer = new StateCheckpointer(tmpDir);
    leaseManager = new LeaseManager({ ttlMs: 60000, maxPerRun: 4 });
    recovery = new RunRecovery(checkpointer, leaseManager);
  });

  it('activates Path A after restoreFromWAL rebuilds captures from crash', async () => {
    const capture = getGlobalDeterminismCapture();
    const engine = getGlobalEventSourcingEngine();
    await engine.init();

    // Simulate pre-crash execution: captures were written to WAL
    capture.captureLLMResponse('run-replay-1', 1, { content: 'resp' });
    capture.captureToolResponse('run-replay-1', 2, { output: 'result' });

    // Wait for WAL persistence
    await new Promise((r) => setTimeout(r, 50));

    // Simulate crash: in-memory captures lost
    capture.clearRun('run-replay-1');
    expect(capture.hasCaptures('run-replay-1')).toBe(false);

    // Recovery attempt should restore from WAL and activate Path A
    const result = await recovery.attempt('run-replay-1');
    expect(result.status).toBe('recovered_via_replay');
    expect(result.strategy).toBe('replay');
    expect(result.replayContext).toBeDefined();
    expect(result.replayContext!.isReplay).toBe(true);
    expect(result.replayContext!.size()).toBe(2);
  });

  it('falls through to Path B (checkpoint) when no captures exist', async () => {
    const lease = leaseManager.acquire('run-no-capture').lease;
    checkpointer.checkpoint({
      runId: 'run-no-capture',
      agentId: 'agent-1',
      timestamp: new Date().toISOString(),
      phase: 'tool_execution',
      stepNumber: 2,
      attemptNumber: 1,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stepDurations: [],
      context: {
        agentId: 'agent-1',
        projectId: 'p',
        goal: 'g',
        availableTools: [],
        maxSteps: 10,
        tokenBudget: 1000,
      },
      totalDurationMs: 0,
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
    });

    const result = await recovery.attempt('run-no-capture');
    expect(result.status).toBe('recovered');
    expect(result.strategy).toBe('checkpoint');
  });

  it('falls through to Path C (not_found) when no captures and no checkpoint', async () => {
    const result = await recovery.attempt('run-nothing');
    expect(result.status).toBe('not_found');
    expect(result.strategy).toBe('none');
  });

  it('diagnose reports replay strategy when captures are available', async () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-diag', 1, { content: 'x' });
    await new Promise((r) => setTimeout(r, 50));

    const diag = recovery.diagnose('run-diag');
    expect(diag.hasCaptures).toBe(true);
    expect(diag.captureCount).toBe(1);
    expect(diag.recommendedStrategy).toBe('replay');
  });

  it('diagnose restores from WAL if in-memory is empty', async () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-diag-2', 1, { content: 'x' });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate crash
    capture.clearRun('run-diag-2');

    const diag = recovery.diagnose('run-diag-2');
    expect(diag.hasCaptures).toBe(true);
    expect(diag.recommendedStrategy).toBe('replay');
  });
});

describe('eventSourcingHealth p95 latency', () => {
  it('includes walWriteLatencyP95Ms in health result', async () => {
    const engine = getGlobalEventSourcingEngine();
    await engine.init();

    // Write some events to populate latency tracking
    for (let i = 0; i < 5; i++) {
      await engine.append({ type: 'health.test', payload: { i } });
    }

    const health = await checkEventSourcingHealth();
    expect(health.details).toBeDefined();
    expect(health.details!.walWriteLatencyP95Ms).toBeDefined();
    expect(health.details!.walWriteLatencyP95Ms).not.toBeNull();
    expect(typeof health.details!.walWriteLatencyP95Ms).toBe('number');
  });

  it('reports walWriteLatencyP95Ms as null when no writes recorded', async () => {
    // Fresh engine with no writes — reset to get a clean state
    resetGlobalEventSourcingEngine();
    const freshWalPath = path.join(tmpDir, 'fresh.wal');
    getGlobalEventSourcingEngine({ walPath: freshWalPath });

    const health = await checkEventSourcingHealth();
    expect(health.details).toBeDefined();
    // With no writes, p95 should be null
    expect(health.details!.walWriteLatencyP95Ms).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A+ gap coverage: chaos injection + cross-process WAL recovery e2e
// ─────────────────────────────────────────────────────────────────────────────

describe('Path A end-to-end replay correctness (chaos injection)', () => {
  /**
   * Critical determinism contract: replay returns the EXACT recorded value,
   * never a recomputed one. This is what makes Path A recovery safe —
   * a replayed run produces bit-identical results to the original.
   */
  it('replay context returns exactly the recorded values, not recomputed', () => {
    const capture = getGlobalDeterminismCapture();
    const originalLLM = {
      content: 'final answer',
      toolCalls: [{ id: 'tc-1', name: 'search', args: { q: 'a' } }],
    };
    const originalTool = { output: 'search-result-payload', metadata: { hits: 3 } };

    capture.captureLLMResponse('run-chaos-1', 1, originalLLM);
    capture.captureToolResponse('run-chaos-1', 2, originalTool);

    const ctx = capture.buildReplayContext('run-chaos-1');
    expect(ctx).not.toBeNull();
    expect(ctx!.isReplay).toBe(true);

    // Read each captured value multiple times — must be referentially stable
    const llmA = ctx!.getLLMResponse(1);
    const llmB = ctx!.getLLMResponse(1);
    expect(llmA).toBe(originalLLM); // referential equality — no copy/recompute
    expect(llmB).toBe(originalLLM);

    const toolA = ctx!.getToolResponse(2);
    const toolB = ctx!.getToolResponse(2);
    expect(toolA).toBe(originalTool);
    expect(toolB).toBe(originalTool);
  });

  it('replay context is a frozen snapshot — later captures do not mutate it', () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-chaos-2', 1, { content: 'v1' });

    const ctx = capture.buildReplayContext('run-chaos-2');
    expect(ctx!.size()).toBe(1);
    expect(ctx!.getLLMResponse(1)).toEqual({ content: 'v1' });

    // Capture more inputs AFTER the replay context was built
    capture.captureLLMResponse('run-chaos-2', 2, { content: 'v2' });
    capture.captureToolResponse('run-chaos-2', 3, { output: 'tool' });

    // The previously-built context must NOT see the new captures —
    // it is a point-in-time snapshot, not a live view.
    expect(ctx!.size()).toBe(1);
    expect(ctx!.has('llmResponse', 2)).toBe(false);
    expect(ctx!.has('toolResponse', 3)).toBe(false);

    // A freshly-built context DOES see them
    const ctx2 = capture.buildReplayContext('run-chaos-2');
    expect(ctx2!.size()).toBe(3);
  });

  it('replay context survives clearRun — snapshot remains usable', () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-chaos-3', 1, { content: 'persisted' });
    capture.captureToolResponse('run-chaos-3', 2, { output: 'persisted-tool' });

    const ctx = capture.buildReplayContext('run-chaos-3');

    // Simulate post-build cleanup (as agentRuntime.ts:2722 does in finally)
    capture.clearRun('run-chaos-3');
    expect(capture.hasCaptures('run-chaos-3')).toBe(false);

    // The snapshot is still usable — recovery code can keep reading from it
    expect(ctx!.size()).toBe(2);
    expect(ctx!.getLLMResponse(1)).toEqual({ content: 'persisted' });
    expect(ctx!.getToolResponse(2)).toEqual({ output: 'persisted-tool' });
  });

  it('has() correctly distinguishes captured vs uncaptured steps', () => {
    const capture = getGlobalDeterminismCapture();
    capture.captureLLMResponse('run-chaos-4', 1, { content: 'a' });
    capture.captureLLMResponse('run-chaos-4', 3, { content: 'b' });

    const ctx = capture.buildReplayContext('run-chaos-4');
    expect(ctx!.has('llmResponse', 1)).toBe(true);
    expect(ctx!.has('llmResponse', 3)).toBe(true);
    expect(ctx!.has('llmResponse', 2)).toBe(false); // gap
    expect(ctx!.has('toolResponse', 1)).toBe(false); // different type
    expect(ctx!.has('timestamp', 1)).toBe(false); // not captured
  });

  it('recovered_via_replay result carries a usable replayContext', async () => {
    const checkpointer = new StateCheckpointer(tmpDir);
    const leaseManager = new LeaseManager({ ttlMs: 60000, maxPerRun: 4 });
    const recovery = new RunRecovery(checkpointer, leaseManager);

    const capture = getGlobalDeterminismCapture();
    const engine = getGlobalEventSourcingEngine();
    await engine.init();

    // Pre-crash: capture two LLM responses + one tool response
    capture.captureLLMResponse('run-chaos-5', 1, { content: 'step1' });
    capture.captureToolResponse('run-chaos-5', 2, { output: 'step2-tool' });
    capture.captureLLMResponse('run-chaos-5', 3, { content: 'step3' });

    await new Promise((r) => setTimeout(r, 50));

    // Crash — wipe in-memory state
    capture.clearRun('run-chaos-5');

    // Recovery must: (1) restore from WAL, (2) activate Path A,
    // (3) return a replayContext that yields the original captured values
    const result = await recovery.attempt('run-chaos-5');
    expect(result.status).toBe('recovered_via_replay');
    expect(result.strategy).toBe('replay');
    expect(result.replayContext).toBeDefined();
    expect(result.replayContext!.isReplay).toBe(true);
    expect(result.replayContext!.size()).toBe(3);

    // The replay context must yield the EXACT original values —
    // this is the determinism contract that makes Path A safe.
    expect(result.replayContext!.getLLMResponse(1)).toEqual({ content: 'step1' });
    expect(result.replayContext!.getToolResponse(2)).toEqual({ output: 'step2-tool' });
    expect(result.replayContext!.getLLMResponse(3)).toEqual({ content: 'step3' });
  });
});

describe('Cross-process WAL recovery (e2e)', () => {
  /**
   * Simulates a process crash and restart: Process A writes captures to WAL
   * but loses in-memory state on crash. Process B starts up with a fresh
   * memory space, loads the existing WAL from disk, and must be able to
   * restore captures and activate Path A recovery.
   *
   * This validates the full crash-recovery chain:
   *   disk WAL → engine.init() → getEventsByCorrelationId
   *   → restoreFromWAL → buildReplayContext → RunRecovery Path A
   */
  it('Process B restores captures from Process A\'s WAL file', async () => {
    const crossProcessWalPath = path.join(tmpDir, 'cross-process.wal');

    // ── Process A: write captures, then "crash" ───────────────────────
    resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
    getGlobalEventSourcingEngine({ walPath: crossProcessWalPath });
    const captureA = getGlobalDeterminismCapture();
    const engineA = getGlobalEventSourcingEngine();
    await engineA.init();

    captureA.captureLLMResponse('run-xproc-1', 1, { content: 'proc-A-llm-1' });
    captureA.captureToolResponse('run-xproc-1', 2, { output: 'proc-A-tool-1' });
    captureA.captureLLMResponse('run-xproc-1', 3, { content: 'proc-A-llm-2' });

    // Wait for async WAL writes to flush to disk
    await new Promise((r) => setTimeout(r, 80));

    // Verify WAL file actually has content on disk
    const walStats = fs.statSync(crossProcessWalPath);
    expect(walStats.size).toBeGreaterThan(0);

    // ── Process B: fresh memory, same WAL file ────────────────────────
    // Resetting singletons simulates a new process — in-memory state is gone
    resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();

    // Process B initializes the engine with the SAME walPath — init() must
    // read the existing WAL file from disk and load events into memory
    getGlobalEventSourcingEngine({ walPath: crossProcessWalPath });
    const engineB = getGlobalEventSourcingEngine();
    await engineB.init();

    // Process B's engine must see Process A's events
    const events = engineB.getEventsByCorrelationId('run-xproc-1');
    expect(events.length).toBe(3);
    expect(events.every((e) => e.type.startsWith('determinism.'))).toBe(true);

    // Hash-chain integrity must survive across the "process boundary"
    const integrityOk = await engineB.verifyIntegrity();
    expect(integrityOk).toBe(true);

    // Process B's capture (fresh instance) must restore from WAL
    const captureB = getGlobalDeterminismCapture();
    expect(captureB.hasCaptures('run-xproc-1')).toBe(false); // nothing yet
    const restored = captureB.restoreFromWAL('run-xproc-1');
    expect(restored).toBe(3);
    expect(captureB.hasCaptures('run-xproc-1')).toBe(true);

    // Restored values must match Process A's original captures
    const ctx = captureB.buildReplayContext('run-xproc-1');
    expect(ctx).not.toBeNull();
    expect(ctx!.size()).toBe(3);
    expect(ctx!.getLLMResponse(1)).toEqual({ content: 'proc-A-llm-1' });
    expect(ctx!.getToolResponse(2)).toEqual({ output: 'proc-A-tool-1' });
    expect(ctx!.getLLMResponse(3)).toEqual({ content: 'proc-A-llm-2' });
  });

  it('Process B activates Path A recovery using Process A\'s WAL', async () => {
    const crossProcessWalPath = path.join(tmpDir, 'cross-process-recovery.wal');

    // ── Process A: write captures and "crash" ─────────────────────────
    resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
    getGlobalEventSourcingEngine({ walPath: crossProcessWalPath });
    const captureA = getGlobalDeterminismCapture();
    const engineA = getGlobalEventSourcingEngine();
    await engineA.init();

    captureA.captureLLMResponse('run-xproc-2', 1, { content: 'pre-crash-llm' });
    captureA.captureToolResponse('run-xproc-2', 2, { output: 'pre-crash-tool' });

    await new Promise((r) => setTimeout(r, 80));

    // ── Process B: fresh process, same WAL ────────────────────────────
    resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
    getGlobalEventSourcingEngine({ walPath: crossProcessWalPath });
    const engineB = getGlobalEventSourcingEngine();
    await engineB.init();

    // Process B's RunRecovery must activate Path A end-to-end
    const checkpointer = new StateCheckpointer(tmpDir);
    const leaseManager = new LeaseManager({ ttlMs: 60000, maxPerRun: 4 });
    const recovery = new RunRecovery(checkpointer, leaseManager);

    const result = await recovery.attempt('run-xproc-2');
    expect(result.status).toBe('recovered_via_replay');
    expect(result.strategy).toBe('replay');
    expect(result.replayContext).toBeDefined();
    expect(result.replayContext!.size()).toBe(2);

    // The replay context must yield Process A's original values —
    // this proves crash recovery is transparent to the caller.
    expect(result.replayContext!.getLLMResponse(1)).toEqual({ content: 'pre-crash-llm' });
    expect(result.replayContext!.getToolResponse(2)).toEqual({ output: 'pre-crash-tool' });
  });

  it('multiple runs in the same WAL are independently restorable', async () => {
    const sharedWalPath = path.join(tmpDir, 'multi-run.wal');

    resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
    getGlobalEventSourcingEngine({ walPath: sharedWalPath });
    const captureA = getGlobalDeterminismCapture();
    const engineA = getGlobalEventSourcingEngine();
    await engineA.init();

    // Process A interleaves captures across two runs
    captureA.captureLLMResponse('run-multi-A', 1, { content: 'A-1' });
    captureA.captureLLMResponse('run-multi-B', 1, { content: 'B-1' });
    captureA.captureToolResponse('run-multi-A', 2, { output: 'A-tool' });
    captureA.captureLLMResponse('run-multi-B', 2, { content: 'B-2' });

    await new Promise((r) => setTimeout(r, 80));

    // ── Process B ─────────────────────────────────────────────────────
    resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
    getGlobalEventSourcingEngine({ walPath: sharedWalPath });
    const engineB = getGlobalEventSourcingEngine();
    await engineB.init();

    const captureB = getGlobalDeterminismCapture();

    // Restore run A — must get only run A's captures, not B's
    const restoredA = captureB.restoreFromWAL('run-multi-A');
    expect(restoredA).toBe(2);
    const ctxA = captureB.buildReplayContext('run-multi-A');
    expect(ctxA!.size()).toBe(2);
    expect(ctxA!.getLLMResponse(1)).toEqual({ content: 'A-1' });
    expect(ctxA!.getToolResponse(2)).toEqual({ output: 'A-tool' });

    // Restore run B — independently
    const restoredB = captureB.restoreFromWAL('run-multi-B');
    expect(restoredB).toBe(2);
    const ctxB = captureB.buildReplayContext('run-multi-B');
    expect(ctxB!.size()).toBe(2);
    expect(ctxB!.getLLMResponse(1)).toEqual({ content: 'B-1' });
    expect(ctxB!.getLLMResponse(2)).toEqual({ content: 'B-2' });

    // Run A's context is NOT contaminated by Run B's restore
    expect(ctxA!.has('llmResponse', 2)).toBe(false);
  });

  it('WAL hash-chain integrity is preserved across crash-restart cycles', async () => {
    const integrityWalPath = path.join(tmpDir, 'integrity.wal');

    // Process A: write captures
    resetGlobalEventSourcingEngine();
    getGlobalEventSourcingEngine({ walPath: integrityWalPath });
    const engineA = getGlobalEventSourcingEngine();
    await engineA.init();

    const captureA = getGlobalDeterminismCapture();
    captureA.captureLLMResponse('run-integ', 1, { content: 'a' });
    captureA.captureToolResponse('run-integ', 2, { output: 'b' });
    captureA.captureLLMResponse('run-integ', 3, { content: 'c' });

    await new Promise((r) => setTimeout(r, 80));

    // Verify integrity on Process A
    expect(await engineA.verifyIntegrity()).toBe(true);

    // Crash + Process B
    resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
    getGlobalEventSourcingEngine({ walPath: integrityWalPath });
    const engineB = getGlobalEventSourcingEngine();
    await engineB.init();

    // Hash chain must be intact after reload from disk
    expect(await engineB.verifyIntegrity()).toBe(true);

    // Process B can append a new event — chain must remain consistent
    const captureB = getGlobalDeterminismCapture();
    // restoreFromWAL doesn't append; we need to write a new event to verify
    // the chain extends correctly. Use the engine directly.
    await engineB.append({
      type: 'determinism.llmResponse',
      payload: { runId: 'run-integ', step: 4, value: { content: 'd' } },
      correlationId: 'run-integ',
    });

    // Chain must still verify after a cross-process append
    expect(await engineB.verifyIntegrity()).toBe(true);

    // Total events: 3 from Process A + 1 from Process B = 4
    const events = engineB.getEventsByCorrelationId('run-integ');
    expect(events.length).toBe(4);
  });
});
