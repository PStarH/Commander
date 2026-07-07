/**
 * Shared authentication plugin abstraction.
 *
 * Originally lived inside oidcAuthPlugin.ts. Extracted so OIDC, SAML, LDAP,
 * and future SSO protocols can share the same plugin contract without
 * coupling to any one protocol.
 */
import type { AuthRole } from './authManager';

export interface AuthPlugin {
  /** Unique name for this plugin */
  readonly name: string;
  /** Authenticate a Bearer token. Returns user info + role on success, null on failure. */
  authenticate(bearerToken: string): Promise<AuthPluginResult | null>;
}

export interface AuthPluginResult {
  /** Stable user identifier from the external identity provider */
  userId: string;
  /** Human-readable username/email */
  username: string;
  /** Commander role mapped from provider claims/attributes */
  role: AuthRole;
  /** Optional tenant ID for multi-tenant mapping */
  tenantId?: string;
  /** Raw claims/attributes from the provider (for audit) */
  claims?: Record<string, unknown>;
}
