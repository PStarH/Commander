import { afterEach, beforeEach } from 'vitest';
import { resetModelRouter } from '../src/runtime/modelRouter';
import { resetMessageBus } from '../src/runtime/messageBus';
import { resetTraceRecorder } from '../src/runtime/executionTrace';
import { resetMetricsCollector } from '../src/runtime/metricsCollector';
import { resetEnterpriseSecurityGateway } from '../src/security/enterpriseSecurityGateway';
import { resetBillExplosionGuard } from '../src/security/billExplosionGuard';
import { resetUnifiedCostAuthority } from '../src/security/unifiedCostAuthority';
import { resetSecurityMonitor } from '../src/security/securityMonitor';
import { resetGuardianAgent } from '../src/security/guardianAgent';
import { resetDataLossPrevention } from '../src/security/dataLossPrevention';
import { resetSecurityOrchestrator } from '../src/runtime/securityOrchestrator';
import { resetCrossAgentCorrelator } from '../src/security/crossAgentCorrelator';
import { resetCapabilityTokenState } from '../src/security/capabilityToken';
import { resetLiteLLMPricing } from '../src/security/litellmPricing';
import { resetRuntimeGuardian } from '../src/runtime/runtimeGuardianBridge';
import { resetSecurityAuditLogger } from '../src/security/securityAuditLogger';
import { resetAuditChainLedger } from '../src/security/auditChainLedger';
import { resetZeroTrustValidator } from '../src/security/zeroTrustValidator';
import { resetTokenBudgetManager } from '../src/runtime/tokenGovernor';
import { resetCheckpointWriter } from '../src/runtime/checkpointWriter';
import { resetExecutionScheduler } from '../src/atr/scheduler';
import { resetLaneManager } from '../src/sandbox/lane';
import { resetWorkCoordinator } from '../src/ultimate/workCoordinator';
import { resetProviderPool } from '../src/telos/providerPool';
import { resetTokenSentinel } from '../src/telos/tokenSentinel';
import { resetSLOManager } from '../src/observability/sloManager';
import { resetAlertRuleEngine } from '../src/observability/alertRuleEngine';
import { resetIncidentManager } from '../src/observability/incidentManager';
import { resetCrossTenantFuzzTest } from '../src/security/crossTenantFuzz';
import { resetDataLeakageVerifier } from '../src/security/dataLeakageVerifier';
import { resetTokenMetrics } from '../src/edit/tokenMetrics';
import { resetLspManager } from '../src/lsp/lspManager';
import { resetTtsrEngine } from '../src/security/ttsrEngine';
import { resetReversibilityGate } from '../src/security/reversibilityGate';
import { resetGlobalFetchGovernor } from '../src/security/securityPrimitives';
import { resetInvariants } from '../src/security/securityInvariantVerifier';
import { resetSecurityResponseState } from '../src/security/securityResponseEngine';
import { resetWebhookDispatcher } from '../src/runtime/webhookDispatcher';
import { resetEventSourcingSubscriber } from '../src/runtime/eventSourcingSubscriber';
import { resetGlobalEventSourcingEngine } from '../src/runtime/eventSourcingEngine';
import { resetGlobalSemanticMemoryStore } from '../src/memory/semanticStore';
import { resetGlobalEpisodicStore } from '../src/memory/episodicStore';
import { resetConversationStore } from '../src/memory/conversationStore';
import { resetUserModelManager } from '../src/memory/userModel';
import { resetUnifiedMemory } from '../src/memory/unifiedMemory';
import { resetGlobalThreeLayerMemory, wireGlobalThreeLayerMemory } from '../src/threeLayerMemory';
import { resetSideEffectGate } from '../src/runtime/sideEffectGate';

// Runtime integration tests must not write to the checkout's durable WAL.
// A caller can still provide an explicit path for tests that exercise WAL
// persistence; an empty default keeps ordinary tests in-memory and isolated.
if (process.env.COMMANDER_EVENT_SOURCING_WAL === undefined) {
  process.env.COMMANDER_EVENT_SOURCING_WAL = '';
}
if (process.env.COMMANDER_OTEL_ENABLED === undefined) {
  process.env.COMMANDER_OTEL_ENABLED = 'false';
}

