/**
 * Standardized error codes for Architecture V2 public APIs.
 *
 * Error codes are language-neutral, stable across SDK versions, and safe to
 * surface in observability without leaking internal implementation details.
 */

export const KERNEL_ERROR_CODES = [
  'DUPLICATE_RUN',
  'DUPLICATE_STEP',
  'DUPLICATE_INTERACTION',
  'INVALID_GRAPH',
  'LEASE_LOST',
  'VERSION_CONFLICT',
  'INVALID_TRANSITION',
  'PRODUCTION_STORAGE_REQUIRED',
  'RUN_NOT_FOUND',
  'STEP_NOT_FOUND',
  'EFFECT_NOT_FOUND',
  'TENANT_IDENTITY_REQUIRED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'CAPABILITY_DENIED',
  'EFFECT_ADMISSION_REJECTED',
  'KERNEL_UNAVAILABLE',
  'POLICY_SNAPSHOT_UNAVAILABLE',
] as const;

export type KernelErrorCode = (typeof KERNEL_ERROR_CODES)[number];

export interface KernelErrorDetails {
  code: KernelErrorCode | string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
