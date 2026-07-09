import type { BenchmarkModule } from './types';
import { thompsonMemoryModule } from './modules/thompsonMemory';
import { strategySelectorModule } from './modules/strategySelector';
import { modelRouterModule } from './modules/modelRouter';
import { effortScalerModule } from './modules/effortScaler';
import { topologyRouterModule } from './modules/topologyRouter';

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
registerModule(strategySelectorModule);
registerModule(modelRouterModule);
registerModule(effortScalerModule);
registerModule(topologyRouterModule);
