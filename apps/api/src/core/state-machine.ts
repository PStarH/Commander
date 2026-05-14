/**
 * Commander State Machine - LangGraph-inspired State Management
 * 
 * This module provides production-ready state machine infrastructure for agent orchestration.
 * Inspired by LangGraph's approach to explicit state management and checkpoint recovery.
 */

// ============================================================================
// Core State Interfaces
// ============================================================================

export interface AgentState {
  id: string;
  currentStep: string;
  context: Record<string, any>;
  memory: EpisodeMemory;
  governanceMode: 'SINGLE' | 'GUARDED' | 'MANUAL';
  metadata: StateMetadata;
}

export interface EpisodeMemory {
  taskId: string;
  messages: MemoryMessage[];
  decisions: Decision[];
  createdAt: number;
  lastUpdated: number;
}

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'system' | 'agent';
  content: string;
  agentName?: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface Decision {
  id: string;
  type: 'task_delegation' | 'tool_call' | 'governance_approval' | 'conflict_resolution';
  agentName: string;
  action: string;
  reasoning: string;
  timestamp: number;
  outcome?: 'success' | 'failure' | 'pending';
}

export interface StateMetadata {
  missionId: string;
  parentStateId?: string;
  version: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// State Transition System
// ============================================================================

export interface StateTransition {
  id: string;
  from: string;
  to: string;
  condition?: (state: AgentState) => boolean | Promise<boolean>;
  onEnter?: (state: AgentState) => AgentState | Promise<AgentState>;
  onExit?: (state: AgentState) => AgentState | Promise<AgentState>;
  metadata?: {
    description?: string;
    governanceRequired?: boolean;
    riskLevel?: 'low' | 'medium' | 'high';
  };
}

export interface TransitionResult {
  success: boolean;
  newState?: AgentState;
  error?: string;
  checkpoint?: Checkpoint;
}

// ============================================================================
// Checkpoint System (Crash Recovery)
// ============================================================================

export interface Checkpoint {
  id: string;
  stateId: string;
  missionId: string;
  timestamp: number;
  state: AgentState;
  hash: string; // Tamper-proof checksum
  type: 'auto' | 'manual' | 'pre_transition' | 'post_transition' | 'error';
  metadata: {
    triggeredBy: 'scheduler' | 'user' | 'system' | 'error_handler';
    transitionId?: string;
    errorMessage?: string;
  };
}

export interface CheckpointManager {
  createCheckpoint(state: AgentState, type: Checkpoint['type']): Promise<Checkpoint>;
  restoreCheckpoint(checkpointId: string): Promise<AgentState>;
  listCheckpoints(missionId: string, limit?: number): Promise<Checkpoint[]>;
  deleteCheckpoint(checkpointId: string): Promise<boolean>;
  getLatestCheckpoint(missionId: string): Promise<Checkpoint | null>;
}

// ============================================================================
// Governance Checkpoint System
// ============================================================================

export interface GovernanceCheckpoint {
  mode: 'SINGLE' | 'GUARDED' | 'MANUAL';
  riskScore: number; // 0-100
  requiredApprovals: string[]; // user_ids
  timeout: number; // ms
  fallbackAction: 'abort' | 'proceed_with_caution' | 'escalate';
  approvalCriteria?: (state: AgentState) => boolean | Promise<boolean>;
}

export interface GovernanceApproval {
  id: string;
  checkpointId: string;
  userId: string;
  decision: 'approved' | 'rejected' | 'escalated';
  timestamp: number;
  comment?: string;
}

// ============================================================================
// State Machine Configuration
// ============================================================================

export interface StateMachineConfig {
  initialState: string;
  states: StateDefinition[];
  transitions: StateTransition[];
  governanceCheckpoints: GovernanceCheckpoint[];
  checkpointInterval?: number; // Auto-checkpoint interval in ms
  maxHistorySize?: number; // Maximum state history to retain
  enableAutoRecovery?: boolean; // Auto-restore from latest checkpoint on crash
}

export interface StateDefinition {
  name: string;
  type: 'start' | 'intermediate' | 'end' | 'error';
  onEnter?: (state: AgentState) => AgentState | Promise<AgentState>;
  onExit?: (state: AgentState) => AgentState | Promise<AgentState>;
  timeout?: number; // State timeout in ms
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
    exponentialBackoff: boolean;
  };
}

// ============================================================================
// State Machine Implementation
// ============================================================================

