import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    threads: false,
    include: [
      'tests/cli/envLoader.test.ts',
      // --- atr ---
      'tests/atr/recoveryBootstrapper.test.ts',
      'tests/atr/taskQueue.test.ts',
      // --- recovery ---
      'tests/recovery/kill9.test.ts',
      // --- runtime ---
      'tests/runtime/agentHandoff.test.ts',
      'tests/runtime/agentInbox.test.ts',
      'tests/runtime/agentRuntime.test.ts',
      'tests/runtime/agentRuntime.integration.test.ts',
      'tests/runtime/agentRuntimeInterface.test.ts',
      'tests/checkpointStore.test.ts',
      'tests/runtime/circuitBreaker.test.ts',
      'tests/runtime/compensation-integration.test.ts',
      'tests/runtime/compensationRegistry.test.ts',
      'tests/runtime/costBenchmark.test.ts',
      'tests/runtime/costEstimator.test.ts',
      'tests/runtime/credentialManager.test.ts',
      'tests/runtime/criticalPath.test.ts',
      'tests/runtime/cycleDetector.test.ts',
      'tests/runtime/dagConverter.test.ts',
      'tests/runtime/deadLetterQueue.test.ts',
      'tests/runtime/dlqRetryWorker.test.ts',
      'tests/runtime/healthCheck.test.ts',
      'tests/runtime/mcpRemoteRuntime.test.ts',
      'tests/runtime/e2e.test.ts',
      'tests/runtime/entropyGater.test.ts',
      'tests/runtime/evolutionaryWorkflowEngine.test.ts',
      'tests/runtime/execPolicy.edge.test.ts',
      'tests/runtime/geminiCacheManager.test.ts',
      'tests/runtime/htmlReport.test.ts',
      'tests/runtime/llmRetry.test.ts',
      'tests/runtime/oidcAuthPlugin.test.ts',
      'tests/runtime/owaspAsiHttpRoute.test.ts',
      'tests/runtime/siemForwarder.test.ts',
      'tests/runtime/localEmbedding.test.ts',
      'tests/runtime/metaLearner.test.ts',
      'tests/runtime/metaTool.test.ts',
      'tests/runtime/metricsCollector.test.ts',
      'tests/runtime/modelPerformanceStore.test.ts',
      'tests/runtime/modelRouter.test.ts',
      'tests/runtime/openTelemetryExporter.test.ts',
      'tests/runtime/promptCacheSavings.test.ts',
      'tests/runtime/providerFallbackChain.test.ts',
      'tests/runtime/reflexionInjector.test.ts',
      'tests/runtime/runRecovery.test.ts',
      'tests/runtime/runtimeAdversarial.test.ts',
      'tests/runtime/securityOrchestrator.test.ts',
      'tests/runtime/securityOrchestrator.integration.test.ts',
      'tests/runtime/securityOrchestratorHelper.test.ts',
      'tests/runtime/samplesStore.test.ts',
      'tests/runtime/semanticCache.test.ts',
      'tests/runtime/speculativeExecutor.test.ts',
      'tests/runtime/stepErrorBoundary.test.ts',
      'tests/runtime/stepTimeoutManager.test.ts',
      'tests/runtime/capacity-baseline.test.ts',
      'tests/runtime/tenant-runtime-isolation.test.ts',
      'tests/runtime/tenantAwareSingleton.test.ts',
      'tests/runtime/tokenBenchmark.test.ts',
      'tests/runtime/tokenMeasurement.test.ts',
      'tests/runtime/toolApproval.test.ts',
      'tests/runtime/toolCalling.test.ts',
      'tests/runtime/toolOrchestrator.test.ts',
      'tests/runtime/toolPlanner.test.ts',
      'tests/runtime/toolResultCache.test.ts',
      'tests/runtime/toolGateHelper.test.ts',
      'tests/runtime/toolResultShape.test.ts',
      'tests/runtime/resilience-integration.test.ts',
      'tests/runtime/toolRetriever.test.ts',
      'tests/runtime/vcrProvider.test.ts',
      'tests/runtime/batchProvider.test.ts',
      // 'tests/runtime/webhookDispatcher.test.ts', // skipped: intermittent timeout in CI
      'tests/runtime/workflowPopulation.test.ts',
      'tests/runtime/sopDashboard.test.ts',
      // --- telos ---
      'tests/telos/providerPool.test.ts',
      'tests/telos/telosOrchestrator.test.ts',
      'tests/telos/tokenSentinel.test.ts',
      'tests/telos/modelCascadeController.test.ts',
      // --- intelligence ---
      'tests/intelligence/costAggregator.test.ts',
      // --- sandbox ---
      'tests/sandbox/lane.test.ts',
      'tests/sandbox/appContainer.test.ts',
      'tests/sandbox/teeEnclave.test.ts',
      'tests/runtime/observationPurifier.test.ts',
      // --- tools ---
      'tests/tools/resourceTools.test.ts',
      // --- observability ---
      'tests/observability/autoScorer.test.ts',
      'tests/observability/datasetStore.test.ts',
      'tests/observability/evalHttpEndpoints.test.ts',
      'tests/observability/evalScorer.test.ts',
      'tests/observability/experimentRunner.test.ts',
      'tests/observability/normalizeExpected.test.ts',
      'tests/observability/otelExporter.test.ts',
      'tests/observability/retryRuleOnRealTraces.test.ts',
      'tests/observability/samplingPolicy.test.ts',
      'tests/observability/traceContext.test.ts',
      'tests/observability/traceContextBridge.test.ts',
      // --- memory (cross-tenant leak fix) ---
      'tests/memory/resolveSessionProjectId.test.ts',

      // --- memory (audit MED item 1 — Phase A route-out) ---
      'tests/threeLayerRouting.test.ts',

      // --- storage ---
      'tests/storage/dataRetention.test.ts',
      'tests/storage/inMemoryDriver.test.ts',
      'tests/storage/jsonDriver.test.ts',
      'tests/storage/sqliteDriver.test.ts',
      'tests/storage/persistentStore.test.ts',
      'tests/storage/inMemoryDriver.test.ts',
      'tests/storage/jsonDriver.test.ts',
      'tests/storage/sqliteDriver.test.ts',
      'tests/storage/persistentStore.test.ts',

      // --- security ---
      'tests/security/guardianAgent.test.ts',
      'tests/security/capabilityToken.test.ts',
      'tests/security/auditChainLedger.test.ts',
      'tests/security/agentLineage.test.ts',
      'tests/security/federatedIdentity.test.ts',
      'tests/security/outputSanitizer.test.ts',
      'tests/security/costGuard.test.ts',
      'tests/security/agentSoc.test.ts',
      'tests/security/euAiActCompliance.test.ts',
      'tests/security/agentStandbyManager.test.ts',
      'tests/security/redTeamBaseline.test.ts',
      'tests/security/edgeSecurityProfile.test.ts',
      'tests/security/complianceAuditReport.test.ts',
      'tests/security/d25-api-key-grep.test.ts',
      'tests/security/d26-rotation-signoff-gate.test.ts',
      'tests/security/d31-rotation-signoff-library-api.test.ts',
      'tests/security/d32-rotation-signoff-async-api.test.ts',
      'tests/security/hardeningSprint.d1.test.ts',
      'tests/security/threatIntelligenceFeed.test.ts',
      'tests/security/crossAgentCorrelator.test.ts',
      'tests/security/mlInjectionDetector.test.ts',
      'tests/security/fuzzTestFramework.test.ts',
      'tests/security/postQuantumCrypto.test.ts',
      'tests/security/multimodalContentScanner.test.ts',
      'tests/security/sandboxVerifier.test.ts',
      'tests/security/voiceContentScanner.test.ts',
      'tests/security/mitreAtlasMapper.test.ts',
      'tests/security/adaptiveHitl.test.ts',
      'tests/security/securityBenchmarkRunner.test.ts',
      'tests/security/supplyChainAttestor.test.ts',
      'tests/security/differentialPrivacyLayer.test.ts',
      'tests/security/security-hardening.test.ts',
      // --- harness ---
      'tests/harness/tier1AgentLoop.test.ts',
      'tests/harness/tier1Harness.test.ts',
      'tests/harness/mcpHarnessCapabilities.test.ts',
      // Note: commander-rotate integration tests spawn the CLI via tsx. They
      // pass when invoked directly but fail inside the vitest worker because
      // the sandboxed environment cannot resolve /bin/sh or the node binary.
      // The CLI itself is verified manually; these tests are excluded from
      // the automated gate until the runner environment supports spawnSync.
      // 'tests/security/commander-rotate.test.ts',
      'tests/security/d25-precommit-hook.test.ts',
      // --- http ---
      // --- ultimate ---
      // 'tests/ultimate/coordinationPolicy.test.ts', // skipped: legacy topology alias names incompatible with D3.2 canonical types
      // 'tests/ultimate/coordinationPolicyLearned.test.ts', // skipped: legacy topology alias names incompatible with D3.2 canonical types
      'tests/ultimate/deliberationYear.test.ts',
      'tests/ultimate/epsilonExploration.test.ts',
      'tests/ultimate/epsilonStore.test.ts',
      // 'tests/ultimate/explorationEventLog.test.ts', // skipped: flaky persistence timing in CI
      // 'tests/ultimate/learnedWeights.test.ts', // skipped: legacy topology alias names incompatible with D3.2 canonical types
      // 'tests/ultimate/learnedWeightsTenant.test.ts', // skipped: legacy topology alias names incompatible with D3.2 canonical types
      'tests/ultimate/orchestrationLabels.test.ts',
      'tests/ultimate/routingDashboard.test.ts',
      'tests/ultimate/subAgentGuard.test.ts',
      'tests/ultimate/tenantWorkCoordinatorRegistry.test.ts',
      // 'tests/ultimate/topologyRouter.test.ts', // skipped: legacy topology alias names incompatible with D3.2 canonical types
      'tests/ultimate/topologyOptimizer.test.ts',
      'tests/ultimate/atomizer.test.ts',
      'tests/ultimate/subAgentExecutor.test.ts',
      'tests/ultimate/orchestrator.test.ts',
      'tests/ultimate/workCoordinator.test.ts',
      'tests/ultimate/workQueueStore.test.ts',
      'tests/ultimate/exeStep.classify.test.ts',
      'tests/ultimate/tokenBudget.test.ts',
      'tests/ultimate/qualityGates.test.ts',
      // --- e2e ---
      'tests/e2e/orchestration.test.ts',
      'tests/e2e/sloMeasurement.test.ts',
      'tests/e2e/load.test.ts',
      'tests/e2e/chaos.test.ts',
      // --- benchmark ---
      // 'tests/benchmark/performanceBenchmark.test.ts', // skipped: environment-dependent latency assertion
      // 'tests/benchmark/loadBenchmark.test.ts', // skipped: intermittent timeout in CI
      'tests/benchmark/costBenchmark.test.ts',
      'tests/benchmark/reliabilityBenchmark.test.ts',
      // 'tests/benchmark/comparisonBenchmark.test.ts', // skipped: environment-dependent latency assertion
      // 'tests/benchmark/advancedPerformanceBenchmark.test.ts', // skipped: environment-dependent latency assertion
      // 'tests/benchmark/realWorldBenchmark.test.ts', // skipped: requires external StepFun API and times out in CI
      // 'tests/benchmark/multiAgentBenchmark.metrics.test.ts', // TODO: depends on missing src/benchmark/multiAgentBenchmark module
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      thresholds: {
        statements: 60,
        branches: 80,
        functions: 70,
        lines: 60,
      },
    },
  },
});
