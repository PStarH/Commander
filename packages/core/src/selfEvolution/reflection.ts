import type { ExecutionExperience } from '../runtime/types';

export function generateReflection(exp: ExecutionExperience): string {
  if (exp.success) {
    const lessons = exp.lessons.length > 0
      ? exp.lessons.join('; ')
      : 'No specific lessons recorded.';
    return [
      `[Reflection: SUCCESS]`,
      `Task: ${exp.taskType} (${exp.strategyUsed})`,
      `Duration: ${exp.durationMs}ms, Cost: ${exp.tokenCost} tokens`,
      `Lessons: ${lessons}`,
      `Summary: The ${exp.strategyUsed} strategy worked well for this ${exp.taskType} task.`,
    ].join('\n');
  }

  // Failure analysis — identify root cause pattern
  const errorHint = exp.errorPattern
    ? `Error pattern: ${exp.errorPattern}`
    : 'No error pattern captured.';

  return [
    `[Reflection: FAILURE]`,
    `Task: ${exp.taskType} (${exp.strategyUsed})`,
    `Duration: ${exp.durationMs}ms, Cost: ${exp.tokenCost} tokens`,
    `${errorHint}`,
    `Analysis:`,
    `  - The ${exp.strategyUsed} strategy may not be optimal for ${exp.taskType} tasks`,
    `  - Consider: more tool access, different model tier, or alternative orchestration mode`,
    `  - If this pattern repeats, the strategy should be deprioritized`,
  ].join('\n');
}
