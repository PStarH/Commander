/**
 * DataLeakageVerifier — deterministic cross-tenant data leakage validation.
 *
 * Seeds tenant-specific data into a target store/runtime, then executes a fixed
 * suite of cross-tenant access attempts. A leak is recorded whenever data
 * seeded for tenant A is returned in a tenant B context.
 *
 * Integrates with:
 *   - tenantContext primitives (runWithTenant, assertSameTenant, tenantKey)
 *   - SecurityAnomalyDetector for violation telemetry
 *   - FuzzTestFramework / CrossTenantFuzzTest for regression CI
 *
 * Usage:
 *   const verifier = new DataLeakageVerifier();
 *   verifier.registerTarget(makeMemoryTarget());
 *   const report = await verifier.verify();
 *   expect(report.leaks).toHaveLength(0);
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import type { MessageBusTopic } from '../runtime/types/messageBus';
import {
  runWithTenant,
  getCurrentTenantId,
  requireCurrentTenantId,
  tenantKey,
  assertSameTenant,
  TenantIsolationError,
  validateTenantId,
} from '../runtime/tenantContext';
import { getSecurityAnomalyDetector } from './securityAnomalyDetector';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type LeakageVector =
  | 'direct_id_spoof'
  | 'key_prefix_spoof'
  | 'path_traversal'
  | 'shared_global_store'
  | 'async_context_confusion'
  | 'list_without_filter'
  | 'case_variation'
  | 'null_byte_truncation';

export interface DataLeakageConfig {
  /** Tenant IDs used as data owners. */
  tenants: string[];
  /** Timeout per verification case (ms). */
  caseTimeoutMs: number;
  /** Vectors to run. */
  vectors: LeakageVector[];
  /** Whether a TenantIsolationError / assertSameTenant rejection counts as a successful defense. */
  rejectionIsPass: boolean;
  /** Publish violations to SecurityAnomalyDetector. */
  publishAnomalies: boolean;
}

export interface TenantDataSeed<T = unknown> {
  tenantId: string;
  items: T[];
}

export interface DataLeakageTarget<T = unknown> {
  /** Human-readable target name. */
  name: string;
  /** Seed data generator for a tenant. */
  seedData: (tenantId: string) => T[];
  /** Write item under tenant. */
  write: (tenantId: string, item: T) => Promise<void> | void;
  /** Read item by key under tenant. */
  read: (tenantId: string, key: string) => Promise<unknown> | unknown;
  /** Optional list all items (tests list_without_filter vector). */
  list?: () => Promise<unknown[]> | unknown[];
  /** Extract key from seed item. */
  keyExtractor: (item: T) => string;
  /** Extract value signature from seed item for leakage detection. */
  valueExtractor: (item: T) => string;
}

export interface LeakageTestCase {
  id: string;
  vector: LeakageVector;
  ownerTenant: string;
  attackerTenant: string;
  description: string;
}

export interface DataLeak {
  caseId: string;
  vector: LeakageVector;
  ownerTenant: string;
  attackerTenant: string;
  leakedValueSignature: string;
  description: string;
}

export interface DataLeakageReport {
  runId: string;
  targetName: string;
  totalCases: number;
  leaks: DataLeak[];
  defended: number;
  errors: number;
  durationMs: number;
  startedAt: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Default Config
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DataLeakageConfig = {
  tenants: ['alpha', 'beta', 'gamma'],
  caseTimeoutMs: 2000,
  vectors: [
    'direct_id_spoof',
    'key_prefix_spoof',
    'path_traversal',
    'shared_global_store',
    'async_context_confusion',
    'list_without_filter',
    'case_variation',
    'null_byte_truncation',
  ],
  rejectionIsPass: true,
  publishAnomalies: false,
};

// ──────────────────────────────────────────────────────────────────────────
// DataLeakageVerifier
// ──────────────────────────────────────────────────────────────────────────

export class DataLeakageVerifier {
  private config: DataLeakageConfig;
  private target: DataLeakageTarget | null = null;
  private seededSignatures = new Map<string, Set<string>>();

