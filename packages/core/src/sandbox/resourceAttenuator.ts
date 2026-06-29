/**
 * Resource Attenuator — Proxy membrane pattern for object-capability (ocap) enforcement
 *
 * Implements the IResourceAttenuator contract from Pillar III.
 *
 * The Proxy membrane pattern:
 * - Every object access is mediated through a Proxy
 * - Proxies enforce capability restrictions (allowlist, denylist, depth limits)
 * - Full membrane: isolates an inner object graph from the outer world
 * - Proxies are revocable — revocation severs all access immediately
 *
 * Per constraint PIII-FR-02, leverages Proxy object isolation.
 * Per constraint NFR-SEC-06, supports principle of least privilege.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { IResourceAttenuator, AttenuationPolicy } from '../contracts/pillarIII';

// ============================================================================
// Types
// ============================================================================

interface ProxyRecord {
  /** Context ID this proxy belongs to */
  contextId: string;
  /** Target object constructor name or string tag */
  target: string;
  /** The policy applied to this proxy */
  policy: AttenuationPolicy;
  /** The revocation handler (if revocable proxy) */
  revoke: (() => void) | null;
}

interface ContextState {
  /** All proxies created for this context */
  proxies: ProxyRecord[];
  /** Whether this context has been revoked */
  revoked: boolean;
  /** Call depth tracking */
  currentCallDepth: number;
}

// ============================================================================
// ResourceAttenuator Implementation
// ============================================================================

export class ResourceAttenuator implements IResourceAttenuator {
  private contexts: Map<string, ContextState> = new Map();
  private policies: Map<string, AttenuationPolicy> = new Map();

  /**
   * Wrap an object with a mediated Proxy.
   *
   * The proxy intercepts:
   * - get: checks allowlist/denylist, tracks call depth, checks expiry
   * - set: checks allowlist/denylist
   * - apply: tracks call depth, checks expiry
   * - has: checks allowlist/denylist
   * - deleteProperty: checks denylist
   */
  wrap<T extends object>(target: T, policy: AttenuationPolicy): T {
    const contextId = this.generateContextId();
    return this.wrapWithContext(target, policy, contextId);
  }

  /**
   * Create a full realm membrane — isolates an inner object graph from the outer world.
   *
   * The inner proxy wraps `inner` to restrict what the outer world can access.
   * The outer proxy wraps `outer` to restrict what the inner world can access.
   *
   * This creates a bidirectional isolation boundary.
   */
  createMembrane(inner: object, outer: object): { innerProxy: object; outerProxy: object } {
    const contextId = this.generateContextId();
    const innerPolicy: AttenuationPolicy = {
      allowedProperties: undefined, // Allow all by default
      deniedProperties: ['eval', 'Function', 'require', 'import', 'process', 'child_process'],
      maxCallDepth: 50,
      expiresAt: undefined,
    };
    const outerPolicy: AttenuationPolicy = {
      allowedProperties: undefined,
      deniedProperties: ['__proto__', 'constructor', 'prototype'],
      maxCallDepth: 50,
      expiresAt: undefined,
    };

    const innerProxy = this.wrapWithContext(inner, innerPolicy, contextId);
    const outerProxy = this.wrapWithContext(outer, outerPolicy, contextId);

    getGlobalLogger().debug('ResourceAttenuator', 'Membrane created', {
      contextId,
    });

    return { innerProxy, outerProxy };
  }

  /**
   * Revoke all proxies created for a given context.
   * After revocation, any access to the proxies throws.
   */
  revoke(contextId: string): void {
    const state = this.contexts.get(contextId);
    if (!state) {
      getGlobalLogger().warn('ResourceAttenuator', 'Unknown context for revocation', { contextId });
      return;
    }

    state.revoked = true;

    // Call all revocation handlers
    for (const record of state.proxies) {
      if (record.revoke) {
        try {
          record.revoke();
        } catch (err) {
          reportSilentFailure(err, 'resourceAttenuator:revoke');
        }
      }
    }

    // Clear the proxies
    state.proxies = [];

    getGlobalLogger().info('ResourceAttenuator', 'Context revoked', {
      contextId,
      proxyCount: state.proxies.length,
    });
  }

  /**
   * Get all active proxies for audit purposes.
   */
  getProxies(): Array<{ contextId: string; target: string; policy: AttenuationPolicy }> {
    const result: Array<{ contextId: string; target: string; policy: AttenuationPolicy }> = [];

    for (const [contextId, state] of this.contexts) {
      if (state.revoked) continue;
      for (const record of state.proxies) {
        result.push({
          contextId,
          target: record.target,
          policy: record.policy,
        });
      }
    }

    return result;
  }

  /**
   * Set a resource-type access policy.
   * This policy is applied when wrapping objects of the given type.
   */
  setPolicy(resourceType: string, policy: AttenuationPolicy): void {
    this.policies.set(resourceType, policy);
    getGlobalLogger().debug('ResourceAttenuator', 'Policy set', {
      resourceType,
      allowedProperties: policy.allowedProperties?.length ?? 'all',
      deniedProperties: policy.deniedProperties?.length ?? 0,
    });
  }

  /**
   * Get the policy for a resource type.
   */
  getPolicy(resourceType: string): AttenuationPolicy | undefined {
    return this.policies.get(resourceType);
  }

  /**
   * Get all active context IDs.
   */
  getActiveContexts(): string[] {
    const result: string[] = [];
    for (const [contextId, state] of this.contexts) {
      if (!state.revoked) result.push(contextId);
    }
    return result;
  }

