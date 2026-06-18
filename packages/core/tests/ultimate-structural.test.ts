import { describe, it, before } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// Structural tests for untested ultimate/ modules
// These verify: module loads, exports exist, constructors work, singletons resolve
// ============================================================================

// --- Module 1: UltimateOrchestrator (754 lines, barrel-exported) ---
import {
  UltimateOrchestrator,
  SubAgentExecutor,
  resetArtifactSystem,
  getArtifactSystem,
} from '../src/ultimate/index';
import type { UltimateOrchestratorConfig } from '../src/ultimate/index';

// --- Module 3: ReflexionTopologicalOptimizer (744 lines, internal) ---
import { ReflexionTopologicalOptimizer } from '../src/ultimate/topologyOptimizer';
import type { OptimizationResult } from '../src/ultimate/topologyOptimizer';

// --- Module 4: RuntimeWorkflowAdapter (536 lines, internal) ---
import {
  RuntimeWorkflowAdapter,
  getRuntimeWorkflowAdapter,
  resetRuntimeWorkflowAdapter,
} from '../src/ultimate/runtimeWorkflowAdapter';
import type {
  TaskState,
  WorkflowDecision,
  AdaptiveExecutionResult,
} from '../src/ultimate/runtimeWorkflowAdapter';

// --- Module 5: deliberateWithLLM (not barrel-exported, used internally) ---
import { deliberateWithLLM } from '../src/ultimate/deliberation';

// --- Dependencies needed for construction ---
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { TELOSOrchestrator } from '../src/telos/telosOrchestrator';
import { ModelRouter, resetModelRouter } from '../src/runtime/modelRouter';

// ============================================================================
// Module-level structural checks
// ============================================================================

describe('ultimate/ modules — structural integrity', () => {
  // --------------------------------------------------------------------------
  // Module 1: UltimateOrchestrator
  // --------------------------------------------------------------------------
  describe('UltimateOrchestrator', () => {
    it('is exported from barrel', () => {
      assert.strictEqual(typeof UltimateOrchestrator, 'function');
    });

    it('can be constructed with AgentRuntime + TELOSOrchestrator', () => {
      resetModelRouter();
      const router = new ModelRouter();
      const runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
      const telos = new TELOSOrchestrator(runtime);
      const orchestrator = new UltimateOrchestrator(telos, runtime);
      assert.ok(orchestrator instanceof UltimateOrchestrator);
    });

    it('can be constructed with partial config override', () => {
      resetModelRouter();
      const router = new ModelRouter();
      const runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
      const telos = new TELOSOrchestrator(runtime);
      const config: Partial<UltimateOrchestratorConfig> = {
        maxRecursiveDepth: 5,
        maxParallelSubAgents: 3,
      };
      const orchestrator = new UltimateOrchestrator(telos, runtime, config);
      assert.ok(orchestrator instanceof UltimateOrchestrator);
    });

    it('has expected method signatures', () => {
      resetModelRouter();
      const router = new ModelRouter();
      const runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
      const telos = new TELOSOrchestrator(runtime);
      const orchestrator = new UltimateOrchestrator(telos, runtime);
      // execute() must be async and accept goal
      assert.strictEqual(typeof orchestrator.execute, 'function');
      assert.strictEqual(orchestrator.execute.constructor.name, 'AsyncFunction');
    });
  });

  // --------------------------------------------------------------------------
  // Module 2: SubAgentExecutor
  // --------------------------------------------------------------------------
  describe('SubAgentExecutor', () => {
    it('is exported from barrel', () => {
      assert.strictEqual(typeof SubAgentExecutor, 'function');
    });

    it('can be constructed with AgentRuntime', () => {
      resetModelRouter();
      const router = new ModelRouter();
      const runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
      const executor = new SubAgentExecutor(runtime);
      assert.ok(executor instanceof SubAgentExecutor);
    });

    it('can be constructed with custom maxParallel', () => {
      resetModelRouter();
      const router = new ModelRouter();
      const runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
      const executor = new SubAgentExecutor(runtime, undefined, 5);
      assert.ok(executor instanceof SubAgentExecutor);
    });

    it('has expected method signatures', () => {
      resetModelRouter();
      const router = new ModelRouter();
      const runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 5000 }, router);
      const executor = new SubAgentExecutor(runtime);
      assert.strictEqual(typeof executor.setTeam, 'function');
      assert.strictEqual(typeof executor.executeNode, 'function');
    });
  });

  // --------------------------------------------------------------------------
  // Module 3: ReflexionTopologicalOptimizer
  // --------------------------------------------------------------------------
  describe('ReflexionTopologicalOptimizer', () => {
    it('can be imported and constructed (zero-arg constructor)', () => {
      const optimizer = new ReflexionTopologicalOptimizer();
      assert.ok(optimizer instanceof ReflexionTopologicalOptimizer);
    });

    it('has expected method signatures', () => {
      const optimizer = new ReflexionTopologicalOptimizer();
      assert.strictEqual(typeof optimizer.optimize, 'function');
      assert.strictEqual(optimizer.optimize.constructor.name, 'AsyncFunction');
    });
  });

  // --------------------------------------------------------------------------
  // Module 4: RuntimeWorkflowAdapter
  // --------------------------------------------------------------------------
  describe('RuntimeWorkflowAdapter', () => {
    it('can be imported and constructed (zero-arg constructor)', () => {
      const adapter = new RuntimeWorkflowAdapter();
      assert.ok(adapter instanceof RuntimeWorkflowAdapter);
    });

    it('singleton getter returns instance', () => {
      const instance = getRuntimeWorkflowAdapter();
      assert.ok(instance instanceof RuntimeWorkflowAdapter);
    });

    it('has expected method signatures', () => {
      const adapter = new RuntimeWorkflowAdapter();
      assert.strictEqual(typeof adapter.decideNextWorkflow, 'function');
      assert.strictEqual(typeof adapter.getExecutionSummary, 'function');
      assert.strictEqual(typeof adapter.getMetrics, 'function');
      assert.strictEqual(typeof adapter.reset, 'function');
    });

    it('resetRuntimeWorkflowAdapter clears singleton', () => {
      const before = getRuntimeWorkflowAdapter();
      resetRuntimeWorkflowAdapter();
      const after = getRuntimeWorkflowAdapter();
      assert.ok(after instanceof RuntimeWorkflowAdapter);
      // Singleton was reset — new instance created on next get
      assert.notStrictEqual(before, after);
    });
  });

  // --------------------------------------------------------------------------
  // Module 5: deliberateWithLLM
  // --------------------------------------------------------------------------
  describe('deliberateWithLLM', () => {
    it('can be imported directly (not in barrel)', () => {
      assert.strictEqual(typeof deliberateWithLLM, 'function');
    });

    it('is an async function', () => {
      assert.strictEqual(deliberateWithLLM.constructor.name, 'AsyncFunction');
    });
  });

  // --------------------------------------------------------------------------
  // Module 6: resetArtifactSystem (barrel-exported, was untested)
  // --------------------------------------------------------------------------
  describe('resetArtifactSystem', () => {
    it('is exported from barrel and callable', () => {
      assert.strictEqual(typeof resetArtifactSystem, 'function');
      assert.strictEqual(typeof getArtifactSystem, 'function');
      resetArtifactSystem();
    });
  });
});
