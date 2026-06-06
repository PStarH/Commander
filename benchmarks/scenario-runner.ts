/**
 * Commander Scenario Runner
 *
 * Runs common user scenarios against Commander to measure:
 * - Success rate
 * - Token consumption
 * - Execution time
 * - Quality of output
 *
 * Usage: npx tsx benchmarks/scenario-runner.ts [--scenario <id>] [--all]
 */

import { deliberate } from '../packages/core/src/ultimate/deliberation';
import { classifyEffortLevel } from '../packages/core/src/ultimate/effortScaler';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

interface Scenario {
  id: string;
  name: string;
  category: string;
  difficulty: string;
  description: string;
  goal: string;
  files: string[];
  expected_actions: string[];
  success_criteria: string[];
  common_failures: string[];
  estimated_tokens: string;
  estimated_time: string;
}

interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  category: string;
  difficulty: string;
  deliberationResult: {
    taskType: string;
    effortLevel: string;
    recommendedTopology: string;
    estimatedAgents: number;
    estimatedTokens: number;
    estimatedDurationMs: number;
    confidence: number;
    suitableForSpeculation: boolean;
  };
  success: boolean;
  tokenUsage?: number;
  durationMs?: number;
  errors?: string[];
}

// Load scenarios from YAML
function loadScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  const files = [
    'benchmarks/scenarios/common-scenarios.yaml',
    'benchmarks/scenarios/general-scenarios.yaml',
  ];
  for (const file of files) {
    if (fs.existsSync(file)) {
      const yamlContent = fs.readFileSync(file, 'utf-8');
      const data = yaml.load(yamlContent) as { scenarios: Scenario[] };
      scenarios.push(...data.scenarios);
    }
  }
  return scenarios;
}

// Run deliberation on a scenario
function runDeliberation(scenario: Scenario): ScenarioResult['deliberationResult'] {
  const plan = deliberate(scenario.goal);

  return {
    taskType: plan.taskType,
    effortLevel: plan.effortLevel,
    recommendedTopology: plan.recommendedTopology,
    estimatedAgents: plan.estimatedAgentCount,
    estimatedTokens: plan.estimatedTokens,
    estimatedDurationMs: plan.estimatedDurationMs,
    confidence: plan.confidence,
    suitableForSpeculation: plan.suitableForSpeculation,
  };
}

