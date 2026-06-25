/**
 * ShowcaseRunner — Commander's "第11秒" killer demo.
 *
 * When the user runs `commander run showcase`, this runner performs a
 * DEBATE-topology code audit using 3 agents:
 *   🔴 Red Team  — finds bugs, vulnerabilities, anti-patterns
 *   🔵 Blue Team — defends code quality, explains design choices
 *   🟡 Judge     — scores and synthesizes into a health report
 *
 * All agents run in parallel using the DEBATE topology. The result is a
 * Chinese-language code health report with scores, findings, and recommendations.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentRuntimeInterface } from '../runtime';
import type { AgentExecutionContext } from '../runtime/types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface ShowcaseResult {
  status: 'success' | 'partial' | 'failed';
  report: string;
  metrics: {
    redTeamTokens: number;
    blueTeamTokens: number;
    judgeTokens: number;
    totalTokens: number;
    durationMs: number;
    filesScanned: number;
    securityScore: number;
    qualityScore: number;
    architectureScore: number;
    overallScore: number;
  };
  findings: {
    critical: string[];
    high: string[];
    medium: string[];
    low: string[];
  };
  redTeamRaw: string;
  blueTeamRaw: string;
  judgeRaw: string;
}

export interface ShowcaseConfig {
  /** Max files to scan (default: 50) */
  maxFiles?: number;
  /** Max file size in bytes (default: 100KB) */
  maxFileSize?: number;
  /** Token budget per agent (default: 32000) */
  tokenBudgetPerAgent?: number;
  /** File extensions to scan */
  extensions?: string[];
}

// ============================================================================
// Default config
// ============================================================================

const DEFAULT_CONFIG: Required<ShowcaseConfig> = {
  maxFiles: 50,
  maxFileSize: 100 * 1024,
  tokenBudgetPerAgent: 32000,
  extensions: [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.css',
    '.html',
    '.json',
    '.yaml',
    '.yml',
    '.md',
    '.sql',
    '.sh',
  ],
};

// ============================================================================
// Agent system prompts
// ============================================================================

const RED_TEAM_PROMPT = `你是一个资深安全审计专家和代码审查者（红队）。你的任务是**毫不留情地**找出代码库中的所有问题。

请聚焦以下方面：
1. **安全漏洞**：注入攻击、XSS、认证绕过、敏感信息泄露、不安全的依赖
2. **运行时风险**：未处理的异常、空指针/undefined 访问、竞态条件、死锁风险
3. **代码坏味道**：过长的函数、深层嵌套、重复代码、God Class、魔法数字
4. **性能问题**：N+1 查询、不必要的循环、内存泄漏风险、同步阻塞
5. **架构反模式**：循环依赖、紧耦合、缺少抽象层、违反单一职责原则

对于你审查的每个文件，请用以下格式输出你的发现：
- 列出每个问题，包含：严重程度（🔴严重/🟠高/🟡中/🟢低）、文件名、行号（如果能推断）、问题描述、修复建议
- 不要客气——红队的职责就是找出所有问题
- 如果某个文件看起来没问题，也要说"未发现明显问题"`;

const BLUE_TEAM_PROMPT = `你是一个资深软件架构师和代码质量倡导者（蓝队）。你的任务是从**防守视角**审视代码库。

请聚焦以下方面：
1. **设计优点**：好的抽象、清晰的分层、合理的命名、优秀的错误处理
2. **架构合理性**：模块边界清晰、依赖方向正确、接口设计良好
3. **可维护性**：代码可读性高、测试覆盖好、文档清晰
4. **扩展性**：设计模式运用得当、开放封闭原则遵守良好
5. **技术创新**：巧妙的解决方案、优雅的算法选择

对于你审查的每个文件，请用以下格式输出你的分析：
- 列出每个优点，包含：影响程度（🟢高价值/🔵有价值）、文件名、具体说明
- 对于红队可能攻击的点，提前给出合理的解释（如果确实是有意设计）
- 如果某个文件确实存在设计问题，诚实指出但不要过度批评
- 你的职责不是否认问题，而是从架构和工程角度提供平衡的视角`;

