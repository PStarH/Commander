/**
 * Failure Injection - chaos harness for the reversibility runtime.
 *
 * Mission: verify that when X goes wrong, the compensation plan still
 * restores the pre-failure state. The harness simulates the seven
 * standard failure categories.
 */

import type { HttpRequest, HttpResponse, HttpSendFn } from './external/httpClient';

export type FailureCategory =
  | 'compute'
  | 'storage'
  | 'network'
  | 'state'
  | 'dependency'
  | 'time'
  | 'security';

export type FailureMode =
  | 'timeout'
  | 'refused'
  | 'reset'
  | 'partition'
  | 'dns_failure'
  | 'slow_network'
  | 'http_5xx'
  | 'http_429'
  | 'http_4xx'
  | 'http_500'
  | 'db_deadlock'
  | 'db_failover'
  | 'cache_eviction'
  | 'process_crash'
  | 'oom'
  | 'cpu_throttle'
  | 'disk_full'
  | 'io_hang'
  | 'snapshot_corruption'
  | 'clock_skew'
  | 'ntp_failure'
  | 'auth_expired'
  | 'iam_deny'
  | 'cert_expired';

export type FailureTarget = 'http' | 'db' | 'fs' | 'clock' | 'process' | 'auth';

export interface FaultRule {
  mode: FailureMode;
  target: FailureTarget;
  probability?: number;
  delayMs?: number;
  statusCode?: number;
  latencyMs?: number;
  partialRate?: number;
  maxInvocations?: number;
}

export interface InjectedFailure {
  rule: FaultRule;
  url?: string;
  timestamp: number;
  description: string;
}

export class FailureInjector {
  private rules: FaultRule[] = [];
  invocations = 0;
  private injected: InjectedFailure[] = [];
  private rng: () => number;
  private clock: () => number;

  constructor(opts: { seed?: number; clock?: () => number } = {}) {
    this.rng = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random.bind(Math);
    this.clock = opts.clock ?? (() => Date.now());
  }

  addRule(rule: FaultRule): void {
    this.rules.push(rule);
  }

  addScenario(scenario: keyof typeof SCENARIOS, opts: Partial<FaultRule> = {}): void {
    const base = SCENARIOS[scenario];
    this.addRule({ ...base, ...opts } as FaultRule);
  }

  reset(): void {
    this.rules = [];
    this.invocations = 0;
    this.injected = [];
  }

  wrapHttp(send: HttpSendFn): HttpSendFn {
    return async (req: HttpRequest): Promise<HttpResponse> => {
      const match = this.matchRule('http');
      if (match) return this.injectHttp(req, match);
      return send(req);
    };
  }