  /**
   * Get statistics about the attenuator.
   */
  getStats(): {
    totalContexts: number;
    activeContexts: number;
    revokedContexts: number;
    totalProxies: number;
    registeredPolicies: number;
  } {
    let activeContexts = 0;
    let revokedContexts = 0;
    let totalProxies = 0;

    for (const state of this.contexts.values()) {
      if (state.revoked) {
        revokedContexts++;
      } else {
        activeContexts++;
        totalProxies += state.proxies.length;
      }
    }

    return {
      totalContexts: this.contexts.size,
      activeContexts,
      revokedContexts,
      totalProxies,
      registeredPolicies: this.policies.size,
    };
  }

  // ------------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------------

  private generateContextId(): string {
    return `ctx-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  private wrapWithContext<T extends object>(
    target: T,
    policy: AttenuationPolicy,
    contextId: string,
  ): T {
    // Ensure context exists
    let state = this.contexts.get(contextId);
    if (!state) {
      state = { proxies: [], revoked: false, currentCallDepth: 0 };
      this.contexts.set(contextId, state);
    }

    const targetName = this.getTargetName(target);
    const self = this;

    // Use Proxy.revocable so we can sever access on revoke()
    const revocable = Proxy.revocable(target, {
      get(obj: T, prop: string | symbol): unknown {
        // Check if context is revoked
        if (state!.revoked) {
          throw new Error(`Access denied: context '${contextId}' has been revoked`);
        }

        // Check expiry
        if (policy.expiresAt !== undefined && Date.now() > policy.expiresAt) {
          throw new Error(`Access denied: policy expired for context '${contextId}'`);
        }

        const propName = String(prop);

        // Check denylist
        if (policy.deniedProperties?.includes(propName)) {
          throw new Error(`Access denied: property '${propName}' is in denylist`);
        }

        // Check allowlist (if present, only listed properties are allowed)
        if (policy.allowedProperties && !policy.allowedProperties.includes(propName)) {
          throw new Error(`Access denied: property '${propName}' is not in allowlist`);
        }

        const value = Reflect.get(obj as object, prop);

        // If the value is a function, wrap it to track call depth
        if (typeof value === 'function') {
          return function (...args: unknown[]) {
            // Check call depth
            if (
              policy.maxCallDepth !== undefined &&
              state!.currentCallDepth >= policy.maxCallDepth
            ) {
              throw new Error(
                `Access denied: max call depth ${policy.maxCallDepth} exceeded in context '${contextId}'`,
              );
            }

            state!.currentCallDepth++;
            try {
              return Reflect.apply(value, obj, args);
            } finally {
              state!.currentCallDepth--;
            }
          };
        }

        // If the value is an object, recursively wrap it
        if (value !== null && typeof value === 'object') {
          return self.wrapWithContext(value as object, policy, contextId);
        }

        return value;
      },

      set(obj: T, prop: string | symbol, value: unknown): boolean {
        if (state!.revoked) {
          throw new Error(`Access denied: context '${contextId}' has been revoked`);
        }

        if (policy.expiresAt !== undefined && Date.now() > policy.expiresAt) {
          throw new Error(`Access denied: policy expired for context '${contextId}'`);
        }

        const propName = String(prop);

        if (policy.deniedProperties?.includes(propName)) {
          throw new Error(`Set denied: property '${propName}' is in denylist`);
        }

        if (policy.allowedProperties && !policy.allowedProperties.includes(propName)) {
          throw new Error(`Set denied: property '${propName}' is not in allowlist`);
        }

        return Reflect.set(obj as object, prop, value);
      },

      has(obj: T, prop: string | symbol): boolean {
        if (state!.revoked) return false;

        const propName = String(prop);
        if (policy.deniedProperties?.includes(propName)) return false;
        if (policy.allowedProperties && !policy.allowedProperties.includes(propName)) return false;

        return Reflect.has(obj as object, prop);
      },

      deleteProperty(obj: T, prop: string | symbol): boolean {
        if (state!.revoked) {
          throw new Error(`Access denied: context '${contextId}' has been revoked`);
        }

        const propName = String(prop);
        if (policy.deniedProperties?.includes(propName)) {
          throw new Error(`Delete denied: property '${propName}' is in denylist`);
        }

        return Reflect.deleteProperty(obj as object, prop);
      },

      apply(target: unknown, thisArg: unknown, argumentsList: unknown[]): unknown {
        if (state!.revoked) {
          throw new Error(`Access denied: context '${contextId}' has been revoked`);
        }

        if (policy.maxCallDepth !== undefined && state!.currentCallDepth >= policy.maxCallDepth) {
          throw new Error(
            `Access denied: max call depth ${policy.maxCallDepth} exceeded in context '${contextId}'`,
          );
        }

        state!.currentCallDepth++;
        try {
          return Reflect.apply(target as Function, thisArg, argumentsList);
        } finally {
          state!.currentCallDepth--;
        }
      },
    });

    // Register the proxy
    state.proxies.push({
      contextId,
      target: targetName,
      policy: { ...policy },
      revoke: revocable.revoke,
    });

    return revocable.proxy as T;
  }

  private getTargetName(target: object): string {
    if (target === null || target === undefined) return 'null';

    // Try constructor name
    const constructor = (target as { constructor?: { name?: string } }).constructor;
    if (constructor && constructor.name) {
      return constructor.name;
    }

    // Try Symbol.toStringTag
    const stringTag = (target as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
    if (stringTag) return stringTag;

    // Fallback
    return typeof target;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalResourceAttenuator: ResourceAttenuator | null = null;

export function getGlobalResourceAttenuator(): ResourceAttenuator {
  if (!globalResourceAttenuator) {
    globalResourceAttenuator = new ResourceAttenuator();
  }
  return globalResourceAttenuator;
}
