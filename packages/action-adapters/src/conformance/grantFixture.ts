import type { CapabilityTokenIssuer } from '@commander/effect-broker';

type ConformanceIssueInput = Parameters<CapabilityTokenIssuer['issue']>[0];

export const conformanceGrantIssueFields = {
  policySnapshotId: 'policy',
  workloadId: 'worker-1',
  nonce: 'nonce-conformance-chaos',
} as const satisfies Pick<ConformanceIssueInput, 'policySnapshotId' | 'workloadId' | 'nonce'>;

type ConformanceIssueOverrides = Omit<
  ConformanceIssueInput,
  keyof typeof conformanceGrantIssueFields
>;

export function buildConformanceIssueInput(): typeof conformanceGrantIssueFields;
export function buildConformanceIssueInput(
  overrides: ConformanceIssueOverrides,
): ConformanceIssueInput;
export function buildConformanceIssueInput(
  overrides?: ConformanceIssueOverrides,
): typeof conformanceGrantIssueFields | ConformanceIssueInput {
  if (!overrides) return conformanceGrantIssueFields;
  return { ...conformanceGrantIssueFields, ...overrides };
}
