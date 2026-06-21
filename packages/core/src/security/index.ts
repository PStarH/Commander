/**
 * Security module — centralized security infrastructure for Commander.
 *
 * Exports:
 * - SecurityAuditLogger: audit trail for all security events
 * - SecurityMonitor: continuous monitoring, anomaly detection, alerting
 * - GuardianAgent: semantic drift, anomaly, and safety monitoring for agents
 * - CapabilityTokenIssuer/Verifier: short-lived HMAC-signed authorization tokens
 * - AuditChainLedger: tamper-evident hash-chained audit log
 * - AgentLineage: immutable parent→child agent relationship tracking
 */
export {
  SecurityAuditLogger,
  getSecurityAuditLogger,
  resetSecurityAuditLogger,
} from './securityAuditLogger';

export type {
  SecurityEventType,
  SecuritySeverity,
  SecurityEvent,
  SecurityStats,
} from './securityAuditLogger';

export { SecurityMonitor, getSecurityMonitor, resetSecurityMonitor } from './securityMonitor';

export type { SecurityAlert, SecurityHealth } from './securityMonitor';

export { GuardianAgent, getGuardianAgent, resetGuardianAgent } from './guardianAgent';

export type {
  GuardianAction,
  GuardianInterventionType,
  GuardianEvidencePack,
  GuardianConfig,
} from './guardianAgent';

// CapabilityToken — short-lived HMAC-signed authorization tokens (Phase 2.1)
export {
  CapabilityTokenIssuer,
  CapabilityTokenVerifier,
  CapabilityTokenError,
  decode,
  sign,
  getCapabilityTokenIssuer,
  resetCapabilityTokenState,
  resetRevocationLedger,
  resolveMasterKey,
  CAPABILITY_TOKEN_KEY_ENV,
  DEFAULT_MAX_TTL_SECONDS,
  MAX_DELEGATION_DEPTH,
  CLOCK_SKEW_SECONDS,
} from './capabilityToken';

export type {
  CapabilityRejectReason,
  CapabilityScope,
  CapabilityPayload,
  IssueOptions,
  VerifyRequest,
  VerifyResult,
  VerifyResultOk,
  VerifyResultErr,
  ParsedCapabilityToken,
  VerifierOptions,
  IssuerOptions,
  CapabilityAuditLogger,
  RiskLevel,
} from './capabilityToken';

// AuditChainLedger — tamper-evident hash-chained audit log (Phase 1.1)
export {
  AuditChainLedger,
  getAuditChainLedger,
  resetAuditChainLedger,
  computeEntryHmac,
  deriveTenantKey,
  resolveMasterKey as resolveAuditChainMasterKey,
  collectPersistedEntries,
  GENESIS_HASH,
  CHAIN_PROTOCOL_VERSION,
  AUDIT_CHAIN_KEY_ENV,
} from './auditChainLedger';

export type {
  AuditChainEntry,
  ChainBreakReason,
  ChainBreak,
  VerifyResult as AuditChainVerifyResult,
  VerifyOptions as AuditChainVerifyOptions,
} from './auditChainLedger';

// AgentLineage — immutable parent→child agent relationship tracking (Phase 2.2)
export { AgentLineage, getAgentLineage, resetAgentLineage } from './agentLineage';

export type {
  LineageNode,
  LineageEventType,
  LineageSummary,
  LineageQuery,
} from './agentLineage';

// SupplyChainScanner — enterprise-grade skill/tool pre-load security scanning
export { SupplyChainScanner, getSupplyChainScanner, resetSupplyChainScanner } from './supplyChainScanner';

export type {
  SupplyChainScanSeverity,
  SupplyChainScanRequest,
  SupplyChainScanResult,
  SupplyChainAction,
  ToolDependency,
  FilePermission,
  NetworkPermission,
  SupplyChainProvenance,
} from './supplyChainScanner';

