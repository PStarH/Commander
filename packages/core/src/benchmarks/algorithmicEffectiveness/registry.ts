import type { BenchmarkModule } from './types';
import { thompsonMemoryModule } from './modules/thompsonMemory';
import { semanticFirewallModule } from './modules/semanticFirewall';
import { adaptiveStoppingModule } from './modules/adaptiveStopping';
import { swarmOrchestratorModule } from './modules/swarmOrchestrator';
import { dynamicCostGuardianModule } from './modules/dynamicCostGuardian';
import { parameterControllerModule } from './modules/parameterController';
import { strategySelectorModule } from './modules/strategySelector';
import { strategyPerformanceTrackerModule } from './modules/strategyPerformanceTracker';
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
import { cacheManagerModule } from './modules/cacheManager';
import { predictionLoopModule } from './modules/predictionLoop';
import { trajectoryAnalyzerModule } from './modules/trajectoryAnalyzer';
import { contextCompactorModule } from './modules/contextCompactor';
import { deliberationModule } from './modules/deliberation';
import { qualityGatesModule } from './modules/qualityGates';
import { outputSanitizerModule } from './modules/outputSanitizer';
import { backpressureControllerModule } from './modules/backpressureController';
import { capabilityMatcherModule } from './modules/capabilityMatcher';
import { subAgentExecutorModule } from './modules/subAgentExecutor';
import { anomalyDetectorModule } from './modules/anomalyDetector';
import { samplingPolicyModule } from './modules/samplingPolicy';
import { sacProtocolModule } from './modules/sacProtocol';
import { securityPrimitivesModule } from './modules/securityPrimitives';
import { reversibilityGateModule } from './modules/reversibilityGate';
import { outboundNetworkPolicyModule } from './modules/outboundNetworkPolicy';

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
registerModule(semanticFirewallModule);
registerModule(adaptiveStoppingModule);
registerModule(swarmOrchestratorModule);
registerModule(dynamicCostGuardianModule);
registerModule(parameterControllerModule);
registerModule(strategySelectorModule);
registerModule(strategyPerformanceTrackerModule);
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
registerModule(cacheManagerModule);
registerModule(predictionLoopModule);
registerModule(trajectoryAnalyzerModule);
registerModule(contextCompactorModule);
registerModule(deliberationModule);
registerModule(qualityGatesModule);
registerModule(outputSanitizerModule);
registerModule(backpressureControllerModule);
registerModule(capabilityMatcherModule);
registerModule(subAgentExecutorModule);
registerModule(anomalyDetectorModule);
registerModule(samplingPolicyModule);
registerModule(sacProtocolModule);
registerModule(securityPrimitivesModule);
registerModule(reversibilityGateModule);
registerModule(outboundNetworkPolicyModule);
