#!/usr/bin/env npx tsx
/**
 * Commander CLI — Multi-Agent Orchestration System
 * Usage: npx @commander/core "your task"
 *        npx @commander/core --company "scheduled task"
 */
import { CommanderAgentLoop } from './packages/core/src/agentLoop';
import { deliberate } from './packages/core/src/ultimate/deliberation';
import { classifyEffortLevel, getEffortRules } from './packages/core/src/ultimate/effortScaler';

const task = process.argv[2] || 'What is the capital of France?';
const isCompany = process.argv.includes('--company');

async function main() {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║        Commander — Multi-Agent System    ║
  ║  70% on GAIA · Dynamic Topology · 13 Tools║
  ╚══════════════════════════════════════════╝
  `);

  if (isCompany) {
    const loop = new CommanderAgentLoop({
      tools: ['web_search', 'web_fetch', 'file_read', 'file_write', 'file_edit',
              'file_search', 'file_list', 'python_execute', 'shell_execute',
              'memory_store', 'memory_recall', 'memory_list', 'git'],
    });
    loop.addTask(task);
    await loop.start();
    return;
  }

  // Show deliberation
  const plan = deliberate(task);
  const effort = classifyEffortLevel(task);
  const rules = getEffortRules(effort);

  console.log(`  Task: "${task.slice(0, 60)}..."`);
  console.log(`  Type: ${plan.taskType}`);
  console.log(`  Effort: ${effort} (${rules.minSubAgents}-${rules.maxSubAgents} agents)`);
  console.log(`  Topology: ${plan.recommendedTopology}`);
  console.log(`  Confidence: ${(plan.confidence * 100).toFixed(0)}%`);
  console.log(`  Requires tools: ${plan.requiresExternalInfo}`);
  console.log(`  Estimated tokens: ${plan.estimatedTokens}`);
  console.log();
  console.log(`  For full execution: npx @commander/core run --task "${task}"`);
}

main().catch(console.error);
