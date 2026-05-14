/**
 * Agent Card Implementation
 * Based on Google's A2A Protocol Specification
 * 
 * Agent Cards are self-descriptions that agents publish
 * to advertise their capabilities, protocols, and request types.
 */

export interface AgentCard {
  /** Unique identifier for the agent */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this agent does */
  description: string;
  /** Version of the agent */
  version: string;
  /** Capabilities this agent provides */
  capabilities: AgentCapability[];
  /** Authentication schemes supported */
  authentication: AuthenticationScheme[];
  /** API endpoints */
  endpoints: AgentEndpoint[];
  /** Metadata */
  metadata: AgentMetadata;
}

export interface AgentCapability {
  /** Capability ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>;
  /** Output schema (JSON Schema) */
  outputSchema?: Record<string, unknown>;
  /** Supported modalities */
  modalities: Modality[];
  /** Estimated duration (for long-running tasks) */
  estimatedDuration?: DurationHint;
}

export type Modality = 'text' | 'audio' | 'video' | 'image' | 'file';

export interface DurationHint {
  min: number;  // seconds
  max: number;  // seconds
  typical: number;  // seconds
}

export interface AuthenticationScheme {
  type: 'bearer' | 'api-key' | 'oauth2' | 'mutual-tls';
  description: string;
  /** For OAuth2 */
  scopes?: string[];
  /** For API key */
  headerName?: string;
}

export interface AgentEndpoint {
  type: 'task' | 'message' | 'artifact' | 'status';
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  description: string;
}

export interface AgentMetadata {
  /** Agent vendor/creator */
  vendor: string;
  /** Homepage URL */
  homepage?: string;
  /** Documentation URL */
  documentation?: string;
  /** Support contact */
  support?: string;
  /** Tags for discovery */
  tags: string[];
  /** Last updated */
  updatedAt: string;
}

/**
 * Commander Agent Card Generator
 */
export class AgentCardGenerator {
  /**
   * Generate Agent Card for Commander
   */
  static generateCommanderCard(baseUrl: string): AgentCard {
    return {
      id: 'commander-main',
      name: 'Commander',
      description: 'Multi-agent orchestration system for project management and task coordination',
      version: '2.0.0',
      capabilities: [
        {
          id: 'mission-create',
          name: 'Create Mission',
          description: 'Create a new mission with agents and tasks',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'medium', 'high'] }
            },
            required: ['title', 'description']
          },
          outputSchema: {
            type: 'object',
            properties: {
              missionId: { type: 'string' },
              status: { type: 'string' }
            }
          },
          modalities: ['text'],
          estimatedDuration: { min: 1, max: 5, typical: 2 }
        },
        {
          id: 'task-delegate',
          name: 'Delegate Task',
          description: 'Delegate a task to a specialized agent',
          inputSchema: {
            type: 'object',
            properties: {
              missionId: { type: 'string' },
              taskDescription: { type: 'string' },
              agentId: { type: 'string' }
            },
            required: ['missionId', 'taskDescription']
          },
          outputSchema: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              status: { type: 'string' }
            }
          },
          modalities: ['text'],
          estimatedDuration: { min: 1, max: 10, typical: 3 }
        },
        {
          id: 'memory-query',
          name: 'Query Memory',
          description: 'Query project memory for decisions, lessons, or context',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              query: { type: 'string' },
              type: { type: 'string', enum: ['decision', 'lesson', 'issue', 'all'] }
            },
            required: ['projectId']
          },
          outputSchema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
                timestamp: { type: 'string' }
              }
            }
          },
          modalities: ['text'],
          estimatedDuration: { min: 1, max: 3, typical: 1 }
        },
        {
          id: 'status-check',
          name: 'Check Status',
          description: 'Get the status of missions, agents, or tasks',
          inputSchema: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['mission', 'agent', 'task', 'all'] },
              id: { type: 'string' }
            }
          },
          outputSchema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              details: { type: 'object' }
            }
          },
          modalities: ['text'],
          estimatedDuration: { min: 0.5, max: 2, typical: 1 }
        }
      ],
      authentication: [
        {
          type: 'bearer',
          description: 'JWT Bearer token authentication'
        },
        {
          type: 'api-key',
          description: 'API key in X-API-Key header',
          headerName: 'X-API-Key'
        }
      ],
      endpoints: [
        {
          type: 'task',
          url: `${baseUrl}/api/task`,
          method: 'POST',
          description: 'Submit a new task for execution'
        },
        {
          type: 'message',
          url: `${baseUrl}/api/message`,
          method: 'POST',
          description: 'Send a message to an agent'
        },
        {
          type: 'status',
          url: `${baseUrl}/api/status`,
          method: 'GET',
          description: 'Get system status'
        },
        {
          type: 'artifact',
          url: `${baseUrl}/api/artifact/:id`,
          method: 'GET',
          description: 'Retrieve an artifact by ID'
        }
      ],
      metadata: {
        vendor: 'OpenClaw',
        homepage: 'https://github.com/openclaw/commander',
        documentation: 'https://docs.openclaw.ai/commander',
        support: 'https://discord.gg/clawd',
        tags: ['orchestration', 'multi-agent', 'project-management', 'task-coordination'],
        updatedAt: new Date().toISOString()
      }
    };
  }
  
  /**
   * Validate an Agent Card
   */
  static validate(card: AgentCard): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!card.id) errors.push('Missing id');
    if (!card.name) errors.push('Missing name');
    if (!card.version) errors.push('Missing version');
    if (!card.capabilities || card.capabilities.length === 0) {
      errors.push('Missing capabilities');
    }
    
    card.capabilities.forEach((cap, i) => {
      if (!cap.id) errors.push(`Capability ${i}: missing id`);
      if (!cap.name) errors.push(`Capability ${i}: missing name`);
      if (!cap.modalities || cap.modalities.length === 0) {
        errors.push(`Capability ${i}: missing modalities`);
      }
    });
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Export Agent Card as JSON
   */
  static toJSON(card: AgentCard): string {
    return JSON.stringify(card, null, 2);
  }
  
  /**
   * Parse Agent Card from JSON
   */
  static fromJSON(json: string): AgentCard {
    return JSON.parse(json) as AgentCard;
  }
}

/**
 * Agent Card Registry
 * Manages known agent cards for discovery
 */
export class AgentCardRegistry {
  private cards: Map<string, AgentCard> = new Map();
  
  /**
   * Register an agent card
   */
  register(card: AgentCard): void {
    const validation = AgentCardGenerator.validate(card);
    if (!validation.valid) {
      throw new Error(`Invalid Agent Card: ${validation.errors.join(', ')}`);
    }
    this.cards.set(card.id, card);
  }
  
  /**
   * Get an agent card by ID
   */
  get(id: string): AgentCard | undefined {
    return this.cards.get(id);
  }
  
  /**
   * Find agents by capability
   */
  findByCapability(capabilityId: string): AgentCard[] {
    return Array.from(this.cards.values()).filter(card =>
      card.capabilities.some(cap => cap.id === capabilityId)
    );
  }
  
  /**
   * Find agents by tags
   */
  findByTags(tags: string[]): AgentCard[] {
    return Array.from(this.cards.values()).filter(card =>
      card.metadata.tags.some(tag => tags.includes(tag))
    );
  }
  
  /**
   * List all registered agents
   */
  listAll(): AgentCard[] {
    return Array.from(this.cards.values());
  }
}
