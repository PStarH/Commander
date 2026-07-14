#!/usr/bin/env tsx
/**
 * bench-memory-poisoning.ts — cross-tenant memory poisoning fuzz benchmark
 *
 * Exercises `packages/core/src/threeLayerMemory.ts` (ThreeLayerMemory) with
 * 6 attack vectors designed to surface cross-tenant bleed that the singleton
 * layer does NOT defend against. The bench assumes the class is used as
 * documented (per-tenant singleton via `runWithTenant` + getGlobalThreeLayerMemory)
 * and additionally tests the class-level attack surface where a shared
 * ThreeLayerMemory instance is reachable across tenants.
 *
 * Attack vectors:
 *   V1. tenant_id_spoof_in_metadata — write carries metadata.tenantId='a',
 *       read from tenant B's context returns it. The class does not filter
 *       on metadata.tenantId in querySync/query; this is the primary leak
 *       path when a ThreeLayerMemory is shared by accident.
 *   V2. longterm_cross_tenant_promotion — Tenant A promotes a working
 *       memory to longterm; Tenant B's `query({layer: 'longterm'})` returns
 *       it. There is no per-tenant check on promoteToLongTerm.
 *   V3. searchRelated_keyword_collision — Tenant A writes "Project Phoenix
 *       secret API key: ABC123"; Tenant B's `searchRelated("API key")`
 *       returns the secret. searchRelated has no tenant filter.
 *   V4. importance_threshold_bypass — Tenant A writes 5 entries with
 *       importance=0.99; Tenant B's `query({importanceThreshold: 0.5})`
 *       returns them. importanceThreshold is a content filter, not a
 *       tenant boundary.
 *   V5. contradictionIds_metadata_leak — Tenant A writes entry X; X's
 *       contradiction detection stores the IDs of tenant A's other entries
 *       in X.metadata.contradictionIds. If Tenant B can read X, the IDs of
 *       tenant A's other entries are leaked.
 *   V6. promoteToLongTerm_layer_transition — Tenant A's working memory is
 *       promoted to longterm; Tenant B's `query({layer: 'longterm'})`
 *       retrieves it. Same as V2 but the attack is initiated by Tenant A
 *       explicitly, not by eviction/promotion logic.
 *
 * Pass criteria: the bench fails the build on the FIRST cross-tenant leak,
 * not on a fixed-leak-count threshold. This avoids the silent-PASS
 * anti-pattern that bench-slo-baseline.ts (until 2026-07-07) and others
 * had: a try/catch that converts an exception to `passed: true` while
 * recording `actualMs: 0`. Here, every leak is `passed: false`.
 *
 * Output baseline:
 *   docs/baselines/memory-poisoning.<YYYY-MM-DD>.json
 *
 * Usage:
 *   npx tsx scripts/bench-memory-poisoning.ts
 *   npx tsx scripts/bench-memory-poisoning.ts --output=docs/baselines/memory-poisoning.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { withBenchmarkEnv } from './benchmarkEnv';

import { createThreeLayerMemory } from '../packages/core/src/threeLayerMemory';

interface AttackVector {
  id: string;
  name: string;
  description: string;
}

interface AttackResult {
  vector: string;
  victimTenant: string;
  attackerTenant: string;
  poisonedPayload: string;
  leakedContent: string | null;
  leakedEntryId: string | null;
  passed: boolean;
  reason?: string;
}

const VECTORS: AttackVector[] = [
  {
    id: 'V1_tenant_id_spoof_in_metadata',
    name: 'tenant_id_spoof_in_metadata',
    description: 'Write entry tagged with metadata.tenantId; expect query to filter by tenant.',
  },
  {
    id: 'V2_longterm_cross_tenant_promotion',
    name: 'longterm_cross_tenant_promotion',
    description: 'Promote working memory to longterm; expect longterm query to respect tenant.',
  },
  {
    id: 'V3_searchRelated_keyword_collision',
    name: 'searchRelated_keyword_collision',
    description:
      'Write secret with distinctive keywords; expect searchRelated to filter by tenant.',
  },
  {
    id: 'V4_importance_threshold_bypass',
    name: 'importance_threshold_bypass',
    description:
      'Write high-importance entries; expect importanceThreshold query to filter by tenant.',
  },
  {
    id: 'V5_contradictionIds_metadata_leak',
    name: 'contradictionIds_metadata_leak',
    description:
      'Trigger contradiction detection; expect metadata.contradictionIds to not leak across tenants.',
  },
  {
    id: 'V6_promoteToLongTerm_layer_transition',
    name: 'promoteToLongTerm_layer_transition',
    description: 'Promote to longterm; expect subsequent longterm query to filter by tenant.',
  },
];

/**
 * TenantContext simulates a thin wrapper that tags every write with a
 * tenantId in metadata.tenantId. This is the canonical pattern the
 * codebase expects callers to use; if a caller forgets to tag, the
 * attack succeeds. The bench models the worst case (writes ARE tagged,
 * reads are NOT filtered) to surface the class-level gap.
 */
