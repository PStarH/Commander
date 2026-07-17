/**
 * Production/enterprise EffectBroker requirement gate (WS2 §4 / L3-03a).
 * Shared across agent, tool, and connector step executors.
 */
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

/** Fail-closed routing: prod denies direct registry unless step is explicitly local-only. */
export function mustRouteExternalEffectThroughBroker(input: {
  hasExternalEffects?: boolean;
  localOnly?: boolean;
}): boolean {
  if (input.hasExternalEffects === true) return true;
  if (isProductionEffectGate() && input.localOnly !== true) return true;
  return false;
}
