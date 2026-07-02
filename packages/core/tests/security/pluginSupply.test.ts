// packages/core/tests/security/pluginSupply.test.ts
import { describe, it, expect } from 'vitest';
import { PLUGIN_SUPPLY_CHAIN_SCENARIOS } from '../../src/security/pluginSupplyChainScenarios';

describe('Plugin Supply Chain Scenarios', () => {
  it('contains 4 plugin supply chain attack scenarios', () => {
    expect(PLUGIN_SUPPLY_CHAIN_SCENARIOS).toHaveLength(4);
  });

  it('all scenarios tagged with plugin', () => {
    for (const s of PLUGIN_SUPPLY_CHAIN_SCENARIOS) {
      expect(s.tags).toContain('plugin');
    }
  });

  it('IDs follow PLUGIN-SUPPLY-NNN format', () => {
    for (const s of PLUGIN_SUPPLY_CHAIN_SCENARIOS) {
      expect(s.id).toMatch(/^PLUGIN-SUPPLY-\d{3}$/);
    }
  });

  it('covers capability drift, sandbox escape, prompt injection, dependency confusion', () => {
    const tags = PLUGIN_SUPPLY_CHAIN_SCENARIOS.flatMap((s) => s.tags);
    expect(tags).toContain('capability-drift');
    expect(tags).toContain('sandbox-escape');
    expect(tags).toContain('prompt-injection');
    expect(tags).toContain('dependency-confusion');
  });

  it('sandbox escape scenario has critical severity', () => {
    const escape = PLUGIN_SUPPLY_CHAIN_SCENARIOS.find((s) =>
      s.tags.includes('sandbox-escape'),
    );
    expect(escape).toBeDefined();
    expect(escape!.severity).toBe('critical');
    expect(escape!.cvssScore).toBeGreaterThanOrEqual(9.0);
  });

  it('all scenarios have unique IDs', () => {
    const ids = PLUGIN_SUPPLY_CHAIN_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
