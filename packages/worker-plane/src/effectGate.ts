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

/**
 * Fail-closed routing for tool/connector steps.
 *
 * - Explicit `hasExternalEffects: true` always requires broker mediation.
 * - Explicit `localOnly: true` may use the registry (internal tools); forged
 *   step-input localOnly remains a Gateway catalog concern (L3-03b).
 * - Otherwise: production/enterprise gate OR a wired broker → mediate.
 *   Caller-supplied `hasExternalEffects: false` / omission cannot bypass a
 *   present broker (WS2 §1 monopoly).
 */
export function mustRouteExternalEffectThroughBroker(
  input: {
    hasExternalEffects?: boolean;
    localOnly?: boolean;
  },
  options?: { brokerPresent?: boolean },
): boolean {
  if (input.hasExternalEffects === true) return true;
  if (input.localOnly === true) return false;
  if (isProductionEffectGate() || options?.brokerPresent === true) return true;
  return false;
}
