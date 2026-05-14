/**
 * Namespaced Memory Store with ACLs and TTL
 *
 * Based on research findings from:
 * - "Multi-Agent Coordination Strategies" (Galileo AI 2025)
 * - "Memory for Autonomous LLM Agents" (arXiv 2603.07670v1)
 *
 * Features:
 * - Namespace per agent role (防止信息孤岛)
 * - Access Control Lists (读/写权限控制)
 * - TTL 自动过期机制
 * - Write Audit (记录谁在何时写了什么)
 */

import {
  EpisodicMemoryItem,
  MemoryWriteOptions,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryStats,
  MemoryStore,
  MemoryKind,
  MemoryDuration,
} from '@commander/core';

// ============================================================================
// ACL Definitions
// ============================================================================

/**
 * Permission levels for memory access
 */
export type MemoryPermission = 'read' | 'write' | 'delete' | 'admin';

/**
 * Role-based access control entry
 */
export interface ACLEntry {
  role: string;
  permissions: MemoryPermission[];
  namespaces: string[]; // Allowed namespaces, '*' for all
}

/**
 * Memory access request context
 */
export interface MemoryAccessContext {
  agentId: string;
  role: string;
  namespace: string;
}

/**
 * Write audit log entry
 */
export interface MemoryAuditLogEntry {
  id: string;
  timestamp: string;
  action: 'write' | 'update' | 'delete' | 'read';
  agentId: string;
  role: string;
  namespace: string;
  memoryId?: string;
  success: boolean;
  errorMessage?: string;
}

// ============================================================================
// Namespace Configuration
// ============================================================================

/**
 * Namespace configuration
 */
export interface NamespaceConfig {
  name: string;
  ttlMs?: number; // Time-to-live in milliseconds
  maxItems?: number; // Maximum items in this namespace
  retentionPolicy: 'fifo' | 'lru' | 'priority'; // Eviction policy when maxItems exceeded
}

/**
 * Default namespace configurations based on agent roles
 */
export const DEFAULT_NAMESPACES: NamespaceConfig[] = [
  { name: 'planner', ttlMs: 7 * 24 * 60 * 60 * 1000, retentionPolicy: 'priority' },
  { name: 'executor', ttlMs: 3 * 24 * 60 * 60 * 1000, retentionPolicy: 'lru' },
  { name: 'reviewer', ttlMs: 14 * 24 * 60 * 60 * 1000, retentionPolicy: 'priority' },
  { name: 'sentinel', ttlMs: 30 * 24 * 60 * 60 * 1000, retentionPolicy: 'fifo' },
  { name: 'orchestrator', ttlMs: 7 * 24 * 60 * 60 * 1000, retentionPolicy: 'priority' },
  { name: 'shared', ttlMs: 30 * 24 * 60 * 60 * 1000, retentionPolicy: 'priority' }, // Shared across agents
];

// ============================================================================
// Default ACL Rules
// ============================================================================

/**
 * Default ACL rules based on Galileo AI recommendations
 */
export const DEFAULT_ACL_RULES: ACLEntry[] = [
  // Orchestrator has full access to all namespaces
  { role: 'orchestrator', permissions: ['read', 'write', 'delete', 'admin'], namespaces: ['*'] },
  
  // Planner can read all, write to planner and shared
  { role: 'planner', permissions: ['read', 'write'], namespaces: ['planner', 'shared'] },
  
  // Executor can read all, write to executor and shared
  { role: 'executor', permissions: ['read', 'write'], namespaces: ['executor', 'shared'] },
  
  // Reviewer can read all, write to reviewer and shared
  { role: 'reviewer', permissions: ['read', 'write'], namespaces: ['reviewer', 'shared'] },
  
  // Sentinel can read all, write to sentinel and shared (audit trail)
  { role: 'sentinel', permissions: ['read', 'write', 'delete'], namespaces: ['sentinel', 'shared'] },
];

// ============================================================================
// Namespaced Memory Store
// ============================================================================

/**
 * Memory item with namespace metadata
 */
export interface NamespacedMemoryItem extends EpisodicMemoryItem {
  namespace: string;
  expiresAt: string; // Required, calculated from TTL
  createdBy: {
    agentId: string;
    role: string;
  };
  acl?: {
    readRoles?: string[];
    writeRoles?: string[];
  };
}

/**
 * Namespaced Memory Store
 *
 * Implements:
 * - Namespace isolation per agent role
 * - ACL-based access control
 * - TTL with automatic expiration
 * - Write audit trail
 */
export class NamespacedMemoryStore {
  private items: Map<string, NamespacedMemoryItem> = new Map();
  private auditLog: MemoryAuditLogEntry[] = [];
  private namespaces: Map<string, NamespaceConfig>;
  private aclRules: ACLEntry[];
  private nextId = 1;

  constructor(
    namespaces: NamespaceConfig[] = DEFAULT_NAMESPACES,
    aclRules: ACLEntry[] = DEFAULT_ACL_RULES
  ) {
    this.namespaces = new Map(namespaces.map(n => [n.name, n]));
    this.aclRules = aclRules;
  }

  // ============================================================================
  // ACL Methods
  // ============================================================================

  /**
   * Check if an agent has permission to perform an action
   */
  hasPermission(
    context: MemoryAccessContext,
    permission: MemoryPermission,
    targetNamespace?: string
  ): boolean {
    const acl = this.aclRules.find(rule => rule.role === context.role);
    if (!acl) return false;

    // Check permission
    if (!acl.permissions.includes(permission) && !acl.permissions.includes('admin')) {
      return false;
    }

    // Check namespace access
    const namespaceToCheck = targetNamespace ?? context.namespace;
    return acl.namespaces.includes('*') || acl.namespaces.includes(namespaceToCheck);
  }

  /**
   * Add or update ACL rule
   */
  setACLRule(entry: ACLEntry): void {
    const existingIndex = this.aclRules.findIndex(r => r.role === entry.role);
    if (existingIndex >= 0) {
      this.aclRules[existingIndex] = entry;
    } else {
      this.aclRules.push(entry);
    }
  }

  /**
   * Get all ACL rules
   */
  getACLRules(): ACLEntry[] {
    return [...this.aclRules];
  }

  // ============================================================================
  // Namespace Methods
  // ============================================================================

  /**
   * Get namespace configuration
   */
  getNamespaceConfig(name: string): NamespaceConfig | undefined {
    return this.namespaces.get(name);
  }

  /**
   * Add or update namespace configuration
   */
  setNamespaceConfig(config: NamespaceConfig): void {
    this.namespaces.set(config.name, config);
  }

  /**
   * Calculate expiration time based on namespace TTL
   */
  private calculateExpiry(namespace: string): string {
    const config = this.namespaces.get(namespace);
    const ttlMs = config?.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // Default 7 days
    return new Date(Date.now() + ttlMs).toISOString();
  }

