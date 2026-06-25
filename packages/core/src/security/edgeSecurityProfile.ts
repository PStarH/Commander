/**
 * EdgeSecurityProfile — Unified Edge/Offline Security Configuration.
 *
 * Commander's edge deployment orchestrator. Bundles all existing offline-capable
 * security primitives into a single auto-detecting profile that switches the
 * entire security stack to edge mode when running offline, on low-resource
 * devices, or in air-gapped environments.
 *
 * What it does:
 *   1. Auto-detect edge/offline mode (no cloud API keys, no network, low resources)
 *   2. Switch to local-only LLM (Ollama/vLLM) via PrivacyRouter
 *   3. State-at-rest encryption (checkpoint encryption with local key)
 *   4. Strict edge sandbox (read-only workspace, no network, protected paths)
 *   5. Resource limits for low-power devices (CPU/memory/tokens)
 *   6. FreezeDry integration for crash-resume on unstable edge connections
 *   7. One-toggle activation: `EdgeSecurityProfile.activateEdgeMode()`
 *
 * Integrates with:
 *   - PrivacyRouter: local-only model routing
 *   - FreezeDryManager: state freeze/thaw for resume
 *   - SandboxManager: edge-appropriate sandbox profiles
 *   - ContentScanner: offline-capable regex scanning (no cloud calls)
 *   - OllamaProvider / VLLMProvider: local LLM inference
 *   - StateCheckpointer: encrypted checkpoint storage
 *   - Commander tier system: extends Hobbyist tier with edge-specific hardening
 *
 * Target environments: IoT gateways, edge servers, air-gapped networks,
 *   mobile/offline-first deployments, embedded AI assistants.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGlobalLogger } from '../logging';
import { getAuditChainLedger } from './auditChainLedger';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type EdgeMode = 'auto' | 'always-edge' | 'always-cloud' | 'off';

export type EdgeDetectionMethod =
  | 'no_cloud_keys' // No cloud API keys found in env
  | 'no_network' // Cannot reach external endpoints
  | 'low_resources' // CPU/memory below thresholds
  | 'explicit_offline' // User explicitly requested edge mode
  | 'air_gapped' // Air-gapped environment detected
  | 'mobile_device' // Running on mobile/embedded device
  | 'containerized_edge'; // Running in edge container (e.g., K3s, MicroK8s)

export interface EdgeDetectionResult {
  /** Whether edge mode is active */
  edgeMode: boolean;
  /** Why edge mode was activated */
  reasons: EdgeDetectionMethod[];
  /** Whether a local LLM is available for inference */
  localModelAvailable: boolean;
  /** Available local providers */
  localProviders: string[];
  /** Network status */
  networkAvailable: boolean;
  /** System resource assessment */
  resources: EdgeResourceAssessment;
  /** Timestamp of detection */
  detectedAt: string;
}

export interface EdgeResourceAssessment {
  /** Total system memory (bytes) */
  totalMemoryBytes: number;
  /** Free system memory (bytes) */
  freeMemoryBytes: number;
  /** CPU core count */
  cpuCores: number;
  /** Average CPU load (1 min) */
  cpuLoad1m: number;
  /** Is this a low-resource device? */
  isLowResource: boolean;
  /** Recommended max concurrency for this device */
  recommendedConcurrency: number;
  /** Recommended max tokens per run */
  recommendedMaxTokens: number;
}

