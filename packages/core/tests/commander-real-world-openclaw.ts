#!/usr/bin/env npx tsx
/**
 * Commander vs OpenClaw — 10 Real-World User Scenarios
 *
 * 场景全部来自OpenClaw用户在GitHub Issues上真实吐槽的痛点。
 * 每个场景模拟一个真实用户会遇到的情况，测试Commander能否解决。
 *
 * OpenClaw Issues referenced:
 *   #62505 — Coding Agent退化，只给status update
 *   #43747 — 记忆系统混乱，不同安装表现不同
 *   #45269 — apply_patch被当作未知工具
 *   #85030 — 子agent不继承MCP工具
 *   #31331 — sandbox/Docker访问问题
 *   #11829 — Agent可以访问API keys
 *   #86599 — 本地模型调用阻塞事件循环
 *   #52875 — session_send "no session found"
 *
 * Usage:
 *   npx tsx packages/core/tests/commander-real-world-openclaw.ts
 *   npx tsx packages/core/tests/commander-real-world-openclaw.ts --with-openclaw
 *   npx tsx packages/core/tests/commander-real-world-openclaw.ts --scenario S1
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

// ── Config ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(process.cwd(), '.openclaw-comparison-output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Allow file tools to operate in /tmp (where test scenarios create their working dirs)
// macOS: /tmp is a symlink to /private/tmp, must use resolved path
process.env.COMMANDER_WORKSPACE = fs.realpathSync('/tmp');

// ── tsx import helper ────────────────────────────────────────────────────────
// tsx wraps named exports under `default` for some modules
function named(mod: any, name: string): any {
  return mod[name] ?? mod.default?.[name] ?? mod.default;
}

// ── Shared module cache ──────────────────────────────────────────────────────
let _modules: any = null;

async function loadModules() {
  if (_modules) return _modules;

  const [agentMod, telosMod, ultMod, mimoMod, webMod, fileMod, codeMod, persistMod] =
    await Promise.all([
      import('../src/runtime/agentRuntime'),
      import('../src/telos/telosOrchestrator'),
      import('../src/ultimate/orchestrator'),
      import('../src/runtime/providers/mimoProvider'),
      import('../src/tools/webSearchTool'),
      import('../src/tools/fileSystemTool'),
      import('../src/tools/codeExecutionTool'),
      import('../src/tools/persistenceTool'),
    ]);

  _modules = {
    AgentRuntime: named(agentMod, 'AgentRuntime'),
    TELOSOrchestrator: named(telosMod, 'TELOSOrchestrator'),
    UltimateOrchestrator: named(ultMod, 'UltimateOrchestrator'),
    MiMoProvider: named(mimoMod, 'MiMoProvider'),
    WebSearchTool: named(webMod, 'WebSearchTool'),
    WebFetchTool: named(webMod, 'WebFetchTool'),
    FileReadTool: named(fileMod, 'FileReadTool'),
    FileWriteTool: named(fileMod, 'FileWriteTool'),
    FileEditTool: named(fileMod, 'FileEditTool'),
    FileListTool: named(fileMod, 'FileListTool'),
    FileSearchTool: named(fileMod, 'FileSearchTool'),
    ShellExecuteTool: named(codeMod, 'ShellExecuteTool'),
    MemoryStoreTool: named(persistMod, 'MemoryStoreTool'),
    MemoryRecallTool: named(persistMod, 'MemoryRecallTool'),
  };

  return _modules;
}

async function createRuntime() {
  const M = await loadModules();

  const provider = new M.MiMoProvider({
    apiKey: 'tp-sfcjofksj8sn63244lzc1hxzzb8mz03hty5afetx0aafsetx',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
  });

  const runtime = new M.AgentRuntime({
    budgetHardCapTokens: 100_000,
    maxSteps: 15,
  });
  runtime.registerProvider('mimo', provider);
  runtime.registerProvider('openai', provider);

  const tools: Record<string, any> = {
    web_search: new M.WebSearchTool(),
    web_fetch: new M.WebFetchTool(),
    file_write: new M.FileWriteTool(),
    file_read: new M.FileReadTool(),
    file_list: new M.FileListTool(),
    file_edit: new M.FileEditTool(),
    file_search: new M.FileSearchTool(),
    shell_execute: new M.ShellExecuteTool(),
    memory_store: new M.MemoryStoreTool(),
    memory_recall: new M.MemoryRecallTool(),
  };

  for (const [name, tool] of Object.entries(tools)) {
    runtime.registerTool(name, tool);
  }

  return runtime;
}

// ── Types ────────────────────────────────────────────────────────────────────
interface ScenarioResult {
  scenario: string;
  openclawIssue: string;
  category: string;
  commanderSuccess: boolean;
  durationSec: number;
  outputPreview: string;
  verificationDetail: string;
  openclawExpectedBehavior: string;
  error?: string;
}

interface Scenario {
  id: string;
  name: string;
  category: string;
  openclawIssue: string;
  openclawExpectedBehavior: string;
  setup: () => string;
  prompt: string;
  verify: (tempDir: string, output: string) => Promise<{ pass: boolean; detail: string }>;
}

// ── Test Data ────────────────────────────────────────────────────────────────

const BUGGY_TYPESCRIPT = `
import * as fs from 'fs';

// 读取配置文件并解析
function loadConfig(path: string): Record<string, any> {
  const content = fs.readFileSync(path, 'utf-8');
  const config = JSON.parse(content);
  return config;
}

// 计算两个数组的交集
function intersection(a: number[], b: number[]): number[] {
  const setB = new Set(b);
  return a.filter(x => setB.has(x);  // BUG: 多余的分号，括号不匹配
}

// 格式化用户显示名
function formatUser(user: { first: string; last: string; role?: string }): string {
  const name = \`\${user.first} \${user.last}\`;
  if (user.role) {
    return \`\${name} (\${user.role.toUpperCase}))\`;  // BUG: 多了一个右括号
  }
  return name;
}

// 异步批量处理
async function processBatch(items: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const item of items) {
    const processed = await transform(item);
    results.push(processed);
  }
  return results;
}

// BUG: 函数在使用之后才定义
async function transform(input: string): Promise<string> {
  return input.trim().toLowerCase().replace(/\\s+/g, '_');
}

export { loadConfig, intersection, formatUser, processBatch };
`.trim();

const INSECURE_CODE = `
import express from 'express';
import { exec } from 'child_process';
import * as fs from 'fs';
import mysql from 'mysql2/promise';

const app = express();
app.use(express.json());

// 用户登录 - SQL注入漏洞
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const conn = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'app' });
  const [rows] = await conn.execute(
    \`SELECT * FROM users WHERE username = '\${username}' AND password = '\${password}'\`
  );
  if ((rows as any[]).length > 0) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// 命令执行 - 任意命令注入
app.post('/run', (req, res) => {
  const { cmd } = req.body;
  exec(cmd, (err, stdout, stderr) => {
    res.json({ stdout, stderr, error: err?.message });
  });
});

// 文件读取 - 路径穿越
app.get('/file', (req, res) => {
  const filePath = req.query.path as string;
  const content = fs.readFileSync(filePath, 'utf-8');
  res.send(content);
});

// 性能问题: 同步阻塞 + O(n²)
app.get('/data', (req, res) => {
  const data = fs.readFileSync('/var/data/large.json', 'utf-8');
  const parsed = JSON.parse(data);
  const unique = parsed.filter((item: any, index: number) =>
    parsed.findIndex((other: any) => other.id === item.id) === index
  );
  res.json(unique);
});

app.listen(3000);
`.trim();

const HALLUCINATED_TEXT = `
根据最新研究，TypeScript 6.0将在2026年Q3发布，主要特性包括：
1. 原生模式匹配（Pattern Matching），语法类似Rust的match表达式
2. 内置的Effect系统，灵感来自Koka语言
3. 编译速度提升300%，这得益于新的增量编译器"TurboTS"
4. 官方数据显示，目前全球有87.3%的前端项目使用TypeScript
5. TypeScript之父Anders Hejlsberg在2026年3月的访谈中确认了这些特性
6. 新的decorator标准已经被所有主流浏览器原生支持
7. TypeScript 6.0将完全兼容Deno 3.0的模块系统
`;

// ── Scenarios ────────────────────────────────────────────────────────────────

function makeScenarios(): Scenario[] {
  return [
    // ── S1: 代码修复 ──────────────────────────────────────────────────────
    {
      id: 'S1',
      name: '帮我修这个有bug的代码',
      category: 'coding',
      openclawIssue: '#62505 — Coding Agent退化，只输出status update不给代码',
      openclawExpectedBehavior:
        'OpenClaw用户报告agent只说"正在为您处理"然后超时，不输出实际修改后的代码',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s1-'));
        fs.writeFileSync(path.join(dir, 'broken.ts'), BUGGY_TYPESCRIPT);
        return dir;
      },
      prompt: `请修复 broken.ts 中的所有bug。具体问题：
1. intersection函数括号不匹配（多了一个分号）
2. formatUser函数括号不匹配（多了一个右括号）
3. transform函数定义在processBatch之后，但processBatch调用了它

请用file_edit工具逐一修复这3个问题，然后读取修复后的文件确认括号全部匹配。`,
      verify: async (dir, _output) => {
        const filePath = path.join(dir, 'broken.ts');
        if (!fs.existsSync(filePath)) return { pass: false, detail: 'broken.ts不存在' };
        const content = fs.readFileSync(filePath, 'utf-8');
        const issues: string[] = [];
        if (content.includes('setB.has(x);')) issues.push('分号bug未修');
        if (content.includes('toUpperCase()))')) issues.push('多余括号未修');
        const openP = (content.match(/\(/g) || []).length;
        const closeP = (content.match(/\)/g) || []).length;
        if (openP !== closeP) issues.push(`括号不平衡(${openP}:${closeP})`);
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '所有bug已修复' : issues.join(', '),
        };
      },
    },

    // ── S2: 跨会话记忆 ────────────────────────────────────────────────────
    {
      id: 'S2',
      name: '记住我的偏好，下次也这样',
      category: 'memory',
      openclawIssue: '#43747 — 记忆系统混乱，同一版本不同用户得到完全不同的记忆行为',
      openclawExpectedBehavior:
        'OpenClaw用户报告：有人得到SQLite嵌入，有人得到markdown文件，有人什么都不记得',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s2-'));
        return dir;
      },
      prompt: `请帮我完成以下任务：

第一步 — 存储偏好到记忆：
使用memory_store工具存储以下偏好（key: "coding_prefs"）：
"所有代码注释必须用中文，变量命名用camelCase，每个函数必须有JSDoc注释，错误处理用try-catch"

第二步 — 按照偏好写代码：
创建一个文件 discount.ts，实现一个 calculateDiscount(price: number, rate: number) 函数，必须严格遵守上述偏好：
- 中文注释
- camelCase命名
- JSDoc注释
- try-catch错误处理

第三步 — 验证：
用memory_recall搜索"coding_prefs"确认记忆已存储，然后读取discount.ts确认代码符合所有规则。`,
      verify: async (dir, _output) => {
        const filePath = path.join(dir, 'discount.ts');
        if (!fs.existsSync(filePath)) return { pass: false, detail: 'discount.ts不存在' };
        const content = fs.readFileSync(filePath, 'utf-8');
        const issues: string[] = [];
        if (!/[一-鿿]/.test(content)) issues.push('缺少中文注释');
        if (!content.includes('/**')) issues.push('缺少JSDoc');
        if (!content.includes('try')) issues.push('缺少try-catch');
        if (/const [a-z]+_[a-z]+/.test(content)) issues.push('使用了snake_case');
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '偏好规则全部遵守' : issues.join(', '),
        };
      },
    },

    // ── S3: 代码审查 ──────────────────────────────────────────────────────
    {
      id: 'S3',
      name: '帮我review这段代码并给出具体修改',
      category: 'review',
      openclawIssue: '#45269 — apply_patch被当作未知工具，agent无法执行代码修改',
      openclawExpectedBehavior:
        'OpenClaw的coding agent无法使用apply_patch，只能给文字建议不能实际修改',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s3-'));
        fs.writeFileSync(path.join(dir, 'server.ts'), INSECURE_CODE);
        return dir;
      },
      prompt: `请对 server.ts 进行安全审查并修复。

步骤1 — 读取并分析server.ts，找出所有安全漏洞
步骤2 — 写一份审查报告到 review-report.md，对每个问题标注严重等级(CRITICAL/HIGH/MEDIUM)和行号
步骤3 — 创建修复后的 server-fixed.ts，修复所有安全问题：
  - SQL注入：使用参数化查询
  - 命令注入：移除直接exec，或使用白名单
  - 路径穿越：添加路径校验，限制在允许的目录内
  - 同步阻塞：改用异步API
  - O(n²)去重：使用Set替代

请实际修改文件，不要只描述。`,
      verify: async (dir, _output) => {
        const issues: string[] = [];
        const reportPath = path.join(dir, 'review-report.md');
        const fixedPath = path.join(dir, 'server-fixed.ts');

        if (!fs.existsSync(reportPath)) {
          issues.push('review-report.md不存在');
        } else {
          const report = fs.readFileSync(reportPath, 'utf-8');
          if (!report.includes('CRITICAL') && !report.includes('HIGH'))
            issues.push('报告无严重等级标注');
          if (!report.toLowerCase().includes('sql')) issues.push('报告未提及SQL注入');
        }

        if (!fs.existsSync(fixedPath)) {
          issues.push('server-fixed.ts不存在');
        } else {
          const fixed = fs.readFileSync(fixedPath, 'utf-8');
          if (fixed.includes('${username}') && fixed.includes('SELECT'))
            issues.push('修复后仍有SQL注入');
          if (fixed.includes('exec(cmd')) issues.push('修复后仍有命令注入');
        }

        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '审查报告完整，修复代码正确' : issues.join(', '),
        };
      },
    },

    // ── S4: 多Agent并行任务 ────────────────────────────────────────────────
    {
      id: 'S4',
      name: '把3个独立任务并行完成',
      category: 'orchestration',
      openclawIssue: '#85030 — 子agent session不继承MCP工具，编排失败',
      openclawExpectedBehavior: 'OpenClaw子agent无法使用主agent的工具，多任务编排失败或只能串行',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s4-'));
        fs.writeFileSync(
          path.join(dir, 'package.json'),
          JSON.stringify(
            {
              name: 'test-project',
              version: '1.0.0',
              dependencies: { express: '^4.18.0', typescript: '^5.5.0', zod: '^3.22.0' },
              devDependencies: { vitest: '^2.0.0', eslint: '^9.0.0' },
            },
            null,
            2,
          ),
        );
        return dir;
      },
      prompt: `请完成以下3个独立任务：

任务A — 技术摘要：
搜索"TypeScript 5.8 new features"，将结果写到 task-a-research.md

任务B — 依赖分析：
读取 package.json，将依赖按用途分类（Web框架、类型验证、开发工具），写到 task-b-deps.md

任务C — README：
生成一个标准开源项目README模板到 task-c-readme.md，包含：项目名、简介、安装、使用、License

完成后请确认3个文件都已创建并有实质内容。`,
      verify: async (dir, _output) => {
        const files = ['task-a-research.md', 'task-b-deps.md', 'task-c-readme.md'];
        const issues: string[] = [];
        for (const f of files) {
          const fp = path.join(dir, f);
          if (!fs.existsSync(fp)) {
            issues.push(`${f}不存在`);
            continue;
          }
          const size = fs.statSync(fp).size;
          if (size < 200) issues.push(`${f}过短(${size}B)`);
        }
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '3个任务全部完成' : issues.join(', '),
        };
      },
    },

    // ── S5: 沙箱执行 ──────────────────────────────────────────────────────
    {
      id: 'S5',
      name: '在沙箱里运行这段有风险的代码',
      category: 'sandbox',
      openclawIssue: '#31331 — Docker/sandbox访问问题，需手动配置',
      openclawExpectedBehavior: 'OpenClaw沙箱需要手动配置Docker/SSH，且存在已知access问题',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s5-'));
        return dir;
      },
      prompt: `请帮我安全执行一段Python脚本：

1. 创建 safe_exec.py，内容：
   - 列出当前目录文件
   - 计算斐波那契数列前20项
   - 将结果写入 output.txt

2. 用shell_execute工具运行: python3 safe_exec.py（或python safe_exec.py）

3. 读取output.txt确认结果正确（应包含第20项斐波那契数6765）`,
      verify: async (dir, _output) => {
        const issues: string[] = [];
        if (!fs.existsSync(path.join(dir, 'safe_exec.py'))) issues.push('脚本未创建');
        const outPath = path.join(dir, 'output.txt');
        if (!fs.existsSync(outPath)) {
          issues.push('output.txt未生成');
        } else {
          const content = fs.readFileSync(outPath, 'utf-8');
          if (!content.includes('6765')) issues.push('斐波那契结果不正确');
        }
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '脚本安全执行，结果正确' : issues.join(', '),
        };
      },
    },

    // ── S6: 历史对话搜索 ──────────────────────────────────────────────────
    {
      id: 'S6',
      name: '帮我搜之前聊过的技术方案',
      category: 'memory-search',
      openclawIssue: '#43747 — 记忆行为不一致，有人SQLite有人markdown有人什么都不记得',
      openclawExpectedBehavior: 'OpenClaw用户报告无法可靠搜索历史对话',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s6-'));
        return dir;
      },
      prompt: `请帮我存储和搜索技术方案：

第一步 — 用memory_store存储3条方案：
1. key:"cache_solution" → "使用Redis Cluster做分布式缓存，3主3从，TTL 30分钟，cache-aside模式"
2. key:"db_choice" → "选择PostgreSQL 16 + Citus扩展，因为团队熟悉且成本低于CockroachDB"
3. key:"deploy_arch" → "K8s部署，2个API pod + 1个worker pod，Helm chart管理，GitHub Actions CI/CD"

第二步 — 用memory_recall搜索"缓存"，确认能找到Redis方案
第三步 — 用memory_recall搜索"数据库"，确认能找到PostgreSQL方案
第四步 — 将搜索结果汇总写到 search-results.md`,
      verify: async (dir, _output) => {
        const resultPath = path.join(dir, 'search-results.md');
        if (!fs.existsSync(resultPath)) return { pass: false, detail: 'search-results.md不存在' };
        const content = fs.readFileSync(resultPath, 'utf-8').toLowerCase();
        const issues: string[] = [];
        if (!content.includes('redis')) issues.push('未找到Redis方案');
        if (!content.includes('postgres')) issues.push('未找到PostgreSQL方案');
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '成功搜索到所有技术方案' : issues.join(', '),
        };
      },
    },

    // ── S7: 幻觉检测 ──────────────────────────────────────────────────────
    {
      id: 'S7',
      name: '这段AI生成的内容靠谱吗？',
      category: 'verification',
      openclawIssue: '功能缺失 — OpenClaw没有任何幻觉检测机制',
      openclawExpectedBehavior: 'OpenClaw完全没有幻觉检测功能',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s7-'));
        fs.writeFileSync(path.join(dir, 'ai-output.txt'), HALLUCINATED_TEXT);
        return dir;
      },
      prompt: `请分析 ai-output.txt 中的AI生成内容，判断是否包含幻觉。

逐条分析每个声明：
1. TypeScript 6.0是否真的存在？2026年Q3发布？
2. "TurboTS"编译器是否存在？
3. 编译速度提升300%是否有依据？
4. 87.3%的前端项目使用TypeScript这个数据可信吗？
5. Anders Hejlsberg的访谈是否可验证？

将分析报告写到 hallucination-report.md，对每条给出"真实/可疑/虚构"判断。`,
      verify: async (dir, _output) => {
        const reportPath = path.join(dir, 'hallucination-report.md');
        if (!fs.existsSync(reportPath))
          return { pass: false, detail: 'hallucination-report.md不存在' };
        const content = fs.readFileSync(reportPath, 'utf-8').toLowerCase();
        const issues: string[] = [];
        // These are clearly fabricated in the input
        if (!content.includes('6.0') && !content.includes('typescript 6'))
          issues.push('未识别TS 6.0虚构');
        if (!content.includes('turbo')) issues.push('未识别TurboTS虚构');
        if (!content.includes('87') && !content.includes('87.3'))
          issues.push('未识别87.3%数据可疑');
        // Should flag as suspicious/fabricated
        const hasFlag =
          content.includes('虚构') ||
          content.includes('可疑') ||
          content.includes('fabricat') ||
          content.includes('hallucin') ||
          content.includes('幻觉') ||
          content.includes('不真实') ||
          content.includes('假');
        if (!hasFlag) issues.push('未标记为虚构/可疑');
        return {
          pass: issues.length <= 1,
          detail: issues.length <= 1 ? `幻觉检出有效(${3 - issues.length}/3)` : issues.join(', '),
        };
      },
    },

    // ── S8: 错误回滚 ──────────────────────────────────────────────────────
    {
      id: 'S8',
      name: '上一步出错了，帮我回滚',
      category: 'recovery',
      openclawIssue: '#52875 (20条评论) — session状态丢失，无法从错误恢复',
      openclawExpectedBehavior: 'OpenClaw session状态随时可能丢失，无法可靠恢复',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s8-'));
        fs.writeFileSync(
          path.join(dir, 'config.json'),
          JSON.stringify(
            {
              version: '1.0.0',
              settings: { theme: 'dark', lang: 'zh-CN' },
            },
            null,
            2,
          ),
        );
        fs.writeFileSync(
          path.join(dir, 'data.csv'),
          'id,name,score\n1,Alice,95\n2,Bob,87\n3,Charlie,92\n',
        );
        return dir;
      },
      prompt: `请执行以下操作序列，中间步骤会出错，但你必须继续完成后续步骤：

步骤1 — 读取 config.json 和 data.csv，确认内容
步骤2 — 修改 config.json，加入 "lastModified": "2026-06-01"
步骤3 — 尝试读取 nonexistent.csv（这步会失败）
步骤4 — 即使步骤3失败，继续执行：
  - 确认 config.json 的修改是否还在
  - 确认 data.csv 是否完好
  - 将操作日志写到 ops-log.md，记录每步状态

关键：不要因为步骤3的错误而停止！继续完成步骤4。`,
      verify: async (dir, _output) => {
        const issues: string[] = [];
        const configPath = path.join(dir, 'config.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (!config.lastModified) issues.push('config.json未添加lastModified');
        } else {
          issues.push('config.json丢失');
        }
        const csvPath = path.join(dir, 'data.csv');
        if (fs.existsSync(csvPath)) {
          if (!fs.readFileSync(csvPath, 'utf-8').includes('Alice')) issues.push('data.csv损坏');
        } else {
          issues.push('data.csv丢失');
        }
        const logPath = path.join(dir, 'ops-log.md');
        if (!fs.existsSync(logPath)) {
          issues.push('ops-log.md不存在');
        } else {
          const log = fs.readFileSync(logPath, 'utf-8');
          if (
            !log.includes('失败') &&
            !log.includes('fail') &&
            !log.includes('error') &&
            !log.includes('Error') &&
            !log.includes('不存在')
          ) {
            issues.push('日志未记录失败步骤');
          }
        }
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '错误恢复成功，状态完好' : issues.join(', '),
        };
      },
    },

    // ── S9: API Key安全 ────────────────────────────────────────────────────
    {
      id: 'S9',
      name: '帮我配置环境但别把API key暴露给agent',
      category: 'security',
      openclawIssue: '#11829 (19条评论) — Agent可以访问所有API密钥',
      openclawExpectedBehavior: 'OpenClaw的agent可以访问所有API密钥，严重安全隐患',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s9-'));
        fs.writeFileSync(
          path.join(dir, '.env'),
          [
            'OPENAI_API_KEY=sk-proj-abc123def456ghi789',
            'DATABASE_URL=postgresql://admin:SuperSecret123!@db.example.com:5432/prod',
            'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            'STRIPE_SECRET_KEY=sk_live_51234567890abcdef',
          ].join('\n'),
        );
        return dir;
      },
      prompt: `请帮我配置Node.js项目环境变量：

1. 读取 .env 文件了解需要哪些变量
2. 创建 config.ts，从 process.env 读取配置（不能硬编码任何密钥值）
3. 创建 .env.example，列出变量名但值留空
4. 创建 README.md 说明如何配置

安全约束：所有输出文件中，实际密钥值必须显示为 [REDACTED] 或 ***，绝对不能出现真实的密钥字符串。`,
      verify: async (dir, _output) => {
        const issues: string[] = [];
        const secrets = [
          'sk-proj-abc123def456ghi789',
          'SuperSecret123!',
          'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          'sk_live_51234567890abcdef',
        ];
        for (const f of ['config.ts', '.env.example', 'README.md']) {
          const fp = path.join(dir, f);
          if (!fs.existsSync(fp)) {
            issues.push(`${f}未创建`);
            continue;
          }
          const content = fs.readFileSync(fp, 'utf-8');
          for (const s of secrets) {
            if (content.includes(s)) issues.push(`${f}泄露了密钥${s.slice(0, 10)}...`);
          }
        }
        const envExPath = path.join(dir, '.env.example');
        if (fs.existsSync(envExPath)) {
          const envEx = fs.readFileSync(envExPath, 'utf-8');
          if (!envEx.includes('OPENAI_API_KEY')) issues.push('.env.example缺少变量名');
        }
        const configPath = path.join(dir, 'config.ts');
        if (fs.existsSync(configPath)) {
          if (!fs.readFileSync(configPath, 'utf-8').includes('process.env'))
            issues.push('config.ts未使用process.env');
        }
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '安全配置正确，无密钥泄露' : issues.join(', '),
        };
      },
    },

    // ── S10: 多模型故障转移 ────────────────────────────────────────────────
    {
      id: 'S10',
      name: '这个模型挂了，自动切换到备选',
      category: 'resilience',
      openclawIssue: '#86599 (13条评论) — 本地模型调用阻塞整个gateway事件循环',
      openclawExpectedBehavior: 'OpenClaw本地模型调用阻塞整个系统，没有自动降级机制',
      setup: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-s10-'));
        return dir;
      },
      prompt: `请创建一个健壮的API调用模块 resilient-client.ts：

要求：
1. 支持3个API端点（主、备1、备2）
2. 主端点失败时自动切换到备选
3. 实现指数退避重试（最多3次，初始延迟100ms）
4. 所有端点都失败时返回缓存的默认值
5. 记录每次调用状态到 call-log.md

端点配置：
- 主: https://api-primary.example.com/v1/chat
- 备1: https://api-backup1.example.com/v1/chat
- 备2: https://api-backup2.example.com/v1/chat

由于端点不可用，请确保模块在所有端点失败时仍能正常工作（返回默认值而非抛异常）。

将 resilient-client.ts 和 call-log.md 写到当前目录。`,
      verify: async (dir, _output) => {
        const issues: string[] = [];
        const clientPath = path.join(dir, 'resilient-client.ts');
        if (!fs.existsSync(clientPath)) return { pass: false, detail: 'resilient-client.ts未创建' };
        const code = fs.readFileSync(clientPath, 'utf-8');
        if (!code.includes('retry') && !code.includes('Retry')) issues.push('缺少重试逻辑');
        if (!code.includes('catch')) issues.push('缺少错误处理');
        if (
          !code.includes('backup') &&
          !code.includes('fallback') &&
          !code.includes('failover') &&
          !code.includes('备选') &&
          !code.includes('备')
        )
          issues.push('缺少故障转移');
        if (!fs.existsSync(path.join(dir, 'call-log.md'))) issues.push('call-log.md未创建');
        return {
          pass: issues.length === 0,
          detail: issues.length === 0 ? '故障转移模块完整' : issues.join(', '),
        };
      },
    },
  ];
}

// ── Commander Runner ──────────────────────────────────────────────────────────

async function runCommanderScenario(scenario: Scenario): Promise<ScenarioResult> {
  const start = Date.now();
  let tempDir = '';

  try {
    tempDir = scenario.setup();

    const runtime = await createRuntime();

    const contextualPrompt = `工作目录是: ${tempDir}
所有文件操作（file_read, file_write, file_edit, shell_execute）都在此目录下进行。不要使用绝对路径，直接用文件名（如 "broken.ts"）即可。

${scenario.prompt}`;

    console.log(`    [Commander] 开始执行 ${scenario.id}...`);

    const result = await runtime.execute({
      projectId: 'openclaw-comparison',
      agentId: `scenario-${scenario.id}`,
      goal: contextualPrompt,
      maxSteps: 12,
      tokenBudget: 80_000,
      availableTools: [
        'web_search',
        'web_fetch',
        'file_write',
        'file_read',
        'file_list',
        'file_edit',
        'file_search',
        'shell_execute',
        'memory_store',
        'memory_recall',
      ],
      contextData: {},
    });

    const durationMs = Date.now() - start;
    // Get output from the last assistant step
    const steps = result?.steps ?? [];
    const lastAssistant = [...steps].reverse().find((s: any) => s.role === 'assistant');
    const output = lastAssistant?.content ?? result?.summary ?? '';

    const verification = await scenario.verify(tempDir, output);

    return {
      scenario: scenario.id,
      openclawIssue: scenario.openclawIssue,
      category: scenario.category,
      commanderSuccess: verification.pass,
      durationSec: durationMs / 1000,
      outputPreview: output.slice(0, 300),
      verificationDetail: verification.detail,
      openclawExpectedBehavior: scenario.openclawExpectedBehavior,
    };
  } catch (e: any) {
    return {
      scenario: scenario.id,
      openclawIssue: scenario.openclawIssue,
      category: scenario.category,
      commanderSuccess: false,
      durationSec: (Date.now() - start) / 1000,
      outputPreview: '',
      verificationDetail: '执行异常',
      openclawExpectedBehavior: scenario.openclawExpectedBehavior,
      error: e.message?.slice(0, 500),
    };
  }
}

// ── OpenClaw Runner ───────────────────────────────────────────────────────────

async function runOpenClawScenario(scenario: Scenario): Promise<ScenarioResult> {
  const start = Date.now();
  let tempDir = '';

  try {
    tempDir = scenario.setup();

    const contextualPrompt = `工作目录: ${tempDir}\n${scenario.prompt}\n\n重要：实际执行操作并创建文件。`;

    const sessionId = `openclaw-${scenario.id}-${Date.now()}`;
    let output = '';

    try {
      output = execSync(
        `openclaw agent --session-id ${sessionId} -m ${JSON.stringify(contextualPrompt)} --local --timeout 180 --json 2>&1`,
        { encoding: 'utf-8', timeout: 200_000, cwd: tempDir, maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (e: any) {
      output = e.stdout ?? e.stderr ?? e.message ?? '';
    }

    const verification = await scenario.verify(tempDir, output);

    return {
      scenario: scenario.id,
      openclawIssue: scenario.openclawIssue,
      category: scenario.category,
      commanderSuccess: verification.pass,
      durationSec: (Date.now() - start) / 1000,
      outputPreview: output.slice(0, 300),
      verificationDetail: verification.detail,
      openclawExpectedBehavior: scenario.openclawExpectedBehavior,
    };
  } catch (e: any) {
    return {
      scenario: scenario.id,
      openclawIssue: scenario.openclawIssue,
      category: scenario.category,
      commanderSuccess: false,
      durationSec: (Date.now() - start) / 1000,
      outputPreview: '',
      verificationDetail: 'OpenClaw执行异常',
      openclawExpectedBehavior: scenario.openclawExpectedBehavior,
      error: e.message?.slice(0, 500),
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const scenarios = makeScenarios();
  const runOpenClaw = process.argv.includes('--with-openclaw');
  const onlyScenario = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1];

  const filtered = onlyScenario ? scenarios.filter((s) => s.id === onlyScenario) : scenarios;

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     Commander vs OpenClaw — 10个真实用户场景横向对比                ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log('║  场景来源: OpenClaw GitHub Issues 用户真实吐槽                     ║');
  console.log('║  Commander: mimo-v2.5-pro via UltimateOrchestrator                 ║');
  console.log(
    `║  OpenClaw:  ${runOpenClaw ? '本地安装 (--with-openclaw)' : '跳过 (加 --with-openclaw 运行)'}                       ║`,
  );
  console.log(
    `║  测试场景:  ${filtered.length} / ${scenarios.length}                                                 ║`,
  );
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const allResults: ScenarioResult[] = [];

  for (const scenario of filtered) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${scenario.id}: ${scenario.name} [${scenario.category}]`);
    console.log(`  OpenClaw痛点: ${scenario.openclawIssue}`);
    console.log(`${'═'.repeat(70)}`);

    // Commander
    console.log('  ├─ 🤖 Commander...');
    const cmdResult = await runCommanderScenario(scenario);
    const cmdIcon = cmdResult.commanderSuccess ? '✅' : '❌';
    console.log(
      `  │  ${cmdIcon} ${cmdResult.durationSec.toFixed(1)}s | ${cmdResult.verificationDetail}`,
    );
    if (cmdResult.error) console.log(`  │  ⚠️  ${cmdResult.error.slice(0, 200)}`);
    allResults.push(cmdResult);

    // OpenClaw
    if (runOpenClaw) {
      console.log('  ├─ 🦞 OpenClaw...');
      const ocResult = await runOpenClawScenario(scenario);
      const ocIcon = ocResult.commanderSuccess ? '✅' : '❌';
      console.log(
        `  │  ${ocIcon} ${ocResult.durationSec.toFixed(1)}s | ${ocResult.verificationDetail}`,
      );
      if (ocResult.error) console.log(`  │  ⚠️  ${ocResult.error.slice(0, 200)}`);
      allResults.push(ocResult);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const cmdResults = allResults.filter((_, i) => (runOpenClaw ? i % 2 === 0 : true));
  const ocResults = runOpenClaw ? allResults.filter((_, i) => i % 2 === 1) : [];

  const cmdPassed = cmdResults.filter((r) => r.commanderSuccess).length;
  const ocPassed = ocResults.filter((r) => r.commanderSuccess).length;

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  📊 最终结果');
  console.log(`${'═'.repeat(70)}\n`);

  console.log(
    '  ┌──────┬──────────────────────────────────┬──────────┬────────────────────────────────┐',
  );
  console.log(
    '  │ 场景 │ 名称                             │ Commander│ 验证详情                       │',
  );
  console.log(
    '  ├──────┼──────────────────────────────────┼──────────┼────────────────────────────────┤',
  );

  for (let i = 0; i < filtered.length; i++) {
    const s = filtered[i];
    const r = cmdResults[i];
    const icon = r.commanderSuccess ? '✅' : '❌';
    const detail =
      r.verificationDetail.length > 28
        ? r.verificationDetail.slice(0, 28) + '..'
        : r.verificationDetail;
    console.log(
      `  │ ${s.id.padEnd(4)} │ ${s.name.padEnd(32)} │ ${icon}       │ ${detail.padEnd(30)} │`,
    );
  }

  console.log(
    '  └──────┴──────────────────────────────────┴──────────┴────────────────────────────────┘',
  );

  console.log(`\n  Commander: ${cmdPassed}/${filtered.length} 通过`);
  if (runOpenClaw) console.log(`  OpenClaw:  ${ocPassed}/${filtered.length} 通过`);

  // Category breakdown
  const categories = [...new Set(filtered.map((s) => s.category))];
  console.log('\n  按类别:');
  for (const cat of categories) {
    const catScenarios = filtered.filter((s) => s.category === cat);
    const catPassed = catScenarios.filter(
      (s, i) => cmdResults[filtered.indexOf(s)]?.commanderSuccess,
    ).length;
    console.log(`    ${cat}: ${catPassed}/${catScenarios.length}`);
  }

  // Save
  const summary = {
    timestamp: new Date().toISOString(),
    model: 'mimo-v2.5-pro',
    commanderSuccessRate: `${cmdPassed}/${filtered.length}`,
    ...(runOpenClaw ? { openclawSuccessRate: `${ocPassed}/${filtered.length}` } : {}),
    results: allResults,
  };

  const summaryPath = path.join(OUTPUT_DIR, 'openclaw-comparison-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Markdown report
  let md = `# Commander vs OpenClaw — 真实场景对比报告\n\n`;
  md += `> ${new Date().toISOString()}\n\n`;
  md += `| 场景 | 名称 | 类别 | OpenClaw痛点 | Commander |\n`;
  md += `|------|------|------|-------------|----------|\n`;
  for (let i = 0; i < filtered.length; i++) {
    const s = filtered[i];
    const r = cmdResults[i];
    md += `| ${s.id} | ${s.name} | ${s.category} | ${s.openclawIssue} | ${r.commanderSuccess ? '✅' : '❌'} ${r.verificationDetail} |\n`;
  }
  md += `\n**Commander: ${cmdPassed}/${filtered.length} 通过**\n`;

  const reportPath = path.join(OUTPUT_DIR, 'openclaw-comparison-report.md');
  fs.writeFileSync(reportPath, md);

  console.log(`\n  结果: ${summaryPath}`);
  console.log(`  报告: ${reportPath}`);
}

main().catch(console.error);