const JUDGE_PROMPT = `你是一个资深技术总监（裁判）。你的任务是综合红队（攻击方）和蓝队（防守方）的分析，输出一份**中文代码健康体检报告**。

你需要完成以下工作：
1. **交叉验证**：红队说有问题但蓝队说合理的，你需要做出判断
2. **严重程度校准**：红队可能过度敏感，蓝队可能过度乐观——你需要给出公正的评分
3. **综合评分**：从安全性、代码质量、架构设计三个维度打分（满分 100）
4. **优先级排序**：哪些问题必须立刻修，哪些可以延后

请用以下 Markdown 格式输出报告：

# 🔬 Commander 代码健康体检报告

## 📊 综合评分
| 维度 | 分数 | 等级 |
|------|------|------|
| 🔒 安全性 | XX/100 | S/A/B/C/D |
| 📝 代码质量 | XX/100 | S/A/B/C/D |
| 🏗️ 架构设计 | XX/100 | S/A/B/C/D |
| **综合** | **XX/100** | **S/A/B/C/D** |

等级说明：S≥90, A≥80, B≥70, C≥60, D<60

## 🔴 严重问题（必须立即修复）
[列出所有严重问题，每个不超过 3 行]

## 🟠 高危问题（本周内修复）
[列出所有高危问题]

## 🟡 中等问题（本迭代修复）
[列出所有中等问题]

## 🟢 低危问题 / 改进建议
[列出改进建议]

## 💡 架构亮点
[蓝队发现的优点，值得保留的设计]

## 📋 行动计划
1. [优先级最高的修复任务]
2. [下一个修复任务]
...

## ⚖️ 裁判点评
[2-3 句话总结，如果双方有争议点，给出你的专业判断]`;

// ============================================================================
// Codebase scanner
// ============================================================================

interface ScannedFile {
  relativePath: string;
  content: string;
  size: number;
  ext: string;
}

function scanCodebase(config: Required<ShowcaseConfig>): ScannedFile[] {
  const cwd = process.cwd();
  const files: ScannedFile[] = [];

  // Directories to skip (not exhaustive — just common noise)
  const skipDirs = new Set([
    'node_modules',
    '.git',
    '.commander',
    'dist',
    'build',
    '.next',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    '.cache',
    'coverage',
    '.commander_output',
    '.commander_samples',
  ]);

  function walk(dir: string): void {
    if (files.length >= config.maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      reportSilentFailure(err, 'showcaseRunner:209');
      return;
    }

    for (const entry of entries) {
      if (files.length >= config.maxFiles) return;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && !skipDirs.has(entry.name)) {
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!config.extensions.includes(ext)) continue;

      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {
        reportSilentFailure(err, 'showcaseRunner:230');
        continue;
      }
      if (stat.size > config.maxFileSize) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relativePath = path.relative(cwd, fullPath);
        files.push({ relativePath, content, size: stat.size, ext });
      } catch (err) {
        reportSilentFailure(err, 'showcaseRunner:240');
        // skip binary / unreadable files
      }
    }
  }

  walk(cwd);

  // Sort by importance: larger files first (more content = more to review)
  files.sort((a, b) => b.size - a.size);
  return files.slice(0, config.maxFiles);
}

// ============================================================================
// File distribution: split files among agents
// ============================================================================

function distributeFiles(files: ScannedFile[], agentCount: number): ScannedFile[][] {
  const buckets: ScannedFile[][] = Array.from({ length: agentCount }, () => []);
  // Round-robin: each agent gets a diverse set
  for (let i = 0; i < files.length; i++) {
    buckets[i % agentCount].push(files[i]);
  }
  return buckets;
}

function formatFilesForAgent(files: ScannedFile[], label: string): string {
  if (files.length === 0) return `\n\n## ${label}\n\n无文件需要审查。\n`;

  const parts: string[] = [];
  parts.push(`\n\n## ${label}\n`);

  for (const file of files) {
    const header = `\n### 📄 ${file.relativePath} (${file.ext}, ${formatSize(file.size)})\n`;
    const truncated =
      file.content.length > 15000
        ? file.content.slice(0, 15000) + '\n\n... [truncated, total: ' + formatSize(file.size) + ']'
        : file.content;
    parts.push(header);
    parts.push('```' + (file.ext.slice(1) || 'text'));
    parts.push(truncated);
    parts.push('```');
  }

  return parts.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============================================================================
// Score extraction from judge report
// ============================================================================

function extractScores(report: string): {
  securityScore: number;
  qualityScore: number;
  architectureScore: number;
  overallScore: number;
} {
  const defaults = { securityScore: 75, qualityScore: 75, architectureScore: 75, overallScore: 75 };

  const scoreMatch = (pattern: RegExp): number => {
    const m = report.match(pattern);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      return isNaN(n) ? defaults.overallScore : Math.min(100, Math.max(0, n));
    }
    return -1;
  };

  const security = scoreMatch(/安全性[^0-9]*(\d+)/);
  const quality = scoreMatch(/代码质量[^0-9]*(\d+)/);
  const architecture = scoreMatch(/架构设计[^0-9]*(\d+)/);
  const overall = scoreMatch(/综合[^0-9]*(\d+)/);

  return {
    securityScore: security > 0 ? security : defaults.securityScore,
    qualityScore: quality > 0 ? quality : defaults.qualityScore,
    architectureScore: architecture > 0 ? architecture : defaults.architectureScore,
    overallScore: overall > 0 ? overall : Math.round((security + quality + architecture) / 3),
  };
}

function extractFindings(report: string): {
  critical: string[];
  high: string[];
  medium: string[];
  low: string[];
} {
  const findings = {
    critical: [] as string[],
    high: [] as string[],
    medium: [] as string[],
    low: [] as string[],
  };

  // Extract from the 🔴/🟠/🟡/🟢 sections
  const sectionPatterns: Array<{ key: keyof typeof findings; icon: string }> = [
    { key: 'critical', icon: '🔴 严重' },
    { key: 'high', icon: '🟠 高危' },
    { key: 'medium', icon: '🟡 中等' },
    { key: 'low', icon: '🟢 低危' },
  ];

  for (const { key, icon } of sectionPatterns) {
    const regex = new RegExp(`${icon}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`, 'i');
    const m = report.match(regex);
    if (m && m[1]) {
      const lines = m[1]
        .split('\n')
        .map((l) => l.replace(/^[-*•]\s*/, '').trim())
        .filter((l) => l.length > 10);
      findings[key] = lines.slice(0, 10);
    }
  }

  return findings;
}

// ============================================================================
// Main runner
// ============================================================================

