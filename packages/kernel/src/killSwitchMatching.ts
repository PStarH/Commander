import { KernelInvariantError } from './types.js';
import type { KillSwitch, KillSwitchMatchDims, KillSwitchScope } from './types.js';

export const KILL_SWITCH_SCOPE_ORDER: KillSwitchScope[] = [
  'tenant',
  'package',
  'model',
  'tool',
  'destination',
  'effect-type',
];

export function killSwitchRuleMatches(
  rule: KillSwitch,
  tenantId: string,
  dims: KillSwitchMatchDims,
): boolean {
  if (!rule.enabled || rule.tenantId !== tenantId) return false;
  switch (rule.scope) {
    case 'tenant':
      return rule.value === tenantId;
    case 'package':
      return dims.package === rule.value;
    case 'model':
      return dims.model === rule.value;
    case 'tool':
      return dims.tool === rule.value;
    case 'destination':
      return dims.destination === rule.value;
    case 'effect-type':
      return dims.effectType === rule.value;
    default:
      return false;
  }
}

export function findMatchingKillSwitchFromRules(
  tenantId: string,
  dims: KillSwitchMatchDims,
  rules: KillSwitch[],
): KillSwitch | null {
  for (const scope of KILL_SWITCH_SCOPE_ORDER) {
    const match = rules.find(
      (rule) => rule.scope === scope && killSwitchRuleMatches(rule, tenantId, dims),
    );
    if (match) return match;
  }
  return null;
}

export async function findMatchingKillSwitchWithLookup(
  tenantId: string,
  dims: KillSwitchMatchDims,
  list: (tenantId: string) => Promise<KillSwitch[]>,
): Promise<KillSwitch | null> {
  let rules: KillSwitch[];
  try {
    rules = await list(tenantId);
  } catch {
    throw new KernelInvariantError('KILL_SWITCH_LOOKUP_FAILED', 'Kill switch lookup failed');
  }
  return findMatchingKillSwitchFromRules(tenantId, dims, rules);
}
