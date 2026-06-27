import { z } from 'zod';

export const MissionStatus = z.enum(['PLANNED', 'RUNNING', 'BLOCKED', 'DONE']);
export const MissionPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const MissionRiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const MissionGovernanceMode = z.enum(['AUTO', 'GUARDED', 'MANUAL']);
export const ProjectMemoryKind = z.enum(['DECISION', 'ISSUE', 'LESSON', 'SUMMARY']);
export const LogLevel = z.enum(['INFO', 'SUCCESS', 'WARN', 'ERROR']);

export const projectIdParam = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/, 'Invalid project ID'),
});

export const missionIdParam = z.object({
  missionId: z.string().min(1),
});

export const agentIdParam = z.object({
  agentId: z.string().min(1),
});

export const createMissionBody = z.object({
  title: z.string().min(1, 'title is required').max(200),
  objective: z.string().max(2000).optional(),
  assignedAgentId: z.string().min(1, 'assignedAgentId is required'),
  priority: MissionPriority.default('MEDIUM'),
  riskLevel: MissionRiskLevel.optional(),
  governanceMode: MissionGovernanceMode.optional(),
});

export const updateMissionBody = z.object({
  status: MissionStatus.optional(),
  priority: MissionPriority.optional(),
  assignedAgentId: z.string().optional(),
  title: z.string().max(200).optional(),
  objective: z.string().max(2000).optional(),
  riskLevel: MissionRiskLevel.optional(),
  governanceMode: MissionGovernanceMode.optional(),
});

export const createMemoryBody = z.object({
  title: z.string().min(1, 'title is required').max(200),
  content: z.string().min(1, 'content is required').max(10000),
  kind: ProjectMemoryKind.default('SUMMARY'),
  missionId: z.string().optional(),
  agentId: z.string().optional(),
  tags: z.array(z.string().max(50)).max(8).optional(),
});

export const createLogBody = z.object({
  message: z.string().min(1, 'message is required').max(5000),
  level: LogLevel.default('INFO'),
});

