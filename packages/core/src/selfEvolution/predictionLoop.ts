import type {
  ExecutionExperience,
  EvolutionPrediction,
  FailureCategory,
  PredictionVerdict,
} from '../runtime/types';
import { getMessageBus } from '../runtime/messageBus';
import { getMetricsCollector } from '../runtime/metricsCollector';

export class PredictionLoop {
  private predictions: EvolutionPrediction[] = [];
  private verdicts: PredictionVerdict[] = [];
  /** Tracks last strategy selected per (modelId, taskType) for change detection */
  private lastPredictedStrategy: Map<string, string> = new Map();
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  createPrediction(
    editId: string,
    description: string,
    targetStrategy: string,
    sourceStrategy: string,
    modelId: string,
    taskTypes: string[],
    predictedFixes: FailureCategory[] = [],
    predictedRegressions: FailureCategory[] = [],
  ): EvolutionPrediction {
    const prediction: EvolutionPrediction = {
      id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      editId,
      description,
      predictedFixes,
      predictedRegressions,
      targetStrategy,
      sourceStrategy,
      modelId,
      taskTypes,
      timestamp: new Date().toISOString(),
    };
    this.predictions.push(prediction);
    if (this.predictions.length > 500) this.predictions.shift();
    return prediction;
  }

  recordExperience(exp: ExecutionExperience): void {
    if (!this.enabled) return;
    this.verifyPrediction(exp);
  }

  getPredictions(): EvolutionPrediction[] {
    return [...this.predictions];
  }

  getVerdicts(): PredictionVerdict[] {
    return [...this.verdicts];
  }

  getLastPredictedStrategy(): Map<string, string> {
    return this.lastPredictedStrategy;
  }

  setPredictions(predictions: EvolutionPrediction[]): void {
    this.predictions = predictions;
  }

  setVerdicts(verdicts: PredictionVerdict[]): void {
    this.verdicts = verdicts;
  }

  setLastPredictedStrategy(map: Map<string, string>): void {
    this.lastPredictedStrategy = map;
  }

  private verifyPrediction(exp: ExecutionExperience): void {
    if (!this.enabled) return;

    const key = `${exp.modelUsed}::${exp.taskType}`;
    const previousStrategy = this.lastPredictedStrategy.get(key);
    if (!previousStrategy || previousStrategy === exp.strategyUsed) return;

    // Strategy changed — find relevant prediction
    const relevant = this.predictions.filter(
      (p) =>
        p.targetStrategy === exp.strategyUsed &&
        p.modelId === exp.modelUsed &&
        p.taskTypes.includes(exp.taskType),
    );

    for (const pred of relevant) {
      const fixConfirmed = pred.predictedFixes.length === 0 ? exp.success : true;
      const regressObserved = !exp.success && pred.predictedRegressions.length > 0;

      const verdict: PredictionVerdict = {
        predictionId: pred.id,
        fixesConfirmed: fixConfirmed ? ['confirmed'] : [],
        regressionsObserved: regressObserved ? ['observed'] : [],
        netImpact: exp.success ? 'positive' : 'negative',
        reverted: false,
        verifiedAt: new Date().toISOString(),
      };

      this.verdicts.push(verdict);
      if (this.verdicts.length > 500) this.verdicts.shift();

      // Record prediction verdict metric (skip neutral)
      if (verdict.netImpact !== 'neutral') {
        getMetricsCollector().recordPredictionVerdict(verdict.netImpact);
      }

      const bus = getMessageBus();
      bus.publish('memory.written', 'meta-learner', {
        type: 'prediction_verdict',
        predictionId: pred.id,
        netImpact: verdict.netImpact,
      });
    }
  }
}
