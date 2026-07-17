/**
 * Tool/connector effect catalog — authority for localOnly registry bypass (L3-03b).
 *
 * Step input `localOnly: true` is a claim; production workers must validate it
 * against this catalog (future: Gateway-issued claims). Fail-closed when absent.
 */

export interface ToolEffectCatalog {
  /** Whether the tool may skip EffectBroker in production when step claims localOnly. */
  isLocalOnlyTool(toolName: string): boolean;
  /** Whether the connector may skip EffectBroker in production when step claims localOnly. */
  isLocalOnlyConnector(connectorName: string): boolean;
}

/** Fail-closed default: no tool/connector is catalog-local. */
export const DENY_ALL_TOOL_EFFECT_CATALOG: ToolEffectCatalog = {
  isLocalOnlyTool: () => false,
  isLocalOnlyConnector: () => false,
};

export class MapToolEffectCatalog implements ToolEffectCatalog {
  constructor(
    private readonly localOnlyTools: ReadonlySet<string> = new Set(),
    private readonly localOnlyConnectors: ReadonlySet<string> = new Set(),
  ) {}

  isLocalOnlyTool(toolName: string): boolean {
    return this.localOnlyTools.has(toolName);
  }

  isLocalOnlyConnector(connectorName: string): boolean {
    return this.localOnlyConnectors.has(connectorName);
  }
}

/** Bootstrap allowlist for internal registry-only tools/connectors. */
export function createDefaultWorkerToolEffectCatalog(): ToolEffectCatalog {
  return new MapToolEffectCatalog(new Set(['echo']), new Set(['memory']));
}
