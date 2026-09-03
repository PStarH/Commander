const CLASS_A_FAMILY_SEGMENTS = new Set([
  'crm',
  'connector',
  'compensate',
  'http',
  'saas',
  'write',
  'mutate',
  'egress',
]);

/** Fail-closed classification for effects that may mutate an external system. */
export function isClassAEffectType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  if (normalized.split('.').some((segment) => CLASS_A_FAMILY_SEGMENTS.has(segment))) return true;
  if (
    normalized.startsWith('llm.') ||
    normalized.startsWith('retrieve.') ||
    normalized.startsWith('read.') ||
    normalized.startsWith('budget.')
  )
    return false;
  if (normalized.startsWith('local.') || normalized.startsWith('compute.')) return false;
  return true;
}
