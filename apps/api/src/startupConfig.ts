import { isProductionEnv } from './envSignal';

const LOOPBACK_HOST = '127.0.0.1';
const MINIMUM_JWT_SECRET_LENGTH = 32;
const MINIMUM_ADMIN_PASSWORD_LENGTH = 16;
const PUBLIC_JWT_SECRETS = new Set([
  'commander-dev-secret-change-in-production',
  'dev-jwt-secret-change-me-in-production',
]);
const PUBLIC_ADMIN_PASSWORDS = new Set(['commander-admin']);

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
