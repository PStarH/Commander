/**
 * Canonical persistent SCIM 2.0 store for the API layer.
 *
 * This module wraps and extends the existing JSON-file based ScimUserStore
 * with additional lookup helpers and re-exports the full type surface.
 * Data is kept per tenant under <dataRoot>/data/scim/<tenantId> as atomic
 * JSON files (users.json / groups.json).
 */
import {
  ScimUserStore,
  ScimConflictError,
  type ScimUser,
  type ScimGroup,
  type ScimName,
  type ScimEmail,
  type ScimMember,
  type ScimUserPatch,
  type ScimGroupPatch,
} from './scimUserStore';

export {
  ScimConflictError,
  type ScimUser,
  type ScimGroup,
  type ScimName,
  type ScimEmail,
  type ScimMember,
  type ScimUserPatch,
  type ScimGroupPatch,
};

/**
 * Primary SCIM store used by scimEndpoints. Extends ScimUserStore so the
 * existing file-backed persistence and tenant isolation are preserved.
 */
export class ScimStore extends ScimUserStore {
  async createUser(tenantId: string | undefined, user: ScimUser): Promise<ScimUser> {
    // Defense-in-depth: never persist a plaintext password in a SCIM resource.
    const safe = { ...user } as ScimUser & { password?: unknown };
    delete safe.password;
    return super.createUser(tenantId, safe);
  }

  async updateUser(
    tenantId: string | undefined,
    userId: string,
    patch: ScimUserPatch,
  ): Promise<ScimUser | null> {
    // Defense-in-depth: reject any attempt to stash a password via PATCH/PUT.
    const safe = { ...patch } as ScimUserPatch & { password?: unknown };
    delete safe.password;
    return super.updateUser(tenantId, userId, safe);
  }

  /**
   * Find a user by email address (case-insensitive). Matches the primary
   * email first; if no primary email is marked it falls back to any email
   * with an equal value.
   */
  async findByEmail(tenantId: string | undefined, email: string): Promise<ScimUser | null> {
    const needle = email.trim().toLowerCase();
    if (needle.length === 0) {
      return null;
    }

    const users = await this.listUsers(tenantId);

    // Prefer a primary email match.
    const primary = users.find((u) =>
      u.emails?.some((e) => e.primary && e.value?.trim().toLowerCase() === needle),
    );
    if (primary) {
      return primary;
    }

    return (
      users.find((u) => u.emails?.some((e) => e.value?.trim().toLowerCase() === needle)) ?? null
    );
  }
}

// ── Singleton for production use ────────────────────────────────────────────

let defaultStore: ScimStore | undefined;

export function getDefaultScimStore(): ScimStore {
  if (!defaultStore) {
    defaultStore = new ScimStore();
  }
  return defaultStore;
}

export function resetDefaultScimStore(): void {
  defaultStore = undefined;
}