// RedTeamFramework — automated adversarial security testing
export {
  RedTeamFramework,
  getRedTeamFramework,
  resetRedTeamFramework,
  createContentScannerDefender,
  createComprehensiveDefender,
  generateSecurityReport,
  generateSecurityReportJson,
  ATTACK_SCENARIOS,
} from './redTeamFramework';

export type {
  AttackCategory,
  TestResult,
  RedTeamTestScenario,
  RedTeamTestResult,
  RedTeamRunReport,
  RedTeamProgressCallback,
} from './redTeamFramework';

// OutputSanitizer — data exfiltration prevention at the output boundary
export {
  OutputSanitizer,
  getOutputSanitizer,
  resetOutputSanitizer,
  sanitizeOutput,
  sanitizeIfNeeded,
} from './outputSanitizer';

export type {
  SensitivityCategory,
  RedactionStrategy,
  RedactionRule,
  RedactionRecord,
  SanitizeResult,
  OutputSanitizerConfig,
} from './outputSanitizer';

// CostGuard — enterprise economic attack detection & auto circuit-breaker
export { CostGuard, getCostGuard, resetCostGuard } from './costGuard';

export type {
  CostAttackType,
  CostGuardAction,
  CostTier,
  CostGuardConfig,
  CostGuardState,
  CostGuardDecision,
  CostGuardReport,
} from './costGuard';

// AgentSOC — P0-P4 event classification, playbook engine, escalation paths, health dashboard
export { AgentSoc, getAgentSoc, resetAgentSoc } from './agentSoc';

export type {
  IncidentPriority,
  IncidentStatus,
  EscalationLevel,
  PlaybookTrigger,
  IncidentClassification,
  SlaTarget,
  Incident,
  PlaybookAction,
  Playbook,
  PostmortemReport,
  SocHealth,
  AgentSocConfig,
} from './agentSoc';

// EuAiActCompliance — EU AI Act Article 12/13/14 automated compliance reporting
export {
  EuAiActComplianceReporter,
  getEuAiActComplianceReporter,
  resetEuAiActComplianceReporter,
} from './euAiActCompliance';

export type {
  EuAiActReport,
  Article12Report,
  Article13Report,
  Article14Report,
  ComplianceSummary,
  ComplianceReportOptions,
} from './euAiActCompliance';

// AgentStandbyManager — hot standby agent architecture with auto-failover
export { AgentStandbyManager, getAgentStandbyManager, resetAgentStandbyManager } from './agentStandbyManager';

export type {
  AgentTier,
  AgentInstance,
  SwitchTrigger,
  SwitchEvent,
  StandbyConfig,
  StandbyHealth,
  StandbyStatus,
} from './agentStandbyManager';

// RedTeamBaseline — regression detection for continuous red team CI/CD
export {
  RedTeamBaselineManager,
  getRedTeamBaseline,
  resetRedTeamBaseline,
} from './redTeamBaseline';

export type {
  RegressionSeverity,
  RegressionResult,
  ImprovementResult,
  BaselineComparison,
  BaselineConfig,
} from './redTeamBaseline';

// EdgeSecurityProfile — unified edge/offline mode: auto-detect, local-only, encrypted state, strict sandbox
export { EdgeSecurityProfile, getEdgeSecurityProfile, resetEdgeSecurityProfile } from './edgeSecurityProfile';

export type {
  EdgeMode,
  EdgeDetectionMethod,
  EdgeDetectionResult,
  EdgeResourceAssessment,
  EdgeSecurityConfig,
  EdgeSecurityStatus,
} from './edgeSecurityProfile';

// ComplianceAuditManager — ISO 42001/NIST AI RMF mapping, posture scoring, trend analysis, audit reports
export {
  ComplianceAuditManager,
  getComplianceAuditManager,
  resetComplianceAuditManager,
} from './complianceAuditReport';

