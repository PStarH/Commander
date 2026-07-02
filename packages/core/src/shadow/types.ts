// packages/core/src/shadow/types.ts
import * as fs from 'node:fs';

export interface ShadowConfig {
  enabled: boolean;
  endpoint: string;
  sampleRate: number;
  scrubPii: boolean;
  ignoreFields: string[];
  diffMode: 'status_cost_latency' | 'full_output';
  timeoutMs: number;
}

export const DEFAULT_IGNORE_FIELDS = ['Authorization', 'x-api-key', 'x-auth-token', 'cookie'];

export function defaultShadowConfig(): ShadowConfig {
  return {
    enabled: false,
    endpoint: 'http://localhost:9999',
    sampleRate: 0.1,
    scrubPii: true,
    ignoreFields: DEFAULT_IGNORE_FIELDS,
    diffMode: 'status_cost_latency',
    timeoutMs: 5000,
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateShadowConfig(cfg: ShadowConfig): ValidationResult {
  const errors: string[] = [];
  if (cfg.sampleRate < 0 || cfg.sampleRate > 1) {
    errors.push('sampleRate must be between 0 and 1');
  }
  if (cfg.enabled && !cfg.endpoint) {
    errors.push('endpoint required when enabled');
  }
  return { valid: errors.length === 0, errors };
}

export interface DriftMetrics {
  statusDeltaPct: number;
  latencyDeltaPct: number;
  costDeltaPct: number;
}

const DRIFT_THRESHOLD_PCT = 5;

export function isDriftThresholdBreached(metrics: DriftMetrics): boolean {
  return (
    metrics.statusDeltaPct > DRIFT_THRESHOLD_PCT ||
    metrics.latencyDeltaPct > DRIFT_THRESHOLD_PCT ||
    metrics.costDeltaPct > DRIFT_THRESHOLD_PCT
  );
}

export interface DriftEntry {
  timestamp: string;
  endpoint: string;
  prodStatus: number;
  shadowStatus: number;
  prodLatencyMs: number;
  shadowLatencyMs: number;
  prodCostUsd: number;
  shadowCostUsd: number;
  driftDetected: boolean;
  metrics: DriftMetrics;
}

export function loadShadowConfig(): ShadowConfig {
  const configPath = `${process.cwd()}/.commander/shadow-config.json`;
  if (fs.existsSync(configPath)) {
    const file = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<ShadowConfig>;
    return { ...defaultShadowConfig(), ...file };
  }
  return defaultShadowConfig();
}
