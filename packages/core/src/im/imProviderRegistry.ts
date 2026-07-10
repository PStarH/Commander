import type { IMProvider } from './imProvider';

export class IMProviderRegistry {
  private providers = new Map<string, IMProvider>();

  register(provider: IMProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`IM provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  resolve(id: string): IMProvider | undefined {
    return this.providers.get(id);
  }

  list(): IMProvider[] {
    return Array.from(this.providers.values());
  }

  reset(): void {
    this.providers.clear();
  }
}

let registry: IMProviderRegistry | undefined;

export function getIMProviderRegistry(): IMProviderRegistry {
  if (!registry) {
    registry = new IMProviderRegistry();
  }
  return registry;
}

export function resetIMProviderRegistry(): IMProviderRegistry {
  registry = new IMProviderRegistry();
  return registry;
}