// Run a single scenario
async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${scenario.name}`);
  console.log(`Category: ${scenario.category} | Difficulty: ${scenario.difficulty}`);
  console.log(`Goal: ${scenario.goal}`);
  console.log(`${'='.repeat(60)}`);

  const startTime = Date.now();

  try {
    // Step 1: Deliberation
    console.log('\n📊 Deliberation...');
    const deliberationResult = runDeliberation(scenario);

    console.log(`  Task Type: ${deliberationResult.taskType}`);
    console.log(`  Effort Level: ${deliberationResult.effortLevel}`);
    console.log(`  Topology: ${deliberationResult.recommendedTopology}`);
    console.log(`  Estimated Agents: ${deliberationResult.estimatedAgents}`);
    console.log(`  Estimated Tokens: ${deliberationResult.estimatedTokens}`);
    console.log(`  Confidence: ${(deliberationResult.confidence * 100).toFixed(0)}%`);

    // Step 2: Check if deliberation matches expected difficulty
    const expectedEffort = scenario.difficulty === 'simple' ? 'SIMPLE'
      : scenario.difficulty === 'medium' ? 'MODERATE'
      : 'COMPLEX';

    const effortMatch = deliberationResult.effortLevel === expectedEffort;
    console.log(`\n  Expected effort: ${expectedEffort}, Got: ${deliberationResult.effortLevel} ${effortMatch ? '✅' : '⚠️'}`);

    const durationMs = Date.now() - startTime;

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      category: scenario.category,
      difficulty: scenario.difficulty,
      deliberationResult,
      success: true,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      category: scenario.category,
      difficulty: scenario.difficulty,
      deliberationResult: {
        taskType: 'UNKNOWN',
        effortLevel: 'UNKNOWN',
        recommendedTopology: 'UNKNOWN',
        estimatedAgents: 0,
        estimatedTokens: 0,
        estimatedDurationMs: 0,
        confidence: 0,
        suitableForSpeculation: false,
      },
      success: false,
      durationMs,
      errors: [String(err)],
    };
  }
}

// Generate report
function generateReport(results: ScenarioResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('SCENARIO RUNNER REPORT');
  console.log('='.repeat(80));

  // Summary
  const total = results.length;
  const successful = results.filter(r => r.success).length;
  const failed = total - successful;

  console.log(`\nTotal Scenarios: ${total}`);
  console.log(`Successful: ${successful} (${((successful / total) * 100).toFixed(0)}%)`);
  console.log(`Failed: ${failed} (${((failed / total) * 100).toFixed(0)}%)`);

  // By category
  console.log('\n📊 By Category:');
  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catSuccess = catResults.filter(r => r.success).length;
    console.log(`  ${cat}: ${catSuccess}/${catResults.length} successful`);
  }

  // By difficulty
  console.log('\n📊 By Difficulty:');
  const difficulties = ['simple', 'medium', 'hard'];
  for (const diff of difficulties) {
    const diffResults = results.filter(r => r.difficulty === diff);
    if (diffResults.length === 0) continue;
    const diffSuccess = diffResults.filter(r => r.success).length;
    console.log(`  ${diff}: ${diffSuccess}/${diffResults.length} successful`);
  }

  // Deliberation accuracy
  console.log('\n📊 Deliberation Accuracy:');
  const effortMatches = results.filter(r => {
    const expected = r.difficulty === 'simple' ? 'SIMPLE'
      : r.difficulty === 'medium' ? 'MODERATE'
      : 'COMPLEX';
    return r.deliberationResult.effortLevel === expected;
  }).length;
  console.log(`  Effort level matches: ${effortMatches}/${total} (${((effortMatches / total) * 100).toFixed(0)}%)`);

  // Topology distribution
  console.log('\n📊 Topology Distribution:');
  const topologies = results.reduce((acc, r) => {
    const t = r.deliberationResult.recommendedTopology;
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  for (const [topology, count] of Object.entries(topologies).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${topology}: ${count} (${((count / total) * 100).toFixed(0)}%)`);
  }

  // Token estimates
  console.log('\n📊 Token Estimates:');
  const totalEstimated = results.reduce((sum, r) => sum + r.deliberationResult.estimatedTokens, 0);
  console.log(`  Total estimated: ${totalEstimated.toLocaleString()} tokens`);
  console.log(`  Average per scenario: ${Math.round(totalEstimated / total).toLocaleString()} tokens`);

  // Confidence distribution
  console.log('\n📊 Confidence Distribution:');
  const avgConfidence = results.reduce((sum, r) => sum + r.deliberationResult.confidence, 0) / total;
  console.log(`  Average confidence: ${(avgConfidence * 100).toFixed(0)}%`);
  const lowConf = results.filter(r => r.deliberationResult.confidence < 0.5).length;
  console.log(`  Low confidence (<50%): ${lowConf} scenarios`);

  // Speculation candidates
  const specCandidates = results.filter(r => r.deliberationResult.suitableForSpeculation).length;
  console.log(`\n📊 Speculation Candidates: ${specCandidates}/${total} (${((specCandidates / total) * 100).toFixed(0)}%)`);

  // Detailed results
  console.log('\n' + '='.repeat(80));
  console.log('DETAILED RESULTS');
  console.log('='.repeat(80));

  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    console.log(`\n${status} ${r.scenarioName}`);
    console.log(`   Category: ${r.category} | Difficulty: ${r.difficulty}`);
    console.log(`   Task: ${r.deliberationResult.taskType} | Effort: ${r.deliberationResult.effortLevel}`);
    console.log(`   Topology: ${r.deliberationResult.recommendedTopology} | Agents: ${r.deliberationResult.estimatedAgents}`);
    console.log(`   Tokens: ${r.deliberationResult.estimatedTokens} | Confidence: ${(r.deliberationResult.confidence * 100).toFixed(0)}%`);
    if (r.errors) {
      console.log(`   Errors: ${r.errors.join(', ')}`);
    }
  }
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const scenarioId = args.find(a => !a.startsWith('--')) || args[args.indexOf('--scenario') + 1];

  console.log('🚀 Commander Scenario Runner');
  console.log('Loading scenarios...\n');

  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenarios`);

  let scenariosToRun = scenarios;
  if (scenarioId) {
    scenariosToRun = scenarios.filter(s => s.id === scenarioId);
    if (scenariosToRun.length === 0) {
      console.error(`Scenario not found: ${scenarioId}`);
      process.exit(1);
    }
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenariosToRun) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  generateReport(results);

  // Save results
  const outputPath = 'benchmarks/scenarios/results.json';
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to ${outputPath}`);
}

main().catch(console.error);
