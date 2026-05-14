/**
 * State Machine API Endpoints
 * REST API for managing agent state machines
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { 
  StateMachine, 
  StateMachineFactory, 
  AgentState,
  GovernanceCheckpoint 
} from './stateMachine';

const router: express.Router = express.Router();

// In-memory state machine instances (for demo; production should use proper storage)
const stateMachines: Map<string, StateMachine> = new Map();

/**
 * POST /api/state-machine/create
 * Create a new state machine for a task
 */
router.post('/create', (req, res) => {
  try {
    const { taskId, projectId, agentId, type = 'standard' } = req.body;

    if (!taskId || !projectId || !agentId) {
      return res.status(400).json({
        error: 'Missing required fields: taskId, projectId, agentId'
      });
    }

    const sm = StateMachineFactory.create(type as 'standard' | 'research');
    const state = sm.initialize(taskId, projectId, agentId);
    
    stateMachines.set(taskId, sm);

    res.json({
      success: true,
      taskId,
      state: {
        currentStep: state.currentStep,
        governanceMode: state.governanceMode,
        metadata: state.metadata,
      }
    });
  } catch (error) {
    console.error('Error creating state machine:', error);
    res.status(500).json({ error: 'Failed to create state machine' });
  }
});

/**
 * GET /api/state-machine/:taskId
 * Get current state of a state machine
 */
router.get('/:taskId', (req, res) => {
  try {
    const { taskId } = req.params;
    const sm = stateMachines.get(taskId);

    if (!sm) {
      return res.status(404).json({ error: 'State machine not found' });
    }

    const state = sm.getState();
    res.json({
      success: true,
      state: state ? {
        currentStep: state.currentStep,
        governanceMode: state.governanceMode,
        memory: {
          taskId: state.memory.taskId,
          projectId: state.memory.projectId,
          historyCount: state.memory.history.length,
        },
        metadata: state.metadata,
      } : null,
      availableTransitions: sm.getAvailableTransitions().map(t => ({
        id: t.id,
        to: t.to,
        governanceRequired: t.governanceRequired,
      })),
      isTerminal: sm.isTerminal(),
    });
  } catch (error) {
    console.error('Error getting state:', error);
    res.status(500).json({ error: 'Failed to get state' });
  }
});

/**
 * POST /api/state-machine/:taskId/transition
 * Execute a state transition
 */
router.post('/:taskId/transition', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { toState, context } = req.body;

    const sm = stateMachines.get(taskId);
    if (!sm) {
      return res.status(404).json({ error: 'State machine not found' });
    }

    if (!toState) {
      return res.status(400).json({ error: 'Missing required field: toState' });
    }

    const result = await sm.transition(toState, context);

    if (result.success) {
      res.json({
        success: true,
        state: {
          currentStep: result.state!.currentStep,
          governanceMode: result.state!.governanceMode,
          metadata: result.state!.metadata,
        }
      });
    } else {
      // Check if it's a governance pending
      if (result.error?.includes('Governance checkpoint pending')) {
        const pendingCheckpoints = sm.getPendingCheckpoints();
        res.json({
          success: false,
          pendingApproval: true,
          checkpoint: pendingCheckpoints.length > 0 ? {
            id: pendingCheckpoints[0].id,
            mode: pendingCheckpoints[0].mode,
            riskScore: pendingCheckpoints[0].riskScore,
          } : null,
          error: result.error
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error
        });
      }
    }
  } catch (error) {
    console.error('Error executing transition:', error);
    res.status(500).json({ error: 'Failed to execute transition' });
  }
});

/**
 * POST /api/state-machine/:taskId/approve
 * Approve a governance checkpoint
 */
router.post('/:taskId/approve', (req, res) => {
  try {
    const { taskId } = req.params;
    const { checkpointId, userId, comment } = req.body;

    const sm = stateMachines.get(taskId);
    if (!sm) {
      return res.status(404).json({ error: 'State machine not found' });
    }

    if (!checkpointId || !userId) {
      return res.status(400).json({ error: 'Missing required fields: checkpointId, userId' });
    }

    const approved = sm.approveCheckpoint(checkpointId, userId, comment);
    res.json({
      success: approved,
      message: approved ? 'Checkpoint approved' : 'Checkpoint not found or already resolved'
    });
  } catch (error) {
    console.error('Error approving checkpoint:', error);
    res.status(500).json({ error: 'Failed to approve checkpoint' });
  }
});

