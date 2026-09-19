import { isProductionEnv } from './envSignal';

const LOOPBACK_HOST = '127.0.0.1';
const MINIMUM_JWT_SECRET_LENGTH = 32;
const MINIMUM_ADMIN_PASSWORD_LENGTH = 16;
const PUBLIC_JWT_SECRETS = new Set([
  'commander-dev-secret-change-in-production',
  'dev-jwt-secret-change-me-in-production',
]);
const PUBLIC_ADMIN_PASSWORDS = new Set(['commander-admin']);
const MINIMUM_AUDIT_KEY_LENGTH = 32;
const PUBLIC_AUDIT_CHAIN_KEYS = new Set([
  'commander-audit-chain-dev-key-DO-NOT-USE-IN-PROD-v1',
  'change-me-to-a-random-secret',
]);

export class ApiStartupConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiStartupConfigurationError';
  }
}

export interface ApiStartupConfig {
  host: string;
  jwtSecret: string;
  adminPassword: string | undefined;
}

function readRequiredSecret(
  environment: NodeJS.ProcessEnv,
  name: 'JWT_SECRET' | 'ADMIN_PASSWORD',
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new ApiStartupConfigurationError(`${name} must be set before the API starts.`);
  }
  return value;
}

function assertJwtSecret(secret: string): void {
  if (PUBLIC_JWT_SECRETS.has(secret)) {
    throw new ApiStartupConfigurationError('JWT_SECRET must not use a public default.');
  }
  if (secret.length < MINIMUM_JWT_SECRET_LENGTH) {
    throw new ApiStartupConfigurationError(
      `JWT_SECRET must be at least ${MINIMUM_JWT_SECRET_LENGTH} characters long.`,
    );
  }
}

function assertAdminPassword(password: string): void {
  if (PUBLIC_ADMIN_PASSWORDS.has(password)) {
    throw new ApiStartupConfigurationError('ADMIN_PASSWORD must not use a public default.');
  }
  if (password.length < MINIMUM_ADMIN_PASSWORD_LENGTH) {
    throw new ApiStartupConfigurationError(
      `ADMIN_PASSWORD must be at least ${MINIMUM_ADMIN_PASSWORD_LENGTH} characters long.`,
    );
  }
}

function assertAuditKey(name: string, value: string): void {
  if (PUBLIC_AUDIT_CHAIN_KEYS.has(value)) {
    throw new ApiStartupConfigurationError(`${name} must not use a public default.`);
  }
  if (value.length < MINIMUM_AUDIT_KEY_LENGTH) {
    throw new ApiStartupConfigurationError(
      `${name} must be at least ${MINIMUM_AUDIT_KEY_LENGTH} characters long.`,
    );
  }
}

/**
 * Audit-chain key material is not optional in production: the ledger HMAC key is
 * read by every security module that records an event, and `ChainManifest`
 * refuses to start without its own key once the manifest chain is enabled. Both
 * resolvers fail closed on their own, but they do so deep inside the security
 * stack — validating here makes the deployment refuse to serve instead, and
 * rejects a public dev key that would produce cryptographically invalid
 * tamper-evidence.
 */
function assertAuditChainKeyConfiguration(environment: NodeJS.ProcessEnv): void {
  const auditChainKey = environment.COMMANDER_AUDIT_CHAIN_KEY?.trim();
  const manifestKey = environment.COMMANDER_MANIFEST_KEY?.trim();
  const manifestEnabled = Boolean(environment.COMMANDER_AUDIT_MANIFEST_DIR?.trim());

  if (auditChainKey) {
    assertAuditKey('COMMANDER_AUDIT_CHAIN_KEY', auditChainKey);
  } else if (isProductionEnv(environment) || manifestEnabled) {
    throw new ApiStartupConfigurationError(
      'COMMANDER_AUDIT_CHAIN_KEY must be set before the API starts in production.',
    );
  }

  if (manifestKey) {
    assertAuditKey('COMMANDER_MANIFEST_KEY', manifestKey);
  } else if (manifestEnabled) {
    throw new ApiStartupConfigurationError(
      'COMMANDER_MANIFEST_KEY must be set when COMMANDER_AUDIT_MANIFEST_DIR enables the manifest chain.',
    );
  }

  if (auditChainKey && manifestKey && auditChainKey === manifestKey) {
    throw new ApiStartupConfigurationError(
      'COMMANDER_MANIFEST_KEY must be distinct from COMMANDER_AUDIT_CHAIN_KEY.',
    );
  }
}

