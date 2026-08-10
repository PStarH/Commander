export const DESIGN_PARTNER_FAULT_POINTS = [
  'before_remote_request',
  'after_remote_commit',
  'before_local_complete',
  'during_outcome_query',
  'during_compensation',
  'during_evidence_persist',
] as const;

export type DesignPartnerFaultPoint = (typeof DESIGN_PARTNER_FAULT_POINTS)[number];

export type DesignPartnerScenarioId =
  | 'tenant_isolation'
  | 'identity'
  | 'policy_binding'
  | 'approval_binding'
  | 'mutation_resistance'
  | 'lease_fencing'
  | 'idempotency'
  | 'ambiguous_completion'
  | 'confirmed_not_applied'
  | 'irreducible_unknown'
  | 'compensation'
  | 'kill_switch'
  | 'evidence'
  | 'recovery'
  | 'backup_restore';

export type DesignPartnerTerminalDisposition =
  | 'DENIED'
  | 'COMPLETED'
  | 'CONFIRMED_NOT_APPLIED'
  | 'ESCALATED'
  | 'COMPENSATED'
  | 'FAILED'
  | 'RESTORED';

export interface DesignPartnerScenarioDefinition {
  id: DesignPartnerScenarioId;
  expectedExternalWrites: number;
  requiresOutcomeQuery: boolean;
  allowedTerminalDispositions: readonly DesignPartnerTerminalDisposition[];
}

export const DESIGN_PARTNER_SCENARIOS: readonly DesignPartnerScenarioDefinition[] = [
  {
    id: 'tenant_isolation',
    expectedExternalWrites: 0,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['DENIED'],
  },
  {
    id: 'identity',
    expectedExternalWrites: 0,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['DENIED'],
  },
  {
    id: 'policy_binding',
    expectedExternalWrites: 0,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['DENIED'],
  },
  {
    id: 'approval_binding',
    expectedExternalWrites: 0,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['DENIED'],
  },
  {
    id: 'mutation_resistance',
    expectedExternalWrites: 0,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['DENIED'],
  },
  {
    id: 'lease_fencing',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['COMPLETED'],
  },
  {
    id: 'idempotency',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['COMPLETED'],
  },
  {
    id: 'ambiguous_completion',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: true,
    allowedTerminalDispositions: ['COMPLETED'],
  },
  {
    id: 'confirmed_not_applied',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: true,
    allowedTerminalDispositions: ['COMPLETED', 'CONFIRMED_NOT_APPLIED'],
  },
  {
    id: 'irreducible_unknown',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: true,
    allowedTerminalDispositions: ['ESCALATED'],
  },
  {
    id: 'compensation',
    expectedExternalWrites: 2,
    requiresOutcomeQuery: true,
    allowedTerminalDispositions: ['COMPENSATED'],
  },
  {
    id: 'kill_switch',
    expectedExternalWrites: 0,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['DENIED'],
  },
  {
    id: 'evidence',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['COMPLETED', 'FAILED'],
  },
  {
    id: 'recovery',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['COMPLETED'],
  },
  {
    id: 'backup_restore',
    expectedExternalWrites: 1,
    requiresOutcomeQuery: false,
    allowedTerminalDispositions: ['RESTORED'],
  },
];

export interface DesignPartnerScenarioObservation {
  id: DesignPartnerScenarioId;
  passed: boolean;
  expectedExternalWrites: number;
  observedExternalWrites: number;
  observedOutcomeQueries: number;
  terminalDisposition: DesignPartnerTerminalDisposition;
  receiptVerified: boolean;
  evidencePersisted: boolean;
  reconciliationLatencyMs: number;
}

export interface DesignPartnerCampaignObservation {
  schema: 'commander-design-partner-campaign/v1';
  startedAt: string;
  endedAt: string;
  driver: {
    boundary: 'external-process' | 'same-process';
    identity: string;
  };
  topology: {
    backend: string;
    processIdentities: Record<string, string>;
    databaseRoles: string[];
    externalSystem: {
      mode: 'real' | 'emulated' | 'recorded' | 'mocked';
      identitySha256: string;
    };
    standardClientPath: boolean;
  };
  faultPoints: DesignPartnerFaultPoint[];
  scenarios: DesignPartnerScenarioObservation[];
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function validateCampaignObservation(
  observation: DesignPartnerCampaignObservation,
): string[] {
  const failures: string[] = [];
  if (observation.schema !== 'commander-design-partner-campaign/v1') {
    failures.push('CAMPAIGN_SCHEMA_INVALID');
  }
  const startedAt = Date.parse(observation.startedAt);
  const endedAt = Date.parse(observation.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    failures.push('CAMPAIGN_TIMING_INVALID');
  }
  if (observation.driver.boundary !== 'external-process' || !observation.driver.identity.trim()) {
    failures.push('CAMPAIGN_DRIVER_BOUNDARY_INVALID');
  }

  const faultCounts = countValues(observation.faultPoints);
  for (const point of DESIGN_PARTNER_FAULT_POINTS) {
    const count = faultCounts.get(point) ?? 0;
    if (count === 0) failures.push(`FAULT_POINT_MISSING:${point}`);
    if (count > 1) failures.push(`FAULT_POINT_DUPLICATE:${point}`);
  }
  for (const point of faultCounts.keys()) {
    if (!(DESIGN_PARTNER_FAULT_POINTS as readonly string[]).includes(point)) {
      failures.push(`FAULT_POINT_UNDECLARED:${point}`);
    }
  }

  const scenarioCounts = countValues(observation.scenarios.map(({ id }) => id));
  const definitions = new Map(DESIGN_PARTNER_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  for (const definition of DESIGN_PARTNER_SCENARIOS) {
    const count = scenarioCounts.get(definition.id) ?? 0;
    if (count === 0) failures.push(`SCENARIO_MISSING:${definition.id}`);
    if (count > 1) failures.push(`SCENARIO_DUPLICATE:${definition.id}`);
  }
  for (const scenario of observation.scenarios) {
    const definition = definitions.get(scenario.id);
    if (!definition) {
      failures.push(`SCENARIO_UNDECLARED:${scenario.id}`);
      continue;
    }
    if (!scenario.passed) failures.push(`SCENARIO_FAILED:${scenario.id}`);
    if (
      scenario.expectedExternalWrites !== definition.expectedExternalWrites ||
      scenario.observedExternalWrites !== definition.expectedExternalWrites
    ) {
      failures.push(`SCENARIO_EXTERNAL_WRITE_COUNT_INVALID:${scenario.id}`);
    }
    if (definition.requiresOutcomeQuery && scenario.observedOutcomeQueries < 1) {
      failures.push(`SCENARIO_OUTCOME_QUERY_REQUIRED:${scenario.id}`);
    }
    if (!definition.allowedTerminalDispositions.includes(scenario.terminalDisposition)) {
      failures.push(`SCENARIO_TERMINAL_DISPOSITION_INVALID:${scenario.id}`);
    }
    if (!scenario.receiptVerified) failures.push(`SCENARIO_RECEIPT_UNVERIFIED:${scenario.id}`);
    if (!scenario.evidencePersisted)
      failures.push(`SCENARIO_EVIDENCE_NOT_PERSISTED:${scenario.id}`);
    if (
      !Number.isFinite(scenario.reconciliationLatencyMs) ||
      scenario.reconciliationLatencyMs < 0
    ) {
      failures.push(`SCENARIO_LATENCY_INVALID:${scenario.id}`);
    }
  }

  return [...new Set(failures)];
}