/**
 * POST /api/state-machine/:taskId/reject
 * Reject a governance checkpoint
 */
router.post('/:taskId/reject', (req, res) => {
  try {
    const { taskId } = req.params;
    const { checkpointId, userId, comment } = req.body;

    const sm = stateMachines.get(taskId);
    if (!sm) {
      return res.status(404).json({ error: 'State machine not found' });
    }

    if (!checkpointId || !userId) {
      return res.status(400).json({ error: 'Missing required fields: checkpointId, userId' });
    }

    const rejected = sm.rejectCheckpoint(checkpointId, userId, comment);
    res.json({
      success: rejected,
      message: rejected ? 'Checkpoint rejected' : 'Checkpoint not found or already resolved'
    });
  } catch (error) {
    console.error('Error rejecting checkpoint:', error);
    res.status(500).json({ error: 'Failed to reject checkpoint' });
  }
});

/**
 * GET /api/state-machine/:taskId/memory
 * Get memory entries for a state machine
 */
router.get('/:taskId/memory', (req, res) => {
  try {
    const { taskId } = req.params;
    const { type } = req.query;

    const sm = stateMachines.get(taskId);
    if (!sm) {
      return res.status(404).json({ error: 'State machine not found' });
    }

    const state = sm.getState();
    if (!state) {
      return res.status(404).json({ error: 'No active state' });
    }

    let entries = state.memory.history;
    if (type && typeof type === 'string') {
      entries = entries.filter(e => e.type === type);
    }

    res.json({
      success: true,
      taskId,
      memory: {
        projectId: state.memory.projectId,
        agentId: state.memory.agentId,
        summary: state.memory.summary,
        entries: entries.map(e => ({
          timestamp: e.timestamp,
          type: e.type,
          content: e.content,
        })),
      }
    });
  } catch (error) {
    console.error('Error getting memory:', error);
    res.status(500).json({ error: 'Failed to get memory' });
  }
});

/**
 * POST /api/state-machine/:taskId/memory
 * Add a memory entry
 */
router.post('/:taskId/memory', (req, res) => {
  try {
    const { taskId } = req.params;
    const { type, content, metadata } = req.body;

    const sm = stateMachines.get(taskId);
    if (!sm) {
      return res.status(404).json({ error: 'State machine not found' });
    }

    if (!type || !content) {
      return res.status(400).json({ error: 'Missing required fields: type, content' });
    }

    sm.addMemoryEntry(type, content, metadata);

    res.json({
      success: true,
      message: 'Memory entry added'
    });
  } catch (error) {
    console.error('Error adding memory:', error);
    res.status(500).json({ error: 'Failed to add memory' });
  }
});

/**
 * POST /api/state-machine/:taskId/resume
 * Resume from a checkpoint
 */
router.post('/:taskId/resume', (req, res) => {
  try {
    const { taskId } = req.params;
    const { checkpointId } = req.body;

    if (!checkpointId) {
      return res.status(400).json({ error: 'Missing required field: checkpointId' });
    }

    // Create new state machine and resume
    const sm = StateMachineFactory.create('standard');
    const state = sm.resumeFromCheckpoint(checkpointId);

    if (!state) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    stateMachines.set(taskId, sm);

    res.json({
      success: true,
      taskId,
      state: {
        currentStep: state.currentStep,
        governanceMode: state.governanceMode,
        metadata: state.metadata,
      }
    });
  } catch (error) {
    console.error('Error resuming from checkpoint:', error);
    res.status(500).json({ error: 'Failed to resume from checkpoint' });
  }
});

/**
 * GET /api/state-machine/types
 * Get available state machine types
 */
router.get('/types', (req, res) => {
  res.json({
    success: true,
    types: StateMachineFactory.getAvailableTypes()
  });
});

/**
 * GET /api/state-machine/:taskId/summary
 * Get state machine summary
 */
router.get('/:taskId/summary', (req, res) => {
  try {
    const { taskId } = req.params;
    const sm = stateMachines.get(taskId);

    if (!sm) {
      return res.status(404).json({ error: 'State machine not found' });
    }

    res.json({
      success: true,
      summary: sm.generateSummary()
    });
  } catch (error) {
    console.error('Error getting summary:', error);
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

export default router;
