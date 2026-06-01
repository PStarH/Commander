// Lightweight ESLint config for no-console enforcement only.
// The project's primary lint gate is `tsc --noEmit` (TypeScript strict).
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['packages/core/src/**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
    files: [
      'packages/core/src/tools/scriptTool.ts',
      'packages/core/src/tools/codeRefinerTool.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  // SDK and web app — separate packages with their own conventions
  {
    files: ['packages/sdk/**/*.ts', 'apps/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // Legacy files with known `any` usage — TODO: refactor to remove `any`
  {
    files: [
      'packages/core/src/benchmark/benchmarkRunner.ts',
      'packages/core/src/tools/webSearchTool.ts',
      'packages/core/src/runtime/distributedTracing.ts',
      'packages/core/src/ultimate/orchestrator.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
);
