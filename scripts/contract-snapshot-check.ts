#!/usr/bin/env node
/**
 * Contract snapshot baseline check (v2 constitution freeze).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  snapshotContracts,
  detectBreakingChanges,
  type ContractSnapshot,
} from '../packages/contracts/src/compatibility.v2.js';

const ROOT = process.cwd();
const BASELINE_PATH = resolve(ROOT, 'packages/contracts/snapshots/contract-snapshot.baseline.json');
const UPDATE_FLAG = '--update-baseline';

function serialize(snapshot: ContractSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + '\n';
}

function summarize(snapshot: ContractSnapshot): string {
  const contractKeys = Object.keys(snapshot.contracts);
  return (
    `packageVersion=${snapshot.packageVersion} ` +
    `contracts=${contractKeys.length} ` +
    `runStates=${snapshot.runStates.length} ` +
    `stepStates=${snapshot.stepStates.length} ` +
    `errorCodes=${snapshot.errorCodes.length}`
  );
}

function readBaseline(): ContractSnapshot {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`[contract:check] No baseline found at ${BASELINE_PATH}.`);
    console.error('[contract:check] Create one with: pnpm contract:snapshot');
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as ContractSnapshot;
  } catch (err) {
    console.error(`[contract:check] Failed to parse baseline: ${(err as Error).message}`);
    process.exit(1);
  }
}

function writeBaseline(snapshot: ContractSnapshot): void {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, serialize(snapshot));
}

function main(): void {
  const updateBaseline = process.argv.slice(2).includes(UPDATE_FLAG);
  const current = snapshotContracts();

  if (updateBaseline) {
    writeBaseline(current);
    console.log(`[contract:snapshot] Baseline written to ${BASELINE_PATH}`);
    console.log(`[contract:snapshot] ${summarize(current)}`);
    return;
  }

  const baseline = readBaseline();
  const breaking = detectBreakingChanges(baseline, current);

  if (breaking.length > 0) {
    console.error('[contract:check] Breaking contract changes detected:');
    for (const change of breaking) console.error(`  - ${change}`);
    console.error('');
    console.error('[contract:check] If intentional, run: pnpm contract:snapshot');
    process.exit(1);
  }

  console.log(`[contract:check] No breaking changes detected (${summarize(current)}).`);
}

main();