export const updateAgentStateBody = z.object({
  summary: z.string().max(5000).optional(),
  preferences: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const memorySearchQuery = z.object({
  kind: ProjectMemoryKind.optional(),
  tags: z.string().optional(),
  q: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const memoryListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export const runContextQuery = z.object({
  agentId: z.string().optional(),
  missionId: z.string().optional(),
  memoryLimit: z.coerce.number().int().min(1).max(100).optional(),
  intent: z.enum(['EXECUTE', 'PLAN', 'REVIEW', 'REASON']).optional(),
  runId: z.string().optional(),
  issuedByKind: z.enum(['HUMAN', 'AGENT', 'SYSTEM']).optional(),
  issuedById: z.string().optional(),
  issuedByLabel: z.string().optional(),
});

export const a2aCreateTaskBody = z.object({
  clientId: z.string().min(1, 'clientId is required'),
  description: z.string().min(1, 'description is required').max(2000),
  input: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});

export const a2aTaskActionBody = z.object({
  agentId: z.string().optional(),
  reason: z.string().max(1000).optional(),
  artifact: z
    .object({
      name: z.string().min(1),
      mimeType: z.string().min(1),
      content: z.string().min(1),
    })
    .optional(),
  progress: z.number().min(0).max(100).optional(),
  message: z
    .object({
      role: z.enum(['user', 'agent']),
      parts: z.array(
        z.object({
          type: z.enum(['text', 'file']),
          text: z.string().optional(),
          mimeType: z.string().optional(),
          data: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

export const qualityCheckBody = z.object({
  input: z.string().max(10000).optional(),
  output: z.string().min(1, 'output is required').max(50000),
  context: z.string().max(10000).optional(),
});

export const securityScanBody = z.object({
  content: z.string().min(1, 'content is required').max(100000),
});

export const createCheckpointBody = z.object({
  missionId: z.string().min(1),
  approverId: z.string().min(1),
  type: z.enum(['GOVERNANCE', 'SECURITY', 'QUALITY']).default('GOVERNANCE'),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const approveRejectBody = z.object({
  approverId: z.string().min(1),
  reason: z.string().max(2000).optional(),
});

export const addEvidenceBody = z.object({
  type: z.enum(['LOG', 'METRIC', 'ARTIFACT', 'MANUAL']).default('MANUAL'),
  content: z.string().min(1).max(10000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const riskScoreBody = z.object({
  missionId: z.string().min(1),
  factors: z
    .array(
      z.object({
        factor: z.string().min(1),
        weight: z.number().min(0).max(1),
        score: z.number().min(0).max(1),
      }),
    )
    .optional(),
});

export const createAgentCardBody = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  url: z.string().url().optional(),
  version: z.string().default('1.0.0'),
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
      stateTransitionHistory: z.boolean().optional(),
    })
    .optional(),
  skills: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  tags: z.array(z.string()).optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
});

export const selectModeBody = z.object({
  taskType: z.string().min(1),
  complexity: z.enum(['low', 'medium', 'high']).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const confidenceActionBody = z.object({
  confidence: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const evaluateBody = z.object({
  output: z.string().min(1).max(50000),
  input: z.string().max(10000).optional(),
  criteria: z.array(z.string()).optional(),
  targetId: z.string().optional(),
});

export const gradeBody = z.object({
  trials: z
    .array(
      z.object({
        output: z.string().min(1),
        expected: z.string().optional(),
        criteria: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(100),
  k: z.number().int().min(1).max(100).optional(),
});

export const executeBody = z.object({
  task: z.string().min(1, 'task is required').max(5000),
  agentId: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  stream: z.boolean().default(false),
});

export const deliberateBody = z.object({
  goal: z.string().min(1, 'goal is required').max(5000),
  context: z.record(z.string(), z.unknown()).optional(),
  constraints: z.array(z.string()).optional(),
});

export const createPipelineBody = z.object({
  steps: z
    .array(
      z.object({
        type: z.string().min(1),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(20),
  name: z.string().max(100).optional(),
});

export const createStateMachineBody = z.object({
  type: z.string().min(1),
  taskId: z.string().min(1).optional(),
  initialData: z.record(z.string(), z.unknown()).optional(),
});

export const transitionBody = z.object({
  action: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const evaluateBatchBody = z.object({
  evaluations: z
    .array(
      z.object({
        output: z.string().min(1).max(50000),
        input: z.string().max(10000).optional(),
        targetId: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
  criteria: z.array(z.string()).optional(),
});

export const quickEvaluateBody = z.object({
  output: z.string().min(1).max(50000),
  input: z.string().max(10000).optional(),
});

export const hallucinationCheckBody = z.object({
  output: z.string().min(1, 'output is required').max(50000),
  sources: z.array(z.string().max(10000)).max(20).optional(),
});

export const assessCredibilityBody = z.object({
  source: z.string().min(1).max(500),
  content: z.string().min(1).max(50000),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const detectPoisoningBody = z.object({
  entries: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string().min(1).max(10000),
        source: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const namespaceWriteBody = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(50000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  role: z.string().min(1).max(100),
});

export const pipelineExecuteBody = z.object({
  steps: z
    .array(
      z.object({
        type: z.string().min(1),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const mcpToolBody = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const mcpConnectBody = z.object({
  url: z.string().url(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).default('sse'),
});

export const reassignBody = z.object({
  itemId: z.string().min(1),
  assignTo: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

export const pauseBody = z.object({
  runId: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

export const resumeBody = z.object({
  runId: z.string().min(1),
});

export const renderReportBody = z.object({
  projectId: z.string().min(1),
  format: z.enum(['html', 'markdown']).default('html'),
  includeCharts: z.boolean().default(true),
});

export const recordConsistencyBody = z.object({
  missionId: z.string().min(1),
  agentId: z.string().min(1),
  output: z.string().min(1).max(50000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const memoryIndexDomainBody = z.object({
  domain: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const memoryIndexEntryBody = z.object({
  content: z.string().min(1).max(50000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const selfAssessBody = z.object({
  missionId: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

// ── Security: Input validation schemas for previously unvalidated endpoints ──

// POST /api/runtime/execute
export const runtimeExecuteBody = z.object({
  agentId: z.string().min(1, 'agentId is required').max(200),
  projectId: z.string().min(1).max(200).optional(),
  missionId: z.string().min(1).max(200).optional(),
  goal: z.string().min(1, 'goal is required').max(10000),
  contextData: z.record(z.string(), z.unknown()).optional(),
  availableTools: z.array(z.string().max(200)).max(50).optional(),
  tokenBudget: z.number().int().min(1).max(1000000).optional(),
});

// POST /api/state-machine/create
export const stateMachineCreateBody = z.object({
  taskId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
  agentId: z.string().min(1).max(200).optional(),
  type: z.enum(['standard', 'saga', 'pipeline']).default('standard'),
  initialData: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/state-machine/:id/resume-from-checkpoint
export const resumeFromCheckpointBody = z.object({
  checkpointId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid checkpointId format'),
});

// POST /api/security/scan
export const securityScanEntryBody = z.object({
  id: z.string().min(1).max(200).optional(),
  content: z.string().min(1, 'content is required').max(100000),
  timestamp: z.string().optional(),
  source: z.string().max(500).optional(),
  embedding: z.array(z.number()).max(10000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// POST /mcp/discover — validated separately in mcpEndpoints.ts via inline checks
export const mcpDiscoverBody = z.object({
  url: z.string().url().optional(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  label: z.string().max(200).optional(),
}).refine(data => data.url || data.command, {
  message: 'Either url or command is required',
});