function makeTenantScopedMemory() {
  return createThreeLayerMemory({});
}

async function runV1_tenantIdSpoofInMetadata(
  memory: Awaited<ReturnType<typeof makeTenantScopedMemory>>,
): Promise<AttackResult> {
  const TENANT_A = 'tenant-a-poison-v1';
  const TENANT_B = 'tenant-b-clean-v1';
  const payload = 'CONFIDENTIAL-TENANT-A-ONLY-7f3a';

  const entry = memory.add(payload, 'longterm', 'project-x', 0.95, ['secret'], {
    tenantId: TENANT_A,
  });

  // Tenant B's read with no tenant filter — this is the attack.
  const tenantBView = memory.querySync({
    layer: 'longterm',
    keywords: ['CONFIDENTIAL'],
    limit: 10,
  });

  const leaked = tenantBView.find((m) => m.id === entry.id) ?? null;
  return {
    vector: 'V1_tenant_id_spoof_in_metadata',
    victimTenant: TENANT_A,
    attackerTenant: TENANT_B,
    poisonedPayload: payload,
    leakedContent: leaked ? leaked.content : null,
    leakedEntryId: leaked ? leaked.id : null,
    passed: leaked === null,
    reason: leaked ? 'metadata.tenantId not enforced in querySync' : undefined,
  };
}

async function runV2_longtermCrossTenantPromotion(
  memory: Awaited<ReturnType<typeof makeTenantScopedMemory>>,
): Promise<AttackResult> {
  const TENANT_A = 'tenant-a-poison-v2';
  const TENANT_B = 'tenant-b-clean-v2';
  const payload = 'PROMOTED-LONGTERM-LEAK-9d2e';

  const working = memory.add(payload, 'working', 'session-a', 0.95, ['ephemeral'], {
    tenantId: TENANT_A,
  });
  memory.promoteToLongTerm(working.id);

  const tenantBView = memory.querySync({
    layer: 'longterm',
    keywords: ['PROMOTED'],
    limit: 10,
  });

  const leaked = tenantBView.find((m) => m.id === working.id) ?? null;
  return {
    vector: 'V2_longterm_cross_tenant_promotion',
    victimTenant: TENANT_A,
    attackerTenant: TENANT_B,
    poisonedPayload: payload,
    leakedContent: leaked ? leaked.content : null,
    leakedEntryId: leaked ? leaked.id : null,
    passed: leaked === null,
    reason: leaked ? 'promoteToLongTerm has no tenant check' : undefined,
  };
}

async function runV3_searchRelatedKeywordCollision(
  memory: Awaited<ReturnType<typeof makeTenantScopedMemory>>,
): Promise<AttackResult> {
  const TENANT_A = 'tenant-a-poison-v3';
  const TENANT_B = 'tenant-b-clean-v3';
  const payload = 'Project Phoenix secret API key: ABC123XYZ-PHOENIX';

  memory.add(payload, 'episodic', 'integration', 0.9, ['credential'], {
    tenantId: TENANT_A,
  });

  const tenantBView = memory.searchRelated('API key phoenix', 10);
  const leaked = tenantBView.find((m) => m.content.includes('ABC123XYZ-PHOENIX')) ?? null;
  return {
    vector: 'V3_searchRelated_keyword_collision',
    victimTenant: TENANT_A,
    attackerTenant: TENANT_B,
    poisonedPayload: payload,
    leakedContent: leaked ? leaked.content : null,
    leakedEntryId: leaked ? leaked.id : null,
    // Bench assertion fix: the `?? null` after `find(...)` ensures `leaked`
    // is null (entry not found in Tenant B's view) or an entry object (leak
    // observable). It can NEVER be `undefined` after the coalesce. The
    // previous `=== undefined` check made this vector structurally
    // unfalsifiable: defended and leaked both reported false. Mirrors the
    // silent-fail cousin of bench-slo-baseline's silent-PASS anti-pattern.
    passed: leaked === null,
    reason: leaked ? 'searchRelated has no tenant filter' : undefined,
  };
}