function isMultiReplicaApi(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.COMMANDER_API_REPLICAS?.trim();
  if (!value) return false;
  const replicas = Number(value);
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new ApiStartupConfigurationError('COMMANDER_API_REPLICAS must be a positive integer.');
  }
  return replicas > 1;
}

/** Resolves the listener interface without binding a socket. */
export function resolveApiHost(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.API_HOST?.trim() || LOOPBACK_HOST;
}

/** Env names read as quota / window / lockout settings and validated at startup. */
export const RATE_LIMIT_CONFIG_NAMES = [
  'API_RATE_LIMIT',
  'API_RATE_LIMIT_USER',
  'API_RATE_LIMIT_TENANT',
  'AUTH_MAX_FAILURES',
  'AUTH_LOCKOUT_MS',
] as const;

/**
 * AUTH-05: a quota / window / lockout value must be a finite positive safe
 * integer. `parseInt` accepted empty strings, decimals, negatives, trailing
 * characters and overflow — all of which produced `NaN` (or a truncated value),
 * and a `NaN` comparison never trips a limit (`count > NaN` is false), so a
 * mistyped env var silently disabled rate limiting / lockout instead of
 * failing startup. The default applies only when the variable is unset; every
 * other value must be valid or the process refuses to start.
 */
export function resolvePositiveSafeInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  // Reject empty strings, signs, decimals, exponents and trailing characters.
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new ApiStartupConfigurationError(
      `${name} must be a finite positive safe integer (got ${JSON.stringify(raw)}).`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApiStartupConfigurationError(
      `${name} must be a finite positive safe integer (got ${JSON.stringify(raw)}).`,
    );
  }
  return value;
}

/**
 * Validates every quota / window / lockout setting before the API starts.
 * Callers use this both at module load (so a misconfigured process cannot serve
 * a request) and at startup so the failure is attributable.
 */
export function assertRateLimitConfiguration(environment: NodeJS.ProcessEnv = process.env): void {
  const rateLimitMax = resolvePositiveSafeInteger(environment, 'API_RATE_LIMIT', 120);
  resolvePositiveSafeInteger(environment, 'API_RATE_LIMIT_USER', rateLimitMax);
  resolvePositiveSafeInteger(environment, 'API_RATE_LIMIT_TENANT', rateLimitMax);
  resolvePositiveSafeInteger(environment, 'AUTH_MAX_FAILURES', 5);
  resolvePositiveSafeInteger(environment, 'AUTH_LOCKOUT_MS', 300_000);
}

/**
 * Resolves the security-sensitive API startup values without touching external
 * services, so startup policy can be tested independently of PostgreSQL.
 */
export function resolveApiStartupConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiStartupConfig {
  const jwtSecret = readRequiredSecret(environment, 'JWT_SECRET');
  assertJwtSecret(jwtSecret);

  const adminPassword = environment.ADMIN_PASSWORD?.trim() || undefined;
  if (adminPassword) assertAdminPassword(adminPassword);
  if ((isProductionEnv(environment) || isMultiReplicaApi(environment)) && !adminPassword) {
    throw new ApiStartupConfigurationError(
      'ADMIN_PASSWORD must be set for production or multi-replica API deployments.',
    );
  }

  assertAuditChainKeyConfiguration(environment);

  return {
    host: resolveApiHost(environment),
    jwtSecret,
    adminPassword,
  };
}

/** Resolves the initial-admin credential only when an admin must be seeded. */
export function resolveBootstrapAdminPassword(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const password = readRequiredSecret(environment, 'ADMIN_PASSWORD');
  assertAdminPassword(password);
  return password;
}
