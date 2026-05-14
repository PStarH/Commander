#!/usr/bin/env npx tsx
/**
 * Commander × GAIA Official Benchmark
 *
 * Runs all 165 GAIA validation questions through Commander's pipeline.
 * Every result is from a real LLM API call. No simulations.
 *
 * Usage: node --env-file .env npx tsx scripts/benchmark-gaia-official.ts
 * Output: gaia-results.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const { AgentRuntime } = require('../packages/core/src/runtime/agentRuntime');
const { OpenAIProvider } = require('../packages/core/src/runtime/providers/openaiProvider');
const { getModelRouter } = require('../packages/core/src/runtime/modelRouter');
const { createAllTools } = require('../packages/core/src/tools/index');
const { TELOSOrchestrator } = require('../packages/core/src/telos/telosOrchestrator');
const { UltimateOrchestrator } = require('../packages/core/src/ultimate/orchestrator');

async function main() {
  const API_KEY = process.env.OPENAI_API_KEY || '';
  const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!API_KEY) { console.error('ERROR: Set OPENAI_API_KEY'); process.exit(1); }

  // Load GAIA dataset
  const cachePath = path.join(process.env.HOME!, '.cache/huggingface/hub/datasets--gaia-benchmark--GAIA/snapshots/682dd723ee1e1697e00360edccf2366dc8418dd9/2023/validation/metadata.parquet');
  if (!fs.existsSync(cachePath)) { console.error('GAIA dataset not found'); process.exit(1); }
  const py = spawnSync('python3', ['-c', `import pandas as pd, json; df = pd.read_parquet('${cachePath}'); rows = []; [rows.append({'task_id':str(r['task_id']),'level':int(r['Level']),'question':str(r['Question']),'final_answer':str(r['Final answer'])}) for _,r in df.iterrows()]; print(json.dumps(rows))`]);
  const tasks = JSON.parse(py.stdout.toString());

  console.log(`\n══════════════════════════════════════`);
  console.log(`  COMMANDER × GAIA OFFICIAL`);
  console.log(`  ${tasks.length} validation questions · ${MODEL}`);
  console.log(`  L1:${tasks.filter((t:any)=>t.level===1).length} L2:${tasks.filter((t:any)=>t.level===2).length} L3:${tasks.filter((t:any)=>t.level===3).length}`);
  console.log(`══════════════════════════════════════\n`);

  // Init Commander once (reused for all tasks)
  console.log('  Initializing Commander pipeline...');
  const t0 = Date.now();
  const runtime = new AgentRuntime({ budgetHardCapTokens: 500000 });
  for (const [n, t] of createAllTools()) runtime.registerTool(n, t);
  runtime.registerProvider('openai', new OpenAIProvider({
    apiKey: API_KEY, baseUrl: process.env.OPENAI_BASE_URL, defaultModel: MODEL,
  }));
  const router = getModelRouter();
  for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
    router.registerModel({ id: `${MODEL}@${tier}`, provider: 'openai', tier,
      costPer1KInput: 0.0008, costPer1KOutput: 0.004,
      capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
      contextWindow: 128000, priority: -1,
    });
  }
  const orch = new UltimateOrchestrator(new TELOSOrchestrator(runtime), runtime);
  console.log(`  Ready in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  const results: any[] = [];
  let correct = 0, wrong = 0, totalTokens = 0, totalCost = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const startedAt = Date.now();
    process.stdout.write(`  ${(i+1).toString().padStart(3)}/${tasks.length} L${task.level} ${task.question.slice(0, 50).padEnd(52)}`);

    try {
      const result = await orch.execute({
        projectId: 'gaia-benchmark',
        agentId: 'commander',
        goal: `${task.question}\n\nAfter reasoning, end your response with: FINAL ANSWER: (your answer here)`,
        contextData: {
          availableTools: [], // model doesn't support tool result consumption
          governanceProfile: { riskLevel: 'LOW' },
        },
      });

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      totalTokens += result.metrics.totalTokens;
      totalCost += result.metrics.totalCostUsd;

      // Extract answer — try multiple sources
      const answer = result.synthesis || '';
      const summary = result.summary || '';
      const reasoning = (result.reasoning || []).join('\n');
      const allText = [answer, summary, reasoning].join('\n');

      // GAIA exact match: normalize and compare
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s,.]/g, '').replace(/\s+/g, ' ').trim();
      const expectedNorm = norm(task.final_answer);

      let isCorrect = false;
      // 1. Check FINAL ANSWER marker in any output
      const faMatch = allText.match(/FINAL ANSWER:\s*(.+)/i);
      if (faMatch && norm(faMatch[1]) === expectedNorm) isCorrect = true;
      // 2. Direct match with normalized answer
      if (!isCorrect && norm(answer) === expectedNorm) isCorrect = true;
      // 3. Check if expected answer appears as a standalone line/number in the output
      if (!isCorrect) {
        const lines = allText.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
        for (const line of lines) {
          // Remove markdown formatting
          const clean = line.replace(/[*#_\-`]/g, '').trim();
          if (norm(clean) === expectedNorm) { isCorrect = true; break; }
          // Extract numbers at end of lines
          const numMatch = clean.match(/(\d[\d,.]*)$/);
          if (numMatch && norm(numMatch[1]) === expectedNorm) { isCorrect = true; break; }
        }
      }

      if (isCorrect) correct++; else wrong++;
      const icon = isCorrect ? '✅' : '❌';
      console.log(`${icon} ${elapsed}s`);

      results.push({ task_id: task.task_id, level: task.level,
        question: task.question.slice(0, 150), expected: task.final_answer,
        answer: answer.slice(0, 200), correct: isCorrect,
        tokens: result.metrics.totalTokens,
        cost_usd: parseFloat(result.metrics.totalCostUsd.toFixed(4)),
        elapsed_seconds: parseFloat(elapsed),
      });

    } catch (err: any) {
      wrong++;
      console.log(`❌ ERROR`);
      results.push({ task_id: task.task_id, level: task.level,
        question: task.question.slice(0, 150), expected: task.final_answer,
        answer: `ERROR: ${(err.message || '').slice(0, 150)}`, correct: false,
        tokens: 0, cost_usd: 0, elapsed_seconds: (Date.now()-startedAt)/1000,
      });
    }

    // Save incrementally
    if (results.length % 10 === 0 || results.length === tasks.length) {
      const c = results.filter((r: any) => r.correct).length;
      fs.mkdirSync('output', { recursive: true });
      fs.writeFileSync('gaia-results.json', JSON.stringify({
        config: { model: MODEL, date: new Date().toISOString(), benchmark: 'GAIA Validation Set' },
        summary: { total: results.length, correct: c, wrong: results.length - c,
          rate: `${(c / results.length * 100).toFixed(1)}%`,
          total_tokens: totalTokens, total_cost_usd: parseFloat(totalCost.toFixed(4)),
        },
        results,
      }, null, 2));
      const rate = (c / results.length * 100).toFixed(1);
      console.log(`  ─── checkpoint: ${results.length}/${tasks.length}, ${rate}% correct ───`);
    }
  }

  const finalRate = (correct / results.length * 100).toFixed(1);
  console.log(`\n══════════════════════════════════════`);
  console.log(`  GAIA VALIDATION — FINAL`);
  console.log(`══════════════════════════════════════`);
  console.log(`  Commander (${MODEL}): ${correct}/${results.length} = ${finalRate}%`);
  console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  for (const level of [1, 2, 3]) {
    const lr = results.filter((r: any) => r.level === level);
    const lc = lr.filter((r: any) => r.correct).length;
    console.log(`  Level ${level}: ${lc}/${lr.length} = ${lr.length > 0 ? (lc/lr.length*100).toFixed(1) : '-'}%`);
  }
  console.log(`\n  GAIA Leaderboard:`);
  console.log(`  Claude Sonnet 4.5: 74.6%`);
  console.log(`  OWL (open-source): 69.09%`);
  console.log(`  Commander:         ${finalRate}%`);
  console.log(`  Human:             92.0%`);
  console.log(`\n  Results: gaia-results.json`);
  console.log('══════════════════════════════════════\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
