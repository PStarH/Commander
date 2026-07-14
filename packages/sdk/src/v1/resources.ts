/**
 * SDK API v1 — stable versioned resources (Architecture V2).
 *
 * These types are the public contract. Do not leak core internals here.
 */

import type { RunState, StepState } from '@commander/contracts';

export const SDK_API_VERSION = 'v1' as const;

/** Canonical run state. Re-exported from @commander/contracts. */
export type RunStateV1 = RunState;

/** Canonical step state. Re-exported from @commander/contracts. */
export type StepStateV1 = StepState;

/**
 * @deprecated Use {@link RunStateV1} from @commander/contracts.
 * Legacy lowercase status names are being removed in Architecture V2 (WP7).
 */
export type RunStatusV1 = RunStateV1;

export interface RunV1 {
  id: string;
  status: RunStateV1;
  goal: string;
  tenantId?: string;
  createdAt: string;
  updatedAt?: string;
  summary?: string;
  error?: string;
}

export interface StepV1 {
  id: string;
  runId: string;
  state: StepStateV1;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface WorkGraphV1 {
  id: string;
  profile: 'run' | 'swarm' | 'drive' | 'goal' | 'company';
  goal: string;
  nodeCount: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface InteractionV1 {
  id: string;
  runId: string;
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  prompt: string;
  response?: unknown;
  createdAt: string;
  expiresAt?: string;
}

export interface ArtifactV1 {
  id: string;
  runId: string;
  name: string;
  contentType: string;
  uri?: string;
  digest?: string;
  createdAt: string;
}

export interface PolicyBundleV1 {
  name: string;
  version: number;
  effectDefaults: { allow: boolean; requireApproval: boolean };
}

/** Resources exposed by the Gateway under /api/v1/... */
export const SDK_V1_RESOURCES = [
  'runs',
  'workgraphs',
  'interactions',
  'artifacts',
  'policy-bundles',
] as const;

export type SdkV1Resource = (typeof SDK_V1_RESOURCES)[number];
