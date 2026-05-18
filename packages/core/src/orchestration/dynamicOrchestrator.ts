/**
 * @experimental — Orchestrator variant not connected to the main execution flow.
 */
import type { OrchestrationTopology } from '../ultimate/types';

export interface TaskStep {
  id: string;
  goal: string;
  requiredTools: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: string;
  error?: string;
  dependsOn: string[];
  estimatedDifficulty: 'easy' | 'medium' | 'hard';
  fallbackStrategy?: 'retry' | 'alternative_tool' | 'simplify' | 'ask_user' | 'skip';
}

export interface ExecutionContext {
  stepHistory: TaskStep[];
  completedTools: Set<string>;
  failedTools: Set<string>;
  currentDepth: number;
  currentGoal: string;
}

export class DynamicOrchestrator {
  private maxDepth = 10;
  private maxRetriesPerStep = 2;

  constructor(maxDepth = 10) {
    this.maxDepth = maxDepth;
  }

  /**
   * Dynamically plan the next step based on current context.
   * Re-evaluates the tool chain after each step completion.
   * This is the core improvement for GAIA-style adaptive tasks.
   */
  planNextStep(context: ExecutionContext, availableTools: string[]): TaskStep | null {
    if (context.currentDepth >= this.maxDepth) return null;
    if (context.stepHistory.length > 0) {
      const lastStep = context.stepHistory[context.stepHistory.length - 1];
      if (lastStep.status === 'failed') {
        return this.getRecoveryStep(lastStep, context, availableTools);
      }
    }

    const goal = context.currentGoal.toLowerCase();
    const usedTools = context.completedTools;

    if (!usedTools.has('web_search') && (goal.includes('search') || goal.includes('find') || goal.includes('latest') || goal.includes('current') || goal.includes('research'))) {
      return { id: `step-${context.stepHistory.length + 1}`, goal: 'Search for relevant information', requiredTools: ['web_search'], status: 'pending', dependsOn: [], estimatedDifficulty: 'easy', fallbackStrategy: 'alternative_tool' };
    }

    if (!usedTools.has('web_fetch') && usedTools.has('web_search')) {
      return { id: `step-${context.stepHistory.length + 1}`, goal: 'Fetch details from search results', requiredTools: ['web_fetch'], status: 'pending', dependsOn: [context.stepHistory.find(s => s.requiredTools.includes('web_search'))?.id || ''], estimatedDifficulty: 'easy', fallbackStrategy: 'retry' };
    }

    if ((goal.includes('image') || goal.includes('screenshot') || goal.includes('diagram') || goal.includes('visual')) && !usedTools.has('vision_analyze')) {
      return { id: `step-${context.stepHistory.length + 1}`, goal: 'Analyze visual information', requiredTools: ['vision_analyze'], status: 'pending', dependsOn: [], estimatedDifficulty: 'medium', fallbackStrategy: 'simplify' };
    }

    if (goal.includes('code') || goal.includes('implement') || goal.includes('function') || goal.includes('script') || goal.includes('python')) {
      if (!usedTools.has('code_search')) {
        return { id: `step-${context.stepHistory.length + 1}`, goal: 'Search existing code for reference', requiredTools: ['code_search'], status: 'pending', dependsOn: [], estimatedDifficulty: 'easy', fallbackStrategy: 'skip' };
      }
      if (!usedTools.has('refine_code')) {
        return { id: `step-${context.stepHistory.length + 1}`, goal: 'Implement and verify code', requiredTools: ['refine_code'], status: 'pending', dependsOn: [], estimatedDifficulty: 'hard', fallbackStrategy: 'simplify' };
      }
    }

    if ((goal.includes('calculate') || goal.includes('compute') || goal.includes('math')) && !usedTools.has('python_execute')) {
      return { id: `step-${context.stepHistory.length + 1}`, goal: 'Perform computation', requiredTools: ['python_execute'], status: 'pending', dependsOn: [], estimatedDifficulty: 'medium', fallbackStrategy: 'simplify' };
    }

    if (!usedTools.has('verify_answer') && context.stepHistory.length > 2) {
      return { id: `step-${context.stepHistory.length + 1}`, goal: 'Verify answer format', requiredTools: ['verify_answer'], status: 'pending', dependsOn: [], estimatedDifficulty: 'easy', fallbackStrategy: 'simplify' };
    }

    return null;
  }

  private getRecoveryStep(failedStep: TaskStep, context: ExecutionContext, availableTools: string[]): TaskStep | null {
    const retryCount = context.stepHistory.filter(s => s.id === failedStep.id).length;
    if (retryCount < this.maxRetriesPerStep && failedStep.fallbackStrategy === 'retry') {
      return { ...failedStep, id: `${failedStep.id}-retry-${retryCount + 1}`, status: 'pending', error: undefined };
    }

    if (failedStep.fallbackStrategy === 'alternative_tool') {
      const alternatives: Record<string, string[]> = {
        'web_search': ['web_fetch'],
        'python_execute': ['shell_execute'],
        'vision_analyze': ['file_read'],
        'code_search': ['grep', 'file_search'],
      };
      const altTools = alternatives[failedStep.requiredTools[0]] || [];
      const availableAlt = altTools.find(t => availableTools.includes(t));
      if (availableAlt) {
        return { id: `${failedStep.id}-alt`, goal: `${failedStep.goal} (alternative approach)`, requiredTools: [availableAlt], status: 'pending', dependsOn: [], estimatedDifficulty: 'medium', fallbackStrategy: 'simplify' };
      }
    }
    return null;
  }

  async executeStep(step: TaskStep, executeTool: (name: string, args: Record<string, unknown>) => Promise<string>): Promise<string> {
    step.status = 'running';
    try {
      const result = await executeTool(step.requiredTools[0], { prompt: step.goal });
      step.status = 'completed';
      step.result = result;
      return result;
    } catch (err: any) {
      step.status = 'failed';
      step.error = err.message;
      throw err;
    }
  }
}