async function runV4_importanceThresholdBypass(
  memory: Awaited<ReturnType<typeof makeTenantScopedMemory>>,
): Promise<AttackResult> {
  const TENANT_A = 'tenant-a-poison-v4';
  const TENANT_B = 'tenant-b-clean-v4';
  const payload = 'HIGH-IMPORTANCE-LEAK-2b8c';

  // Add multiple high-importance entries to surface the importance-threshold
  // attack surface (a single entry might be missed by random selection; 5
  // entries guarantee a positive hit on a broken filter).
  const added: string[] = [];
  for (let i = 0; i < 5; i++) {
    const e = memory.add(`${payload}-${i}`, 'longterm', `project-${i}`, 0.99, ['critical'], {
      tenantId: TENANT_A,
    });
    added.push(e.id);
  }

  const tenantBView = memory.querySync({
    layer: 'longterm',
    keywords: ['HIGH-IMPORTANCE'],
    importanceThreshold: 0.5,
    limit: 20,
  });

  const leakedIds = tenantBView.map((m) => m.id).filter((id) => added.includes(id));
  return {
    vector: 'V4_importance_threshold_bypass',
    victimTenant: TENANT_A,
    attackerTenant: TENANT_B,
    poisonedPayload: payload,
    leakedContent: leakedIds.length > 0 ? 'multiple entries leaked' : null,
    leakedEntryId: leakedIds[0] ?? null,
    passed: leakedIds.length === 0,
    reason:
      leakedIds.length > 0
        ? `importanceThreshold query returned ${leakedIds.length}/${added.length} cross-tenant entries`
        : undefined,
  };
}

async function runV5_contradictionIdsMetadataLeak(
  memory: Awaited<ReturnType<typeof makeTenantScopedMemory>>,
): Promise<AttackResult> {
  const TENANT_A = 'tenant-a-poison-v5';
  const TENANT_B = 'tenant-b-clean-v5';

  // Seed several entries that will trigger the contradiction detector on
  // the next write. The detector (textSimilarity > 0.7) requires similar
  // content; we use a recurring phrase.
  for (let i = 0; i < 3; i++) {
    memory.add(
      `Recurring session fact number ${i} about deployment pipeline for tenant a.`,
      'longterm',
      `ctx-${i}`,
      0.6,
      ['fact'],
      { tenantId: TENANT_A },
    );
  }
  // The trigger entry: high importance, similar text, conflicting importance.
  const trigger = memory.add(
    'Recurring session fact about deployment pipeline for tenant a, but with a different policy.',
    'longterm',
    'ctx-trigger',
    0.1,
    ['fact'],
    { tenantId: TENANT_A },
  );

  // Tenant B attempts to read the trigger entry directly. If they can guess
  // the ID (via searchRelated on the seed), they can read metadata.contradictionIds,
  // which contains the IDs of tenant A's other entries.
  const tenantBSeedView = memory.querySync({
    layer: 'longterm',
    keywords: ['Recurring session fact'],
    limit: 10,
  });
  const triggerLeak = tenantBSeedView.find((m) => m.id === trigger.id);
  const contradictionIds = (triggerLeak?.metadata?.contradictionIds as string[] | undefined) ?? [];
  const leaked = contradictionIds.length > 0;

  return {
    vector: 'V5_contradictionIds_metadata_leak',
    victimTenant: TENANT_A,
    attackerTenant: TENANT_B,
    poisonedPayload: trigger.id,
    leakedContent: leaked ? `contradictionIds=${JSON.stringify(contradictionIds)}` : null,
    leakedEntryId: trigger.id,
    passed: !leaked,
    reason: leaked ? 'metadata.contradictionIds leaked cross-tenant' : undefined,
  };
}

