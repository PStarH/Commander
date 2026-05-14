/**
 * Memory Index System
 * Based on Claude Code's three-layer memory architecture
 * 
 * Architecture:
 * - Layer 1: In-Context Memory (active window) - handled by LLM
 * - Layer 2: memory/index.json (pointer index) - this module
 * - Layer 3: PROJECT.md (project-level config) - static
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface MemoryPointer {
  domain: string;
  filePath: string;
  description: string;
  lastUpdated: string;
}

export interface MemoryIndex {
  version: string;
  projectId: string;
  pointers: MemoryPointer[];
  lastReconciled?: string;
}

export interface DomainMemory {
  domain: string;
  entries: MemoryEntry[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    entryCount: number;
  };
}

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: 'decision' | 'context' | 'pattern' | 'preference' | 'issue' | 'lesson';
  title: string;
  content: string;
  tags: string[];
}

const MEMORY_DIR = path.resolve(__dirname, '../../memory');
const INDEX_FILE = path.join(MEMORY_DIR, 'index.json');

export class MemoryIndexManager {
  private index: MemoryIndex | null = null;
  
  constructor(private readonly projectId: string) {
    this.loadIndex();
  }
  
  /**
   * Get or create memory index
   */
  private loadIndex(): void {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    
    if (fs.existsSync(INDEX_FILE)) {
      try {
        const raw = fs.readFileSync(INDEX_FILE, 'utf8');
        this.index = JSON.parse(raw);
      } catch {
        this.index = null;
      }
    }
    
    if (!this.index) {
      this.index = {
        version: '1.0',
        projectId: this.projectId,
        pointers: []
      };
      this.persistIndex();
    }
  }
  
  /**
   * Add a new memory domain
   */
  addDomain(domain: string, description: string): MemoryPointer {
    const fileName = `${domain.toLowerCase().replace(/\s+/g, '-')}.json`;
    const filePath = path.join(MEMORY_DIR, fileName);
    
    const pointer: MemoryPointer = {
      domain,
      filePath: fileName,
      description,
      lastUpdated: new Date().toISOString()
    };
    
    // Check if domain already exists
    const existing = this.index!.pointers.find(p => p.domain === domain);
    if (existing) {
      return existing;
    }
    
    this.index!.pointers.push(pointer);
    this.persistIndex();
    
    // Initialize domain file if not exists
    if (!fs.existsSync(filePath)) {
      const domainMemory: DomainMemory = {
        domain,
        entries: [],
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          entryCount: 0
        }
      };
      fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));
    }
    
    return pointer;
  }
  
  /**
   * Get pointer for a domain
   */
  getPointer(domain: string): MemoryPointer | undefined {
    return this.index!.pointers.find(p => p.domain === domain);
  }
  
  /**
   * List all domains
   */
  listDomains(): MemoryPointer[] {
    return this.index!.pointers;
  }
  
  /**
   * Read domain memory
   */
  readDomain(domain: string): DomainMemory | null {
    const pointer = this.getPointer(domain);
    if (!pointer) return null;
    
    const filePath = path.join(MEMORY_DIR, pointer.filePath);
    if (!fs.existsSync(filePath)) return null;
    
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  
  /**
   * Write entry to domain memory (self-healing: append, don't overwrite)
   */
  writeEntry(domain: string, entry: Omit<MemoryEntry, 'id' | 'timestamp'>): MemoryEntry | null {
    const pointer = this.getPointer(domain);
    if (!pointer) return null;
    
    const filePath = path.join(MEMORY_DIR, pointer.filePath);
    const domainMemory = this.readDomain(domain) || {
      domain,
      entries: [],
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entryCount: 0
      }
    };
    
    const newEntry: MemoryEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...entry
    };
    
    domainMemory.entries.push(newEntry);
    domainMemory.metadata.updatedAt = new Date().toISOString();
    domainMemory.metadata.entryCount = domainMemory.entries.length;
    
    fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));
    
    // Update pointer
    pointer.lastUpdated = new Date().toISOString();
    this.persistIndex();
    
    return newEntry;
  }
  
  /**
   * Reconcile memory (remove duplicates, fix inconsistencies)
   */
  reconcile(): { removed: number; merged: number } {
    let removed = 0;
    let merged = 0;
    
    for (const pointer of this.index!.pointers) {
      const domainMemory = this.readDomain(pointer.domain);
      if (!domainMemory) continue;
      
      // Find duplicates by title + type
      const seen = new Map<string, MemoryEntry>();
      const newEntries: MemoryEntry[] = [];
      
      for (const entry of domainMemory.entries) {
        const key = `${entry.type}:${entry.title}`;
        if (seen.has(key)) {
          // Merge content
          const existing = seen.get(key)!;
          existing.content += '\n\n---\n\n' + entry.content;
          existing.tags = [...new Set([...existing.tags, ...entry.tags])];
          merged++;
        } else {
          seen.set(key, entry);
          newEntries.push(entry);
        }
      }
      
      removed = domainMemory.entries.length - newEntries.length;
      domainMemory.entries = newEntries;
      domainMemory.metadata.entryCount = newEntries.length;
      
      const filePath = path.join(MEMORY_DIR, pointer.filePath);
      fs.writeFileSync(filePath, JSON.stringify(domainMemory, null, 2));
    }
    
    this.index!.lastReconciled = new Date().toISOString();
    this.persistIndex();
    
    return { removed, merged };
  }
  
  private persistIndex(): void {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(this.index, null, 2));
  }
}

// Default domains for Commander
export const DEFAULT_DOMAINS = [
  { domain: 'Project Context', description: 'Project goals, constraints, architecture' },
  { domain: 'Decisions', description: 'Architectural decisions and rationale' },
  { domain: 'Patterns', description: 'Code patterns and conventions' },
  { domain: 'Preferences', description: 'User preferences and settings' },
  { domain: 'Issues', description: 'Known issues and workarounds' },
  { domain: 'Lessons', description: 'Lessons learned from iterations' }
];