import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/runtime/agentRuntime.test.ts',
      'tests/httpServer.test.ts',
      'tests/runtime/criticalPath.test.ts',
      'tests/runtime/entropyGater.test.ts',
      'tests/runtime/e2e.test.ts',
      'tests/runtime/htmlReport.test.ts',
      'tests/runtime/metaTool.test.ts',
      'tests/runtime/speculativeExecutor.test.ts',
      'tests/runtime/toolCalling.test.ts',
      'tests/runtime/toolRetriever.test.ts',
      'tests/telos/providerPool.test.ts',
      'tests/telos/telosOrchestrator.test.ts',
      'tests/telos/tokenSentinel.test.ts',
    ],
    environment: 'node',
  },
});
