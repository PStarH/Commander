import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { MiMoProvider } from '../src/runtime/providers/mimoProvider';
import { WebSearchTool, WebFetchTool } from '../src/tools/webSearchTool';
import { getModelRouter, resetModelRouter } from '../src/runtime/modelRouter';
import type { AgentExecutionContext } from '../src/runtime/types';

const BROWSE_COMP_CSV_URL = 'https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv';
const BROWSE_COMP_CSV_LOCAL = '/tmp/browse_comp_test_set.csv';
const QUESTION_COUNT = parseInt(process.env.BROWSE_COMP_COUNT || '20', 10);

function deriveKey(password: string, length: number): Buffer {
  const hash = crypto.createHash('sha256').update(password).digest();
  const fullKey = Buffer.alloc(Math.ceil(length / hash.length) * hash.length);
  for (let i = 0; i < fullKey.length; i += hash.length) hash.copy(fullKey, i);
  return fullKey.subarray(0, length);
}

function decrypt(ct: string, pw: string): string {
  const enc = Buffer.from(ct, 'base64');
  const key = deriveKey(pw, enc.length);
  const dec = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i++) dec[i] = enc[i] ^ key[i];
  return dec.toString('utf-8');
}

interface Question {
  problem: string;
  answer: string;
}

function loadQuestions(csv: string, n?: number): Question[] {
  const lines = csv.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',');
  const qs: Question[] = [];
  for (const line of lines.slice(1)) {
    const vals = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] || '').trim(); });
    try {
      qs.push({ problem: decrypt(row.problem, row.canary), answer: decrypt(row.answer, row.canary) });
    } catch { /* skip decrypt failures */ }
  }
  if (n && n < qs.length) {
    let s = 0;
    const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = qs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [qs[i], qs[j]] = [qs[j], qs[i]]; }
    return qs.slice(0, n);
  }
  return qs;
}

// ============================================================================
// Load .env from project root (walk up from CWD)
// ============================================================================
function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      const vars: Array<[string, string]> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (key && val) vars.push([key, val]);
      }
      for (const [key, rawVal] of vars) {
        if (!process.env[key]) {
          const expanded = rawVal.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
          process.env[key] = expanded;
        }
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnv();

const QUERY_TEMPLATE = `{Question}

You can search the web and fetch pages. Use web_search to find information, then use web_fetch to read specific pages.

Your final answer should be in this format:
Explanation: {{your explanation}}
Exact Answer: {{your final answer}}
Confidence: {{0-100}}`;

const GRADER_TEMPLATE = `Judge whether the following [response] to [question] is correct or not based on the precise and unambiguous [correct_answer] below.

[question]: {question}
[response]: {response}

Your judgement must be in the format and criteria specified below:

extracted_final_answer: The final exact answer extracted from the [response]. Put the extracted answer as 'None' if there is no exact, final answer to extract from the response.

[correct_answer]: {correct_answer}

reasoning: Explain why the extracted_final_answer is correct or incorrect based on [correct_answer], focusing only on if there are meaningful differences between [correct_answer] and the extracted_final_answer.

correct: Answer 'yes' if extracted_final_answer matches the [correct_answer] given above, or is within a small margin of error for numerical problems. Answer 'no' otherwise.

confidence: The extracted confidence score between 0% and 100% from [response]. Put 100 if there is no confidence score available.`;

async function callMiMo(messages: Array<{ role: string; content: string }>, maxTokens = 1024): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.MIMO_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
  const model = process.env.OPENAI_MODEL || 'mimo-v2.5';
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.0, max_tokens: maxTokens }),
  });
  if (!resp.ok) return '';
  const data = await resp.json() as any;
  const msg = data.choices?.[0]?.message || {};
  return msg.content || msg.reasoning_content || '';
}

describe('BrowseComp × Commander (web search)', () => {
  const results = { correct: 0, total: 0 };
  let runtime: AgentRuntime;

  before(async () => {
    const apiKey = process.env.OPENAI_API_KEY || process.env.MIMO_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
    const model = process.env.OPENAI_MODEL || 'mimo-v2.5';
    if (!apiKey) throw new Error('Set OPENAI_API_KEY in .env');

    resetModelRouter();
    const router = getModelRouter();
    runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 300000, maxStepsPerRun: 6 }, router);
    runtime.registerProvider('mimo', new MiMoProvider({ apiKey, baseUrl, defaultModel: model }));
    runtime.registerProvider('openai', new MiMoProvider({ apiKey, baseUrl, defaultModel: model }));
    runtime.registerTool('web_search', new WebSearchTool());
    runtime.registerTool('web_fetch', new WebFetchTool());
    console.log(`BrowseComp × Commander | model=${model} | count=${QUESTION_COUNT} | tools=web_search,web_fetch`);
  });

  it(`run ${QUESTION_COUNT} questions`, async () => {
    let csv: string;
    if (fs.existsSync(BROWSE_COMP_CSV_LOCAL)) {
      csv = fs.readFileSync(BROWSE_COMP_CSV_LOCAL, 'utf-8');
    } else {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 90000);
      const r = await fetch(BROWSE_COMP_CSV_URL, { signal: c.signal });
      clearTimeout(t);
      csv = await r.text();
    }
    const questions = loadQuestions(csv, QUESTION_COUNT);
    assert.ok(questions.length > 0);

    for (let i = 0; i < questions.length; i++) {
      const { problem, answer } = questions[i];
      const prompt = QUERY_TEMPLATE.replace('{Question}', problem);
      console.log(`[${i + 1}/${questions.length}] ${problem.slice(0, 80)}...`);

      const ctx: AgentExecutionContext = {
        agentId: 'browsecomp',
        projectId: 'benchmark',
        goal: prompt,
        availableTools: ['web_search', 'web_fetch'],
        maxSteps: 6,
        tokenBudget: 32000,
        contextData: {},
      };

      try {
        const agentResult = await runtime.execute(ctx);
        let response = agentResult.summary || '';
        if (!response) {
          for (let si = agentResult.steps.length - 1; si >= 0; si--) {
            const s = agentResult.steps[si];
            if (s.type === 'response' && s.content && !s.content.includes('<tool_call>') && s.content.length > 20) {
              response = s.content;
              break;
            }
          }
        }
        const grade = await callMiMo([{ role: 'user', content: GRADER_TEMPLATE.replace('{question}', problem).replace('{response}', response).replace('{correct_answer}', answer) }]);
        const isCorrect = grade.toLowerCase().includes('correct: yes');
        if (isCorrect) results.correct++;
        results.total++;
        const mark = isCorrect ? '✓' : '✗';
        console.log(`  → ${mark} ${isCorrect ? 'CORRECT' : 'WRONG'}`);
        console.log(`  response: ${(response || '(empty)').slice(0, 300)}`);
        console.log(`  expected: ${answer.slice(0, 100)}`);
        if (!isCorrect && response) {
          console.log(`  steps: ${agentResult.steps.length}`);
          for (const step of agentResult.steps.slice(-2)) {
            console.log(`  step[${step.stepNumber}] type=${step.type} content=${(step.content || '(empty)').slice(0, 120)}`);
          }
        }
      } catch (e) {
        results.total++;
        console.log(`  → ✗ ERROR: ${(e as Error).message.slice(0, 200)}`);
      }
    }

    const acc = (results.correct / Math.max(results.total, 1)) * 100;
    console.log(`\n═══ BrowseComp × Commander ═══`);
    console.log(`Accuracy: ${acc.toFixed(1)}% (${results.correct}/${results.total})`);
  });
});