export class StateMachine {
  private config: StateMachineConfig;
  private currentState: AgentState;
  private stateHistory: AgentState[] = [];
  private checkpointManager: CheckpointManager;
  private pendingGovernanceApprovals: Map<string, GovernanceCheckpoint> = new Map();

  constructor(
    config: StateMachineConfig,
    checkpointManager: CheckpointManager
  ) {
    this.config = config;
    this.checkpointManager = checkpointManager;
    this.currentState = this.createInitialState();
  }

  private createInitialState(): AgentState {
    return {
      id: this.generateId(),
      currentStep: this.config.initialState,
      context: {},
      memory: {
        taskId: this.generateId(),
        messages: [],
        decisions: [],
        createdAt: Date.now(),
        lastUpdated: Date.now()
      },
      governanceMode: 'SINGLE',
      metadata: {
        missionId: this.generateId(),
        version: 1,
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    };
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Transition to a new state following the defined graph edges
   */
  async transition(targetState: string): Promise<TransitionResult> {
    const transition = this.findTransition(this.currentState.currentStep, targetState);
    
    if (!transition) {
      return {
        success: false,
        error: `No valid transition from ${this.currentState.currentStep} to ${targetState}`
      };
    }

    // Check governance requirements
    if (transition.metadata?.governanceRequired || 
        this.currentState.governanceMode === 'MANUAL') {
      const governanceResult = await this.handleGovernanceCheckpoint(transition);
      if (!governanceResult.success) {
        return governanceResult;
      }
    }

    // Check transition condition
    if (transition.condition && !(await transition.condition(this.currentState))) {
      return {
        success: false,
        error: `Transition condition not satisfied for ${transition.id}`
      };
    }

    // Create pre-transition checkpoint
    const checkpoint = await this.checkpointManager.createCheckpoint(
      this.currentState,
      'pre_transition'
    );

    try {
      // Execute transition lifecycle
      let newState = { ...this.currentState };
      
      // Execute onExit
      if (transition.onExit) {
        newState = await transition.onExit(newState);
      }

      // Update state
      newState.currentStep = targetState;
      newState.metadata.updatedAt = Date.now();
      newState.metadata.version++;

      // Execute onEnter
      if (transition.onEnter) {
        newState = await transition.onEnter(newState);
      }

      // Save to history
      this.stateHistory.push(this.currentState);
      if (this.config.maxHistorySize) {
        this.stateHistory = this.stateHistory.slice(-this.config.maxHistorySize);
      }

      // Update current state
      this.currentState = newState;

      // Create post-transition checkpoint
      await this.checkpointManager.createCheckpoint(newState, 'post_transition');

      return {
        success: true,
        newState,
        checkpoint
      };
    } catch (error) {
      // Restore from checkpoint on error
      if (this.config.enableAutoRecovery) {
        await this.checkpointManager.restoreCheckpoint(checkpoint.id);
      }
      
      return {
        success: false,
        error: `Transition failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        checkpoint
      };
    }
  }

  private findTransition(from: string, to: string): StateTransition | undefined {
    return this.config.transitions.find(t => t.from === from && t.to === to);
  }

  private async handleGovernanceCheckpoint(transition: StateTransition): Promise<TransitionResult> {
    const governanceCheckpoint: GovernanceCheckpoint = {
      mode: this.currentState.governanceMode,
      riskScore: this.calculateRiskScore(transition),
      requiredApprovals: [],
      timeout: 30000, // 30 seconds default
      fallbackAction: 'abort'
    };

    // In MANUAL mode, always require approval
    if (this.currentState.governanceMode === 'MANUAL') {
      this.pendingGovernanceApprovals.set(transition.id, governanceCheckpoint);
      
      // In a real implementation, this would notify the user and wait for approval
      // For now, we'll return a pending status
      return {
        success: false,
        error: 'Governance approval required in MANUAL mode'
      };
    }

    // In GUARDED mode, check risk score
    if (this.currentState.governanceMode === 'GUARDED' && governanceCheckpoint.riskScore > 70) {
      this.pendingGovernanceApprovals.set(transition.id, governanceCheckpoint);
      return {
        success: false,
        error: `Risk score ${governanceCheckpoint.riskScore} exceeds threshold, approval required`
      };
    }

    return { success: true };
  }

  private calculateRiskScore(transition: StateTransition): number {
    const riskLevels = { low: 20, medium: 50, high: 80 };
    return riskLevels[transition.metadata?.riskLevel || 'low'];
  }

  /**
   * Get current state
   */
  getCurrentState(): AgentState {
    return this.currentState;
  }

  /**
   * Get state history
   */
  getStateHistory(): AgentState[] {
    return [...this.stateHistory];
  }

  /**
   * Restore from a checkpoint
   */
  async restoreFromCheckpoint(checkpointId: string): Promise<void> {
    this.currentState = await this.checkpointManager.restoreCheckpoint(checkpointId);
  }

  /**
   * Update state context
   */
  updateContext(key: string, value: any): void {
    this.currentState.context[key] = value;
    this.currentState.metadata.updatedAt = Date.now();
  }

  /**
   * Add message to episode memory
   */
  addMessage(message: Omit<MemoryMessage, 'timestamp'>): void {
    this.currentState.memory.messages.push({
      ...message,
      timestamp: Date.now()
    });
    this.currentState.memory.lastUpdated = Date.now();
  }

  /**
   * Add decision to episode memory
   */
  addDecision(decision: Omit<Decision, 'id' | 'timestamp'>): void {
    this.currentState.memory.decisions.push({
      ...decision,
      id: this.generateId(),
      timestamp: Date.now()
    });
    this.currentState.memory.lastUpdated = Date.now();
  }
}

// ============================================================================
// SQLite-based Checkpoint Manager Implementation
// ============================================================================

import { createHash } from 'crypto';

export class SQLiteCheckpointManager implements CheckpointManager {
  private db: any; // Would be properly typed with better-sqlite3
  private checkpointsDir: string;

  constructor(db: any, checkpointsDir: string = './checkpoints') {
    this.db = db;
    this.checkpointsDir = checkpointsDir;
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        state_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        type TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        transition_id TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mission_id ON checkpoints(mission_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON checkpoints(timestamp);
    `);
  }

  async createCheckpoint(
    state: AgentState, 
    type: Checkpoint['type']
  ): Promise<Checkpoint> {
    const id = this.generateId();
    const timestamp = Date.now();
    const stateJson = JSON.stringify(state);
    const hash = createHash('sha256').update(stateJson).digest('hex');

    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (id, state_id, mission_id, timestamp, state_json, hash, type, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      state.id,
      state.metadata.missionId,
      timestamp,
      stateJson,
      hash,
      type,
      type === 'manual' ? 'user' : 'system'
    );

    return {
      id,
      stateId: state.id,
      missionId: state.metadata.missionId,
      timestamp,
      state,
      hash,
      type,
      metadata: {
        triggeredBy: type === 'manual' ? 'user' : 'system'
      }
    };
  }

  async restoreCheckpoint(checkpointId: string): Promise<AgentState> {
    const stmt = this.db.prepare(`
      SELECT state_json, hash FROM checkpoints WHERE id = ?
    `);
    
    const row = stmt.get(checkpointId);
    if (!row) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    // Verify integrity
    const computedHash = createHash('sha256').update(row.state_json).digest('hex');
    if (computedHash !== row.hash) {
      throw new Error(`Checkpoint ${checkpointId} integrity check failed`);
    }

    return JSON.parse(row.state_json);
  }

  async listCheckpoints(missionId: string, limit: number = 10): Promise<Checkpoint[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints 
      WHERE mission_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    
    const rows = stmt.all(missionId, limit);
    return rows.map(this.rowToCheckpoint);
  }

  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM checkpoints WHERE id = ?');
    const result = stmt.run(checkpointId);
    return result.changes > 0;
  }

  async getLatestCheckpoint(missionId: string): Promise<Checkpoint | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints 
      WHERE mission_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    
    const row = stmt.get(missionId);
    return row ? this.rowToCheckpoint(row) : null;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private rowToCheckpoint(row: any): Checkpoint {
    return {
      id: row.id,
      stateId: row.state_id,
      missionId: row.mission_id,
      timestamp: row.timestamp,
      state: JSON.parse(row.state_json),
      hash: row.hash,
      type: row.type,
      metadata: {
        triggeredBy: row.triggered_by,
        transitionId: row.transition_id,
        errorMessage: row.error_message
      }
    };
  }
}

// ============================================================================
// Export Factory Function
// ============================================================================

export function createStateMachine(
  config: StateMachineConfig,
  db: any
): StateMachine {
  const checkpointManager = new SQLiteCheckpointManager(db);
  return new StateMachine(config, checkpointManager);
}
