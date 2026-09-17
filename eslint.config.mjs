// Lightweight ESLint config for no-console enforcement only.
// The project's primary lint gate is `tsc --noEmit` (TypeScript strict).
import tseslint from 'typescript-eslint';

/**
 * Rules shared by every scope that has a config block below.
 *
 * A file with NO matching block is parsed by ESLint's default parser, which
 * cannot parse TypeScript at all — it reports a parsing error per file and the
 * file is never actually linted. That is what happened to `apps/**`,
 * `integrations/**`, most `packages/*` and all of `scripts/**`: widening
 * `lint:eslint` to them produced 347 parsing errors, i.e. the files were being
 * counted as "linted" while nothing was checked.
 */
const sharedRules = {
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  '@typescript-eslint/no-unused-vars': [
    'warn',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  // None of these scopes is error-clean on `no-explicit-any` yet; keeping it a
  // warning here matches `packages/kernel` and keeps the gate actionable
  // without pretending the backlog is closed.
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-require-imports': 'off',
  'prefer-const': 'warn',
};

export default tseslint.config(
  {
    ignores: ['**/*.js', '**/*.d.ts'],
  },
  // Every first-party TypeScript scope gets a parser. Specific blocks below
  // narrow `no-console` and tighten rules where a scope is already clean.
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/tests/**/*.ts',
      'packages/*/test/**/*.ts',
      'apps/*/src/**/*.ts',
      'apps/*/test/**/*.ts',
      'apps/*/tests/**/*.ts',
      'integrations/*/src/**/*.ts',
      'integrations/*/tests/**/*.ts',
      'scripts/**/*.ts',
    ],
    extends: [tseslint.configs.base],
    rules: sharedRules,
  },
  {
    files: ['packages/core/src/**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-require-imports': 'off',
      'prefer-const': 'warn',
    },
  },
  // CLI files — terminal UI, console.log is the intended output mechanism
  {
    files: [
      'packages/core/src/cli.ts',
      'packages/core/src/cli/**/*.ts',
      'packages/core/src/tui.ts',
      'packages/core/src/config/commanderConfig.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  // Logger implementation — needs console to write
  {
    files: ['packages/core/src/logging.ts'],
    rules: { 'no-console': 'off' },
  },
  // Test files — console.* for debugging is expected
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: { 'no-console': 'off' },
  },
  // Benchmark scripts — console.* for reporting
  {
    files: ['packages/core/benchmarks/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // Tools with inline code templates containing console.log references
  {
    files: ['packages/core/src/tools/scriptTool.ts', 'packages/core/src/tools/codeRefinerTool.ts'],
    rules: { 'no-console': 'off' },
  },
  // Security test/reporting scripts — console.* for adversarial test output and compliance reports
  {
    files: [
      'packages/core/src/security/runAdversarialLLMTest.ts',
      'packages/core/src/security/runComplianceAudit.ts',
      'packages/core/src/security/runRedTeamBattery.ts',
      'packages/core/src/security/hardAdversarialTest.ts',
      'packages/core/src/security/unknownAdversarialTest.ts',
    ],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'warn' },
  },
  // Repository scripts and integrations are operator/CLI/acceptance tooling:
  // `console` is the intended output mechanism, and they are not part of the
  // TypeScript build, so no-console carries no signal there.
  {
    files: ['scripts/**/*.ts', 'integrations/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // SDK and web app — separate packages with their own conventions
  {
    files: ['packages/sdk/**/*.ts', 'apps/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // Kernel package — lower-level durable kernel, includes CLI entrypoints and tests
  {
    files: ['packages/kernel/src/**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      'prefer-const': 'warn',
    },
  },
  // Legacy files with known `any` usage — NOTE: refactor to remove `any`
  {
    files: [
      'packages/core/src/benchmark/benchmarkRunner.ts',
      'packages/core/src/tools/webSearchTool.ts',
      'packages/core/src/runtime/distributedTracing.ts',
      'packages/core/src/ultimate/orchestrator.ts',
      'packages/core/src/security/runAdversarialLLMTest.ts',
      'packages/core/src/security/hardAdversarialTest.ts',
      'packages/core/src/security/unknownAdversarialTest.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
);
