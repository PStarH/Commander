/**
 * Evaluation Runner Infrastructure
 * Based on Anthropic's eval best practices
 * 
 * Key principles:
 * 1. Task = single test case with clear input + success criteria
 * 2. Trial = one attempt at a task (need multiple for non-determinism)
 * 3. Grader = scoring logic (code-based, model-based, or human)
 * 4. Transcript = complete execution record
 * 5. Outcome = final environment state (what actually happened)
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

export type GraderType = 'code-based' | 'model-based' | 'human';

export interface EvaluationTask {
  id: string;
  name: string;
  description: string;
  input: any;
  expectedOutcome?: any;
  timeoutMs?: number;
  metadata?: Record<string, any>;
}

export interface EvaluationTrial {
  id: string;
  taskId: string;
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout';
  startTime: string;
  endTime?: string;
  transcript: TranscriptEntry[];
  outcome?: TrialOutcome;
  error?: string;
}

export interface TranscriptEntry {
  timestamp: string;
  type: 'input' | 'output' | 'tool_call' | 'tool_result' | 'state_change' | 'error';
  data: any;
}

export interface TrialOutcome {
  success: boolean;
  result?: any;
  metrics: {
    durationMs: number;
    toolCalls: number;
    tokensUsed?: number;
    retryCount: number;
  };
}

export interface GraderResult {
  graderId: string;
  graderType: GraderType;
  passed: boolean;
  score?: number;
  explanation?: string;
  details?: any;
}

export interface Grader {
  id: string;
  type: GraderType;
  grade: (trial: EvaluationTrial) => Promise<GraderResult>;
}

// ============================================================================
// Code-Based Graders (Deterministic)
// ============================================================================

export class StringMatchGrader implements Grader {
  id: string;
  type: GraderType = 'code-based';
  
  constructor(
    id: string,
    private expected: string,
    private options: {
      exact?: boolean;
      caseSensitive?: boolean;
      regex?: boolean;
    } = {}
  ) {
    this.id = id;
  }
  
  async grade(trial: EvaluationTrial): Promise<GraderResult> {
    if (!trial.outcome?.result) {
      return {
        graderId: this.id,
        graderType: 'code-based',
        passed: false,
        explanation: 'No result to grade'
      };
    }
    
    const actual = String(trial.outcome.result);
    let passed = false;
    
    if (this.options.regex) {
      const regex = new RegExp(this.expected, this.options.caseSensitive ? '' : 'i');
      passed = regex.test(actual);
    } else if (this.options.exact) {
      passed = this.options.caseSensitive 
        ? actual === this.expected 
        : actual.toLowerCase() === this.expected.toLowerCase();
    } else {
      passed = this.options.caseSensitive
        ? actual.includes(this.expected)
        : actual.toLowerCase().includes(this.expected.toLowerCase());
    }
    
    return {
      graderId: this.id,
      graderType: 'code-based',
      passed,
      score: passed ? 1 : 0,
      explanation: passed 
        ? `Output matches expected: ${this.expected.substring(0, 50)}...`
        : `Output does not match. Expected: ${this.expected.substring(0, 50)}, Got: ${actual.substring(0, 50)}`,
      details: { expected: this.expected, actual }
    };
  }
}

export class ToolCallVerificationGrader implements Grader {
  id: string;
  type: GraderType = 'code-based';
  
  constructor(
    id: string,
    private options: {
      requiredTools?: string[];
      forbiddenTools?: string[];
      minToolCalls?: number;
      maxToolCalls?: number;
    } = {}
  ) {
    this.id = id;
  }
  
  async grade(trial: EvaluationTrial): Promise<GraderResult> {
    const toolCalls = trial.transcript
      .filter(e => e.type === 'tool_call')
      .map(e => e.data?.tool || e.data?.name);
    
    const uniqueTools = [...new Set(toolCalls)];
    
    // Check required tools
    if (this.options.requiredTools) {
      const missing = this.options.requiredTools.filter(t => !uniqueTools.includes(t));
      if (missing.length > 0) {
        return {
          graderId: this.id,
          graderType: 'code-based',
          passed: false,
          score: 0,
          explanation: `Missing required tools: ${missing.join(', ')}`,
          details: { required: this.options.requiredTools, actual: uniqueTools }
        };
      }
    }
    
    // Check forbidden tools
    if (this.options.forbiddenTools) {
      const used = this.options.forbiddenTools.filter(t => uniqueTools.includes(t));
      if (used.length > 0) {
        return {
          graderId: this.id,
          graderType: 'code-based',
          passed: false,
          score: 0,
          explanation: `Used forbidden tools: ${used.join(', ')}`,
          details: { forbidden: this.options.forbiddenTools, actual: uniqueTools }
        };
      }
    }
    
    // Check tool call count
    const callCount = toolCalls.length;
    if (this.options.minToolCalls !== undefined && callCount < this.options.minToolCalls) {
      return {
        graderId: this.id,
        graderType: 'code-based',
        passed: false,
        score: 0,
        explanation: `Too few tool calls: ${callCount} < ${this.options.minToolCalls}`,
        details: { min: this.options.minToolCalls, actual: callCount }
      };
    }
    
    if (this.options.maxToolCalls !== undefined && callCount > this.options.maxToolCalls) {
      return {
        graderId: this.id,
        graderType: 'code-based',
        passed: false,
        score: 0,
        explanation: `Too many tool calls: ${callCount} > ${this.options.maxToolCalls}`,
        details: { max: this.options.maxToolCalls, actual: callCount }
      };
    }
    
    return {
      graderId: this.id,
      graderType: 'code-based',
      passed: true,
      score: 1,
      explanation: `Tool call verification passed`,
      details: { toolsUsed: uniqueTools, callCount }
    };
  }
}

export class OutcomeVerificationGrader implements Grader {
  id: string;
  type: GraderType = 'code-based';
  
  constructor(
    id: string,
    private verifier: (outcome: any) => boolean | Promise<boolean>,
    private description?: string
  ) {
    this.id = id;
  }
  
  async grade(trial: EvaluationTrial): Promise<GraderResult> {
    if (!trial.outcome) {
      return {
        graderId: this.id,
        graderType: 'code-based',
        passed: false,
        explanation: 'No outcome to verify'
      };
    }
    
    try {
      const passed = await this.verifier(trial.outcome);
      return {
        graderId: this.id,
        graderType: 'code-based',
        passed,
        score: passed ? 1 : 0,
        explanation: this.description || (passed ? 'Outcome verified' : 'Outcome verification failed'),
        details: { outcome: trial.outcome }
      };
    } catch (error) {
      return {
        graderId: this.id,
        graderType: 'code-based',
        passed: false,
        score: 0,
        explanation: `Verifier error: ${error}`,
        details: { error: String(error) }
      };
    }
  }
}

// ============================================================================
// Evaluation Runner
// ============================================================================

export interface EvaluationRunConfig {
  trialsPerTask: number;
  timeoutMs: number;
  isolation: boolean; // Each trial from clean state
  parallel: boolean; // Run trials in parallel
}

export class EvaluationRunner {
  private trials: Map<string, EvaluationTrial[]> = new Map();
  private defaultConfig: EvaluationRunConfig = {
    trialsPerTask: 3,
    timeoutMs: 60000,
    isolation: true,
    parallel: false
  };
  
  /**
   * Run a single task for multiple trials
   */
  async runTask(
    task: EvaluationTask,
    agent: (input: any, transcript: TranscriptEntry[]) => Promise<any>,
    config: Partial<EvaluationRunConfig> = {}
  ): Promise<EvaluationTrial[]> {
    const cfg = { ...this.defaultConfig, ...config };
    const trials: EvaluationTrial[] = [];
    const runId = uuidv4();
    
    for (let i = 0; i < cfg.trialsPerTask; i++) {
      const trialId = uuidv4();
      const trial: EvaluationTrial = {
        id: trialId,
        taskId: task.id,
        runId,
        status: 'pending',
        startTime: new Date().toISOString(),
        transcript: []
      };
      
      trials.push(trial);
      
      try {
        trial.status = 'running';
        trial.transcript.push({
          timestamp: new Date().toISOString(),
          type: 'input',
          data: task.input
        });
        
        // Run agent with timeout
        const startTime = Date.now();
        let result: any;
        let timeoutReached = false;
        
        try {
          result = await Promise.race([
            agent(task.input, trial.transcript),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), task.timeoutMs || cfg.timeoutMs)
            )
          ]);
        } catch (error) {
          if (error instanceof Error && error.message === 'Timeout') {
            timeoutReached = true;
          } else {
            throw error;
          }
        }
        
        const durationMs = Date.now() - startTime;
        
        if (timeoutReached) {
          trial.status = 'timeout';
          trial.transcript.push({
            timestamp: new Date().toISOString(),
            type: 'error',
            data: { error: 'Timeout', durationMs }
          });
        } else {
          trial.status = 'completed';
          trial.transcript.push({
            timestamp: new Date().toISOString(),
            type: 'output',
            data: result
          });
          
          trial.outcome = {
            success: true,
            result,
            metrics: {
              durationMs,
              toolCalls: trial.transcript.filter(e => e.type === 'tool_call').length,
              retryCount: 0
            }
          };
        }
        
      } catch (error) {
        trial.status = 'failed';
        trial.error = String(error);
        trial.transcript.push({
          timestamp: new Date().toISOString(),
          type: 'error',
          data: { error: String(error) }
        });
      }
      
      trial.endTime = new Date().toISOString();
    }
    
    // Store trials
    const existing = this.trials.get(task.id) || [];
    this.trials.set(task.id, [...existing, ...trials]);
    
    return trials;
  }
  
  /**
   * Grade trials with multiple graders
   */
  async gradeTrials(
    trials: EvaluationTrial[],
    graders: Grader[]
  ): Promise<Map<string, GraderResult[]>> {
    const results = new Map<string, GraderResult[]>();
    
    for (const trial of trials) {
      const trialResults: GraderResult[] = [];
      
      for (const grader of graders) {
        const result = await grader.grade(trial);
        trialResults.push(result);
      }
      
      results.set(trial.id, trialResults);
    }
    
    return results;
  }
  
  /**
   * Calculate pass@k metric
   * Probability of at least one success in k trials
   */
  calculatePassAtK(
    trials: EvaluationTrial[],
    graderResults: Map<string, GraderResult[]>,
    k: number,
    requireAllGraders: boolean = true
  ): number {
    const n = trials.length;
    if (n === 0 || k > n) return 0;
    
    let successes = 0;
    for (let i = 0; i <= n - k; i++) {
      const subset = trials.slice(i, i + k);
      const anySuccess = subset.some(trial => {
        const results = graderResults.get(trial.id);
        if (!results) return false;
        
        if (requireAllGraders) {
          return results.every(r => r.passed);
        } else {
          return results.some(r => r.passed);
        }
      });
      
      if (anySuccess) successes++;
    }
    
    return successes / (n - k + 1);
  }
  
  /**
   * Calculate pass^k metric
   * Probability of all k trials succeeding
   */
  calculatePassExpK(
    trials: EvaluationTrial[],
    graderResults: Map<string, GraderResult[]>,
    k: number,
    requireAllGraders: boolean = true
  ): number {
    const n = trials.length;
    if (n === 0 || k > n) return 0;
    
    let allSuccessCount = 0;
    let totalCombinations = 0;
    
    for (let i = 0; i <= n - k; i++) {
      const subset = trials.slice(i, i + k);
      totalCombinations++;
      
      const allSuccess = subset.every(trial => {
        const results = graderResults.get(trial.id);
        if (!results) return false;
        
        if (requireAllGraders) {
          return results.every(r => r.passed);
        } else {
          return results.some(r => r.passed);
        }
      });
      
      if (allSuccess) allSuccessCount++;
    }
    
    return totalCombinations > 0 ? allSuccessCount / totalCombinations : 0;
  }
  
  /**
   * Get all trials for a task
   */
  getTrials(taskId: string): EvaluationTrial[] {
    return this.trials.get(taskId) || [];
  }
  
  /**
   * Get trial statistics
   */
  getStats(taskId: string): {
    total: number;
    completed: number;
    failed: number;
    timeout: number;
    avgDurationMs: number;
  } {
    const trials = this.trials.get(taskId) || [];
    
    const completed = trials.filter(t => t.status === 'completed').length;
    const failed = trials.filter(t => t.status === 'failed').length;
    const timeout = trials.filter(t => t.status === 'timeout').length;
    
    const durations = trials
      .filter(t => t.outcome)
      .map(t => t.outcome!.metrics.durationMs);
    
    const avgDurationMs = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    
    return {
      total: trials.length,
      completed,
      failed,
      timeout,
      avgDurationMs
    };
  }
}

// ============================================================================
// Trial Isolation Helper
// ============================================================================

export class TrialIsolation {
  private snapshots: Map<string, any> = new Map();
  
  /**
   * Save state before trial
   */
  saveState(trialId: string, state: any): void {
    this.snapshots.set(trialId, JSON.parse(JSON.stringify(state)));
  }
  
  /**
   * Restore state after trial
   */
  restoreState(trialId: string): any | null {
    const snapshot = this.snapshots.get(trialId);
    if (snapshot) {
      this.snapshots.delete(trialId);
      return JSON.parse(JSON.stringify(snapshot));
    }
    return null;
  }
  
  /**
   * Clear all snapshots
   */
  clear(): void {
    this.snapshots.clear();
  }
}

// ============================================================================
// Export Factory
// ============================================================================

export function createEvaluationRunner(config?: Partial<EvaluationRunConfig>): EvaluationRunner {
  const runner = new EvaluationRunner();
  if (config) {
    Object.assign(runner['defaultConfig'], config);
  }
  return runner;
}