export type {
  IsoClause,
  NistAirmfFunction,
  ScoringDimension,
  ComplianceControl,
  DimensionScore,
  SecurityPosture,
  PostureSnapshot,
  IsoComplianceSummary,
  NistRmfAlignmentSummary,
  ComplianceAuditReport,
  TrendAnalysis,
  AuditChecklistItem,
  ComplianceConfig,
} from './complianceAuditReport';

// ThreatIntelligenceFeed — dynamic threat feed with TLP, source registration, SupplyChainScanner integration
export {
  ThreatIntelligenceFeed,
  getThreatIntelligenceFeed,
  resetThreatIntelligenceFeed,
} from './threatIntelligenceFeed';

export type {
  TlpLevel,
  ThreatSignature,
  ThreatFeedSource,
  ThreatFeedHealth,
  ThreatFeedConfig,
} from './threatIntelligenceFeed';

// CrossAgentCorrelator — multi-agent attack chain detection
export {
  CrossAgentCorrelator,
  getCrossAgentCorrelator,
  resetCrossAgentCorrelator,
} from './crossAgentCorrelator';

export type {
  CorrelationRuleType,
  CrossAgentEvent,
  CorrelationMatch,
  CorrelationRule,
  CorrelatorConfig,
} from './crossAgentCorrelator';

// MLInjectionDetector — embedding-based semantic injection detection
export {
  MLInjectionDetector,
  getMLInjectionDetector,
  resetMLInjectionDetector,
} from './mlInjectionDetector';

export type {
  InjectionVector,
  DetectionResult,
  MLDetectorConfig,
} from './mlInjectionDetector';

// FuzzTestFramework — mutation-based tool input fuzzer with coverage-guided feedback
export {
  FuzzTestFramework,
  getFuzzTestFramework,
  resetFuzzTestFramework,
  createFileSystemToolHarness,
  createWebSearchToolHarness,
} from './fuzzTestFramework';

export type {
  MutationStrategy,
  FuzzSeverity,
  FuzzInput,
  FuzzResult,
  FuzzRunReport,
  FuzzerConfig,
  ToolHarness,
} from './fuzzTestFramework';

// PostQuantumCrypto — PQ-safe hash (SHAKE-256), key generation, signing, verification
export {
  PostQuantumCrypto,
  getPostQuantumCrypto,
  resetPostQuantumCrypto,
  pqHash,
  pqVerifyMac,
} from './postQuantumCrypto';

export type {
  PqAlgorithm,
  PqKeyPair,
  PqMac,
  PqHashResult,
  PqCryptoConfig,
} from './postQuantumCrypto';

// MultimodalContentScanner — voice/video/image threat scanning
export {
  MultimodalContentScanner,
  getMultimodalContentScanner,
  resetMultimodalContentScanner,
} from './multimodalContentScanner';

export type {
  ModalityType,
  MultimodalThreatType,
  MultimodalThreatSeverity,
  MultimodalThreat,
  MultimodalScanResult,
  MultimodalScannerConfig,
} from './multimodalContentScanner';

// SandboxVerifier — formal sandbox verification harness
export {
  SandboxVerifier,
  getSandboxVerifier,
  resetSandboxVerifier,
} from './sandboxVerifier';

export type {
  VerificationArea,
  VerificationResult,
  VerificationTest,
  VerificationEvidence,
  SandboxVerificationReport,
  VerifierConfig,
} from './sandboxVerifier';

// VoiceContentScanner — enhanced audio/voice threat scanning
export {
  VoiceContentScanner,
  getVoiceContentScanner,
  resetVoiceContentScanner,
} from './voiceContentScanner';

export type {
  VoiceThreatType,
  VoiceThreatSeverity,
  VoiceThreat,
  VoiceScanResult,
  VoiceScannerConfig,
} from './voiceContentScanner';

// FederatedIdentity — cross-org trust delegation with HMAC+OIDC JWT dual signing (Phase 3)
export {
  FederatedIdentity,
  getFederatedIdentity,
  resetFederatedIdentity,
  resolveFederationKey,
  resolveFederationOIDCKey,
  FEDERATION_KEY_ENV,
  FEDERATION_OIDC_KEY_ENV,
} from './federatedIdentity';

