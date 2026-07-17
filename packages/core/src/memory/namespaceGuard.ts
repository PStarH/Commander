/**
 * Memory namespace write guard (MEMORY-001).
 *
 * Extracted from the deleted MemorySystem facade so security tests keep a
 * single, callable enforcement point without resurrecting a dead product class.
 */
export function assertNamespaced(
  writerAgentId: string,
  targetPath: string,
  acl?: { role: string; namespaces: string[] },
): void {
  const writerNs = `agents/${writerAgentId}`;
  if (targetPath.startsWith(writerNs)) return;
  if (acl && acl.namespaces.some((ns) => targetPath.startsWith(ns))) return;
  if (acl && acl.namespaces.includes('tasks') && targetPath.startsWith('tasks/')) return;
  throw new Error(
    `MEMORY-001: agent "${writerAgentId}" attempted to write outside its namespace: ${targetPath}`,
  );
}
