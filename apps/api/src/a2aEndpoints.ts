/**
 * A2A HTTP Endpoints
 * REST API for Agent-to-Agent communication
 * Based on Google's A2A Protocol Specification
 */

import express, { Request, Response, Router } from 'express';
import { AgentCardGenerator, AgentCardRegistry } from './agentCard';
import { TaskManager, ArtifactManager, Task } from './a2aTask';

export interface A2AServerConfig {
  port: number;
  baseUrl: string;
}

export function createA2ARouter(
  taskManager: TaskManager,
  artifactManager: ArtifactManager,
  cardRegistry: AgentCardRegistry
): Router {
  const router = express.Router();
  router.use(express.json());

  /**
   * GET /.well-known/agent-card
   * Return the Agent Card for this agent
   */
  router.get('/.well-known/agent-card', (req: Request, res: Response) => {
    const baseUrl = req.protocol + '://' + req.get('host');
    const card = AgentCardGenerator.generateCommanderCard(baseUrl);
    res.json(card);
  });

  /**
   * GET /agent-cards
   * List all registered agents
   */
  router.get('/agent-cards', (req: Request, res: Response) => {
    const { tag, capability } = req.query;
    
    let cards;
    if (tag) {
      cards = cardRegistry.findByTags([tag as string]);
    } else if (capability) {
      cards = cardRegistry.findByCapability(capability as string);
    } else {
      cards = cardRegistry.listAll();
    }
    
    res.json({ cards, count: cards.length });
  });

  /**
   * GET /agent-cards/:id
   * Get a specific agent card
   */
  router.get('/agent-cards/:id', (req: Request, res: Response) => {
    const card = cardRegistry.get(req.params.id);
    if (!card) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(card);
  });

  /**
   * POST /tasks
   * Create a new task
   */
  router.post('/tasks', (req: Request, res: Response) => {
    const { clientId, description, input, priority } = req.body;
    
    if (!clientId || !description) {
      return res.status(400).json({ 
        error: 'Missing required fields: clientId, description' 
      });
    }
    
    const task = taskManager.create(
      clientId,
      description,
      input || {},
      priority || 'medium'
    );
    
    res.status(201).json(task);
  });

  /**
   * GET /tasks/:id
   * Get task status
   */
  router.get('/tasks/:id', (req: Request, res: Response) => {
    const task = taskManager.get(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
  });

  /**
   * POST /tasks/:id/start
   * Start a task
   */
  router.post('/tasks/:id/start', (req: Request, res: Response) => {
    const { agentId } = req.body;
    
    if (!agentId) {
      return res.status(400).json({ error: 'Missing agentId' });
    }
    
    try {
      const task = taskManager.start(req.params.id, agentId);
      res.json(task);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /tasks/:id/pause
   * Pause a running task
   */
  router.post('/tasks/:id/pause', (req: Request, res: Response) => {
    try {
      const task = taskManager.pause(req.params.id);
      res.json(task);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /tasks/:id/resume
   * Resume a paused task
   */
  router.post('/tasks/:id/resume', (req: Request, res: Response) => {
    try {
      const task = taskManager.resume(req.params.id);
      res.json(task);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /tasks/:id/cancel
   * Cancel a task
   */
  router.post('/tasks/:id/cancel', (req: Request, res: Response) => {
    try {
      const task = taskManager.cancel(req.params.id);
      res.json(task);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /tasks/:id/complete
   * Complete a task with an artifact
   */
  router.post('/tasks/:id/complete', (req: Request, res: Response) => {
    const { contentType, content, metadata } = req.body;
    
    if (!contentType || content === undefined) {
      return res.status(400).json({ 
        error: 'Missing required fields: contentType, content' 
      });
    }
    
    try {
      const artifact = artifactManager.create(
        req.params.id,
        contentType,
        content,
        metadata
      );
      
      const task = taskManager.complete(req.params.id, artifact);
      res.json(task);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /tasks/:id/fail
   * Mark a task as failed
   */
  router.post('/tasks/:id/fail', (req: Request, res: Response) => {
    const { error } = req.body;
    
    if (!error) {
      return res.status(400).json({ error: 'Missing error message' });
    }
    
    try {
      const task = taskManager.fail(req.params.id, error);
      res.json(task);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /tasks/:id/progress
   * Update task progress
   */
  router.post('/tasks/:id/progress', (req: Request, res: Response) => {
    const { progress } = req.body;
    
    if (typeof progress !== 'number') {
      return res.status(400).json({ error: 'Progress must be a number' });
    }
    
    try {
      const task = taskManager.updateProgress(req.params.id, progress);
      res.json(task);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /tasks/:id/messages
   * Send a message to a task
   */
  router.post('/tasks/:id/messages', (req: Request, res: Response) => {
    const { sender, type, content, metadata } = req.body;
    
    if (!sender || !type || !content) {
      return res.status(400).json({ 
        error: 'Missing required fields: sender, type, content' 
      });
    }
    
    try {
      const message = taskManager.addMessage(
        req.params.id,
        sender,
        type,
        content,
        metadata
      );
      res.status(201).json(message);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * GET /tasks
   * List tasks with filters
   */
  router.get('/tasks', (req: Request, res: Response) => {
    const { status, clientId, agentId } = req.query;
    
    let tasks: Task[];
    
    if (status) {
      tasks = taskManager.listByStatus(status as any);
    } else if (clientId) {
      tasks = taskManager.listByClient(clientId as string);
    } else if (agentId) {
      tasks = taskManager.listByAgent(agentId as string);
    } else {
      tasks = Array.from((taskManager as any).tasks.values());
    }
    
    res.json({ tasks, count: tasks.length });
  });

  /**
   * GET /artifacts/:id
   * Get an artifact by ID
   */
  router.get('/artifacts/:id', (req: Request, res: Response) => {
    const artifact = artifactManager.get(req.params.id);
    
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    
    res.json(artifact);
  });

  /**
   * GET /artifacts/task/:taskId
   * Get artifacts for a task
   */
  router.get('/artifacts/task/:taskId', (req: Request, res: Response) => {
    const artifacts = artifactManager.getByTask(req.params.taskId);
    res.json({ artifacts, count: artifacts.length });
  });

  return router;
}

/**
 * Start A2A Server
 */
export function startA2AServer(config: A2AServerConfig) {
  const app = express();
  
  const taskManager = new TaskManager();
  const artifactManager = new ArtifactManager();
  const cardRegistry = new AgentCardRegistry();
  
  // Register self
  const selfCard = AgentCardGenerator.generateCommanderCard(
    `http://localhost:${config.port}`
  );
  cardRegistry.register(selfCard);
  
  // Mount A2A routes
  app.use('/a2a', createA2ARouter(taskManager, artifactManager, cardRegistry));
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0.0' });
  });
  
  return new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.log(`A2A Server running on http://localhost:${config.port}`);
      console.log(`Agent Card: http://localhost:${config.port}/a2a/.well-known/agent-card`);
      resolve();
    });
  });
}
