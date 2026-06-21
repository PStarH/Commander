import type { LLMProvider, Tool, AgentRuntimeConfig } from './types';
import type { ModelRouter } from './modelRouter';
import type { TenantProvider } from './tenantProvider';
import type { ThreeLayerMemory } from '../threeLayerMemory';
import type { MetricsCollector } from './metricsCollector';
import type { MessageBus } from './messageBus';
import type { HookManager } from '../pluginManager';
import type { Logger } from '../logging';

export interface ServiceOverrides {
  modelRouter?: ModelRouter;
  tenantProvider?: TenantProvider;
  memory?: ThreeLayerMemory;
  metricsCollector?: MetricsCollector;
  messageBus?: MessageBus;
  hookManager?: HookManager;
  logger?: Logger;
}

export class ServiceContainer {
  private static instance: ServiceContainer | null = null;
  private overrides: ServiceOverrides = {};

  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
    }
    return ServiceContainer.instance;
  }

  static resetInstance(): void {
    ServiceContainer.instance = null;
  }

  setOverrides(overrides: ServiceOverrides): void {
    this.overrides = { ...this.overrides, ...overrides };
  }

  getModelRouter(fallback: () => ModelRouter): ModelRouter {
    return this.overrides.modelRouter ?? fallback();
  }

  getTenantProvider(fallback: () => TenantProvider): TenantProvider {
    return this.overrides.tenantProvider ?? fallback();
  }

  getMemory(fallback: () => ThreeLayerMemory | null): ThreeLayerMemory | null {
    if (this.overrides.memory !== undefined) return this.overrides.memory;
    return fallback();
  }

  getMetricsCollector(fallback: () => MetricsCollector): MetricsCollector {
    return this.overrides.metricsCollector ?? fallback();
  }

  getMessageBus(fallback: () => MessageBus): MessageBus {
    return this.overrides.messageBus ?? fallback();
  }

  getHookManager(fallback: () => HookManager): HookManager {
    return this.overrides.hookManager ?? fallback();
  }

  getLogger(fallback: () => Logger): Logger {
    return this.overrides.logger ?? fallback();
  }

  clearOverrides(): void {
    this.overrides = {};
  }
}

export function getServiceContainer(): ServiceContainer {
  return ServiceContainer.getInstance();
}

export function resetServiceContainer(): void {
  ServiceContainer.resetInstance();
}