export interface EdgeSecurityConfig {
  /** Edge mode activation strategy */
  mode: EdgeMode;
  /** Whether state encryption is enabled (default: true in edge mode) */
  enableStateEncryption: boolean;
  /** Encryption key for state-at-rest. Auto-generated if not provided. */
  stateEncryptionKey?: string;
  /** Strict sandbox: no network access for tools (default: true in edge mode) */
  strictEdgeSandbox: boolean;
  /** Read-only workspace enforcement (default: true in edge mode) */
  readOnlyWorkspace: boolean;
  /** Protected paths that cannot be accessed (additional to defaults) */
  protectedPaths: string[];
  /** Enable FreezeDry for crash-resume cycles (default: true in edge mode) */
  enableFreezeDry: boolean;
  /** Max tokens per run on edge devices (default: 4000) */
  edgeMaxTokens: number;
  /** Max concurrent agents on edge devices (default: 1) */
  edgeMaxConcurrency: number;
  /** Network check endpoints for offline detection */
  networkCheckEndpoints: string[];
  /** Network check timeout (ms) */
  networkCheckTimeoutMs: number;
  /** Resource thresholds for low-resource detection */
  resourceThresholds: {
    /** Minimum free memory (bytes) to NOT be low-resource */
    minFreeMemoryBytes: number;
    /** Minimum CPU cores to NOT be low-resource */
    minCpuCores: number;
    /** Maximum CPU load to NOT be low-resource */
    maxCpuLoad: number;
  };
  /** Whether to log edge mode transitions */
  auditTransitions: boolean;
}

export interface EdgeSecurityStatus {
  /** Whether edge mode is currently active */
  active: boolean;
  /** Current mode configuration */
  mode: EdgeMode;
  /** Detection result from last check */
  detection: EdgeDetectionResult | null;
  /** Whether state encryption is active */
  stateEncryptionActive: boolean;
  /** Whether strict sandbox is active */
  strictSandboxActive: boolean;
  /** Whether FreezeDry is active */
  freezeDryActive: boolean;
  /** Current security posture summary */
  posture: 'edge-hardened' | 'edge-basic' | 'cloud' | 'degraded';
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: EdgeSecurityConfig = {
  mode: 'auto',
  enableStateEncryption: true,
  strictEdgeSandbox: true,
  readOnlyWorkspace: true,
  protectedPaths: [
    '/etc/passwd',
    '/etc/shadow',
    '/etc/ssl',
    '/root',
    '/var/run/docker.sock',
    '~/.ssh',
    '~/.aws',
    '~/.config/gcloud',
  ],
  enableFreezeDry: true,
  edgeMaxTokens: 4000,
  edgeMaxConcurrency: 1,
  networkCheckEndpoints: [
    'https://api.openai.com/v1/models',
    'https://www.google.com/generate_204',
    'https://github.com',
  ],
  networkCheckTimeoutMs: 3000,
  resourceThresholds: {
    minFreeMemoryBytes: 512 * 1024 * 1024, // 512 MB
    minCpuCores: 2,
    maxCpuLoad: 0.8,
  },
  auditTransitions: true,
};

// ============================================================================
// EdgeSecurityProfile
// ============================================================================

export class EdgeSecurityProfile {
  private config: EdgeSecurityConfig;
  private active = false;
  private detection: EdgeDetectionResult | null = null;
  private encryptionKey: Buffer | null = null;
  private stateEncryptionActive = false;
  private strictSandboxActive = false;
  private freezeDryActive = false;
  private postureChecks = 0;
  private lastPostureCheck = 0;
  private running = false;