export async function runShowcase(
  runtime: AgentRuntimeInterface,
  config?: ShowcaseConfig,
): Promise<ShowcaseResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();
  const logger = getGlobalLogger();

  // Phase 1: Scan codebase
  logger.info('Showcase', 'Scanning codebase...');
  const files = scanCodebase(cfg);
  logger.info('Showcase', `Scanned ${files.length} files`);

  if (files.length === 0) {
    return {
      status: 'failed',
      report:
        '# 代码健康体检报告\n\n当前目录未找到可扫描的代码文件。请在有代码文件的目录下运行此命令。\n',
      metrics: {
        redTeamTokens: 0,
        blueTeamTokens: 0,
        judgeTokens: 0,
        totalTokens: 0,
        durationMs: Date.now() - startTime,
        filesScanned: 0,
        securityScore: 0,
        qualityScore: 0,
        architectureScore: 0,
        overallScore: 0,
      },
      findings: { critical: [], high: [], medium: [], low: [] },
      redTeamRaw: '',
      blueTeamRaw: '',
      judgeRaw: '',
    };
  }

  // Phase 2: Distribute files between Red and Blue teams
  const buckets = distributeFiles(files, 2);
  const redFiles = buckets[0];
  const blueFiles = buckets[1];

  const redFileBlock = formatFilesForAgent(redFiles, '红队审查文件');
  const blueFileBlock = formatFilesForAgent(blueFiles, '蓝队审查文件');

  // Phase 3: Run Red and Blue teams in parallel (with graceful degradation)
  logger.info('Showcase', 'Running Red and Blue teams...');

  const baseCtx: Omit<AgentExecutionContext, 'agentId' | 'goal'> = {
    projectId: 'showcase',
    contextData: { governanceProfile: { riskLevel: 'LOW' } },
    availableTools: [],
    maxSteps: 10,
    tokenBudget: cfg.tokenBudgetPerAgent,
  };

  let redRaw = '';
  let blueRaw = '';
  let redTokens = 0;
  let blueTokens = 0;

  try {
    const [redResult, blueResult] = await Promise.all([
      runtime.execute({
        ...baseCtx,
        agentId: 'red-team',
        goal: `${RED_TEAM_PROMPT}\n\n以下是你需要审查的代码文件：${redFileBlock}\n\n请逐个审查以上每个文件，列出所有发现的问题。`,
      }),
      runtime.execute({
        ...baseCtx,
        agentId: 'blue-team',
        goal: `${BLUE_TEAM_PROMPT}\n\n以下是你需要审查的代码文件：${blueFileBlock}\n\n请逐个分析以上每个文件，列出所有发现的设计优点和架构合理性。`,
      }),
    ]);

    redRaw =
      (redResult.status === 'success' ? redResult.summary : (redResult.error ?? '红队执行失败')) ??
      '';
    blueRaw =
      (blueResult.status === 'success'
        ? blueResult.summary
        : (blueResult.error ?? '蓝队执行失败')) ?? '';
    redTokens = redResult.totalTokenUsage?.totalTokens ?? 0;
    blueTokens = blueResult.totalTokenUsage?.totalTokens ?? 0;

    logger.info('Showcase', `Red team: ${redResult.status}, Blue team: ${blueResult.status}`);
  } catch (err) {
    logger.warn('Showcase', 'Red/Blue teams crashed', { error: (err as Error)?.message });
    redRaw = `红队崩溃: ${(err as Error)?.message ?? 'unknown'}`;
    blueRaw = `蓝队崩溃: ${(err as Error)?.message ?? 'unknown'}`;
  }

  // Phase 4: Judge synthesizes (with graceful degradation)
  logger.info('Showcase', 'Running Judge...');

  const judgeGoal = [
    JUDGE_PROMPT,
    '',
    '---',
    '',
    '## 🔴 红队报告',
    redRaw || '(红队未产出有效报告)',
    '',
    '---',
    '',
    '## 🔵 蓝队报告',
    blueRaw || '(蓝队未产出有效报告)',
    '',
    '---',
    '',
    `## 📊 扫描统计`,
    `- 总文件数：${files.length}`,
    `- 红队审查文件数：${redFiles.length}`,
    `- 蓝队审查文件数：${blueFiles.length}`,
    '- 请综合以上两份报告，输出最终的中文代码健康体检报告。',
  ].join('\n');

  let judgeRaw = '';
  let judgeTokens = 0;

  try {
    const judgeResult = await runtime.execute({
      ...baseCtx,
      agentId: 'judge',
      goal: judgeGoal,
      maxSteps: 12,
      tokenBudget: cfg.tokenBudgetPerAgent * 2,
    });
    judgeRaw =
      (judgeResult.status === 'success'
        ? judgeResult.summary
        : (judgeResult.error ?? '裁判执行失败')) ?? '';
    judgeTokens = judgeResult.totalTokenUsage?.totalTokens ?? 0;
  } catch (err) {
    logger.warn('Showcase', 'Judge crashed', { error: (err as Error)?.message });
    judgeRaw = `裁判崩溃: ${(err as Error)?.message ?? 'unknown'}`;
  }

  // Phase 5: Compute metrics
  const report =
    judgeRaw ||
    `# 代码健康体检报告\n\n## 综合评分\n\n裁判未能产出有效报告。\n\n### 红队原始输出\n${redRaw.slice(0, 2000)}\n\n### 蓝队原始输出\n${blueRaw.slice(0, 2000)}`;

  const scores = extractScores(report);
  const findings = extractFindings(report);

  const allSuccess = redRaw.length > 0 && blueRaw.length > 0 && judgeRaw.length > 0;

  return {
    status: allSuccess ? 'success' : 'partial',
    report,
    metrics: {
      redTeamTokens: redTokens,
      blueTeamTokens: blueTokens,
      judgeTokens,
      totalTokens: redTokens + blueTokens + judgeTokens,
      durationMs: Date.now() - startTime,
      filesScanned: files.length,
      ...scores,
    },
    findings,
    redTeamRaw: redRaw,
    blueTeamRaw: blueRaw,
    judgeRaw,
  };
}
