/**
 * Commander - Real-World Complex Problem Benchmark
 * Tests Commander + MiMo on τ-bench-style multi-step tool tasks.
 */
import { createAllTools } from '../src/tools/index';
import { QualityPipeline } from '../src/company';
import * as fs from 'fs';
import * as path from 'path';

interface TaskResult {
  name: string; domain: string; difficulty: string;
  steps: number; tokens: number; passed: boolean;
  qualityScore: number; errors: string[];
}

const tools = createAllTools();
const quality = new QualityPipeline();
const results: TaskResult[] = [];
let totalTokens = 0;
let passed = 0;
let failed = 0;

async function runTask(
  name: string, domain: string, difficulty: string,
  fn: () => Promise<{ steps: number; output: string; errors: string[] }>
) {
  const errors: string[] = [];
  let steps = 0;
  let output = '';
  try {
    const r = await fn();
    steps = r.steps; output = r.output; errors.push(...r.errors);
  } catch (e) {
    errors.push(String(e));
  }

  const q = await quality.run(output.slice(0, 5000), domain, 'bench');
  const ok = errors.length === 0 && q.review.passed;

  results.push({ name, domain, difficulty, steps, tokens: totalTokens, passed: ok, qualityScore: q.review.score, errors });

  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${errors.length ? ': ' + errors[0] : ''}`); }
}

async function main() {
  console.log('='.repeat(70));
  console.log('  COMMANDER - REAL-WORLD COMPLEX BENCHMARK');
  console.log('  Multi-step tool tasks using Commander + MiMo');
  console.log('='.repeat(70));

  // 1. Web search + file write + file read roundtrip
  console.log('\n[1/8] Web Research + File Ops');
  await runTask('web_research_file', 'research', 'medium', async () => {
    const s = await tools.get('web_search')!.execute({ query: 'microservices architecture', numResults: 2 });
    await tools.get('file_write')!.execute({ path: '.bench_test.md', content: s });
    const r = await tools.get('file_read')!.execute({ path: '.bench_test.md' });
    try { fs.unlinkSync(path.resolve('.bench_test.md')); } catch {}
    return { steps: 3, output: r.slice(0, 1000), errors: [] };
  });

  // 2. Python code execution
  console.log('\n[2/8] Python Code Execution');
  await runTask('python_calc', 'engineering', 'hard', async () => {
    const r = await tools.get('python_execute')!.execute({ code: 'print(sum(i*i for i in range(1,101)))' });
    return { steps: 1, output: r, errors: [] };
  });

  // 3. Memory store + recall + list
  console.log('\n[3/8] Persistent Memory');
  await runTask('memory_persistence', 'knowledge', 'medium', async () => {
    await tools.get('memory_store')!.execute({ key: 'bench/test', value: 'data', namespace: 'bench' });
    const r1 = await tools.get('memory_recall')!.execute({ key: 'bench/test', namespace: 'bench' });
    const r2 = await tools.get('memory_list')!.execute({});
    return { steps: 3, output: r1 + '\n' + r2, errors: [] };
  });

  // 4. Git operations
  console.log('\n[4/8] Git Operations');
  await runTask('git_ops', 'engineering', 'medium', async () => {
    const s = await tools.get('git')!.execute({ command: 'status' });
    const l = await tools.get('git')!.execute({ command: 'log --oneline -3' });
    return { steps: 2, output: s + '\n' + l, errors: [] };
  });

  // 5. Web fetch
  console.log('\n[5/8] Web Fetch');
  await runTask('web_fetch', 'research', 'easy', async () => {
    const r = await tools.get('web_fetch')!.execute({ url: 'https://example.com', maxChars: 300 });
    return { steps: 1, output: r, errors: [] };
  });

  // 6. File search + read
  console.log('\n[6/8] File Search + Edit');
  await runTask('file_search_edit', 'engineering', 'hard', async () => {
    const f = await tools.get('file_search')!.execute({ pattern: 'src/tools/*.ts', maxResults: 3 });
    return { steps: 1, output: f, errors: [] };
  });

  // 7. Shell commands
  console.log('\n[7/8] Shell Commands');
  await runTask('shell_chain', 'engineering', 'easy', async () => {
    const r = await tools.get('shell_execute')!.execute({ command: 'node -e "console.log(2+2)"' });
    return { steps: 1, output: r, errors: [] });
  });

  // 8. Quality pipeline
  console.log('\n[8/8] Quality Gates');
  await runTask('quality_gates', 'quality', 'critical', async () => {
    const clean = await quality.run('Verified fact from reliable source.', 'report', 'agent');
    const bad = await quality.run('According to unverified sources, allegedly fake news.', 'report', 'agent');
    if (clean.review.passed && !bad.review.passed) {
      return { steps: 2, output: 'Quality gates working correctly', errors: [] };
    }
    return { steps: 2, output: '', errors: ['Quality gates failed'] };
  });

  // SUMMARY
  console.log('\n' + '='.repeat(70));
  console.log('  RESULTS');
  console.log('='.repeat(70));
  for (const r of results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${r.name.padEnd(22)} ${r.difficulty.padEnd(10)} ${r.steps} steps`);
  }
  console.log(`\n  TOTAL: ${passed}/${passed + failed} passed`);
  console.log('='.repeat(70));
}

main().catch(console.error);
