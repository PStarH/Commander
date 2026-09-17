/**
 * Side-effect environment bootstrap for the Commander CLI.
 *
 * ESM evaluates a module's static import list (depth-first, in source order)
 * BEFORE that module's own statements run. A `loadEnvUp()` call inside
 * `cliEntry.ts`'s `main()` therefore executes only after every module in the
 * import graph has already been evaluated — too late for the config/provider
 * modules that snapshot `process.env` at module scope. Importing this module as
 * the FIRST import of `cliEntry.ts` makes the walk-up `.env` values available
 * before any of those modules initialize.
 *
 * Semantics:
 *   - Inherited environment always wins. `process.loadEnvFile()` never
 *     overwrites a key that is already present in `process.env`, so an exported
 *     shell variable is not clobbered by a `.env` file.
 *   - Skipped when `NODE_ENV=test`, so a test run never ingests a developer's
 *     real `.env` from the repository root.
 *   - Skipped when `COMMANDER_SKIP_DOTENV=1`, an explicit opt-out for hermetic
 *     or reproducible invocations.
 */
import { loadEnvUp } from './envLoader';

if (process.env.NODE_ENV !== 'test' && process.env.COMMANDER_SKIP_DOTENV !== '1') {
  loadEnvUp();
}