async function runV6_promoteToLongTermLayerTransition(
  memory: Awaited<ReturnType<typeof makeTenantScopedMemory>>,
): Promise<AttackResult> {
  const TENANT_A = 'tenant-a-poison-v6';
  const TENANT_B = 'tenant-b-clean-v6';
  const payload = 'EXPLICIT-PROMOTE-LEAK-5e1a';

  const working = memory.add(payload, 'working', 'session-a-v6', 0.95, ['session'], {
    tenantId: TENANT_A,
  });
  memory.promoteToLongTerm(working.id);

  const tenantBView = memory.querySync({
    layer: 'longterm',
    keywords: ['EXPLICIT-PROMOTE'],
    limit: 10,
  });
  const leaked = tenantBView.find((m) => m.id === working.id) ?? null;
  return {
    vector: 'V6_promoteToLongTerm_layer_transition',
    victimTenant: TENANT_A,
    attackerTenant: TENANT_B,
    poisonedPayload: payload,
    leakedContent: leaked ? leaked.content : null,
    leakedEntryId: leaked ? leaked.id : null,
    passed: leaked === null,
    reason: leaked ? 'promoteToLongTerm has no tenant check (V2 duplicate)' : undefined,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/memory-poisoning.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('Cross-Tenant Memory Poisoning Fuzz Benchmark');
  console.log('═'.repeat(70));
  console.log(`  Vectors: ${VECTORS.length}`);
  console.log(`  Target: packages/core/src/threeLayerMemory.ts (ThreeLayerMemory)`);
  console.log('═'.repeat(70));

  // Single shared instance — the bench models the worst case (an accidental
  // cross-tenant shared instance). Per the codebase's documented usage, the
  // singleton layer isolates tenants; this bench tests the class-level attack
  // surface that the singleton does NOT defend against.
  const memory = await makeTenantScopedMemory();
  const results: AttackResult[] = [];

  const start = Date.now();

  // Run all 6 vectors against the SAME shared memory to surface cross-vector
  // interactions (e.g. V4's high-importance writes inflate V1's leak surface).
  for (const vector of VECTORS) {
    let result: AttackResult;
    try {
      switch (vector.id) {
        case 'V1_tenant_id_spoof_in_metadata':
          result = await runV1_tenantIdSpoofInMetadata(memory);
          break;
        case 'V2_longterm_cross_tenant_promotion':
          result = await runV2_longtermCrossTenantPromotion(memory);
          break;
        case 'V3_searchRelated_keyword_collision':
          result = await runV3_searchRelatedKeywordCollision(memory);
          break;
        case 'V4_importance_threshold_bypass':
          result = await runV4_importanceThresholdBypass(memory);
          break;
        case 'V5_contradictionIds_metadata_leak':
          result = await runV5_contradictionIdsMetadataLeak(memory);
          break;
        case 'V6_promoteToLongTerm_layer_transition':
          result = await runV6_promoteToLongTermLayerTransition(memory);
          break;
        default:
          throw new Error(`Unknown vector id: ${vector.id}`);
      }
    } catch (err) {
      result = {
        vector: vector.id,
        victimTenant: 'unknown',
        attackerTenant: 'unknown',
        poisonedPayload: 'unknown',
        leakedContent: null,
        leakedEntryId: null,
        passed: false,
        reason: `vector threw: ${(err as Error).message}`,
      };
    }
    results.push(result);
    const icon = result.passed ? '\u2705' : '\u274C';
    console.log(
      `  ${icon} ${vector.id}: ${result.passed ? 'defended' : (result.reason ?? 'leaked')}`,
    );
  }

  const durationMs = Date.now() - start;
  const totalCases = VECTORS.length;
  const defended = results.filter((r) => r.passed).length;
  const leaked = totalCases - defended;
  console.log('─'.repeat(70));
  console.log(`  Total cases:  ${totalCases}`);
  console.log(`  Defended:     ${defended}`);
  console.log(`  Leaks:        ${leaked}`);
  console.log(`  Duration:     ${durationMs}ms`);
  console.log('═'.repeat(70));

  if (leaked > 0) {
    console.log('\n  \uD83D\uDEA8 LEAKS DETECTED:');
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`    \u2022 ${r.vector}: ${r.reason ?? 'leaked without reason set'}`);
    }
  }

  const baseline = withBenchmarkEnv(
    {
      benchmark: 'memory-poisoning',
      config: { vectors: VECTORS.length },
      report: {
        targetName: 'three_layer_memory',
        totalCases,
        defended,
        leaks: results
          .filter((r) => !r.passed)
          .map((r) => ({
            vector: r.vector,
            victimTenant: r.victimTenant,
            attackerTenant: r.attackerTenant,
            leakedContent: r.leakedContent,
            leakedEntryId: r.leakedEntryId,
            reason: r.reason,
          })),
        errors: 0,
        durationMs,
        vectorDetails: results,
      },
      summary: {
        passed: leaked === 0,
        leakCount: leaked,
      },
    },
    { evidence: 'simulated' },
  );

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  if (leaked > 0) {
    console.log(`\u274C FAIL: ${leaked} cross-tenant memory leak(s) detected`);
    process.exit(1);
  }
  console.log('\u2705 PASS: No cross-tenant memory poisoning leaks detected');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
