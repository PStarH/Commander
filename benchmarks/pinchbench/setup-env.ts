/**
 * Setup environment for PinchBench tests.
 * This file MUST be loaded before any Commander modules.
 *
 * Usage: npx tsx --require ./setup-env.ts test_multifile.ts
 */

// Set workspace BEFORE loading any modules that use SAFE_ROOT
process.env.COMMANDER_WORKSPACE = '/tmp/pinch-multifile-test';

// Load .env
import * as fs from 'node:fs';
import * as path from 'node:path';

function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && val && !process.env[key]) process.env[key] = val;
      }
      return;
    }
    dir = path.dirname(dir);
  }
}
loadEnv();

console.log('[setup-env] COMMANDER_WORKSPACE set to:', process.env.COMMANDER_WORKSPACE);
