/**
 * Memory namespace write guard (MEMORY-001).
 *
 * Enforced on MemoryService.store default write path (InMemory + Postgres).
 * Agent-identified writes must land in the writer's namespace, an ACL-granted
 * namespace, or the shared tasks/ scope.
 */

export type MemoryNamespaceAcl = { role: string; namespaces: string[] };

export function assertNamespaced(
  writerAgentId: string,
  targetPath: string,
  acl?: MemoryNamespaceAcl,
): void {
  const writerNs = `agents/${writerAgentId}`;
  if (targetPath.startsWith(writerNs)) return;
  if (acl && acl.namespaces.some((ns) => targetPath.startsWith(ns))) return;
  if (acl && acl.namespaces.includes('tasks') && targetPath.startsWith('tasks/')) return;
  throw new Error(
    `MEMORY-001: agent "${writerAgentId}" attempted to write outside its namespace: ${targetPath}`,
  );
}

/**
 * Derive target path + ACL from a store input and enforce MEMORY-001.
 * Skips when there is no agent identity (system / tenant-scoped bulk jobs).
 */
export function assertNamespacedStoreInput(input: {
  agentId?: string;
  id?: string;
  meta?: Record<string, unknown>;
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
  const rawAcl = meta.acl;
  if (rawAcl && typeof rawAcl === 'object') {
    const candidate = rawAcl as { role?: unknown; namespaces?: unknown };
    if (typeof candidate.role === 'string' && Array.isArray(candidate.namespaces)) {
      acl = {
        role: candidate.role,
        namespaces: candidate.namespaces.filter((n): n is string => typeof n === 'string'),
      };
    }
  } else if (namespace && meta.createdBy && typeof meta.createdBy === 'object') {
    // HTTP namespaced-memory writes: role already authorized at the gateway;
    // grant that namespace for the agent-scoped store check.
    const createdBy = meta.createdBy as { role?: unknown };
    if (typeof createdBy.role === 'string') {
      acl = { role: createdBy.role, namespaces: [namespace] };
    }
  }

  assertNamespaced(agentId, targetPath, acl);
}
