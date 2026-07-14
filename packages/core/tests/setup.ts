import { beforeEach } from 'vitest';
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
import { resetGlobalSemanticMemoryStore } from '../src/memory/semanticStore';
import { resetGlobalEpisodicStore } from '../src/memory/episodicStore';
import { resetConversationStore } from '../src/memory/conversationStore';
import { resetUserModelManager } from '../src/memory/userModel';
import { resetUnifiedMemory } from '../src/memory/unifiedMemory';
import { resetGlobalThreeLayerMemory, wireGlobalThreeLayerMemory } from '../src/threeLayerMemory';
import {
  resetSideEffectGate,
  setSideEffectGate,
  type SideEffectGate,
} from '../src/runtime/sideEffectGate';

/**
 * Always-admit SideEffectGate for unit/integration tests that exercise
 * AgentRuntime tool loops without a full ATR run handle.
 *
 * Production still requires admit() via getSideEffectGate(); tests inject a
 * soft gate so tool handlers run. Individual SideEffectGate unit tests call
 * resetSideEffectGate() and construct real gates themselves.
 *
 * Soft bypass via COMMANDER_EFFECT_BROKER_COMPAT is intentionally NOT enabled
 * globally here — that flag is production-gated and would hide fail-closed bugs.
 */
function createAlwaysAdmitGate(): SideEffectGate {
  return {
    admit: async (req: { stepId: string; toolName?: string }) => ({
      replayed: false,
      actionId: `test-admit:${req.stepId}`,
      decision: {
        decisionId: 'test_always_admit',
        allow: true,
        effect: 'allow',
      },
      decisionId: 'test_always_admit',
    }),
  } as unknown as SideEffectGate;
}

// CI Quality Gates sets NODE_ENV=production. Capability token issuance
// refuses the default key in production unless COMMANDER_CAPABILITY_TOKEN_KEY
// is set (>=32 chars). Provide a deterministic test key for the suite only.
if (!process.env.COMMANDER_CAPABILITY_TOKEN_KEY || process.env.COMMANDER_CAPABILITY_TOKEN_KEY.length < 32) {
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
beforeEach(() => {
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
  resetEventSourcingSubscriber();
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

  // V2 gate: reinstall always-admit stub after reset so AgentRuntime tool
  // integration tests can execute tool bodies without a full ATR handle.
  resetSideEffectGate();
  setSideEffectGate(createAlwaysAdmitGate());
});