/**
 * LM-03: the always-admit SideEffectGate is deliberately NOT installed here.
 *
 * It used to be re-injected in the global `beforeEach` below, which made
 * "admitted" the default security state of every test in `packages/core`: no
 * test could observe a regression in the production fail-closed admission path,
 * because whatever `ToolExecutionService` did, the stub returned `allow: true`.
 *
 * The stub now lives in `tests/helpers/runtimeUnitFixture.ts` and is opt-in per
 * test file (`installAlwaysAdmitGate()` / `withAlwaysAdmitGate()`). The global
 * hook still *resets* the singleton, so the default is the real, fail-closed
 * `SideEffectGate`.
 *
 * Soft bypass via COMMANDER_EFFECT_BROKER_COMPAT remains intentionally NOT
 * enabled globally — that flag is production-gated and would hide fail-closed
 * bugs.
 */

// CI Quality Gates sets NODE_ENV=production. Capability token issuance
// refuses the default key in production unless COMMANDER_CAPABILITY_TOKEN_KEY
// is set (>=32 chars). Provide a deterministic test key for the suite only.
if (
  !process.env.COMMANDER_CAPABILITY_TOKEN_KEY ||
  process.env.COMMANDER_CAPABILITY_TOKEN_KEY.length < 32
) {
  process.env.COMMANDER_CAPABILITY_TOKEN_KEY = 'test-capability-token-key-32chars-min!!';
}
// Keep V2 gate soft for unit/integration tool loops; sideEffectGate unit tests
// construct real gates themselves after resetSideEffectGate().
if (process.env.NODE_ENV === 'production' && process.env.COMMANDER_TEST_FORCE_PROD !== '1') {
  // Vitest under CI still needs tool loops; do not flip NODE_ENV (sideEffectGate
  // production cases set it per-test). Capability key above is enough for issue().
}

/**
 * Global test isolation reset.
 *
 * Security singletons (especially the cost/bill guards) accumulate per-tenant
 * state across tests and can trigger false-positive "model_degradation" blocks
 * once a cheaper model has been recorded. Reset them before every test so that
 * no test is polluted by the security state of a previous test.
 */
beforeEach(async () => {
  resetEventSourcingSubscriber();
  await resetGlobalEventSourcingEngine();

  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetMetricsCollector();
  resetTokenBudgetManager();
  resetCheckpointWriter();
  resetExecutionScheduler();
  resetLaneManager();
  resetWorkCoordinator();
  resetProviderPool();
  resetTokenSentinel();

  resetEnterpriseSecurityGateway();
  resetBillExplosionGuard();
  resetUnifiedCostAuthority();
  resetSecurityMonitor();
  resetGuardianAgent();
  resetDataLossPrevention();
  resetSecurityOrchestrator();
  resetCrossAgentCorrelator();
  resetCapabilityTokenState();
  resetLiteLLMPricing();
  resetRuntimeGuardian();
  resetSecurityAuditLogger();
  resetAuditChainLedger();
  resetZeroTrustValidator();
  resetReversibilityGate();
  resetGlobalFetchGovernor();
  resetInvariants();
  resetSecurityResponseState();
  resetSLOManager();
  resetAlertRuleEngine();
  resetIncidentManager();
  resetCrossTenantFuzzTest();
  resetDataLeakageVerifier();
  resetTokenMetrics();
  resetLspManager();
  resetTtsrEngine();
  resetWebhookDispatcher();
  resetGlobalSemanticMemoryStore();
  resetGlobalEpisodicStore();
  resetConversationStore();
  resetUserModelManager();
  resetGlobalThreeLayerMemory();
  resetUnifiedMemory();
  wireGlobalThreeLayerMemory(null);

  // LM-03: reset to the REAL, fail-closed SideEffectGate. Tests that need the
  // always-admit unit fixture must install it explicitly — see
  // `tests/helpers/runtimeUnitFixture.ts`.
  resetSideEffectGate();
});

afterEach(async () => {
  resetEventSourcingSubscriber();
  await resetGlobalEventSourcingEngine();
});
