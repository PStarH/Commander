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
import { resetWebhookDispatcher } from '../src/runtime/webhookDispatcher';
import { resetGlobalSemanticMemoryStore } from '../src/memory/semanticStore';
import { resetGlobalEpisodicStore } from '../src/memory/episodicStore';

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
});
