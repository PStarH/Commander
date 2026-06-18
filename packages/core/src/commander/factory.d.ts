/**
 * factory.ts — RuntimeFactory that wires up a Commander instance based on
 * resolved tier configuration.
 *
 * Takes a ResolvedConfig from tier.ts and creates the necessary runtime
 * components: TenantProvider, AgentRuntime, Provider registration, etc.
 */
import { AgentRuntime } from '../runtime/agentRuntime';
import type { ResolvedConfig } from './tier';
export interface WiredRuntime {
    runtime: AgentRuntime;
    tier: ResolvedConfig['tier'];
    features: ResolvedConfig['features'];
}
/**
 * Create and wire a complete runtime based on resolved configuration.
 *
 * This is the single entry point that assembles:
 *   1. TenantProvider (null/simple/multi based on tier)
 *   2. AgentRuntime with tier-appropriate config
 *   3. LLM Provider registration (lazy-loaded by provider type)
 *   4. Tool registration (all built-in tools)
 *   5. Model registration in the router
 */
export declare function createWiredRuntime(config: ResolvedConfig): Promise<WiredRuntime>;
//# sourceMappingURL=factory.d.ts.map