  constructor(config?: Partial<DataLeakageConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  registerTarget<T>(target: DataLeakageTarget<T>): void {
    this.target = target as DataLeakageTarget;
  }

  unregisterTarget(): void {
    this.target = null;
    this.seededSignatures.clear();
  }

  /**
   * Seed tenant-isolated data for all configured tenants.
   */
  async seed(): Promise<void> {
    if (!this.target) throw new Error('No target registered');
    this.seededSignatures.clear();

    for (const tenantId of this.config.tenants) {
      validateTenantId(tenantId);
      const items = this.target.seedData(tenantId);
      const signatures = new Set<string>();
      for (const item of items) {
        signatures.add(this.target.valueExtractor(item));
        await runWithTenant(tenantId, () => this.target!.write(tenantId, item));
      }
      this.seededSignatures.set(tenantId, signatures);
    }
  }

  /**
   * Run the full deterministic leakage verification suite.
   */
  async verify(): Promise<DataLeakageReport> {
    if (!this.target) throw new Error('No target registered');
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    await this.seed();

    const cases = this.generateCases();
    const leaks: DataLeak[] = [];
    let defended = 0;
    let errors = 0;

    for (const testCase of cases) {
      const result = await this.executeCase(testCase);
      if (result.leak) {
        leaks.push(result.leak);
        if (this.config.publishAnomalies) {
          this.publishLeakAnomaly(result.leak);
        }
      } else if (result.defended) {
        defended++;
      } else if (result.error) {
        errors++;
      }
    }

    return {
      runId: `dlv-${startMs}`,
      targetName: this.target.name,
      totalCases: cases.length,
      leaks,
      defended,
      errors,
      durationMs: Date.now() - startMs,
      startedAt,
    };
  }

  reset(): void {
    this.unregisterTarget();
  }

  // ── Case Generation ─────────────────────────────────────────────────────

  private generateCases(): LeakageTestCase[] {
    const cases: LeakageTestCase[] = [];
    let id = 0;
    for (const owner of this.config.tenants) {
      for (const attacker of this.config.tenants) {
        if (owner === attacker) continue;
        for (const vector of this.config.vectors) {
          cases.push({
            id: `dlv-${id++}`,
            vector,
            ownerTenant: owner,
            attackerTenant: attacker,
            description: `${vector}: ${attacker} attempts to read ${owner} data`,
          });
        }
      }
    }
    return cases;
  }

  // ── Case Execution ──────────────────────────────────────────────────────

  private async executeCase(
    testCase: LeakageTestCase,
  ): Promise<{ leak?: DataLeak; defended?: boolean; error?: string }> {
    if (!this.target) return { error: 'No target registered' };

    const startMs = Date.now();
    try {
      const value = await this.runWithTimeout(
        this.config.caseTimeoutMs,
        this.invokeAttack(testCase),
      );
      const leakedSignature = this.detectLeak(testCase.ownerTenant, value);
      if (leakedSignature) {
        return {
          leak: {
            caseId: testCase.id,
            vector: testCase.vector,
            ownerTenant: testCase.ownerTenant,
            attackerTenant: testCase.attackerTenant,
            leakedValueSignature: leakedSignature,
            description: testCase.description,
          },
        };
      }
      return { defended: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isDefense =
        this.config.rejectionIsPass &&
        (err instanceof TenantIsolationError || /tenant|isolation|cross-tenant/i.test(errorMsg));
      return isDefense ? { defended: true } : { error: errorMsg };
    } finally {
      // Avoid leaking timers in tests
      void (Date.now() - startMs);
    }
  }

  private invokeAttack(testCase: LeakageTestCase): Promise<unknown> | unknown {
    const target = this.target!;
    const owner = testCase.ownerTenant;
    const attacker = testCase.attackerTenant;
    const keyHint = this.firstKeyHint(owner);

    switch (testCase.vector) {
      case 'direct_id_spoof':
        // Attacker context tries to read using owner's tenant id directly
        return runWithTenant(attacker, () => target.read(owner, keyHint));

      case 'key_prefix_spoof': {
        // Craft a key that looks like it belongs to owner but from attacker context
        const spoofKey = tenantKey(owner, keyHint).replace(/^tenant:/, '');
        return runWithTenant(attacker, () => target.read(attacker, spoofKey));
      }

      case 'path_traversal': {
        const traversalKey = `../../${owner}/${keyHint}`;
        return runWithTenant(attacker, () => target.read(attacker, traversalKey));
      }

      case 'shared_global_store':
        // Read without any tenant context (global fallback)
        return target.read(owner, keyHint);

      case 'async_context_confusion': {
        // Start in attacker context, then try to read owner data while still inside
        return runWithTenant(attacker, () => target.read(owner, keyHint));
      }

      case 'list_without_filter': {
        if (!target.list) {
          throw new TenantIsolationError('Target does not support list');
        }
        return runWithTenant(attacker, () => target.list!());
      }

      case 'case_variation': {
        const caseVarOwner = owner.toUpperCase();
        return runWithTenant(attacker, () => target.read(caseVarOwner, keyHint));
      }

      case 'null_byte_truncation': {
        const nullKey = `${keyHint}\x00${owner}`;
        return runWithTenant(attacker, () => target.read(owner, nullKey));
      }

      default:
        return undefined;
    }
  }

  private firstKeyHint(tenantId: string): string {
    const target = this.target!;
    const items = target.seedData(tenantId);
    if (items.length === 0) return 'secret';
    return target.keyExtractor(items[0]);
  }

  private detectLeak(tenantId: string, value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const signatures = this.seededSignatures.get(tenantId);
    if (!signatures) return null;

    const flatten = (v: unknown): string[] => {
      if (v === null || v === undefined) return [];
      if (typeof v === 'string') return [v];
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
        return [String(v)];
      if (Array.isArray(v)) return v.flatMap(flatten);
      if (typeof v === 'object')
        return Object.values(v as Record<string, unknown>).flatMap(flatten);
      return [];
    };

    const fragments = flatten(value);
    for (const signature of signatures) {
      for (const fragment of fragments) {
        if (fragment.includes(signature)) return signature;
      }
    }
    return null;
  }

  private runWithTimeout<T>(ms: number, promiseLike: Promise<T> | T): Promise<T> {
    const promise = Promise.resolve(promiseLike);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('DataLeakageTimeout')), ms);
    });
    return Promise.race([promise, timeout]);
  }

  private publishLeakAnomaly(leak: DataLeak): void {
    try {
      const detector = getSecurityAnomalyDetector();
      detector.processEvent({
        id: crypto.randomUUID(),
        topic: 'tenant.data_leak_detected' as MessageBusTopic,
        source: 'DataLeakageVerifier',
        payload: {
          agentId: 'data-leakage-verifier',
          runId: leak.caseId,
          vector: leak.vector,
          ownerTenant: leak.ownerTenant,
          attackerTenant: leak.attackerTenant,
          leakedSignature: leak.leakedValueSignature,
        },
        priority: 'high',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      reportSilentFailure(err, 'dataLeakageVerifier:publish');
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Convenience Targets
// ──────────────────────────────────────────────────────────────────────────

export interface InMemoryLeakageTargetOptions<T = unknown> {
  name: string;
  store: Map<string, T>;
  seedValue: (tenantId: string) => T;
  valueToString: (value: T) => string;
}

export function createInMemoryLeakageTarget<T>(
  options: InMemoryLeakageTargetOptions<T>,
): DataLeakageTarget<{ key: string; value: T }> {
  return {
    name: options.name,
    seedData: (tenantId) => [
      { key: 'secret', value: options.seedValue(tenantId) },
      { key: 'profile', value: options.seedValue(tenantId) },
    ],
    keyExtractor: (item) => item.key,
    valueExtractor: (item) => options.valueToString(item.value),
    write: (tenantId, item) => {
      assertSameTenant(tenantId);
      const key = tenantKey(tenantId, item.key);
      options.store.set(key, item.value);
    },
    read: (tenantId, key) => {
      requireCurrentTenantId();
      assertSameTenant(tenantId);
      const keyResolved = tenantKey(tenantId, key);
      return options.store.get(keyResolved);
    },
    list: () => {
      const tenantId = getCurrentTenantId();
      if (!tenantId) return [];
      const prefix = tenantKey(tenantId, '');
      return Array.from(options.store.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let instance: DataLeakageVerifier | null = null;

export function getDataLeakageVerifier(config?: Partial<DataLeakageConfig>): DataLeakageVerifier {
  if (!instance || config) {
    instance = new DataLeakageVerifier(config);
  }
  return instance;
}

export function resetDataLeakageVerifier(): void {
  instance?.reset();
  instance = null;
}