export type {
  ResourceScope,
  FederationTrust,
  IssueTrustParams,
  FederatedExchangeResult,
  FederatedExchangeRejection,
  FederatedExchangeOutcome,
  FederationRejectReason,
} from './federatedIdentity';

// TEESandbox — Trusted Execution Environment (AWS Nitro Enclaves / GCP Confidential VMs)
export { TEESandbox } from '../sandbox/teeEnclave';
export type { TEEBackend, TEEAttestation, TEESandboxResult } from '../sandbox/teeEnclave';

// MitreAtlasMapper — automatic MITRE ATLAS tactics/techniques mapping
export { MitreAtlasMapper, getMitreAtlasMapper, resetMitreAtlasMapper } from './mitreAtlasMapper';
export type {
  AtlasTactic,
  AtlasTechnique,
  AtlasSubTechnique,
  AtlasHeatmapCell,
  AtlasMapping,
  MitreAtlasReport,
} from './mitreAtlasMapper';

// AdaptiveHITL — risk-adaptive human-in-the-loop strategy engine
export { AdaptiveHITL, getAdaptiveHitl, resetAdaptiveHitl, maxStrategy } from './adaptiveHitl';
export type {
  HITLStrategy,
  ToolRiskSignal,
  AgentConfidenceSignal,
  CorrelationSignal as HITLCorrelationSignal,
  VerificationSignal as HITLVerificationSignal,
  MissionSignal,
  HITLSignalBundle,
  HITLFactor,
  HITLDecision,
  AgentBehaviorProfile,
  AdaptiveHITLConfig,
} from './adaptiveHitl';

// SecurityBenchmarkRunner — automated CI/CD security benchmark scoring (AgentDojo, Agent-SafetyBench, AgentHarm)
export {
  SecurityBenchmarkRunner,
  getSecurityBenchmarkRunner,
  resetSecurityBenchmarkRunner,
  ALL_BENCHMARK_CASES,
  getCasesForBenchmark,
} from './securityBenchmarkRunner';
export type {
  BenchmarkId,
  BenchmarkTestCase,
  BenchmarkTestResult,
  BenchmarkRunReport,
  BenchmarkTrend,
  BenchmarkRunnerConfig,
  DefenderFn,
} from './securityBenchmarkRunner';

// SupplyChainAttestor — SPDX 2.3 SBOM generation + Sigstore keyless attestation + verification
export {
  SupplyChainAttestor,
  getSupplyChainAttestor,
  resetSupplyChainAttestor,
  componentToPurl,
  hashFile,
  hashString,
} from './supplyChainAttestor';
export type {
  SpdxPackage,
  SpdxRelationship,
  SpdxDocument,
  InTotoStatement,
  AttestationBundle,
  AttestationResult,
  VerificationResult as AttestationVerificationResult,
  ComponentEntry,
  AttestorConfig,
} from './supplyChainAttestor';

// DifferentialPrivacyLayer — ε-DP Laplace/Gaussian noise for cross-agent memory sharing
export {
  DifferentialPrivacyLayer,
  getDifferentialPrivacyLayer,
  resetDifferentialPrivacyLayer,
  sampleLaplace,
  sampleGaussian,
  laplaceMechanism,
  gaussianMechanism,
  analyzeSensitivity,
  classifyEpsilon,
} from './differentialPrivacyLayer';
export type {
  DPPrivacyLevel,
  DPQueryType,
  DPSensitivity,
  DPDataBounds,
  PrivacyBudget,
  DifferentialPrivacyConfig,
  DPQueryResult,
  DPQueryRejection,
  DPQueryOutcome,
} from './differentialPrivacyLayer';

// Scanner→Attestor bridge — SupplyChainScanner now auto-calls SupplyChainAttestor
// on passed scans. The attestor singleton is accessible via getSupplyChainAttestor().
// Re-exported here for convenience.
