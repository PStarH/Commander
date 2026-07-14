/**
 * Single choke point for the pre-V2 in-process execution path.
 *
 * The legacy runtime is intentionally available only for local/embedded
 * development. Production and explicit V2 mode must never mount or execute it.
 * Keeping this decision in one module prevents individual routers from
 * accidentally reintroducing a second execution authority.
 */

export function isLegacyExecutionAllowed(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.COMMANDER_V2_MODE !== '1' &&
    process.env.COMMANDER_LEGACY_EXECUTION === '1'
  );
}

export function legacyExecutionDisabledReason(): string {
  if (process.env.NODE_ENV === 'production') return 'legacy execution is forbidden in production';
  if (process.env.COMMANDER_V2_MODE === '1') return 'Architecture V2 mode is enabled';
  return 'COMMANDER_LEGACY_EXECUTION=1 is required for local compatibility mode';
}

export function assertLegacyExecutionAllowed(operation: string): void {
  if (!isLegacyExecutionAllowed()) {
    throw new Error(`${operation} is disabled: ${legacyExecutionDisabledReason()}`);
  }
}