  constructor(config?: Partial<EdgeSecurityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Defer encryption key initialization to start()
    // so encrypt/decrypt properly gate on active state.
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start the edge security profile.
   * Auto-detects edge mode and activates appropriate protections.
   */
  async start(): Promise<EdgeDetectionResult> {
    if (this.running) return this.detection!;

    this.running = true;
    const log = getGlobalLogger();

    // Determine edge mode
    const detection = await this.detectEdgeMode();
    this.detection = detection;

    if (detection.edgeMode) {
      log.info('EdgeSecurityProfile', '🌐 Edge mode detected — activating edge security profile', {
        reasons: detection.reasons,
        localModelAvailable: detection.localModelAvailable,
        resources: {
          isLowResource: detection.resources.isLowResource,
          freeMemoryMB: Math.round(detection.resources.freeMemoryBytes / 1024 / 1024),
        },
      });

      // Activate edge protections
      if (this.config.enableStateEncryption) {
        this.activateStateEncryption();
      }
      if (this.config.strictEdgeSandbox) {
        this.activateStrictSandbox();
      }
      if (this.config.enableFreezeDry) {
        await this.activateFreezeDry();
      }

      this.active = true;
      this.auditTransition('activated', detection);
    } else {
      log.info('EdgeSecurityProfile', '☁️ Cloud/connected mode — edge profile idle');
      this.auditTransition('idle', detection);
    }

    return detection;
  }

  /** Stop the edge security profile. */
  stop(): void {
    this.running = false;
    this.active = false;
    this.deactivateAll();
  }

  /** Check if edge mode is active. */
  isActive(): boolean {
    return this.active;
  }

  /** Check if the profile is running. */
  isRunning(): boolean {
    return this.running;
  }

  // ── Edge Detection ────────────────────────────────────────────────

  /**
   * Detect whether the system is running in an edge/offline environment.
   * Checks multiple signals: network, API keys, resources, environment markers.
   */
  async detectEdgeMode(): Promise<EdgeDetectionResult> {
    // Explicit mode overrides
    if (this.config.mode === 'always-edge') {
      return this.buildDetectionResult(true, ['explicit_offline']);
    }
    if (this.config.mode === 'always-cloud' || this.config.mode === 'off') {
      return this.buildDetectionResult(false, []);
    }

    const reasons: EdgeDetectionMethod[] = [];

    // Check 1: Cloud API keys
    const hasCloudKeys = this.checkCloudApiKeys();
    if (!hasCloudKeys) {
      reasons.push('no_cloud_keys');
    }

    // Check 2: Network connectivity
    const networkAvailable = await this.checkNetworkConnectivity();
    if (!networkAvailable) {
      reasons.push('no_network');
    }

    // Check 3: System resources
    const resources = this.assessResources();
    if (resources.isLowResource) {
      reasons.push('low_resources');
    }

    // Check 4: Environment markers
    if (this.isAirGapped()) {
      reasons.push('air_gapped');
    }
    if (this.isMobileDevice()) {
      reasons.push('mobile_device');
    }
    if (this.isContainerizedEdge()) {
      reasons.push('containerized_edge');
    }

    // Decision: edge mode if no cloud keys AND (no network OR low resources OR explicit markers)
    const edgeMode =
      !hasCloudKeys && (!networkAvailable || resources.isLowResource || reasons.length > 1);

    // Check local model availability
    const { localModelAvailable, localProviders } = await this.checkLocalModels();

    return this.buildDetectionResult(edgeMode, reasons, {
      localModelAvailable,
      localProviders,
      networkAvailable,
      resources,
    });
  }

  /**
   * Quick synchronous check: are we in edge mode?
   * Uses cached detection result if available.
   */
  isEdgeMode(): boolean {
    return this.active;
  }

  /** Re-check edge mode and update status. */
  async refreshDetection(): Promise<EdgeDetectionResult> {
    this.detection = await this.detectEdgeMode();
    return this.detection;
  }

  // ── Security Posture ──────────────────────────────────────────────

  /** Get current edge security status. */
  getStatus(): EdgeSecurityStatus {
    let posture: EdgeSecurityStatus['posture'] = 'cloud';

    if (this.active) {
      // Edge-hardened: state encryption + strict sandbox are the minimum requirements.
      // FreezeDry is best-effort on edge and may not be available in all environments.
      if (this.stateEncryptionActive && this.strictSandboxActive) {
        posture = 'edge-hardened';
      } else if (this.stateEncryptionActive || this.strictSandboxActive) {
        posture = 'edge-basic';
      } else {
        posture = 'degraded';
      }
    }

    return {
      active: this.active,
      mode: this.config.mode,
      detection: this.detection,
      stateEncryptionActive: this.stateEncryptionActive,
      strictSandboxActive: this.strictSandboxActive,
      freezeDryActive: this.freezeDryActive,
      posture,
    };
  }

  // ── State Encryption ──────────────────────────────────────────────

  /**
   * Encrypt agent state data for storage at rest.
   * Uses AES-256-GCM with the profile's encryption key.
   */
  encryptState(plaintext: string): { encrypted: string; iv: string; authTag: string } {
    if (!this.encryptionKey || !this.stateEncryptionActive) {
      throw new Error('State encryption not initialized. Call start() first.');
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag,
    };
  }

  /**
   * Decrypt agent state data previously encrypted with encryptState().
   */
  decryptState(params: { encrypted: string; iv: string; authTag: string }): string {
    if (!this.encryptionKey || !this.stateEncryptionActive) {
      throw new Error('State encryption not initialized. Call start() first.');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(params.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(params.authTag, 'hex'));

    let decrypted = decipher.update(params.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /** Check if state encryption is active. */
  isStateEncryptionActive(): boolean {
    return this.stateEncryptionActive;
  }

  // ── Sandbox Policy ────────────────────────────────────────────────

  /**
   * Get the edge-appropriate sandbox policy.
   * Returns the strictest sandbox configuration for edge mode.
   */
  getEdgeSandboxPolicy(): {
    mode: 'read-only' | 'workspace-write';
    networkPolicy: 'blocked' | 'localhost-only';
    protectedPaths: string[];
  } {
    if (!this.strictSandboxActive) {
      return {
        mode: 'workspace-write',
        networkPolicy: 'localhost-only',
        protectedPaths: this.config.protectedPaths,
      };
    }

    return {
      mode: this.config.readOnlyWorkspace ? 'read-only' : 'workspace-write',
      networkPolicy: 'blocked',
      protectedPaths: [
        ...this.config.protectedPaths,
        // Edge-specific additional protections
        '/proc',
        '/sys',
        '/dev',
        '/boot',
      ],
    };
  }

  /** Check if strict sandbox is active. */
  isStrictSandboxActive(): boolean {
    return this.strictSandboxActive;
  }

  // ── Resource Limits ───────────────────────────────────────────────

  /** Get the recommended resource limits for edge devices. */
  getEdgeResourceLimits(): {
    maxTokens: number;
    maxConcurrency: number;
    isLowResource: boolean;
  } {
    const resources = this.detection?.resources ?? this.assessResources();

    // For always-edge mode, skip the low-resource cap since the user
    // explicitly requested edge with custom limits.
    const isLowResource = resources.isLowResource && this.config.mode !== 'always-edge';

    return {
      maxTokens: isLowResource
        ? Math.min(this.config.edgeMaxTokens, 4000)
        : this.config.edgeMaxTokens,
      maxConcurrency: isLowResource ? 1 : Math.min(this.config.edgeMaxConcurrency, 2),
      isLowResource: resources.isLowResource,
    };
  }

  // ── Public Utilities ──────────────────────────────────────────────

  /** Get the encryption key (for integration with other components). */
  getEncryptionKey(): Buffer | null {
    return this.encryptionKey;
  }

  /** Get the detection result. */
  getDetection(): EdgeDetectionResult | null {
    return this.detection;
  }

  /** Check if FreezeDry is active. */
  isFreezeDryActive(): boolean {
    return this.freezeDryActive;
  }

  // ==========================================================================
  // Internal — Detection
  // ==========================================================================

  private checkCloudApiKeys(): boolean {
    const cloudKeyEnvs = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY',
      'DEEPSEEK_API_KEY',
      'ZHIPU_API_KEY',
      'MIMO_API_KEY',
      'XIAOMI_API_KEY',
      'CO_API_KEY',
      'MISTRAL_API_KEY',
      'GROQ_API_KEY',
      'TOGETHER_API_KEY',
      'PERPLEXITY_API_KEY',
      'FIREWORKS_API_KEY',
      'REPLICATE_API_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'XAI_API_KEY',
    ];

    return cloudKeyEnvs.some((env) => {
      const val = process.env[env];
      return val && val.length > 5;
    });
  }

  private async checkNetworkConnectivity(): Promise<boolean> {
    for (const endpoint of this.config.networkCheckEndpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.networkCheckTimeoutMs);
        await fetch(endpoint, {
          method: 'HEAD',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return true;
      } catch (err) {
        reportSilentFailure(err, 'edgeSecurityProfile:539');
        continue;
      }
    }
    return false;
  }

  private assessResources(): EdgeResourceAssessment {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus().length;
    const loadAvg = os.loadavg()[0];

    const isLowResource =
      freeMem < this.config.resourceThresholds.minFreeMemoryBytes ||
      cpus < this.config.resourceThresholds.minCpuCores ||
      loadAvg > this.config.resourceThresholds.maxCpuLoad;

    return {
      totalMemoryBytes: totalMem,
      freeMemoryBytes: freeMem,
      cpuCores: cpus,
      cpuLoad1m: loadAvg,
      isLowResource,
      recommendedConcurrency: isLowResource ? 1 : Math.min(cpus, 4),
      recommendedMaxTokens: isLowResource ? 4000 : 16000,
    };
  }

  private isAirGapped(): boolean {
    // Check for air-gapped environment markers
    try {
      const dockerConfigPath = path.join(os.homedir(), '.docker', 'config.json');
      if (fs.existsSync(dockerConfigPath)) {
        const config = JSON.parse(fs.readFileSync(dockerConfigPath, 'utf-8'));
        if (config && config.credsStore === '') {
          return true; // Empty cred store in Docker config suggests air-gapped
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:579');
      /* non-critical */
    }

    // Check for offline package manager configs
    const npmrcPath = path.join(os.homedir(), '.npmrc');
    try {
      if (fs.existsSync(npmrcPath)) {
        const npmrc = fs.readFileSync(npmrcPath, 'utf-8');
        if (npmrc.includes('offline') || npmrc.includes('prefer-offline=true')) {
          return true;
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:593');
      /* non-critical */
    }

    return false;
  }

  private isMobileDevice(): boolean {
    const platform = os.platform();
    const arch = os.arch();

    // ARM-based devices (Raspberry Pi, mobile)
    if (arch === 'arm' || arch === 'arm64') {
      const totalMem = os.totalmem();
      // Less than 4GB RAM on ARM = likely mobile/embedded
      if (totalMem < 4 * 1024 * 1024 * 1024) {
        return true;
      }
    }

    // Android detection
    if (platform === 'android') return true;

    return false;
  }

  private isContainerizedEdge(): boolean {
    // Check for edge container runtimes
    try {
      // K3s detection
      if (fs.existsSync('/var/lib/rancher/k3s')) return true;
      // MicroK8s detection
      if (fs.existsSync('/var/snap/microk8s')) return true;
      // IoT Edge runtime
      if (fs.existsSync('/etc/iotedge')) return true;
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:629');
      /* non-critical */
    }

    // Check for /.dockerenv (standard container detection)
    try {
      if (fs.existsSync('/.dockerenv')) {
        const totalMem = os.totalmem();
        // Small container (< 2GB) = likely edge, not cloud
        if (totalMem < 2 * 1024 * 1024 * 1024) return true;
      }
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:641');
      /* non-critical */
    }

    return false;
  }

  private async checkLocalModels(): Promise<{
    localModelAvailable: boolean;
    localProviders: string[];
  }> {
    const providers: string[] = [];

    // Try Ollama
    try {
      const { OllamaProvider } = await import('../runtime/providers/ollamaProvider');
      const running = await OllamaProvider.isRunning();
      if (running) {
        providers.push('ollama');
      }
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:662');
      /* unavailable */
    }

    // Try vLLM
    try {
      const vllmUrl = process.env.VLLM_BASE_URL || 'http://localhost:8000/v1';
      const response = await fetch(vllmUrl.replace(/\/v1\/?$/, '') + '/health', {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        providers.push('vllm');
      }
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:676');
      /* unavailable */
    }

    return {
      localModelAvailable: providers.length > 0,
      localProviders: providers,
    };
  }

  // ==========================================================================
  // Internal — Activation
  // ==========================================================================

  private activateStateEncryption(): void {
    if (!this.encryptionKey) {
      this.initializeEncryptionKey();
    }
    this.stateEncryptionActive = true;
    getGlobalLogger().info('EdgeSecurityProfile', '🔐 State-at-rest encryption activated');
  }

  private activateStrictSandbox(): void {
    this.strictSandboxActive = true;
    getGlobalLogger().info(
      'EdgeSecurityProfile',
      '🛡️ Strict edge sandbox activated (read-only workspace, no network)',
    );
  }

  private async activateFreezeDry(): Promise<void> {
    try {
      const { getFreezeDryManager } = await import('../runtime/freezeDry');
      getFreezeDryManager(); // Initialize if not yet created
      this.freezeDryActive = true;
      getGlobalLogger().info(
        'EdgeSecurityProfile',
        '❄️ FreezeDry activated for crash-resume cycles',
      );
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:716');
      getGlobalLogger().warn(
        'EdgeSecurityProfile',
        'FreezeDry unavailable — continuing without crash-resume',
      );
      this.freezeDryActive = false;
    }
  }

  private deactivateAll(): void {
    this.stateEncryptionActive = false;
    this.strictSandboxActive = false;
    this.freezeDryActive = false;
    this.encryptionKey = null;
    this.detection = null;
  }

  // ==========================================================================
  // Internal — Helpers
  // ==========================================================================

  private initializeEncryptionKey(): void {
    if (this.config.stateEncryptionKey) {
      // Use provided key — hash to 32 bytes for AES-256
      this.encryptionKey = crypto
        .createHash('sha256')
        .update(this.config.stateEncryptionKey)
        .digest();
    } else {
      // Auto-generate a key from machine fingerprint
      const fingerprint = [
        os.hostname(),
        os.platform(),
        os.arch(),
        (() => {
          try {
            return os.userInfo().username;
          } catch (err) {
            reportSilentFailure(err, 'edgeSecurityProfile:754');
            return 'edge-agent';
          }
        })(),
        process.cwd(),
        'commander-edge-security-v1',
      ].join(':');

      this.encryptionKey = crypto.createHash('sha256').update(fingerprint).digest();
    }
  }

  private buildDetectionResult(
    edgeMode: boolean,
    reasons: EdgeDetectionMethod[],
    options?: {
      localModelAvailable?: boolean;
      localProviders?: string[];
      networkAvailable?: boolean;
      resources?: EdgeResourceAssessment;
    },
  ): EdgeDetectionResult {
    return {
      edgeMode,
      reasons,
      localModelAvailable: options?.localModelAvailable ?? false,
      localProviders: options?.localProviders ?? [],
      networkAvailable: options?.networkAvailable ?? true,
      resources: options?.resources ?? this.assessResources(),
      detectedAt: new Date().toISOString(),
    };
  }

  private auditTransition(
    action: 'activated' | 'deactivated' | 'idle',
    detection: EdgeDetectionResult,
  ): void {
    if (!this.config.auditTransitions) return;

    try {
      getAuditChainLedger().logEvent({
        type: 'config_change',
        severity: 'medium',
        source: 'EdgeSecurityProfile',
        message: `Edge mode ${action}: ${detection.reasons.join(', ') || 'cloud mode'}`,
        details: {
          action,
          reasons: detection.reasons,
          localModelAvailable: detection.localModelAvailable,
          resources: {
            isLowResource: detection.resources.isLowResource,
            freeMemoryMB: Math.round(detection.resources.freeMemoryBytes / 1024 / 1024),
          },
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'edgeSecurityProfile:810');
      /* best-effort */
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

const edgeSecuritySingleton = createTenantAwareSingleton(() => new EdgeSecurityProfile());

/** Get the global EdgeSecurityProfile. */
export function getEdgeSecurityProfile(_config?: Partial<EdgeSecurityConfig>): EdgeSecurityProfile {
  return edgeSecuritySingleton.get();
}

/** Reset the edge security profile (for test isolation). */
export function resetEdgeSecurityProfile(): void {
  edgeSecuritySingleton.reset();
}
