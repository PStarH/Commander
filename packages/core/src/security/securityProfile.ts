/**
 * Security Profile — ENV-driven tiered security configuration
 *
 * Local-first single-user agents don't need the same security posture as
 * enterprise multi-tenant deployments. This module exposes a single
 * COMMANDER_SECURITY_PROFILE env var (dev | standard | strict) that
 * controls the default enablement of security layers across the gateway,
 * DLP, and hallucination detector.
 *
 * Profile hierarchy:
 *   dev      — minimal overhead, core DLP only, no hallucination detection
 *   standard — production-ready local-first (default): all gateway layers on,
 *              common DLP types only, hallucination detection on
 *   strict   — enterprise / regulated: all 14 DLP types (incl. industry-specific)
 *
 * Individual layers can still be toggled at runtime via configure(); the
 * profile only sets the *initial* defaults.
 *
 * Rationale: OWASP Top 10 for Agentic Applications (2026) recommends
 * "Least Agency" — don't load defenses for threats outside the deployment
 * scope. Anthropic's Zero Trust for AI Agents (2026) maturity model similarly
 * distinguishes tier 1 (single-user) from tier 3 (enterprise) postures.
 */

export type SecurityProfile = 'dev' | 'standard' | 'strict';

/**
 * Common DLP types — relevant for any agent deployment (credentials, PII,
 * network-internal addresses). Always enabled in every profile.
 */
export const COMMON_DLP_TYPES: readonly string[] = [
  'api_key',
  'jwt_token',
  'private_key',
  'credit_card',
  'email',
  'phone_number',
  'internal_ip',
  'database_connection_string',
  'aws_credential',
  'gcp_credential',
  'azure_credential',
] as const;

/**
 * Industry-specific DLP types — opt-in. These are region/sector-specific
 * (US SSN, China ID card, finance bank account) and shouldn't be enabled
 * for a generic local-first agent by default. Enable via `strict` profile
 * or explicit configure() call.
 */
export const INDUSTRY_DLP_TYPES: readonly string[] = [
  'ssn', // US Social Security Number
  'chinese_id', // China ID card (GB 11643-1999)
  'bank_account', // Bank account number (keyword + Luhn)
] as const;

export interface SecurityProfileConfig {
  // EnterpriseSecurityGateway layer flags
  enableZeroTrust: boolean;
  enableDLP: boolean;
  enableBillGuard: boolean;
  enableGuardian: boolean;
  enableSecurityMonitor: boolean;
  dlpBlockCritical: boolean;
  // DLP type enablement
  dlpEnabledTypes: readonly string[];
  // Hallucination detector
  enableHallucinationDetector: boolean;
}

const PROFILES: Record<SecurityProfile, SecurityProfileConfig> = {
  // Dev: minimal overhead for local development / CI
  dev: {
    enableZeroTrust: false,
    enableDLP: true,
    enableBillGuard: true,
    enableGuardian: false,
    enableSecurityMonitor: false,
    dlpBlockCritical: false,
    dlpEnabledTypes: COMMON_DLP_TYPES,
    enableHallucinationDetector: false,
  },
  // Standard: production-ready local-first single-user deployment
  standard: {
    enableZeroTrust: true,
    enableDLP: true,
    enableBillGuard: true,
    enableGuardian: true,
    enableSecurityMonitor: true,
    dlpBlockCritical: true,
    dlpEnabledTypes: COMMON_DLP_TYPES, // industry types opt-in
    enableHallucinationDetector: true,
  },
  // Strict: enterprise / regulated deployment (all layers, all DLP types)
  strict: {
    enableZeroTrust: true,
    enableDLP: true,
    enableBillGuard: true,
    enableGuardian: true,
    enableSecurityMonitor: true,
    dlpBlockCritical: true,
    dlpEnabledTypes: [...COMMON_DLP_TYPES, ...INDUSTRY_DLP_TYPES],
    enableHallucinationDetector: true,
  },
};

let cachedProfile: SecurityProfile | null = null;

/**
 * Get the active security profile from COMMANDER_SECURITY_PROFILE env var.
 * Defaults to 'standard' if unset or invalid.
 */
export function getSecurityProfile(): SecurityProfile {
  if (cachedProfile === null) {
    const env = (process.env.COMMANDER_SECURITY_PROFILE ?? 'standard').toLowerCase();
    if (env === 'dev' || env === 'standard' || env === 'strict') {
      cachedProfile = env;
    } else {
      cachedProfile = 'standard';
    }
  }
  return cachedProfile;
}

/**
 * Get the full config for the active security profile.
 */
export function getSecurityProfileConfig(): SecurityProfileConfig {
  return PROFILES[getSecurityProfile()];
}

/**
 * Reset the profile cache. Useful for tests that change env vars.
 */
export function resetSecurityProfileCache(): void {
  cachedProfile = null;
}
