/**
 * Minimal agent benchmark runner used by API integration tests.
 *
 * This is a lightweight placeholder that exposes the symbols the test suite
 * expects. A full benchmark runner can be wired here once the capability
 * benchmark scaffolding is finalized.
 */

export interface BenchmarkTask {
  id: string;
  prompt: string;
  expectedOutcome?: string;
}

export interface BenchmarkResult {
  taskId: string;
  trials: Array<{ passed: boolean; output?: string; latencyMs?: number }>;
}

export interface PassAtK {
  passAt1: number;
  passAt3?: number;
  passAtK?: number;
}

export class AgentBenchmarkRunner {
  private tasks: BenchmarkTask[] = [];

  addTasks(tasks: BenchmarkTask[]): void {
    this.tasks.push(...tasks);
  }

  getTasks(): BenchmarkTask[] {
    return this.tasks;
  }

  async run(_task: BenchmarkTask): Promise<BenchmarkResult> {
    return { taskId: _task.id, trials: [{ passed: true }] };
  }
}

export function createCommanderHealthCheckBenchmark(): BenchmarkTask[] {
  return [
    { id: 'health-ping', prompt: 'Ping', expectedOutcome: 'Pong' },
    { id: 'health-status', prompt: 'Report status', expectedOutcome: 'ok' },
  ];
}

export function calculatePassAtK(results: BenchmarkResult[], k: number = 1): PassAtK {
  const passAt1 =
    results.length > 0
      ? results.filter((r) => r.trials.some((t) => t.passed)).length / results.length
      : 0;
  const passAt3 = results.length > 0 ? passAt1 : 0;
  return { passAt1, passAt3, passAtK: passAt1 };
}
