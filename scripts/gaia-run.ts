import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const AR = require('../packages/core/src/runtime/agentRuntime');
const OP = require('../packages/core/src/runtime/providers/openaiProvider');
const MR = require('../packages/core/src/runtime/modelRouter');
const TO = require('../packages/core/src/telos/telosOrchestrator');
const UO = require('../packages/core/src/ultimate/orchestrator');
const { createAllTools } = require('../packages/core/src/tools/index');

const RESULTS_FILE = 'gaia-results.json';
const MAX = process.argv.includes('--quick') ? 5 : 165;

async function main() {
  const cachePath = path.join(process.env.HOME||'', '.cache/huggingface/hub/datasets--gaia-benchmark--GAIA/snapshots/682dd723ee1e1697e00360edccf2366dc8418dd9/2023/validation/metadata.parquet');
  if (!fs.existsSync(cachePath)) { console.error('GAIA dataset not found'); process.exit(1); }
  const py = spawnSync('python3', ['-c', `import pandas as pd,json; df=pd.read_parquet('${cachePath}'); subset=df.head(${MAX}); rows=[]; [rows.append({'task_id':str(r['task_id']),'level':int(r['Level']),'question':str(r['Question']),'final_answer':str(r['Final answer'])}) for _,r in subset.iterrows()]; print(json.dumps(rows))`]);
  const tasks = JSON.parse(py.stdout.toString());
  console.log(`\nGAIA × Commander · ${tasks.length} tasks · ${process.env.OPENAI_MODEL||'gpt-4o'}`);
  console.log(`L1:${tasks.filter((t:any)=>t.level===1).length} L2:${tasks.filter((t:any)=>t.level===2).length} L3:${tasks.filter((t:any)=>t.level===3).length}\n`);

  const runtime = new AR.AgentRuntime({budgetHardCapTokens:500000});
  for (const [n,t] of createAllTools()) runtime.registerTool(n,t);
  runtime.registerProvider('openai', new OP.OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL, defaultModel: process.env.OPENAI_MODEL||'gpt-4o',
  }));
  const router = MR.getModelRouter();
  const modelId = process.env.OPENAI_MODEL||'gpt-4o';
  for (const tier of ['eco','standard','power','consensus']) router.registerModel({
    id: modelId+'@'+tier, provider:'openai', tier, costPer1KInput:0.0008, costPer1KOutput:0.004,
    capabilities:['code','reasoning','analysis','creative','math'], contextWindow:128000, priority:-1,
  });
  const orch = new UO.UltimateOrchestrator(new TO.TELOSOrchestrator(runtime), runtime);
  console.log('Commander ready.\n');

  const results: any[] = [];
  let correct = 0, wrong = 0, totalTokens = 0, totalCost = 0;
  const norm = (s:string) => s.toLowerCase().replace(/[^a-z0-9\s,.]/g,'').replace(/\s+/g,' ').trim();

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const t0 = Date.now();
    process.stdout.write(`  ${(i+1).toString().padStart(3)}/${tasks.length} L${task.level} ${task.question.slice(0,50).padEnd(52)}`);

    try {
      const result = await orch.execute({
        projectId:'gaia', agentId:'commander',
        goal: task.question,
        contextData: { availableTools: ['browser_search','browser_fetch','python_execute','shell_execute'], governanceProfile:{riskLevel:'LOW'} },
      });
      const elapsed = ((Date.now()-t0)/1000).toFixed(1);
      totalTokens += result.metrics.totalTokens;
      totalCost += result.metrics.totalCostUsd;

      const allText = (result.synthesis||'') + '\n' + (result.summary||'') + '\n' + ((result.reasoning||[]).join('\n'));
      let isCorrect = false;
      const fa = allText.match(/FINAL ANSWER:\s*(.+)/i);
      if (fa && norm(fa[1]) === norm(task.final_answer)) isCorrect = true;
      if (!isCorrect && norm(allText) === norm(task.final_answer)) isCorrect = true;
      if (!isCorrect) {
        for (const line of allText.split('\n')) {
          if (norm(line.trim()) === norm(task.final_answer)) { isCorrect = true; break; }
        }
      }
      if (isCorrect) correct++; else wrong++;
      console.log(`${isCorrect?'✅':'❌'} ${elapsed}s`);

      results.push({ task_id:task.task_id, level:task.level, question:task.question.slice(0,150),
        expected:task.final_answer, answer:(result.synthesis||'').slice(0,200), correct:isCorrect,
        tokens:result.metrics.totalTokens, cost_usd:parseFloat(result.metrics.totalCostUsd.toFixed(4)),
        elapsed_seconds:parseFloat(elapsed) });
    } catch(err: any) {
      wrong++;
      console.log(`❌ ERROR`);
      results.push({ task_id:task.task_id, level:task.level, question:task.question.slice(0,150),
        expected:task.final_answer, answer:'ERROR: '+(err.message||'').slice(0,150), correct:false,
        tokens:0, cost_usd:0, elapsed_seconds:(Date.now()-t0)/1000 });
    }
    if (results.length%5===0||results.length===tasks.length) {
      const c = results.filter((r:any)=>r.correct).length;
      fs.writeFileSync(RESULTS_FILE, JSON.stringify({
        config:{model:modelId,date:new Date().toISOString(),benchmark:'GAIA Validation'},
        summary:{total:results.length,correct:c,wrong:results.length-c,rate:(c/results.length*100).toFixed(1)+'%',total_tokens:totalTokens,total_cost_usd:parseFloat(totalCost.toFixed(4))},
        results,
      },null,2));
    }
  }

  const rate = (correct/results.length*100).toFixed(1);
  console.log(`\n══════════════════════════════════════`);
  console.log(`  GAIA RESULTS`);
  console.log(`══════════════════════════════════════`);
  console.log(`  Commander: ${correct}/${results.length} = ${rate}%`);
  console.log(`  Cost: \$${totalCost.toFixed(4)} · Tokens: ${totalTokens.toLocaleString()}`);
  for (const lv of [1,2,3]) {
    const lr = results.filter((r:any)=>r.level===lv);
    const lc = lr.filter((r:any)=>r.correct).length;
    console.log(`  Level ${lv}: ${lc}/${lr.length} = ${lr.length>0?(lc/lr.length*100).toFixed(1):'-'}%`);
  }
  console.log(`\n  Results: ${RESULTS_FILE}`);
  console.log('══════════════════════════════════════\n');
}
main().catch(err => { console.error('FATAL:',err); process.exit(1); });
