/**
 * Internal URL Protocol — unified resource access for the agent.
 *
 * Inspired by oh-my-pi's internal URL system. Provides a single interface
 * to access different resource types through the file_read tool:
 *
 * - agent://<id> — subagent output
 * - memory://<key> — memory store entries
 * - skill://<name> — skill content
 * - checkpoint://<id> — checkpoint state
 *
 * This simplifies the tool interface — the agent uses file_read for everything.
 */

import { getCheckpointManager } from './checkpointManager';

// ============================================================================
// Types
// ============================================================================

export interface InternalUrlResult {
  content: string;
  mimeType?: string;
  immutable?: boolean;
}

export type InternalUrlHandler = (
  path: string,
  params: Record<string, string>,
) => Promise<InternalUrlResult>;

// ============================================================================
// URL Parser
// ============================================================================

export interface ParsedInternalUrl {
  protocol: string;
  path: string;
  params: Record<string, string>;
}

/**
 * Parse an internal URL like "agent://id/output" or "memory://key?namespace=ns"
 */
export function parseInternalUrl(url: string): ParsedInternalUrl | null {
  const match = url.match(/^([a-z]+):\/\/([^?]+)(?:\?(.+))?$/);
  if (!match) return null;

  const [, protocol, pathPart, queryPart] = match;
  const params: Record<string, string> = {};

  if (queryPart) {
    for (const param of queryPart.split('&')) {
      const [key, value] = param.split('=');
      if (key) params[decodeURIComponent(key)] = decodeURIComponent(value ?? '');
    }
  }

  return {
    protocol: protocol.toLowerCase(),
    path: pathPart,
    params,
  };
}

/**
 * Check if a string is an internal URL.
 */
export function isInternalUrl(url: string): boolean {
  return /^[a-z]+:\/\//.test(url) && !url.startsWith('http://') && !url.startsWith('https://');
}

// ============================================================================
// URL Router
// ============================================================================

export class InternalUrlRouter {
  private handlers = new Map<string, InternalUrlHandler>();

  constructor() {
    // Register built-in handlers
    this.register('checkpoint', this.handleCheckpoint.bind(this));
    this.register('memory', this.handleMemory.bind(this));
    this.register('skill', this.handleSkill.bind(this));
    this.register('agent', this.handleAgent.bind(this));
  }

  /**
   * Register a handler for a protocol.
   */
  register(protocol: string, handler: InternalUrlHandler): void {
    this.handlers.set(protocol.toLowerCase(), handler);
  }

  /**
   * Resolve an internal URL to its content.
   */
  async resolve(url: string): Promise<InternalUrlResult | null> {
    const parsed = parseInternalUrl(url);
    if (!parsed) return null;

    const handler = this.handlers.get(parsed.protocol);
    if (!handler) return null;

    try {
      return await handler(parsed.path, parsed.params);
    } catch (err) {
      return {
        content: `Error resolving ${url}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Check if a URL can be handled.
   */
  canHandle(url: string): boolean {
    const parsed = parseInternalUrl(url);
    if (!parsed) return false;
    return this.handlers.has(parsed.protocol);
  }

  /**
   * Get list of supported protocols.
   */
  getProtocols(): string[] {
    return Array.from(this.handlers.keys());
  }

  // ── Built-in Handlers ──

  private async handleCheckpoint(
    path: string,
    params: Record<string, string>,
  ): Promise<InternalUrlResult> {
    const manager = getCheckpointManager();

    if (path === 'list' || path === '') {
      const checkpoints = manager.list();
      if (checkpoints.length === 0) {
        return { content: 'No checkpoints saved.', immutable: true };
      }
      const lines = checkpoints.map((cp) => {
        const age = Math.round((Date.now() - cp.timestamp) / 1000);
        return `${cp.id} | ${cp.label} | step ${cp.stepNumber} | ${cp.messageCount} msgs | ${age}s ago`;
      });
      return { content: `Checkpoints:\n${lines.join('\n')}`, immutable: true };
    }

    // Get specific checkpoint
    const checkpoint = manager.get(path);
    if (!checkpoint) {
      return { content: `Checkpoint not found: ${path}` };
    }

    if (params.action === 'collapse') {
      const summary = manager.collapse(path);
      return { content: summary || 'Failed to collapse checkpoint', immutable: true };
    }

    // Return checkpoint summary
    return {
      content: [
        `Checkpoint: ${checkpoint.label}`,
        `ID: ${checkpoint.id}`,
        `Step: ${checkpoint.stepNumber}`,
        `Messages: ${checkpoint.messages.length}`,
        `Tokens: ${checkpoint.tokenCount}`,
        `Files read: ${checkpoint.filesRead.join(', ') || 'none'}`,
        `Files modified: ${checkpoint.filesModified.join(', ') || 'none'}`,
      ].join('\n'),
      immutable: true,
    };
  }

  private async handleMemory(
    path: string,
    params: Record<string, string>,
  ): Promise<InternalUrlResult> {
    // Memory access would integrate with the memory system
    // For now, return a placeholder
    const namespace = params.namespace || 'default';
    return {
      content: `Memory access: ${path} (namespace: ${namespace})\nNote: Memory integration pending.`,
      immutable: false,
    };
  }

  private async handleSkill(
    path: string,
    _params: Record<string, string>,
  ): Promise<InternalUrlResult> {
    // Skill access would integrate with the skill system
    return {
      content: `Skill: ${path}\nNote: Skill integration pending.`,
      immutable: true,
    };
  }

  private async handleAgent(
    path: string,
    _params: Record<string, string>,
  ): Promise<InternalUrlResult> {
    // Agent output access would integrate with the subagent system
    return {
      content: `Agent output: ${path}\nNote: Agent integration pending.`,
      immutable: true,
    };
  }
}

// ============================================================================
// Global singleton
// ============================================================================

let globalRouter: InternalUrlRouter | null = null;

export function getInternalUrlRouter(): InternalUrlRouter {
  if (!globalRouter) {
    globalRouter = new InternalUrlRouter();
  }
  return globalRouter;
}

export function resetInternalUrlRouter(): void {
  globalRouter = null;
}
