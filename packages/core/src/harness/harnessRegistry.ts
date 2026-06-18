/**
 * HarnessRegistry — Selects the optimal AgentHarness for each execution context.
 *
 * Selection policy (in priority order):
 *   1. Tier-based (power models first)
 *   2. Model family (GPT-4, Claude, etc.)
 *   3. Provider
 *   4. Feature flags (e.g., "mcp-server")
 *   5. Auto (fallback to DefaultHarness)
 *
 * Built-in rules can be extended with custom rules via addRule() or config.
 */
import type {
  AgentHarness,
  HarnessSelectionContext,
  HarnessSelectionRule,
  HarnessConfig,
} from './harnessTypes';
import { BUILTIN_HARNESS_RULES, DEFAULT_HARNESS_CONFIG } from './harnessTypes';
import { getGlobalLogger } from '../logging';

export class HarnessRegistry {
  private harnesses: Map<string, AgentHarness> = new Map();
  private rules: HarnessSelectionRule[] = [];
  private config: HarnessConfig;

  constructor(config?: Partial<HarnessConfig>) {
    this.config = { ...DEFAULT_HARNESS_CONFIG, ...config };
    this.rules = [...BUILTIN_HARNESS_RULES];
    if (this.config.customRules) {
      this.rules.push(...this.config.customRules);
    }
    // Sort by priority descending
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  registerHarness(harness: AgentHarness): void {
    if (this.harnesses.has(harness.name)) {
      throw new Error(`Harness "${harness.name}" is already registered`);
    }
    this.harnesses.set(harness.name, harness);
    getGlobalLogger().info(
      'HarnessRegistry',
      `Registered harness: ${harness.name} (${harness.getCapabilities().description})`,
    );
  }

  unregisterHarness(name: string): boolean {
    const removed = this.harnesses.delete(name);
    if (removed) {
      getGlobalLogger().info('HarnessRegistry', `Unregistered harness: ${name}`);
    }
    return removed;
  }

  getHarness(name: string): AgentHarness | undefined {
    return this.harnesses.get(name);
  }

  listHarnesses(): AgentHarness[] {
    return Array.from(this.harnesses.values());
  }

  /**
   * Add a custom selection rule. Rules are re-sorted by priority after addition.
   */
  addRule(rule: HarnessSelectionRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a custom selection rule by name.
   * Built-in rules cannot be removed (they are restored on reset).
   */
  removeRule(name: string): boolean {
    const builtinNames = new Set(BUILTIN_HARNESS_RULES.map((r) => r.name));
    if (builtinNames.has(name)) {
      getGlobalLogger().warn('HarnessRegistry', `Cannot remove built-in rule "${name}"`);
      return false;
    }
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /**
   * Reset rules to built-in defaults. Preserves registered harnesses.
   */
  resetRules(): void {
    this.rules = [...BUILTIN_HARNESS_RULES];
    if (this.config.customRules) {
      this.rules.push(...this.config.customRules);
    }
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Select the best harness for the given execution context.
   *
   * Evaluates rules in priority order. Returns the first harness whose
   * rule matches AND whose supports() returns true.
   * Returns null if no harness matches (should not happen with fallback rule).
   */
  select(ctx: HarnessSelectionContext): AgentHarness | null {
    if (!this.config.enabled) {
      return this.harnesses.get('default') ?? null;
    }

    for (const rule of this.rules) {
      if (!rule.matcher(ctx)) continue;

      const harness = this.harnesses.get(rule.harness);
      if (!harness) {
        getGlobalLogger().warn(
          'HarnessRegistry',
          `Rule "${rule.name}" matched but harness "${rule.harness}" not registered`,
        );
        continue;
      }

      if (!harness.supports(ctx)) {
        if (this.config.verbose) {
          getGlobalLogger().debug(
            'HarnessRegistry',
            `Rule "${rule.name}" → harness "${rule.harness}" does not support context, skipping`,
          );
        }
        continue;
      }

      if (this.config.verbose) {
        const reason = (rule.reason || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
          const value = (ctx as unknown as Record<string, unknown>)[key];
          return value !== undefined ? String(value) : `{{${key}}}`;
        });
        getGlobalLogger().debug(
          'HarnessRegistry',
          `Selected: ${rule.name} → ${harness.name} (${reason})`,
        );
      }

      return harness;
    }

    // Last resort: try default harness directly
    const fallback = this.harnesses.get('default');
    if (fallback) {
      getGlobalLogger().warn('HarnessRegistry', 'No rule matched, falling back to default harness');
      return fallback;
    }

    return null;
  }

  /**
   * Get current rules for inspection/debugging.
   */
  getRules(): HarnessSelectionRule[] {
    return [...this.rules];
  }

  /**
   * Reload config at runtime.
   */
  updateConfig(config: Partial<HarnessConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.customRules) {
      this.resetRules();
    }
  }
}
