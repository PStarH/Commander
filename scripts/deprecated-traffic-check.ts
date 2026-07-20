#!/usr/bin/env node
/**
 * Helper for zero-traffic deletion evidence (metrics snapshot or static proof).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const inventory = JSON.parse(
  readFileSync(join(process.cwd(), 'config/deprecated-authorities.json'), 'utf-8'),
) as { authorities: Array<{ id: string; status: string; zeroTrafficWindowDays: number }> };

const target = process.argv[2];
if (!target) {
  console.log('Usage: deprecated-traffic-check.ts <inventory-id> [--static]');
  process.exit(1);
}

const entry = inventory.authorities.find((a) => a.id === target);
if (!entry) {
  console.error(`Unknown inventory id: ${target}`);
  process.exit(1);
}

if (process.argv.includes('--static')) {
  if (entry.status === 'deleted') {
    console.log(`[traffic-check] ${target}: static proven-zero (deleted)`);
    process.exit(0);
  }
  console.error(`[traffic-check] ${target}: not statically proven`);
  process.exit(1);
}

console.error(`[traffic-check] ${target}: requires production metrics backend (30d window)`);
process.exit(2);
