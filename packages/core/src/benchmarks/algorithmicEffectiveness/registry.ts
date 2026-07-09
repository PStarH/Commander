import type { BenchmarkModule } from './types';
import { thompsonMemoryModule } from './modules/thompsonMemory';
import { dynamicCostGuardianModule } from './modules/dynamicCostGuardian';
import { parameterControllerModule } from './modules/parameterController';
import { strategySelectorModule } from './modules/strategySelector';
import { metaLearnerModule } from './modules/metaLearner';
import { modelRouterModule } from './modules/modelRouter';
import { smartModelRouterModule } from './modules/smartModelRouter';
import { effortScalerModule } from './modules/effortScaler';
import { topologyRouterModule } from './modules/topologyRouter';
import { tokenGovernorModule } from './modules/tokenGovernor';
import { executionRouterModule } from './modules/executionRouter';
import { llmRetryModule } from './modules/llmRetry';
import { circuitBreakerModule } from './modules/circuitBreaker';
import { costPredictorModule } from './modules/costPredictor';
import { modelCascadeControllerModule } from './modules/modelCascadeController';

const registry: Map<string, BenchmarkModule> = new Map();

export function registerModule(module: BenchmarkModule): void {
  registry.set(module.id, module);
}

export function getModule(id: string): BenchmarkModule {
  const mod = registry.get(id);
  if (!mod) throw new Error(`Benchmark module "${id}" not found`);
  return mod;
}

export function getRegisteredModuleIds(): string[] {
  return Array.from(registry.keys());
}

export function getAllModules(): BenchmarkModule[] {
  return Array.from(registry.values());
}

registerModule(thompsonMemoryModule);
registerModule(dynamicCostGuardianModule);
registerModule(parameterControllerModule);
registerModule(strategySelectorModule);
registerModule(metaLearnerModule);
registerModule(modelRouterModule);
registerModule(smartModelRouterModule);
registerModule(effortScalerModule);
registerModule(topologyRouterModule);
registerModule(tokenGovernorModule);
registerModule(executionRouterModule);
registerModule(llmRetryModule);
registerModule(circuitBreakerModule);
registerModule(costPredictorModule);
registerModule(modelCascadeControllerModule);
