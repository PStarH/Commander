#!/usr/bin/env npx tsx
/**
 * Commander × GAIA — Direct API Benchmark
 * 
 * Calls the model directly (no tool definitions) to test knowledge.
 * Every result is from a real API call.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const API_KEY = process.env.OPENAI_API_KEY || '';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const RESULTS_FILE = 'gaia-results.json';
const MAX = process.argv.includes('--quick') ? 10 : 165;
let totalTokens = 0, totalCost = 0;

function loadTasks() {
  const cachePath = path.join(process.env.HOME!, '.cache/huggingface/hub/datasets--gaia-benchmark--GAIA/snapshots/682dd723ee1e1697e00360edccf2366dc8418dd9/2023/validation/metadata.parquet');
  const py = spawnSync('python3', ['-c', `import pandas as pd, json; df = pd.read_parquet('${cachePath}'); subset = df.head(${MAX}); rows = []; [rows.append({'task_id':str(r['task_id']),'level':int(r['Level']),'question':str(r['Question']),'final_answer':str(r['Final answer'])}) for _,r in subset.iterrows()]; print(json.dumps(rows))`]);
  return JSON.parse(py.stdout.toString());
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s,.]/g, '').replace(/\s+/g, ' ').trim();
}

async function callLLM(prompt: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}`},
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {role: 'system', content: 'Answer concisely and accurately. End with: FINAL ANSWER: (your answer)'},
        {role: 'user', content: prompt},
      ],
      max_tokens: 512,
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const usage = data.usage || {};
  totalTokens += (usage.prompt_tokens||0) + (usage.completion_tokens||0);
  const costPerM = 0.15; // approximate
  totalCost += ((usage.prompt_tokens||0) + (usage.completion_tokens||0)) / 1000000 * costPerM;
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function main() {
  if (!API_KEY) { console.error('ERROR: Set OPENAI_API_KEY'); process.exit(1); }
  const tasks = loadTasks();
  console.log(`\n══════════════════════════════════════`);
  console.log(`  GAIA DIRECT BENCHMARK`);
  console.log(`  Model: ${MODEL} · Tasks: ${tasks.length}`);
  console.log(`  L1:${tasks.filter((t:any)=>t.level===1).length} L2:${tasks.filter((t:any)=>t.level===2).length} L3:${tasks.filter((t:any)=>t.level===3).length}`);
  console.log(`══════════════════════════════════════\n`);

  const results: any[] = [];
  let correct = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const t0 = Date.now();
    process.stdout.write(`  ${(i+1).toString().padStart(3)}/${tasks.length} L${task.level} ${task.question.slice(0, 50).padEnd(52)}`);

    try {
      const answer = await callLLM(task.question);
      const elapsed = ((Date.now()-t0)/1000).toFixed(1);
      
      // Check exact match
      let isCorrect = false;
      if (normalize(answer) === normalize(task.final_answer)) isCorrect = true;
      const fa = answer.match(/FINAL ANSWER:\s*(.+)/i);
      if (fa && normalize(fa[1]) === normalize(task.final_answer)) isCorrect = true;
      // Check last line
      const lines = answer.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length > 0 && normalize(lines[lines.length-1]) === normalize(task.final_answer)) isCorrect = true;
      
      if (isCorrect) correct++;
      console.log(`${isCorrect ? '✅' : '❌'} ${elapsed}s`);
      
      results.push({ task_id: task.task_id, level: task.level,
        question: task.question.slice(0, 150), expected: task.final_answer,
        answer: answer.slice(0, 200), correct: isCorrect,
        elapsed_seconds: parseFloat(elapsed),
      });
    } catch (err: any) {
      console.log(`❌ ERROR`);
      results.push({ task_id: task.task_id, level: task.level,
        question: task.question.slice(0, 150), expected: task.final_answer,
        answer: `ERROR: ${(err.message||'').slice(0,150)}`, correct: false,
        elapsed_seconds: (Date.now()-t0)/1000,
      });
    }

    if (results.length % 10 === 0 || results.length === tasks.length) {
      const c = results.filter((r: any) => r.correct).length;
      fs.writeFileSync(RESULTS_FILE, JSON.stringify({
        config: { model: MODEL, date: new Date().toISOString(), benchmark: 'GAIA Validation' },
        summary: { total: results.length, correct: c, wrong: results.length-c,
          rate: `${(c/results.length*100).toFixed(1)}%`,
          total_tokens: totalTokens, total_cost_usd: parseFloat(totalCost.toFixed(4)),
        },
        results,
      }, null, 2));
    }
  }

  const rate = (correct/results.length*100).toFixed(1);
  console.log(`\n══════════════════════════════════════`);
  console.log(`  RESULTS`);
  console.log(`══════════════════════════════════════`);
  console.log(`  ${MODEL}: ${correct}/${results.length} = ${rate}%`);
  console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  for (const level of [1,2,3]) {
    const lr = results.filter((r:any) => r.level === level);
    const lc = lr.filter((r:any) => r.correct).length;
    console.log(`  Level ${level}: ${lc}/${lr.length} = ${lr.length > 0 ? (lc/lr.length*100).toFixed(1) : '-'}%`);
  }
  console.log(`\n  GAIA leaderboard:`);
  console.log(`  Claude Sonnet 4.5: 74.6%`);
  console.log(`  OWL:               69.09%`);
  console.log(`  ${MODEL}:          ${rate}%`);
  console.log(`  Human:             92.0%`);
  console.log(`\n  Results: ${RESULTS_FILE}`);
  console.log('══════════════════════════════════════\n');
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });
