import * as fs from 'fs';
import * as path from 'path';
import type { LLMRequest, LLMResponse, ApiCallRecord } from './types';
import { extractCode, extractTaskId, isValidSolution } from './codeExtractor';

/**
 * Write-optimized audit trail for LLM API calls, verification results,
 * and evaluation samples. Every request/response pair is persisted as
 * a JSON Line — append-only, async-safe, easily greppable.
 *
 * Storage layout:
 *   .commander_samples/
 *   ├── llm_calls.ndjson        # All LLM request/response records
 *   ├── verifications.ndjson    # Verification results
 *   └── runs/
 *       └── {runId}.json        # Per-run manifest
 */
export class SamplesStore {
  private baseDir: string;
  private llmStream: fs.WriteStream | null = null;
  private verifStream: fs.WriteStream | null = null;
  private writeQueue: Array<() => Promise<void>> = [];
  private flushing = false;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), '.commander_samples');
    this.ensureDir();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Record an LLM API call. Thread-safe via write queue. */
  async recordLLMCall(
    request: LLMRequest,
    response: LLMResponse | null,
    params: {
      provider: string;
      durationMs: number;
      attemptNumber: number;
      error?: string;
      /** Evaluation task ID (e.g. "HumanEval/64") — triggers code extraction */
      taskId?: string;
      /** Pre-extracted solution code (skips auto-extraction) */
      extractedCode?: string;
    },
  ): Promise<string> {
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const content = response?.content ?? params.error ?? '';
    const record: ApiCallRecord = {
      callId,
      model: request.model,
      provider: params.provider,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      reasoningConfig: request.reasoningConfig,
      promptTokens: response?.usage.promptTokens ?? 0,
      completionTokens: response?.usage.completionTokens ?? 0,
      totalTokens: response?.usage.totalTokens ?? 0,
      durationMs: params.durationMs,
      finishReason: response?.finishReason ?? 'error',
      attemptNumber: params.attemptNumber,
      contentPrefix: content.slice(0, 500),
      extractedCode: params.extractedCode ?? (params.taskId ? extractCode(content) : undefined),
      error: params.error,
      taskId: params.taskId,
      timestamp: new Date().toISOString(),
    };

    this.enqueueWrite(() => this.appendLine('llm_calls.ndjson', record));
    return callId;
  }

  /** Record a verification result. */
  async recordVerification(
    goal: string,
    output: string,
    result: {
      passed: boolean;
      confidence: number;
      signalCount: number;
      tokensUsed: number;
      stagesRun: number[];
      skipReason?: string;
    },
  ): Promise<void> {
    const record = {
      timestamp: new Date().toISOString(),
      goalPrefix: goal.slice(0, 200),
      outputPrefix: output.slice(0, 200),
      passed: result.passed,
      confidence: result.confidence,
      signalCount: result.signalCount,
      tokensUsed: result.tokensUsed,
      stagesRun: result.stagesRun,
      skipReason: result.skipReason,
    };

    this.enqueueWrite(() => this.appendLine('verifications.ndjson', record));
  }

  /** Create a run manifest with full parameter provenance. */
  async recordRunManifest(runId: string, manifest: Record<string, unknown>): Promise<void> {
    const dir = path.join(this.baseDir, 'runs');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${runId}.json`);
    this.enqueueWrite(async () => {
      fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
    });
  }

  /** Drain all pending writes to disk. Call before shutdown. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    while (this.writeQueue.length > 0) {
      const task = this.writeQueue.shift();
      if (task) await task();
    }
    this.flushing = false;
    if (this.llmStream) { this.llmStream.end(); this.llmStream = null; }
    if (this.verifStream) { this.verifStream.end(); this.verifStream = null; }
  }

  /** Get total record count for llm_calls (approximate). */
  getCallCount(): number {
    return this.readAllLines('llm_calls.ndjson').length;
  }

  /** Get total record count for verifications (approximate). */
  getVerificationCount(): number {
    return this.readAllLines('verifications.ndjson').length;
  }

  // ---------------------------------------------------------------------------
  // EvalPlus Export
  // ---------------------------------------------------------------------------

  /**
   * Export recorded LLM calls as evalplus-compatible samples.jsonl.
   * Returns the file path of the written output.
   *
   * Output format per line:
   *   {"task_id": "HumanEval/64", "solution": "def ..."}
   *
   * Two modes:
   *  - Structured: records were stored with explicit taskId and extractedCode
   *  - Recovery: extracts taskId from contentPrefix, code from contentPrefix
   *             (works with any existing SamplesStore data)
   */
  exportEvalPlusSamples(outputPath?: string): string {
    const records = this.readAllRecords();
    const evalMap = new Map<string, string>();

    for (const r of records) {
      let taskId = r.taskId;
      let code = r.extractedCode;

      // Recovery mode: try to infer taskId from content
      if (!taskId) {
        taskId = extractTaskId(r.contentPrefix) ?? undefined;
      }
      if (!taskId) continue;

      // Recovery mode: auto-extract code from stored content
      if (!code && !r.error) {
        const fullContent = r.contentPrefix + (r.contentPrefix.length >= 500 ? '...' : '');
        code = extractCode(fullContent);
      }
      if (!code || !isValidSolution(code)) continue;

      // Prefer the latest successful attempt per task
      evalMap.set(taskId, code);
    }

    const evalEntries: string[] = [];
    for (const [taskId, solution] of evalMap) {
      evalEntries.push(JSON.stringify({ task_id: taskId, solution }));
    }

    const outPath = outputPath ?? path.join(this.baseDir, 'evalplus_samples.jsonl');
    fs.writeFileSync(outPath, evalEntries.join('\n') + '\n', 'utf-8');
    return outPath;
  }

  /**
   * Read all stored ApiCallRecords from disk, handling partial/corrupt lines.
   */
  readAllRecords(): ApiCallRecord[] {
    const lines = this.readAllLines('llm_calls.ndjson');
    const records: ApiCallRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as ApiCallRecord);
      } catch {
        // Skip corrupt lines silently
      }
    }
    return records;
  }

  /** Get the base directory path. */
  getBaseDir(): string {
    return this.baseDir;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private ensureDir(): void {
    fs.mkdirSync(path.join(this.baseDir, 'runs'), { recursive: true });
  }

  /** Enqueue a write task to serialise concurrent access. */
  private enqueueWrite(task: () => Promise<void>): void {
    this.writeQueue.push(task);
    if (!this.flushing) {
      this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.writeQueue.length > 0) {
      const task = this.writeQueue.shift();
      if (task) await task();
    }
  }

  /** Append a JSON line to a given file (creates stream on first use). */
  private async appendLine(fileName: string, data: unknown): Promise<void> {
    const filePath = path.join(this.baseDir, fileName);
    const line = JSON.stringify(data) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');
  }

  /** Read all non-empty lines from a file in the samples directory. */
  private readAllLines(fileName: string): string[] {
    const p = path.join(this.baseDir, fileName);
    if (!fs.existsSync(p)) return [];
    const content = fs.readFileSync(p, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(l => l.length > 0);
  }
}
