#!/usr/bin/env npx tsx
/**
 * Commander 综合压力测试 — 单任务同时考验5大核心能力
 *
 * 场景: 从零构建一个安全的、可观测的、自动优化的任务调度系统
 * 需要同时使用: 编排 + 记忆 + 质量门禁 + 自我进化 + 安全沙箱
 *
 * Usage:
 *   npx tsx packages/core/tests/commander-combined-stress.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const TEST_WORKSPACE = path.join(process.cwd(), '.combined-test-workspace');
if (!fs.existsSync(TEST_WORKSPACE)) fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
process.env.COMMANDER_WORKSPACE = TEST_WORKSPACE;

function named(mod: any, name: string): any {
  return mod[name] ?? mod.default?.[name] ?? mod.default;
}

let _modules: any = null;
async function loadModules() {
  if (_modules) return _modules;
  const [agentMod, telosMod, ultMod, mimoMod, webMod, fileMod, codeMod, persistMod] = await Promise.all([
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
    apiKey: process.env.MIMO_API_KEY || '',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5',
  });
  const runtime = new M.AgentRuntime({ budgetHardCapTokens: 500_000, maxSteps: 20 });
  runtime.registerProvider('mimo', provider);
  runtime.registerProvider('openai', provider);
  const tools: Record<string, any> = {
    web_search: new M.WebSearchTool(), web_fetch: new M.WebFetchTool(),
    file_write: new M.FileWriteTool(), file_read: new M.FileReadTool(),
    file_list: new M.FileListTool(), file_edit: new M.FileEditTool(),
    file_search: new M.FileSearchTool(), shell_execute: new M.ShellExecuteTool(),
    memory_store: new M.MemoryStoreTool(), memory_recall: new M.MemoryRecallTool(),
  };
  for (const [name, tool] of Object.entries(tools)) runtime.registerTool(name, tool);
  return runtime;
}

function walkDir(dir: string, prefix: string = ''): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...walkDir(path.join(dir, entry.name), relPath));
      else files.push(relPath);
    }
  } catch {}
  return files;
}

// ═══════════════════════════════════════════════════════════════════════════
// 综合场景: 从零构建一个安全的、可观测的任务调度系统
// ═══════════════════════════════════════════════════════════════════════════

const TASK = `
请从零构建一个**安全的、可观测的、自动优化的分布式任务调度系统**.

这个系统需要:
1. 支持定时任务(Cron)和一次性任务
2. 支持任务依赖(DAG)
3. 任务执行有安全沙箱隔离
4. 有完整的可观测性(指标、日志、追踪)
5. 有自我优化机制(根据历史执行数据调整调度策略)

## 第1步 — 核心实现 (src/)

### src/scheduler.ts — 调度器核心
- Scheduler类: addJob, removeJob, start, stop, getJobStatus
- 支持Cron表达式解析
- 支持一次性任务延迟执行
- 任务队列管理(优先级、并发限制)

### src/job.ts — 任务定义
- Job类: id, name, cron, handler, priority, timeout, retries, dependencies
- JobStatus: pending, running, success, failed, timeout, cancelled
- JobResult: output, durationMs, error, retryCount

### src/dag.ts — DAG依赖管理
- DAG类: addNode, addEdge, getExecutionOrder, hasCycle, getReadyJobs
- 拓扑排序计算执行顺序
- 环检测防止死锁
- 就绪任务识别(所有依赖已完成)

### src/sandbox.ts — 任务沙箱
- Sandbox类: execute(job, context)
- 超时控制(AbortController)
- 内存限制监控
- 输出捕获(stdout/stderr)
- 错误隔离(一个任务失败不影响其他)

### src/metrics.ts — 可观测性
- Metrics类: counter, gauge, histogram, timer
- 任务执行计数(成功/失败/超时)
- 执行耗时直方图
- 活跃任务数
- 队列深度
- 导出Prometheus格式

### src/optimizer.ts — 自我优化
- Optimizer类: analyzeHistory, suggestChanges, applyOptimization
- 分析历史执行数据
- 识别慢任务和频繁失败任务
- 建议调整: 增加重试、调整超时、修改并发数、重新排序优先级
- 记录优化决策和效果

### src/logger.ts — 结构化日志
- Logger类: info, warn, error, debug
- JSON格式输出
- 上下文注入(jobId, traceId)
- 日志级别控制

### src/index.ts — 入口
- 创建Scheduler实例
- 注册默认任务
- 启动调度器
- 暴露HTTP API(可选)

## 第2步 — 安全审查 (security/)

### security/audit.md
审查以上代码的安全风险:
- 沙箱逃逸可能性
- 任务注入风险
- 资源耗尽攻击
- 敏感信息泄露

### security/policy.json
定义执行策略:
- 允许的系统调用
- 网络访问限制
- 文件系统限制
- 资源配额

## 第3步 — 质量验证 (quality/)

### quality/test-plan.md
测试计划:
- 单元测试用例列表(至少15个)
- 集成测试场景(至少5个)
- 边界条件测试(至少5个)

### quality/performance.md
性能分析:
- 时间复杂度分析(每个核心操作)
- 空间复杂度分析
- 瓶颈识别
- 优化建议

## 第4步 — 进化记录 (evolution/)

### evolution/optimization-log.md
记录设计过程中的权衡:
- 为什么选择这种调度算法
- 为什么用这种沙箱隔离方式
- 为什么用这种指标格式
- 如果重来会做什么不同的决定

### evolution/strategy-scores.md
对3种调度策略评分:
1. 简单FIFO
2. 优先级+公平调度
3. 基于历史数据的自适应调度

## 第5步 — 配置和文档

### package.json — 依赖配置
### tsconfig.json — TypeScript配置
### README.md — 完整文档(架构图、API参考、使用示例)

## 验证标准
每个文件必须有完整的实现代码,不能只有注释或空壳.
`;

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     Commander 综合压力测试 — 单任务考验5大能力                     ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log('║  场景: 从零构建安全的、可观测的、自动优化的任务调度系统             ║');
  console.log('║  能力: 编排+记忆+质量门禁+自我进化+安全沙箱                        ║');
  console.log('║  模型: mimo-v2.5                                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const tempDir = fs.mkdtempSync(path.join(TEST_WORKSPACE, 'combined-'));
  const relDir = path.relative(TEST_WORKSPACE, tempDir);
  const runtime = await createRuntime();

  const prompt = `CRITICAL: You MUST use tools (file_write, file_edit, file_read, memory_store, memory_recall) to create files. Do NOT just describe.

IMPORTANT: All file paths must start with "${relDir}/".

${TASK}`;

  const start = Date.now();
  console.log('  开始执行综合任务...\n');

  try {
    const result = await runtime.execute({
      projectId: 'combined-stress',
      agentId: 'combined-v1',
      goal: prompt,
      maxSteps: 20,
      tokenBudget: 400_000,
      availableTools: ['web_search', 'web_fetch', 'file_write', 'file_read', 'file_list', 'file_edit', 'file_search', 'shell_execute', 'memory_store', 'memory_recall'],
      contextData: {},
    });

    const durationSec = (Date.now() - start) / 1000;
    const files = walkDir(tempDir);

    // ── 验证 ───────────────────────────────────────────────────────────
    const checks: Record<string, { passed: boolean; detail: string }> = {};

    // 编排: 核心模块完整
    const srcFiles = files.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
    const coreModules = ['scheduler.ts', 'job.ts', 'dag.ts', 'sandbox.ts', 'metrics.ts', 'optimizer.ts'];
    const missingCore = coreModules.filter(m => !srcFiles.some(f => f.endsWith(m)));
    checks['编排-核心模块'] = {
      passed: missingCore.length === 0 && srcFiles.length >= 5,
      detail: missingCore.length === 0 ? `${srcFiles.length}个源码模块完整` : `缺少: ${missingCore.join(', ')}`,
    };

    // 质量门禁: 测试计划+性能分析
    const hasTestPlan = files.some(f => f.includes('test-plan'));
    const hasPerf = files.some(f => f.includes('performance'));
    checks['质量门禁'] = {
      passed: hasTestPlan && hasPerf,
      detail: hasTestPlan && hasPerf ? '测试计划+性能分析完整' : `测试计划:${hasTestPlan}, 性能分析:${hasPerf}`,
    };

    // 安全沙箱: 审计+策略
    const hasAudit = files.some(f => f.includes('audit'));
    const hasPolicy = files.some(f => f.includes('policy'));
    checks['安全沙箱'] = {
      passed: hasAudit && hasPolicy,
      detail: hasAudit && hasPolicy ? '安全审计+执行策略完整' : `审计:${hasAudit}, 策略:${hasPolicy}`,
    };

    // 自我进化: 优化日志+策略评分
    const hasOptLog = files.some(f => f.includes('optimization-log'));
    const hasScores = files.some(f => f.includes('strategy-scores'));
    checks['自我进化'] = {
      passed: hasOptLog && hasScores,
      detail: hasOptLog && hasScores ? '优化日志+策略评分完整' : `优化日志:${hasOptLog}, 评分:${hasScores}`,
    };

    // 配置+文档
    const hasPkg = files.includes('package.json');
    const hasReadme = files.includes('README.md');
    checks['配置文档'] = {
      passed: hasPkg && hasReadme,
      detail: hasPkg && hasReadme ? 'package.json+README完整' : `package.json:${hasPkg}, README:${hasReadme}`,
    };

    // 内容验证: 关键文件有实际实现
    const schedulerPath = files.find(f => f.endsWith('scheduler.ts'));
    let schedulerOk = false;
    if (schedulerPath) {
      const content = fs.readFileSync(path.join(tempDir, schedulerPath), 'utf-8');
      schedulerOk = content.includes('class') && content.length > 500;
    }
    checks['代码质量'] = {
      passed: schedulerOk,
      detail: schedulerOk ? '调度器有完整类实现' : '调度器实现不完整',
    };

    // ── 输出 ───────────────────────────────────────────────────────────
    const passed = Object.values(checks).filter(c => c.passed).length;
    const total = Object.keys(checks).length;

    console.log(`\n${'═'.repeat(70)}`);
    console.log('  📊 综合压力测试结果');
    console.log(`${'═'.repeat(70)}\n`);

    for (const [name, check] of Object.entries(checks)) {
      const icon = check.passed ? '✅' : '❌';
      console.log(`  ${icon} ${name}: ${check.detail}`);
    }

    console.log(`\n  文件总数: ${files.length}`);
    console.log(`  源码模块: ${srcFiles.length}`);
    console.log(`  耗时: ${durationSec.toFixed(1)}s`);
    console.log(`\n  综合评分: ${passed}/${total} 维度通过`);

    if (passed === total) {
      console.log('\n  🏆 综合压力测试通过！单任务成功运用了全部5大核心能力。');
    } else {
      console.log(`\n  ⚠️  ${total - passed}个维度未通过，需要改进。`);
    }

    // Save
    const outDir = path.join(process.cwd(), '.combined-test-output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      durationSec,
      filesCount: files.length,
      srcFilesCount: srcFiles.length,
      passed, total,
      checks,
      files,
    }, null, 2));

    let md = `# Commander 综合压力测试报告\n\n> ${new Date().toISOString()} | mimo-v2.5 | ${durationSec.toFixed(0)}s\n\n`;
    md += `## 评分: ${passed}/${total}\n\n`;
    md += `| 维度 | 结果 | 详情 |\n|------|------|------|\n`;
    for (const [name, check] of Object.entries(checks)) {
      md += `| ${name} | ${check.passed ? '✅' : '❌'} | ${check.detail} |\n`;
    }
    md += `\n## 文件清单 (${files.length}个)\n\n`;
    md += files.map(f => `- ${f}`).join('\n') + '\n';
    fs.writeFileSync(path.join(outDir, 'report.md'), md);

    console.log(`\n  结果: ${outDir}/results.json`);
    console.log(`  报告: ${outDir}/report.md`);

  } catch (e: any) {
    console.error(`  ❌ 执行异常: ${e.message?.slice(0, 300)}`);
  }
}

main().catch(console.error);