  /**
   * Enforce namespace item limit with eviction policy
   */
  private enforceLimit(namespace: string): void {
    const config = this.namespaces.get(namespace);
    if (!config?.maxItems) return;

    const namespaceItems = Array.from(this.items.values())
      .filter(item => item.namespace === namespace);

    if (namespaceItems.length >= config.maxItems) {
      // Evict items based on retention policy
      const itemsToEvict = namespaceItems.length - config.maxItems + 1;
      
      let sortedItems: NamespacedMemoryItem[];
      switch (config.retentionPolicy) {
        case 'fifo':
          sortedItems = namespaceItems.sort((a, b) => 
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
          break;
        case 'lru':
          sortedItems = namespaceItems.sort((a, b) => 
            new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime()
          );
          break;
        case 'priority':
        default:
          sortedItems = namespaceItems.sort((a, b) => a.priority - b.priority);
          break;
      }

      // Evict oldest/lowest priority items
      for (let i = 0; i < itemsToEvict; i++) {
        if (sortedItems[i]) {
          this.items.delete(sortedItems[i].id);
          this.logAudit({
            action: 'delete',
            agentId: 'system',
            role: 'system',
            namespace,
            memoryId: sortedItems[i].id,
            success: true,
            errorMessage: `Evicted due to ${config.retentionPolicy} policy`,
          });
        }
      }
    }
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Write a memory item with ACL check
   */
  write(
    options: MemoryWriteOptions & { namespace: string },
    context: MemoryAccessContext
  ): NamespacedMemoryItem | null {
    // Check write permission
    if (!this.hasPermission(context, 'write', options.namespace)) {
      this.logAudit({
        action: 'write',
        agentId: context.agentId,
        role: context.role,
        namespace: options.namespace,
        success: false,
        errorMessage: 'Permission denied',
      });
      return null;
    }

    const now = new Date().toISOString();
    const id = `mem-${this.nextId++}`;
    const expiresAt = this.calculateExpiry(options.namespace);

    const item: NamespacedMemoryItem = {
      id,
      projectId: options.projectId,
      missionId: options.missionId,
      agentId: options.agentId,
      kind: options.kind,
      duration: options.duration ?? 'EPISODIC',
      title: options.title,
      content: options.content,
      tags: options.tags ?? [],
      priority: options.priority ?? 50,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt,
      evidenceRefs: options.evidenceRefs,
      confidence: options.confidence ?? 0.8,
      namespace: options.namespace,
      createdBy: {
        agentId: context.agentId,
        role: context.role,
      },
    };

    this.items.set(id, item);
    this.enforceLimit(options.namespace);
    
    this.logAudit({
      action: 'write',
      agentId: context.agentId,
      role: context.role,
      namespace: options.namespace,
      memoryId: id,
      success: true,
    });

    return item;
  }

  /**
   * Read a memory item with ACL check
   */
  read(
    id: string,
    context: MemoryAccessContext
  ): NamespacedMemoryItem | null {
    const item = this.items.get(id);
    if (!item) return null;

    // Check read permission
    if (!this.hasPermission(context, 'read', item.namespace)) {
      this.logAudit({
        action: 'read',
        agentId: context.agentId,
        role: context.role,
        namespace: item.namespace,
        memoryId: id,
        success: false,
        errorMessage: 'Permission denied',
      });
      return null;
    }

    // Check expiration
    if (new Date(item.expiresAt) < new Date()) {
      this.items.delete(id);
      this.logAudit({
        action: 'delete',
        agentId: 'system',
        role: 'system',
        namespace: item.namespace,
        memoryId: id,
        success: true,
        errorMessage: 'Expired',
      });
      return null;
    }

    // Update last accessed time
    item.lastAccessedAt = new Date().toISOString();
    
    this.logAudit({
      action: 'read',
      agentId: context.agentId,
      role: context.role,
      namespace: item.namespace,
      memoryId: id,
      success: true,
    });

    return item;
  }

  /**
   * Update a memory item with ACL check
   */
  update(
    id: string,
    updates: Partial<Pick<NamespacedMemoryItem, 'priority' | 'tags' | 'confidence' | 'content'>>,
    context: MemoryAccessContext
  ): NamespacedMemoryItem | null {
    const item = this.items.get(id);
    if (!item) return null;

    // Check write permission
    if (!this.hasPermission(context, 'write', item.namespace)) {
      this.logAudit({
        action: 'update',
        agentId: context.agentId,
        role: context.role,
        namespace: item.namespace,
        memoryId: id,
        success: false,
        errorMessage: 'Permission denied',
      });
      return null;
    }

    Object.assign(item, updates);
    item.lastAccessedAt = new Date().toISOString();
    
    this.logAudit({
      action: 'update',
      agentId: context.agentId,
      role: context.role,
      namespace: item.namespace,
      memoryId: id,
      success: true,
    });

    return item;
  }

  /**
   * Delete a memory item with ACL check
   */
  delete(
    id: string,
    context: MemoryAccessContext
  ): boolean {
    const item = this.items.get(id);
    if (!item) return false;

    // Check delete permission
    if (!this.hasPermission(context, 'delete', item.namespace)) {
      this.logAudit({
        action: 'delete',
        agentId: context.agentId,
        role: context.role,
        namespace: item.namespace,
        memoryId: id,
        success: false,
        errorMessage: 'Permission denied',
      });
      return false;
    }

    this.items.delete(id);
    
    this.logAudit({
      action: 'delete',
      agentId: context.agentId,
      role: context.role,
      namespace: item.namespace,
      memoryId: id,
      success: true,
    });

    return true;
  }

  // ============================================================================
  // Search Operations
  // ============================================================================

  /**
   * Search memories within accessible namespaces
   */
  search(
    query: MemorySearchQuery & { namespaces?: string[] },
    context: MemoryAccessContext
  ): MemorySearchResult {
    // Determine accessible namespaces
    const acl = this.aclRules.find(rule => rule.role === context.role);
    const accessibleNamespaces = acl?.namespaces.includes('*')
      ? Array.from(this.namespaces.keys())
      : (acl?.namespaces ?? []);

    // Filter by requested namespaces if specified
    const searchNamespaces = query.namespaces
      ? query.namespaces.filter(n => accessibleNamespaces.includes(n))
      : accessibleNamespaces;

    let results = Array.from(this.items.values())
      .filter(item => {
        // Filter by accessible namespaces
        if (!searchNamespaces.includes(item.namespace)) return false;
        
        // Filter by project
        if (item.projectId !== query.projectId) return false;
        
        // Filter by expiration
        if (new Date(item.expiresAt) < new Date()) return false;
        
        // Filter by kind
        if (query.kind && item.kind !== query.kind) return false;
        
        // Filter by mission
        if (query.missionId && item.missionId !== query.missionId) return false;
        
        // Filter by agent
        if (query.agentId && item.agentId !== query.agentId) return false;
        
        // Filter by tags
        if (query.tags && query.tags.length > 0) {
          if (!query.tags.some(tag => item.tags.includes(tag))) return false;
        }
        
        // Filter by priority
        if (query.minPriority !== undefined && item.priority < query.minPriority) return false;
        
        // Filter by confidence
        if (query.minConfidence !== undefined && item.confidence < query.minConfidence) return false;
        
        // Text search
        if (query.query) {
          const lowerQuery = query.query.toLowerCase();
          if (
            !item.title.toLowerCase().includes(lowerQuery) &&
            !item.content.toLowerCase().includes(lowerQuery)
          ) return false;
        }
        
        return true;
      });

    // Sort by priority (descending) then by createdAt (descending)
    results.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const total = results.length;
    const limit = query.limit ?? 50;
    const items = results.slice(0, limit);

    return { items, total, query };
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  /**
   * Delete all expired items
   */
  deleteExpired(): number {
    const now = new Date();
    let count = 0;
    
    for (const [id, item] of this.items) {
      if (new Date(item.expiresAt) < now) {
        this.items.delete(id);
        count++;
        
        this.logAudit({
          action: 'delete',
          agentId: 'system',
          role: 'system',
          namespace: item.namespace,
          memoryId: id,
          success: true,
          errorMessage: 'Expired',
        });
      }
    }
    
    return count;
  }

  /**
   * Get statistics for a namespace
   */
  getNamespaceStats(namespace: string): {
    totalItems: number;
    avgPriority: number;
    avgConfidence: number;
    oldestItem?: string;
    newestItem?: string;
    expiringItems: number;
  } {
    const namespaceItems = Array.from(this.items.values())
      .filter(item => item.namespace === namespace);

    if (namespaceItems.length === 0) {
      return {
        totalItems: 0,
        avgPriority: 0,
        avgConfidence: 0,
        expiringItems: 0,
      };
    }

    const now = new Date();
    const expiringItems = namespaceItems.filter(
      item => new Date(item.expiresAt) < new Date(now.getTime() + 24 * 60 * 60 * 1000)
    ).length;

    const sorted = namespaceItems.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return {
      totalItems: namespaceItems.length,
      avgPriority: namespaceItems.reduce((sum, item) => sum + item.priority, 0) / namespaceItems.length,
      avgConfidence: namespaceItems.reduce((sum, item) => sum + item.confidence, 0) / namespaceItems.length,
      oldestItem: sorted[0]?.createdAt,
      newestItem: sorted[sorted.length - 1]?.createdAt,
      expiringItems,
    };
  }

  // ============================================================================
  // Audit Log Methods
  // ============================================================================

  /**
   * Get audit log entries
   */
  getAuditLog(options?: {
    namespace?: string;
    agentId?: string;
    action?: 'write' | 'update' | 'delete' | 'read';
    limit?: number;
  }): MemoryAuditLogEntry[] {
    let entries = [...this.auditLog];

    if (options?.namespace) {
      entries = entries.filter(e => e.namespace === options.namespace);
    }
    if (options?.agentId) {
      entries = entries.filter(e => e.agentId === options.agentId);
    }
    if (options?.action) {
      entries = entries.filter(e => e.action === options.action);
    }

    // Sort by timestamp descending
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (options?.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Log an audit entry
   */
  private logAudit(entry: Omit<MemoryAuditLogEntry, 'id' | 'timestamp'>): void {
    const auditEntry: MemoryAuditLogEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.auditLog.push(auditEntry);

    // Keep only last 1000 audit entries to prevent unbounded growth
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
  }
}

// NamespacedMemoryStore is the default export
// DEFAULT_NAMESPACES and DEFAULT_ACL_RULES are already exported at declaration
