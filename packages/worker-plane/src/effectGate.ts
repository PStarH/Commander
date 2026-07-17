/**
 * Production/enterprise EffectBroker requirement gate (WS2 §4 / L3-03a).
 * Shared across agent, tool, and connector step executors.
 */
import type { ToolEffectCatalog } from './toolEffectCatalog.js';
import { DENY_ALL_TOOL_EFFECT_CATALOG } from './toolEffectCatalog.js';

export function isProductionEffectGate(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.COMMANDER_PROFILE === 'enterprise' ||
    process.env.COMMANDER_REQUIRE_EFFECT_BROKER === '1'
  );
}

export function assertEffectBrokerForProduction(component: string, broker: unknown): void {
  if (isProductionEffectGate() && !broker) {
    throw new Error(
      `EFFECT_BROKER_UNAVAILABLE: ${component} requires EffectBroker in production/enterprise (WS2 §1 / L3-03a)`,
    );
  }
}

export interface EffectRoutingContext {
  brokerPresent?: boolean;
  toolName?: string;
  connectorName?: string;
  catalog?: ToolEffectCatalog;
  /** Connector step supplied connection config — forbids localOnly registry bypass in prod. */
  hasConnection?: boolean;
}

/**
 * Whether step input `localOnly: true` is authorized to bypass EffectBroker.
 *
 * - Production: catalog must list the tool/connector (fail-closed if missing).
 * - Dev/test: step claim alone suffices (L3-03a ergonomics).
 */
export function isCatalogAuthorizedLocalOnly(
  input: { localOnly?: boolean },
  ctx: Pick<EffectRoutingContext, 'toolName' | 'connectorName' | 'catalog'>,
): boolean {
  if (input.localOnly !== true) return false;
  if (!isProductionEffectGate()) return true;

  const catalog = ctx.catalog ?? DENY_ALL_TOOL_EFFECT_CATALOG;
  if (ctx.toolName) return catalog.isLocalOnlyTool(ctx.toolName);
  if (ctx.connectorName) return catalog.isLocalOnlyConnector(ctx.connectorName);
  return false;
}

/**
 * Fail-closed routing for tool/connector steps.
 *
 * - Explicit `hasExternalEffects: true` always requires broker mediation.
 * - `localOnly: true` may use the registry only when catalog-authoritative
 *   (L3-03b); forged step-input localOnly in production routes via broker.
 * - Production connector steps with `connection` cannot use localOnly bypass.
 * - Otherwise: production/enterprise gate OR a wired broker → mediate.
 */
export function mustRouteExternalEffectThroughBroker(
  input: {
    hasExternalEffects?: boolean;
    localOnly?: boolean;
  },
  options?: EffectRoutingContext,
): boolean {
  if (input.hasExternalEffects === true) return true;

  if (isProductionEffectGate() && options?.hasConnection === true) {
    return true;
  }

  if (
    isCatalogAuthorizedLocalOnly(input, {
      toolName: options?.toolName,
      connectorName: options?.connectorName,
      catalog: options?.catalog,
    })
  ) {
    return false;
  }

  if (isProductionEffectGate() || options?.brokerPresent === true) return true;
  return false;
}
