// packages/core/src/chaos/types.ts
export type ChaosLayer = 'L1' | 'L2' | 'L3' | 'L4';

export const ALL_LAYERS: ChaosLayer[] = ['L1', 'L2', 'L3', 'L4'];

export interface ChaosScenario {
  layers: ChaosLayer[];
  tenantId?: string;
  durationSec?: number;
  faultTypes?: string[];
  verifyRecovery?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function parseLayers(input: string): ChaosLayer[] {
  const raw = input.split(',').map((s) => s.trim());
  for (const r of raw) {
    if (!ALL_LAYERS.includes(r as ChaosLayer)) {
      throw new Error(`Unknown layer ${r}`);
    }
  }
  return raw as ChaosLayer[];
}

export function validateScenario(scenario: ChaosScenario): ValidationResult {
  const errors: string[] = [];
  for (const layer of scenario.layers) {
    if (!ALL_LAYERS.includes(layer)) {
      errors.push(`Unknown layer ${layer}`);
    }
  }
  if (scenario.layers.includes('L4') && !scenario.tenantId) {
    errors.push('tenantId required for L4');
  }
  return { valid: errors.length === 0, errors };
}