  wrapDb<T extends object>(db: T): T {
    return new Proxy(db, {
      get: (target, prop) => {
        const original = (target as Record<string | symbol, unknown>)[prop];
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) => {
          const match = this.matchRule('db');
          if (match) return this.injectDb(prop, args, match);
          return (original as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as T;
  }

  wrapFs<T extends object>(fs: T): T {
    return new Proxy(fs, {
      get: (target, prop) => {
        const original = (target as Record<string | symbol, unknown>)[prop];
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) => {
          const match = this.matchRule('fs');
          if (match) return this.injectFs(prop, args, match);
          return (original as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as T;
  }

  scheduleProcessCrash(delayMs = 0): NodeJS.Timeout {
    return setTimeout(() => {
      throw new Error('Injected process crash');
    }, delayMs);
  }

  skewClock(skewMs: number): void {
    this.clock = () => Date.now() + skewMs;
  }

  injectedCount(): number {
    return this.injected.length;
  }
  getInjected(): InjectedFailure[] {
    return [...this.injected];
  }

  private matchRule(target: FailureTarget): FaultRule | null {
    this.invocations++;
    for (const rule of this.rules) {
      if (rule.target !== target) continue;
      if (rule.maxInvocations !== undefined && rule.maxInvocations <= 0) continue;
      if (rule.maxInvocations !== undefined) rule.maxInvocations--;
      const prob = rule.probability ?? 1;
      if (this.rng() > prob) continue;
      if (rule.delayMs && rule.delayMs > 0) continue;
      return rule;
    }
    return null;
  }

  private async injectHttp(req: HttpRequest, rule: FaultRule): Promise<HttpResponse> {
    this.injected.push({
      rule,
      url: req.url,
      timestamp: this.clock(),
      description: `injected ${rule.mode} on ${req.method} ${req.url}`,
    });
    switch (rule.mode) {
      case 'timeout':
        await new Promise((r) => setTimeout(r, req.timeoutMs ?? 30000));
        return { status: 0, headers: {}, body: 'injected timeout', ok: false };
      case 'refused':
        return { status: 0, headers: {}, body: 'injected connection refused', ok: false };
      case 'reset':
        return { status: 0, headers: {}, body: 'injected connection reset', ok: false };
      case 'partition':
        return { status: 0, headers: {}, body: 'injected network partition', ok: false };
      case 'dns_failure':
        return { status: 0, headers: {}, body: 'injected DNS failure', ok: false };
      case 'slow_network':
        await new Promise((r) => setTimeout(r, rule.latencyMs ?? 5000));
        break;
      case 'http_5xx':
      case 'http_500':
        return { status: 500, headers: {}, body: 'injected 500', ok: false };
      case 'http_429':
        return { status: 429, headers: { 'retry-after': '1' }, body: 'injected 429', ok: false };
      case 'http_4xx':
        return { status: rule.statusCode ?? 400, headers: {}, body: 'injected 4xx', ok: false };
      case 'auth_expired':
        return { status: 401, headers: {}, body: 'injected auth expired', ok: false };
      case 'iam_deny':
        return { status: 403, headers: {}, body: 'injected IAM deny', ok: false };
      case 'cert_expired':
        return { status: 0, headers: {}, body: 'injected cert expired', ok: false };
      default:
        return { status: 500, headers: {}, body: `injected ${rule.mode}`, ok: false };
    }
    return { status: 200, headers: {}, body: '{}', ok: true };
  }

  private injectDb(method: string | symbol, _args: unknown[], rule: FaultRule): never {
    this.injected.push({
      rule,
      timestamp: this.clock(),
      description: `injected ${rule.mode} on db.${String(method)}`,
    });
    switch (rule.mode) {
      case 'db_deadlock':
        throw new Error('SQLITE_BUSY: database is locked');
      case 'db_failover':
        throw new Error('connection lost during failover');
      case 'disk_full':
        throw new Error('SQLITE_FULL: database or disk is full');
      default:
        throw new Error(`Injected ${rule.mode} on db.${String(method)}`);
    }
  }

  private injectFs(method: string | symbol, _args: unknown[], rule: FaultRule): never {
    this.injected.push({
      rule,
      timestamp: this.clock(),
      description: `injected ${rule.mode} on fs.${String(method)}`,
    });
    switch (rule.mode) {
      case 'disk_full':
        throw new Error('ENOSPC: no space left on device');
      case 'io_hang':
        throw new Error('injected I/O hang');
      case 'snapshot_corruption':
        throw new Error('injected snapshot corruption');
      default:
        throw new Error(`Injected ${rule.mode} on fs.${String(method)}`);
    }
  }
}

export const SCENARIOS = {
  'network-timeout': { target: 'http', mode: 'timeout' } as FaultRule,
  'network-500': { target: 'http', mode: 'http_500' } as FaultRule,
  'network-429': { target: 'http', mode: 'http_429' } as FaultRule,
  'network-partition': { target: 'http', mode: 'partition' } as FaultRule,
  'auth-expired': { target: 'http', mode: 'auth_expired' } as FaultRule,
  'iam-deny': { target: 'http', mode: 'iam_deny' } as FaultRule,
  'db-deadlock': { target: 'db', mode: 'db_deadlock' } as FaultRule,
  'db-failover': { target: 'db', mode: 'db_failover' } as FaultRule,
  'disk-full': { target: 'fs', mode: 'disk_full' } as FaultRule,
  'io-hang': { target: 'fs', mode: 'io_hang' } as FaultRule,
  'flaky-network': { target: 'http', mode: 'http_500', probability: 0.3 } as FaultRule,
  'rate-limited': { target: 'http', mode: 'http_429', probability: 0.5 } as FaultRule,
  'crash-mid-step': { target: 'process', mode: 'process_crash' } as FaultRule,
  'clock-skew': { target: 'clock', mode: 'clock_skew' } as FaultRule,
  'partial-completion': {
    target: 'http',
    mode: 'http_500',
    probability: 0.5,
    partialRate: 0.3,
  } as FaultRule,
} as const;

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScenarioReport {
  scenarioName: string;
  totalInvocations: number;
  injectedFailures: InjectedFailure[];
  byMode: Record<string, number>;
  byCategory: Record<FailureCategory, number>;
  durationMs: number;
  success: boolean;
}

export async function runScenario(input: {
  name: string;
  setup: () => Promise<void> | void;
  work: () => Promise<unknown>;
  teardown?: () => Promise<void> | void;
  injector: FailureInjector;
}): Promise<ScenarioReport> {
  const start = Date.now();
  await input.setup();
  let success = true;
  try {
    await input.work();
  } catch {
    success = false;
  }
  if (input.teardown) await input.teardown();
  const injected = input.injector.getInjected();
  const byMode: Record<string, number> = {};
  const byCategory: Record<FailureCategory, number> = {
    compute: 0,
    storage: 0,
    network: 0,
    state: 0,
    dependency: 0,
    time: 0,
    security: 0,
  };
  for (const f of injected) {
    byMode[f.rule.mode] = (byMode[f.rule.mode] ?? 0) + 1;
    byCategory[modeToCategory(f.rule.mode)]++;
  }
  return {
    scenarioName: input.name,
    totalInvocations: input.injector.invocations,
    injectedFailures: injected,
    byMode,
    byCategory,
    durationMs: Date.now() - start,
    success,
  };
}

function modeToCategory(mode: FailureMode): FailureCategory {
  if (['timeout', 'refused', 'reset', 'partition', 'dns_failure', 'slow_network'].includes(mode))
    return 'network';
  if (['http_5xx', 'http_429', 'http_4xx', 'http_500'].includes(mode)) return 'dependency';
  if (['db_deadlock', 'db_failover', 'cache_eviction'].includes(mode)) return 'state';
  if (['process_crash', 'oom', 'cpu_throttle'].includes(mode)) return 'compute';
  if (['disk_full', 'io_hang', 'snapshot_corruption'].includes(mode)) return 'storage';
  if (['clock_skew', 'ntp_failure'].includes(mode)) return 'time';
  if (['auth_expired', 'iam_deny', 'cert_expired'].includes(mode)) return 'security';
  return 'dependency';
}
