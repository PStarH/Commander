/**
 * Memory namespace write guard (MEMORY-001).
 *
 * Enforced on MemoryService.store default write path (InMemory + Postgres).
 * Agent-identified writes must land in the writer's namespace, an ACL-granted
 * namespace, or the shared tasks/ scope.
 *
 * ACL must be passed via StoreMemoryInput.namespaceAcl (server-injected).
 * Client-controlled meta.acl / meta.createdBy are never trusted.
 */

export type MemoryNamespaceAcl = { role: string; namespaces: string[] };

function normalizeAclNamespaces(namespaces: string[]): string[] {
  return namespaces.filter((n) => typeof n === 'string' && n.length > 0);
}

export function assertNamespaced(
  writerAgentId: string,
  targetPath: string,
  acl?: MemoryNamespaceAcl,
): void {
  const writerNs = `agents/${writerAgentId}`;
  if (targetPath.startsWith(writerNs)) return;
  const namespaces = acl ? normalizeAclNamespaces(acl.namespaces) : [];
  if (namespaces.some((ns) => targetPath.startsWith(ns))) return;
  if (namespaces.includes('tasks') && targetPath.startsWith('tasks/')) return;
  throw new Error(
    `MEMORY-001: agent "${writerAgentId}" attempted to write outside its namespace: ${targetPath}`,
  );
}

/**
 * Derive target path from a store input and enforce MEMORY-001.
 * Skips when there is no agent identity (system / tenant-scoped bulk jobs).
 * Cross-namespace grants require server-injected `namespaceAcl` only.
 */
export function assertNamespacedStoreInput(input: {
  agentId?: string;
  id?: string;
  meta?: Record<string, unknown>;
  namespaceAcl?: MemoryNamespaceAcl;
}): void {
  const agentId = input.agentId;
  if (!agentId) return;

  const recordId = input.id ?? 'pending';
  const meta = input.meta ?? {};
  const namespace = typeof meta.namespace === 'string' && meta.namespace.length > 0
    ? meta.namespace.replace(/\/$/, '')
    : undefined;
  const targetPath = namespace
    ? `${namespace}/${recordId}`
    : `agents/${agentId}/${recordId}`;

  let acl: MemoryNamespaceAcl | undefined;
  if (input.namespaceAcl && typeof input.namespaceAcl.role === 'string') {
    acl = {
      role: input.namespaceAcl.role,
      namespaces: normalizeAclNamespaces(input.namespaceAcl.namespaces ?? []),
    };
  }

  assertNamespaced(agentId, targetPath, acl);
}
