/**
 * Pillar III: V8-Level Multi-Tenancy & Zero-Trust Sandbox — Abstract Interface Contracts
 *
 * Per Commander Ultimate Architecture Blueprint Section 4.3.
 * All contracts are abstract interfaces with zero external dependencies.
 */

// ============================================================================
// Sandbox
// ============================================================================

/**
 * Sandbox execution configuration.
 */
export interface ISandboxConfig {
  /** Maximum execution time in ms */
  timeoutMs: number;
  /** Maximum heap size in MB */
  maxHeapMb: number;
  /** Allowed system calls (seccomp whitelist) */
  allowedSyscalls?: string[];
  /** Enable Proxy membrane for ocap enforcement */
  enableMembrane: boolean;
  /** Isolation tier */
  tier: SandboxTier;
}

/**
 * Sandbox isolation tiers — defense in depth.
 */
export type SandboxTier = 'v8-isolate' | 'seccomp' | 'wasm' | 'tee';

/**
 * Sandbox execution result.
 */
export interface ISandboxResult {
  /** Execution output */
  output: unknown;
  /** Whether execution succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Capabilities actually used during execution (audit trail) */
  capabilitiesUsed: string[];
  /** Execution time in ms */
  executionTimeMs: number;
  /** Peak memory usage in MB */
  peakMemoryMb: number;
}

/**
 * Sandbox interface for isolated code execution.
 *
 * Per constraint NFR-SEC-04, sandbox escape SHALL be impossible
 * by construction (not just difficult).
 */
export interface ISandbox {
  /** Execute code within the sandbox with the given capabilities */
  execute(
    code: string,
    capabilities: string[],
    config: Partial<ISandboxConfig>,
  ): Promise<ISandboxResult>;
  /** Create a V8 Isolate for lightweight isolation */
  createIsolate(config?: Partial<ISandboxConfig>): Promise<string>;
  /** Terminate an isolate immediately (preemption) */
  terminate(isolateId: string): void;
  /** Get resource metrics for an isolate */
  getMetrics(isolateId: string): { heapUsedMb: number; executionTimeMs: number };
}

// ============================================================================
// Capability Token
// ============================================================================

/**
 * Capability token for zero-trust authorization.
 *
 * Per constraint NFR-SEC-02, tokens SHALL be unforgeable with
 * cryptographic proofs. Per constraint NFR-SEC-06, supports
 * principle of least privilege via attenuation.
 */
export interface ICapabilityToken {
  /** Serialize to binary format (Biscuit wire format) */
  serialize(): Uint8Array;
  /** Verify cryptographic signature (Ed25519) */
  verify(): boolean;
  /** Append a restriction block (attenuation — never expands rights) */
  attenuate(restrictions: Record<string, unknown>): ICapabilityToken;
  /** Create a child token for delegation */
  delegate(): ICapabilityToken;
  /** Check if the token has expired */
  readonly expiry: number;
  /** Token ID for revocation tracking */
  readonly tokenId: string;
}

// ============================================================================
// Resource Attenuator (Proxy Membrane)
// ============================================================================

/**
 * Resource attenuator using Proxy membrane pattern.
 *
 * Implements object-capability (ocap) model: every access is mediated
 * through a Proxy that enforces capability restrictions.
 *
 * Per constraint PIII-FR-02, leverages Proxy object isolation.
 */
export interface IResourceAttenuator {
  /** Wrap an object with a mediated Proxy */
  wrap<T extends object>(target: T, policy: AttenuationPolicy): T;
  /** Create a full realm membrane (isolate object graphs) */
  createMembrane(inner: object, outer: object): { innerProxy: object; outerProxy: object };
  /** Revoke all proxies created for a given context */
  revoke(contextId: string): void;
  /** Get all active proxies for audit */
  getProxies(): Array<{ contextId: string; target: string; policy: AttenuationPolicy }>;
  /** Set a resource-type access policy */
  setPolicy(resourceType: string, policy: AttenuationPolicy): void;
}

export interface AttenuationPolicy {
  /** Allowed property names (whitelist) */
  allowedProperties?: string[];
  /** Denied property names (blacklist) */
  deniedProperties?: string[];
  /** Maximum call depth */
  maxCallDepth?: number;
  /** Time-bounded access (expiry timestamp) */
  expiresAt?: number;
  /** Custom guard function name */
  guard?: string;
}

// ============================================================================
// TEE Enclave
// ============================================================================

/**
 * TEE (Trusted Execution Environment) enclave interface.
 *
 * Per constraint PIII-FR-13, heavy sandbox tier uses TEE hardware
 * isolation (Intel TDX / AMD SEV-SNP).
 */
export interface ITeeEnclave {
  /** Initialize the enclave with remote attestation */
  initialize(): Promise<void>;
  /** Execute code inside the enclave */
  executeInEnclave(code: string, input: unknown): Promise<unknown>;
  /** Verify the enclave's remote attestation report */
  verifyAttestation(): Promise<boolean>;
  /** Seal data with TEE-identity encryption */
  seal(data: Uint8Array): Promise<Uint8Array>;
  /** Unseal data (only succeeds in the same TEE identity) */
  unseal(sealed: Uint8Array): Promise<Uint8Array>;
}

// ============================================================================
// Sandbox Scheduler
// ============================================================================

/**
 * Sandbox tier selection based on risk assessment.
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Hybrid sandbox scheduler with weighted fair queuing.
 *
 * Per constraint PIII-FR-10, automatically selects isolation tier
 * based on sensitivity classification. Per constraint PIII-FR-15,
 * tier selection is automatic based on risk profile.
 */
export interface ISandboxScheduler {
  /** Schedule execution in the appropriate sandbox tier */
  schedule(code: string, riskProfile: RiskProfile): Promise<ISandboxResult>;
  /** Set resource quota per principal */
  setQuota(principalId: string, limits: QuotaLimits): void;
  /** Preempt a running sandbox */
  preempt(isolateId: string): void;
  /** Get current utilization metrics */
  readonly utilization: SchedulerUtilization;
}

export interface RiskProfile {
  /** Risk level */
  level: RiskLevel;
  /** Code source (trusted/untrusted) */
  source: 'TRUSTED' | 'UNTRUSTED' | 'UNKNOWN';
  /** Whether the code handles sensitive data */
  handlesSensitiveData: boolean;
  /** Whether the code makes network calls */
  requiresNetwork: boolean;
}

export interface QuotaLimits {
  /** Maximum concurrent sandboxes */
  maxConcurrent: number;
  /** Maximum total CPU time per time window (ms) */
  maxCpuTimeMs: number;
  /** Maximum total memory (MB) */
  maxMemoryMb: number;
}

export interface SchedulerUtilization {
  /** Active sandboxes per tier */
  activeByTier: Record<SandboxTier, number>;
  /** Total sandboxes created */
  totalCreated: number;
  /** Average wait time in queue (ms) */
  averageWaitMs: number;
}
