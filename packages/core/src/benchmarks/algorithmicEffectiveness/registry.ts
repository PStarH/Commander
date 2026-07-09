import type { BenchmarkModule } from './types';
import { thompsonMemoryModule } from './modules/thompsonMemory';
import { adaptiveStoppingModule } from './modules/adaptiveStopping';
import { swarmOrchestratorModule } from './modules/swarmOrchestrator';
import { dynamicCostGuardianModule } from './modules/dynamicCostGuardian';
import { parameterControllerModule } from './modules/parameterController';
import { strategySelectorModule } from './modules/strategySelector';
import { metaLearnerModule } from './modules/metaLearner';
import { modelRouterModule } from './modules/modelRouter';
import { smartModelRouterModule } from './modules/smartModelRouter';
import { effortScalerModule } from './modules/effortScaler';
import { topologyRouterModule } from './modules/topologyRouter';
import { tokenGovernorModule } from './modules/tokenGovernor';
import { tokenSentinelModule } from './modules/tokenSentinel';
import { executionRouterModule } from './modules/executionRouter';
import { providerFallbackChainModule } from './modules/providerFallbackChain';
import { llmRetryModule } from './modules/llmRetry';
import { circuitBreakerModule } from './modules/circuitBreaker';
import { bm25ToolDiscoveryModule } from './modules/bm25ToolDiscovery';
import { speculativeExecutorModule } from './modules/speculativeExecutor';
import { fusionEngineModule } from './modules/fusionEngine';
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
registerModule(adaptiveStoppingModule);
registerModule(swarmOrchestratorModule);
registerModule(dynamicCostGuardianModule);
registerModule(parameterControllerModule);
registerModule(strategySelectorModule);
registerModule(metaLearnerModule);
registerModule(modelRouterModule);
registerModule(smartModelRouterModule);
registerModule(effortScalerModule);
registerModule(topologyRouterModule);
registerModule(tokenGovernorModule);
registerModule(tokenSentinelModule);
registerModule(executionRouterModule);
registerModule(providerFallbackChainModule);
registerModule(llmRetryModule);
registerModule(circuitBreakerModule);
registerModule(bm25ToolDiscoveryModule);
registerModule(speculativeExecutorModule);
registerModule(fusionEngineModule);
registerModule(costPredictorModule);
registerModule(modelCascadeControllerModule);
