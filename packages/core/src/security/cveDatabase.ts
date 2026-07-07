/**
 * CVEDatabase — CVE 数据库集成与实时漏洞检查模块。
 *
 * 提供 2025-2026 年 Agent / AI / 供应链相关高危漏洞的内置数据库，并支持接入
 * 外部 CVE 数据源（NVD API、GitHub Advisory Database），对项目依赖进行实时
 * 漏洞扫描、评分、优先级排序与自动修复建议生成。
 *
 * 能力概览：
 *   1. 内置已知高危 CVE 数据库（含 CVSS 10.0 的 Langflow / AI Agent RCE 等）
 *   2. 外部数据源接入（NVD API、GitHub Advisory Database）—— 增量同步
 *   3. 项目依赖实时扫描
 *      - 检查 package.json 依赖版本
 *      - 检查 package-lock.json 完整性哈希（sha512 缺失即标记为可疑）
 *      - 解析传递依赖（transitive dependencies）
 *   4. CVE 匹配引擎
 *      - 按包名 + 版本范围匹配（自实现轻量 semver 比较器）
 *      - 按 CPE（Common Platform Enumeration）匹配
 *      - 按关键字模糊匹配（"langflow" / "agent" / "mcp" 等）
 *   5. 漏洞评分与优先级
 *      - CVSS 评分（9.0+ CRITICAL / 7.0-8.9 HIGH / 4.0-6.9 MEDIUM / <4.0 LOW）
 *      - 利用可能性评估（公开 PoC / 已武器化 / 在野利用）
 *      - 修复紧急度（立即修复 / 本周修复 / 本月修复 / 持续关注）
 *   6. 自动修复建议（安全版本、替代包、修复 PR 描述）
 *   7. 定期扫描调度（启动全量扫描 / 每小时增量扫描 / 依赖变更触发）
 *
 * 设计：
 *   外部数据源 ─┐
 *   内置数据库 ─┼─→ CVEDatabase ─→ 匹配引擎 ─→ 评分/优先级 ─→ 修复建议
 *   项目依赖 ──┘        │
 *                       ├─→ SecurityAuditLogger（审计链）
 *                       ├─→ MetricsCollector（指标）
 *                       └─→ Logger（日志）
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getSecurityAuditLogger } from './securityAuditLogger';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// 类型定义
// ============================================================================

/** 包生态系统（包管理器）类型 */
export type PackageEcosystem =
  | 'npm'
  | 'pypi'
  | 'maven'
  | 'go'
  | 'composer'
  | 'gem'
  | 'nuget'
  | 'generic';

/** CVE 严重级别（基于 CVSS 评分区间） */
export type CVESeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** 修复优先级 */
export type FixPriority = 'IMMEDIATE' | 'THIS_WEEK' | 'THIS_MONTH' | 'MONITOR';

/** CVE 数据来源 */
export type CVESource = 'builtin' | 'nvd' | 'ghsa' | 'manual';

/** 受影响的包描述 */
export interface AffectedPackage {
  /** 包名（如 "langflow"、"next"、"@tanstack/react-query"） */
  name: string;
  /** 所属生态系统 */
  ecosystem: PackageEcosystem;
  /** 受影响的版本范围（semver 表达式，如 "<=1.0.19"、"<2.0.0"） */
  vulnerableRange: string;
  /** CPE 2.3 标识符（可选，用于 CPE 匹配） */
  cpe?: string;
  /** 该包对应的安全修复版本（可选，与 CVEEntry.fixedVersions 互为镜像） */
  fixedVersion?: string;
}

/** 单条 CVE 数据库条目 */
export interface CVEEntry {
  /** CVE 编号（如 "CVE-2026-33017"） */
  cveId: string;
  /** 漏洞描述（中文） */
  description: string;
  /** CVSS v3.x 基础评分（0.0 - 10.0） */
  cvssScore: number;
  /** 严重级别（由 cvssScore 派生） */
  severity: CVESeverity;
  /** 受影响的包列表 */
  affectedPackages: AffectedPackage[];
  /** 各包对应的安全修复版本：{ 包名: 安全版本 } */
  fixedVersions: Record<string, string>;
  /** 是否存在公开可用的利用 */
  exploitAvailable: boolean;
  /** 是否已被武器化 / 出现在野利用 */
  weaponized: boolean;
  /** 是否存在公开 PoC */
  publicPoc: boolean;
  /** CPE 标识符列表（用于 CPE 匹配，可由 affectedPackages[].cpe 汇总） */
  cpe?: string[];
  /** 关键字列表（用于模糊匹配，如 "langflow"、"agent"、"mcp"） */
  keywords: string[];
  /** CWE 分类编号（可选） */
  cweIds?: string[];
  /** 参考链接 */
  references?: string[];
  /** 首次发布日期（ISO 8601） */
  publishedDate: string;
  /** 最后修改日期（ISO 8601） */
  lastModified: string;
  /** 数据来源 */
  source: CVESource;
}

/** 依赖描述符（扫描输入） */
export interface DependencyDescriptor {
  /** 包名 */
  name: string;
  /** 已安装版本 */
  version: string;
  /** 生态系统（默认 npm） */
  ecosystem?: PackageEcosystem;
  /** 完整性哈希（如 "sha512-..."，来自 lockfile） */
  integrity?: string;
  /** 是否为开发依赖 */
  isDev?: boolean;
  /** 是否为可选依赖 */
  isOptional?: boolean;
  /** 是否为传递依赖 */
  transitive?: boolean;
  /** 解析地址（lockfile 中的 resolved 字段） */
  resolved?: string;
  /** CPE 标识符（可选，用于 CPE 匹配） */
  cpe?: string;
}

/** 漏洞匹配结果 */
export interface VulnerabilityMatch {
  /** CVE 编号 */
  cveId: string;
  /** 受影响的包名 */
  packageName: string;
  /** 已安装版本 */
  installedVersion: string;
  /** 生态系统 */
  ecosystem: PackageEcosystem;
  /** 严重级别 */
  severity: CVESeverity;
  /** CVSS 评分 */
  cvssScore: number;
  /** 是否存在利用 */
  exploitAvailable: boolean;
  /** 是否已武器化 */
  weaponized: boolean;
  /** 修复优先级 */
  priority: FixPriority;
  /** 修复建议（简短摘要） */
  recommendation: string;
  /** 匹配命中的方式 */
  matchedBy: 'package_version' | 'cpe' | 'keyword';
}

/** 扫描结果 */
export interface ScanResult {
  /** 扫描的依赖总数 */
  totalScanned: number;
  /** 发现的漏洞数量 */
  vulnerabilitiesFound: number;
  /** CRITICAL 级别数量 */
  criticalCount: number;
  /** HIGH 级别数量 */
  highCount: number;
  /** MEDIUM 级别数量 */
  mediumCount: number;
  /** 所有漏洞匹配列表 */
  matches: VulnerabilityMatch[];
  /** 扫描耗时（毫秒） */
  scanDurationMs: number;
  /** 扫描时间戳（ISO 8601） */
  scannedAt: string;
  /** 传递依赖扫描数量 */
  transitiveScanned?: number;
  /** 完整性哈希缺失 / 异常的包 */
  integrityIssues?: Array<{ name: string; version: string; reason: string }>;
}

/** 修复建议 */
export interface FixRecommendation {
  /** CVE 编号 */
  cveId: string;
  /** 包名 */
  packageName: string;
  /** 已安装版本 */
  installedVersion: string;
  /** 严重级别 */
  severity: CVESeverity;
  /** 修复优先级 */
  priority: FixPriority;
  /** 推荐的安全版本 */
  recommendedVersion?: string;
  /** 升级命令（如 "npm install next@15.1.3"） */
  upgradeCommand?: string;
  /** 替代包建议 */
  alternativePackages?: Array<{ name: string; reason: string }>;
  /** 修复理由 */
  rationale: string;
  /** 生成的修复 PR 描述（Markdown） */
  prDescription: string;
}

/** CVE 搜索查询 */
export interface CVESearchQuery {
  /** 关键字（模糊匹配 cveId / description / keywords / 包名） */
  keyword?: string;
  /** 精确 CVE 编号 */
  cveId?: string;
  /** 包名 */
  packageName?: string;
  /** 生态系统 */
  ecosystem?: PackageEcosystem;
  /** CPE 标识符 */
  cpe?: string;
  /** 最低 CVSS 评分 */
  minCvss?: number;
  /** 严重级别 */
  severity?: CVESeverity;
  /** 是否仅返回有利用的 */
  exploitAvailable?: boolean;
  /** 返回数量上限（默认 50） */
  limit?: number;
}

/** CVE 数据库统计信息 */
export interface CVEStats {
  /** CVE 总数 */
  totalCVEs: number;
  /** 内置 CVE 数量 */
  builtinCVEs: number;
  /** 外部 CVE 数量 */
  externalCVEs: number;
  /** 按严重级别分布 */
  bySeverity: Record<CVESeverity, number>;
  /** 按数据来源分布 */
  bySource: Record<CVESource, number>;
  /** 存在利用的 CRITICAL 数量 */
  criticalExploitAvailable: number;
  /** 上次扫描时间（ISO 8601） */
  lastScanAt?: string;
  /** 上次扫描结果 */
  lastScanResult?: ScanResult;
  /** 定时扫描是否启用 */
  periodicScanActive: boolean;
  /** 定时扫描间隔（毫秒） */
  periodicScanIntervalMs?: number;
  /** 累计扫描次数 */
  totalScansRun: number;
  /** 监听的 package.json 路径数量 */
  watchedPathCount: number;
}

/** 外部 CVE 数据源配置 */
export interface ExternalSourceConfig {
  /** 数据源 ID */
  id: string;
  /** 数据源名称 */
  name: string;
  /** 数据源类型 */
  type: 'nvd' | 'ghsa' | 'url';
  /** 接口地址 */
  endpoint: string;
  /** API 密钥（NVD / GHSA 可能需要） */
  apiKey?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 最后同步时间（ISO 8601） */
  lastSyncAt?: string;
  /** 同步失败次数 */
  errorCount: number;
}

// ============================================================================
// 内置 CVE 数据库（2025-2026 年 Agent / AI / 供应链相关高危漏洞）
// ============================================================================

const BUILTIN_CVE_ENTRIES: CVEEntry[] = [
  {
    cveId: 'CVE-2026-33017',
    description:
      'Langflow AI 平台远程代码执行漏洞。未授权攻击者可通过恶意构造的 prompt / 组件链在服务端执行任意代码，影响所有 <= 1.0.19 版本，已在野利用。',
    cvssScore: 10.0,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: 'langflow',
        ecosystem: 'pypi',
        vulnerableRange: '<=1.0.19',
        cpe: 'cpe:2.3:a:langflow:langflow:*:*:*:*:*:python:*:*',
        fixedVersion: '1.0.20',
      },
    ],
    fixedVersions: { langflow: '1.0.20' },
    exploitAvailable: true,
    weaponized: true,
    publicPoc: true,
    cpe: ['cpe:2.3:a:langflow:langflow:*:*:*:*:*:python:*:*'],
    keywords: ['langflow', 'ai', 'agent', 'rce', 'prompt injection', 'llm', '低代码'],
    cweIds: ['CWE-94', 'CWE-77'],
    references: [
      'https://nvd.nist.gov/vuln/detail/CVE-2026-33017',
      'https://github.com/langflow-ai/langflow/security/advisories',
    ],
    publishedDate: '2026-04-15T00:00:00.000Z',
    lastModified: '2026-05-02T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2025-54322',
    description:
      'AI Agent 在自动化漏洞挖掘中发现的路由器远程代码执行漏洞。未授权远程攻击者可构造特制请求在受影响路由器固件上执行任意命令，CVSS 10.0。',
    cvssScore: 10.0,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: 'router-firmware',
        ecosystem: 'generic',
        vulnerableRange: '*',
        cpe: 'cpe:2.3:h:*:router_firmware:*:*:*:*:*:*:*:*',
      },
    ],
    fixedVersions: {},
    exploitAvailable: true,
    weaponized: true,
    publicPoc: true,
    cpe: ['cpe:2.3:h:*:router_firmware:*:*:*:*:*:*:*:*'],
    keywords: ['router', 'agent', 'rce', 'firmware', 'ai discovered', '固件'],
    cweIds: ['CWE-78', 'CWE-119'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2025-54322'],
    publishedDate: '2025-12-10T00:00:00.000Z',
    lastModified: '2026-01-08T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-45321',
    description:
      'TanStack 系列 npm 包供应链投毒事件。恶意版本被发布到 npm 仓库，安装时执行窃取凭据与环境变量的后门代码，影响 @tanstack/* 命名空间下被投毒的版本范围。',
    cvssScore: 9.8,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: '@tanstack/react-query',
        ecosystem: 'npm',
        vulnerableRange: '5.75.0 - 5.75.2',
        fixedVersion: '5.75.3',
      },
      {
        name: '@tanstack/query-core',
        ecosystem: 'npm',
        vulnerableRange: '5.75.0 - 5.75.2',
        fixedVersion: '5.75.3',
      },
      {
        name: '@tanstack/react-table',
        ecosystem: 'npm',
        vulnerableRange: '8.21.0 - 8.21.2',
        fixedVersion: '8.21.3',
      },
    ],
    fixedVersions: {
      '@tanstack/react-query': '5.75.3',
      '@tanstack/query-core': '5.75.3',
      '@tanstack/react-table': '8.21.3',
    },
    exploitAvailable: true,
    weaponized: true,
    publicPoc: false,
    keywords: ['tanstack', 'npm', 'supply chain', 'poisoning', '投毒', '供应链'],
    cweIds: ['CWE-506', 'CWE-494'],
    references: [
      'https://nvd.nist.gov/vuln/detail/CVE-2026-45321',
      'https://github.com/TanStack/query/security/advisories',
    ],
    publishedDate: '2026-05-20T00:00:00.000Z',
    lastModified: '2026-05-22T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-48027',
    description:
      'Nx Console VS Code 扩展供应链攻击。受感染版本的扩展在激活时从远端拉取并执行恶意脚本，窃取开发者环境中的令牌与 SSH 密钥。',
    cvssScore: 9.6,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: 'nrwl.angular-console',
        ecosystem: 'npm',
        vulnerableRange: '18.0.0 - 18.1.4',
        fixedVersion: '18.1.5',
        cpe: 'cpe:2.3:a:nrwl:nx_console:*:*:*:*:*:vscode:*:*',
      },
      {
        name: '@nx-console/vscode',
        ecosystem: 'npm',
        vulnerableRange: '1.0.0 - 1.0.7',
        fixedVersion: '1.0.8',
      },
    ],
    fixedVersions: {
      'nrwl.angular-console': '18.1.5',
      '@nx-console/vscode': '1.0.8',
    },
    exploitAvailable: true,
    weaponized: true,
    publicPoc: false,
    cpe: ['cpe:2.3:a:nrwl:nx_console:*:*:*:*:*:vscode:*:*'],
    keywords: ['nx', 'nx console', 'vscode', 'extension', 'supply chain', '供应链', 'ide'],
    cweIds: ['CWE-506', 'CWE-494'],
    references: [
      'https://nvd.nist.gov/vuln/detail/CVE-2026-48027',
      'https://marketplace.visualstudio.com/items/Nrwl.angular-console',
    ],
    publishedDate: '2026-06-03T00:00:00.000Z',
    lastModified: '2026-06-05T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-28363',
    description:
      'OpenClaw 容器运行时容器逃逸漏洞。攻击者可利用内核命名空间处理缺陷从容器逃逸到宿主机，CVSS 9.9，影响 OpenClaw < 1.4.0。',
    cvssScore: 9.9,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: 'openclaw',
        ecosystem: 'generic',
        vulnerableRange: '<1.4.0',
        cpe: 'cpe:2.3:a:openclaw:openclaw:*:*:*:*:*:*:*:*',
        fixedVersion: '1.4.0',
      },
    ],
    fixedVersions: { openclaw: '1.4.0' },
    exploitAvailable: true,
    weaponized: false,
    publicPoc: true,
    cpe: ['cpe:2.3:a:openclaw:openclaw:*:*:*:*:*:*:*:*'],
    keywords: ['openclaw', 'container', 'escape', '容器逃逸', 'runtime'],
    cweIds: ['CWE-269', 'CWE-250'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-28363'],
    publishedDate: '2026-03-18T00:00:00.000Z',
    lastModified: '2026-03-25T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-41940',
    description:
      'cPanel 认证绕过漏洞。认证逻辑缺陷允许攻击者绕过登录校验访问管理接口，CVSS 9.8，影响 cPanel & WHM < 124.0.9。',
    cvssScore: 9.8,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: 'cpanel',
        ecosystem: 'generic',
        vulnerableRange: '<124.0.9',
        cpe: 'cpe:2.3:a:cpanel:cpanel:*:*:*:*:*:*:*:*',
        fixedVersion: '124.0.9',
      },
    ],
    fixedVersions: { cpanel: '124.0.9' },
    exploitAvailable: true,
    weaponized: true,
    publicPoc: false,
    cpe: ['cpe:2.3:a:cpanel:cpanel:*:*:*:*:*:*:*:*'],
    keywords: ['cpanel', 'authentication bypass', '认证绕过', 'whm'],
    cweIds: ['CWE-287', 'CWE-306'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-41940'],
    publishedDate: '2026-05-08T00:00:00.000Z',
    lastModified: '2026-05-12T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-42779',
    description:
      'Apache MINA 反序列化远程代码执行漏洞。未授权攻击者可发送特制序列化对象触发任意代码执行，CVSS 9.8，影响 org.apache.mina:mina-core < 2.2.4。',
    cvssScore: 9.8,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: 'org.apache.mina:mina-core',
        ecosystem: 'maven',
        vulnerableRange: '<2.2.4',
        cpe: 'cpe:2.3:a:apache:mina:*:*:*:*:*:java:*:*',
        fixedVersion: '2.2.4',
      },
    ],
    fixedVersions: { 'org.apache.mina:mina-core': '2.2.4' },
    exploitAvailable: false,
    weaponized: false,
    publicPoc: true,
    cpe: ['cpe:2.3:a:apache:mina:*:*:*:*:*:java:*:*'],
    keywords: ['apache', 'mina', 'deserialization', '反序列化', 'rce', 'java'],
    cweIds: ['CWE-502'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-42779'],
    publishedDate: '2026-05-15T00:00:00.000Z',
    lastModified: '2026-05-18T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-42945',
    description:
      'NGINX rewrite 模块堆溢出漏洞。特制请求可触发堆缓冲区溢出导致拒绝服务或潜在代码执行，CVSS 9.2，影响 nginx < 1.27.4。',
    cvssScore: 9.2,
    severity: 'CRITICAL',
    affectedPackages: [
      {
        name: 'nginx',
        ecosystem: 'generic',
        vulnerableRange: '<1.27.4',
        cpe: 'cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*',
        fixedVersion: '1.27.4',
      },
    ],
    fixedVersions: { nginx: '1.27.4' },
    exploitAvailable: false,
    weaponized: false,
    publicPoc: true,
    cpe: ['cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*'],
    keywords: ['nginx', 'heap overflow', '堆溢出', 'rewrite', 'f5'],
    cweIds: ['CWE-122', 'CWE-787'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-42945'],
    publishedDate: '2026-05-25T00:00:00.000Z',
    lastModified: '2026-05-28T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-23918',
    description:
      'Apache HTTP/2 Double Free 漏洞。特制 HTTP/2 流可触发双重释放导致拒绝服务，CVSS 8.8，影响 httpd < 2.4.63。',
    cvssScore: 8.8,
    severity: 'HIGH',
    affectedPackages: [
      {
        name: 'httpd',
        ecosystem: 'generic',
        vulnerableRange: '<2.4.63',
        cpe: 'cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*',
        fixedVersion: '2.4.63',
      },
    ],
    fixedVersions: { httpd: '2.4.63' },
    exploitAvailable: false,
    weaponized: false,
    publicPoc: false,
    cpe: ['cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*'],
    keywords: ['apache', 'http2', 'double free', '双重释放', 'httpd', 'dos'],
    cweIds: ['CWE-415'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-23918'],
    publishedDate: '2026-02-27T00:00:00.000Z',
    lastModified: '2026-03-04T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-21440',
    description:
      'AdonisJS 路径遍历远程代码执行漏洞。特制请求可利用路径遍历绕过限制并执行任意代码，CVSS 8.7，影响 @adonisjs/core < 6.14.2。',
    cvssScore: 8.7,
    severity: 'HIGH',
    affectedPackages: [
      {
        name: '@adonisjs/core',
        ecosystem: 'npm',
        vulnerableRange: '<6.14.2',
        cpe: 'cpe:2.3:a:adonisjs:core:*:*:*:*:*:node.js:*:*',
        fixedVersion: '6.14.2',
      },
    ],
    fixedVersions: { '@adonisjs/core': '6.14.2' },
    exploitAvailable: false,
    weaponized: false,
    publicPoc: true,
    cpe: ['cpe:2.3:a:adonisjs:core:*:*:*:*:*:node.js:*:*'],
    keywords: ['adonisjs', 'path traversal', '路径遍历', 'rce', 'node.js'],
    cweIds: ['CWE-22', 'CWE-94'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-21440'],
    publishedDate: '2026-02-10T00:00:00.000Z',
    lastModified: '2026-02-14T00:00:00.000Z',
    source: 'builtin',
  },
  {
    cveId: 'CVE-2026-44578',
    description:
      'Next.js WebSocket 服务端请求伪造（SSRF）漏洞。攻击者可借助特制 WebSocket 请求让服务端访问内部资源，CVSS 8.6，影响 next < 15.1.3。',
    cvssScore: 8.6,
    severity: 'HIGH',
    affectedPackages: [
      {
        name: 'next',
        ecosystem: 'npm',
        vulnerableRange: '<15.1.3',
        cpe: 'cpe:2.3:a:vercel:next.js:*:*:*:*:*:node.js:*:*',
        fixedVersion: '15.1.3',
      },
    ],
    fixedVersions: { next: '15.1.3' },
    exploitAvailable: false,
    weaponized: false,
    publicPoc: true,
    cpe: ['cpe:2.3:a:vercel:next.js:*:*:*:*:*:node.js:*:*'],
    keywords: ['nextjs', 'next.js', 'websocket', 'ssrf', 'vercel', 'react'],
    cweIds: ['CWE-918'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2026-44578'],
    publishedDate: '2026-06-01T00:00:00.000Z',
    lastModified: '2026-06-04T00:00:00.000Z',
    source: 'builtin',
  },
];

/** 已知安全替代包映射（用于修复建议中的替代包推荐） */
const SAFE_ALTERNATIVES: Record<string, Array<{ name: string; reason: string }>> = {
  langflow: [
    { name: 'flowise', reason: '同为 LLM 编排框架，社区维护活跃，可评估作为替代' },
    { name: 'n8n', reason: '工作流自动化平台，支持 AI 节点，攻击面较小' },
  ],
  '@tanstack/react-query': [
    { name: 'swr', reason: 'Vercel 出品的 React 数据请求库，API 类似且无已知投毒事件' },
  ],
  next: [{ name: '@remix-run/react', reason: '基于 Web 标准的全栈框架，可作为 Next.js 替代评估' }],
};

// ============================================================================
// 轻量级 Semver 比较器（自实现，避免引入外部依赖）
// ============================================================================

/** 解析语义化版本字符串为可比较的数字元组 */
function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: number[];
} {
  const cleaned = version.replace(/^[^0-9]*/, '').trim();
  const [main, pre] = cleaned.split('-');
  const parts = main.split('.').map((p) => parseInt(p, 10) || 0);
  const prerelease = pre
    ? pre.split('.').map((p) => {
        const n = parseInt(p, 10);
        return Number.isNaN(n) ? 0 : n;
      })
    : [];
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    prerelease,
  };
}

/** 比较两个版本字符串，返回 -1 / 0 / 1 */
function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  // 含预发布标识的版本低于正式版本
  const aHasPre = va.prerelease.length > 0;
  const bHasPre = vb.prerelease.length > 0;
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  for (let i = 0; i < Math.max(va.prerelease.length, vb.prerelease.length); i++) {
    const ap = va.prerelease[i] ?? -1;
    const bp = vb.prerelease[i] ?? -1;
    if (ap !== bp) return ap < bp ? -1 : 1;
  }
  return 0;
}

/** 判断单个比较器是否满足 */
function satisfiesComparator(version: string, comp: string): boolean {
  const c = comp.trim();
  if (c === '' || c === '*') return true;

  // caret: ^1.2.3 => >=1.2.3 <2.0.0
  if (c.startsWith('^')) {
    const base = c.slice(1);
    const p = parseVersion(base);
    if (compareVersions(version, base) < 0) return false;
    return compareVersions(version, `${p.major + 1}.0.0`) < 0;
  }

  // tilde: ~1.2.3 => >=1.2.3 <1.3.0
  if (c.startsWith('~')) {
    const base = c.slice(1);
    const p = parseVersion(base);
    if (compareVersions(version, base) < 0) return false;
    return compareVersions(version, `${p.major}.${p.minor + 1}.0`) < 0;
  }

  const opMatch = c.match(/^(<=|>=|<|>|=)?(.+)$/);
  const op = opMatch?.[1] ?? '=';
  const target = (opMatch?.[2] ?? c).trim();
  const cmp = compareVersions(version, target);
  switch (op) {
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '=':
    default:
      return cmp === 0;
  }
}

/**
 * 检查版本是否满足给定的范围表达式。
 * 支持："*"、精确版本、"<=" / "<" / ">=" / ">" / "="、"^"、"~"、
 *      闭区间 "1.0.0 - 2.0.0"、"||" 组合（OR）、"," / 空格 组合（AND）。
 */
function satisfiesRange(version: string, range: string): boolean {
  const v = version.trim();
  if (!v) return false;
  const r = range.trim();
  if (r === '' || r === '*') return true;

  // OR 组合
  const orGroups = r
    .split('||')
    .map((g) => g.trim())
    .filter(Boolean);
  if (orGroups.length > 1) {
    return orGroups.some((g) => satisfiesRange(version, g));
  }

  // 闭区间 "1.0.0 - 2.0.0"
  const hyphenMatch = r.match(/^(.+?)\s*-\s*(.+)$/);
  if (hyphenMatch && !r.match(/^[<>=^~]/)) {
    const low = hyphenMatch[1].trim();
    const high = hyphenMatch[2].trim();
    return compareVersions(v, low) >= 0 && compareVersions(v, high) <= 0;
  }

  // AND 组合（逗号或空格分隔）
  const comparators = r.split(/[\s,]+/).filter(Boolean);
  if (comparators.length === 0) return true;
  return comparators.every((comp) => satisfiesComparator(v, comp));
}

// ============================================================================
// CVEDatabase
// ============================================================================

export class CVEDatabase {
  /** CVE 条目存储（按 cveId 索引） */
  private entries: Map<string, CVEEntry> = new Map();
  /** 内置 CVE 数量 */
  private builtinCount: number = 0;
  /** 监听的 package.json 路径集合（用于定时重扫） */
  private watchedPaths: Set<string> = new Set();
  /** 上次扫描的依赖快照（用于定时增量扫描） */
  private lastScannedDeps: DependencyDescriptor[] = [];
  /** 上次扫描结果 */
  private lastScanResult?: ScanResult;
  /** 上次扫描时间 */
  private lastScanAt?: string;
  /** 累计扫描次数 */
  private scanCount: number = 0;
  /** 定时扫描定时器 */
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  /** 定时扫描间隔（毫秒） */
  private periodicIntervalMs?: number;
  /** 外部数据源配置 */
  private externalSources: ExternalSourceConfig[] = [];
  /** 上次外部数据源同步时间 */
  private lastExternalSyncAt?: string;

  constructor(options?: { externalSources?: ExternalSourceConfig[] }) {
    // 加载内置 CVE 数据库
    for (const entry of BUILTIN_CVE_ENTRIES) {
      this.entries.set(entry.cveId, { ...entry });
    }
    this.builtinCount = BUILTIN_CVE_ENTRIES.length;

    if (options?.externalSources) {
      for (const src of options.externalSources) {
        this.externalSources.push({ ...src });
      }
    }
  }

  // ── 数据源与条目管理 ────────────────────────────────────────────────

  /**
   * 添加外部 CVE 数据（来自 NVD / GitHub Advisory / 手动维护）。
   *
   * 已存在的 cveId 会被覆盖（以最新数据为准），并更新 lastModified。
   *
   * @param entries 外部 CVE 条目数组
   * @returns 实际新增 / 更新的条目数量
   */
  addExternalCVEs(entries: CVEEntry[]): number {
    let count = 0;
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (!entry.cveId) continue;
      const normalized: CVEEntry = {
        ...entry,
        source: entry.source ?? 'manual',
        lastModified: entry.lastModified ?? now,
        keywords: entry.keywords ?? [],
        affectedPackages: entry.affectedPackages ?? [],
        fixedVersions: entry.fixedVersions ?? {},
        cpe: entry.cpe ?? this.collectCpes(entry),
      };
      this.entries.set(entry.cveId, normalized);
      count++;
    }

    if (count > 0) {
      this.auditEvent(
        'cve_database_updated',
        `外部 CVE 数据已更新：新增/更新 ${count} 条`,
        { addedCount: count, totalEntries: this.entries.size },
        'low',
      );
      this.recordMetric('cve.database.external_added', count, {
        source: entries[0]?.source ?? 'manual',
      });
    }
    return count;
  }

  /**
   * 注册外部 CVE 数据源（NVD API / GitHub Advisory Database）。
   *
   * @param config 数据源配置
   */
  registerExternalSource(config: ExternalSourceConfig): void {
    const existing = this.externalSources.findIndex((s) => s.id === config.id);
    if (existing >= 0) {
      this.externalSources[existing] = { ...config };
    } else {
      this.externalSources.push({ ...config });
    }
    this.auditEvent(
      'external_source_registered',
      `外部数据源已注册：${config.name} (${config.type})`,
      { sourceId: config.id, type: config.type, enabled: config.enabled },
      'low',
    );
  }

  /**
   * 同步所有已启用的外部数据源（增量拉取最新 CVE）。
   *
   * 使用全局 fetch（Node 18+），失败时通过 reportSilentFailure 静默上报，
   * 不会中断调用方。返回本次同步新增 / 更新的条目数量。
   *
   * @returns 新增 / 更新的 CVE 条目数量
   */
  async syncExternalSources(): Promise<number> {
    let totalAdded = 0;
    const enabledSources = this.externalSources.filter((s) => s.enabled);
    if (enabledSources.length === 0) return 0;

    for (const source of enabledSources) {
      try {
        const entries = await this.fetchFromSource(source);
        if (entries.length > 0) {
          totalAdded += this.addExternalCVEs(entries);
        }
        source.lastSyncAt = new Date().toISOString();
        source.errorCount = 0;
      } catch (err) {
        source.errorCount += 1;
        reportSilentFailure(err, `cveDatabase.syncExternalSources:${source.id}`);
        try {
          const logger = getGlobalLogger();
          logger.warn('CVEDatabase', `外部数据源同步失败：${source.name}`, {
            sourceId: source.id,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* 日志不可用时忽略 */
        }
      }
    }

    this.lastExternalSyncAt = new Date().toISOString();
    return totalAdded;
  }

  /**
   * 从单个外部数据源拉取并映射 CVE 条目。
   * 防御性解析：响应结构不符合预期时返回空数组而非抛错。
   */
  private async fetchFromSource(source: ExternalSourceConfig): Promise<CVEEntry[]> {
    if (typeof fetch !== 'function') {
      return [];
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (source.apiKey) {
      headers['apiKey'] = source.apiKey;
    }
    const res = await fetch(source.endpoint, { headers });
    if (!res.ok) {
      throw new Error(`外部数据源 ${source.id} 返回状态码 ${res.status}`);
    }
    const data = (await res.json()) as unknown;

    if (source.type === 'nvd') {
      return this.mapNvdResponse(data);
    } else if (source.type === 'ghsa') {
      return this.mapGhsaResponse(data);
    }
    // 通用 URL：尝试按 NVD 结构解析，失败则返回空
    return this.mapNvdResponse(data);
  }

  /** 将 NVD API 响应映射为 CVEEntry[] */
  private mapNvdResponse(data: unknown): CVEEntry[] {
    const out: CVEEntry[] = [];
    if (!isObjectWithProp(data, 'vulnerabilities')) return out;
    const vulns = (data as { vulnerabilities: unknown[] }).vulnerabilities;
    if (!Array.isArray(vulns)) return out;
    for (const v of vulns) {
      if (!isObjectWithProp(v, 'cve')) continue;
      const cve = (v as { cve: Record<string, unknown> }).cve;
      const cveId = cve.id as string | undefined;
      if (!cveId) continue;
      const descriptions = cve.descriptions as Array<{ lang: string; value: string }> | undefined;
      const description =
        descriptions?.find((d) => d.lang === 'en')?.value ?? descriptions?.[0]?.value ?? '无描述';
      const metrics = cve.metrics as Record<string, unknown> | undefined;
      const cvssData = this.extractCvss(metrics);
      const published = (cve.published as string) ?? new Date().toISOString();
      const modified = (cve.lastModified as string) ?? published;
      out.push({
        cveId,
        description,
        cvssScore: cvssData.score,
        severity: this.severityFromScore(cvssData.score),
        affectedPackages: [],
        fixedVersions: {},
        exploitAvailable: false,
        weaponized: false,
        publicPoc: false,
        keywords: [],
        references: this.extractReferences(cve),
        publishedDate: published,
        lastModified: modified,
        source: 'nvd',
      });
    }
    return out;
  }

  /** 将 GitHub Advisory Database 响应映射为 CVEEntry[] */
  private mapGhsaResponse(data: unknown): CVEEntry[] {
    const out: CVEEntry[] = [];
    const advisories = isObjectWithProp(data, 'data')
      ? ((data as { data: { securityVulnerabilities?: { nodes?: unknown[] } } }).data
          ?.securityVulnerabilities?.nodes ?? [])
      : Array.isArray(data)
        ? data
        : [];
    if (!Array.isArray(advisories)) return out;
    for (const adv of advisories) {
      if (!isObjectWithProp(adv, 'advisory')) continue;
      const advisory = (
        adv as { advisory: Record<string, unknown>; package?: Record<string, unknown> }
      ).advisory;
      const ghsaId = advisory.ghsaId as string | undefined;
      const cveIds = advisory.cveId as string | undefined;
      const cveId = cveIds ?? ghsaId;
      if (!cveId) continue;
      const summary = (advisory.summary as string) ?? '无描述';
      const cvss = advisory.cvss as { score?: number } | undefined;
      const score = cvss?.score ?? 0;
      const pkg = (adv as { package?: { name?: string; ecosystem?: string } }).package;
      const affectedPackages = pkg?.name
        ? [
            {
              name: pkg.name,
              ecosystem: (pkg.ecosystem?.toLowerCase() as PackageEcosystem) ?? 'npm',
              vulnerableRange:
                (adv as { vulnerableVersionRange?: string }).vulnerableVersionRange ?? '*',
            },
          ]
        : [];
      const published = (advisory.publishedAt as string) ?? new Date().toISOString();
      const modified = (advisory.updatedAt as string) ?? published;
      out.push({
        cveId,
        description: summary,
        cvssScore: score,
        severity: this.severityFromScore(score),
        affectedPackages,
        fixedVersions: {},
        exploitAvailable: false,
        weaponized: false,
        publicPoc: false,
        keywords: pkg?.name ? [pkg.name] : [],
        publishedDate: published,
        lastModified: modified,
        source: 'ghsa',
      });
    }
    return out;
  }

  /** 从 NVD metrics 中提取 CVSS 评分 */
  private extractCvss(metrics: Record<string, unknown> | undefined): { score: number } {
    if (!metrics) return { score: 0 };
    const keys = ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2'];
    for (const key of keys) {
      const arr = metrics[key] as Array<{ cvssData?: { baseScore?: number } }> | undefined;
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.cvssData?.baseScore != null) {
        return { score: arr[0].cvssData.baseScore };
      }
    }
    return { score: 0 };
  }

  /** 从 NVD cve 节点提取参考链接 */
  private extractReferences(cve: Record<string, unknown>): string[] {
    const refs = cve.references as Array<{ url?: string }> | undefined;
    if (!Array.isArray(refs)) return [];
    return refs.map((r) => r.url).filter((u): u is string => typeof u === 'string');
  }

  /** 从 affectedPackages 汇总 CPE 列表 */
  private collectCpes(entry: CVEEntry): string[] {
    const cpes: string[] = [];
    for (const p of entry.affectedPackages) {
      if (p.cpe) cpes.push(p.cpe);
    }
    if (entry.cpe) for (const c of entry.cpe) cpes.push(c);
    return Array.from(new Set(cpes));
  }

  // ── 查询 API ───────────────────────────────────────────────────────

  /**
   * 根据 CVE 编号获取单条 CVE 详情。
   *
   * @param cveId CVE 编号（如 "CVE-2026-33017"）
   * @returns CVE 条目；不存在时返回 undefined
   */
  getCVE(cveId: string): CVEEntry | undefined {
    return this.entries.get(cveId);
  }

  /**
   * 搜索 CVE 数据库，支持关键字模糊匹配、CPE 匹配与多条件过滤。
   *
   * @param query 搜索关键字（字符串）或结构化查询对象
   * @returns 匹配的 CVE 条目数组（按 CVSS 评分降序）
   */
  searchCVE(query: string | CVESearchQuery): CVEEntry[] {
    const q: CVESearchQuery =
      typeof query === 'string' ? { keyword: query, limit: 50 } : { limit: 50, ...query };
    const keyword = q.keyword?.toLowerCase().trim();
    const results: CVEEntry[] = [];

    for (const entry of this.entries.values()) {
      // CVE 编号精确匹配
      if (q.cveId && entry.cveId.toLowerCase() === q.cveId.toLowerCase()) {
        results.push(entry);
        continue;
      }

      // 关键字模糊匹配（cveId / description / keywords / 包名）
      if (keyword) {
        const haystack = [
          entry.cveId,
          entry.description,
          ...entry.keywords,
          ...entry.affectedPackages.map((p) => p.name),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }

      // 包名过滤
      if (q.packageName) {
        const hasPkg = entry.affectedPackages.some(
          (p) => p.name.toLowerCase() === q.packageName!.toLowerCase(),
        );
        if (!hasPkg) continue;
      }

      // 生态系统过滤
      if (q.ecosystem) {
        const hasEco = entry.affectedPackages.some((p) => p.ecosystem === q.ecosystem);
        if (!hasEco) continue;
      }

      // CPE 匹配
      if (q.cpe) {
        const allCpes = this.collectCpes(entry);
        const matched = allCpes.some((c) => c.includes(q.cpe!));
        if (!matched) continue;
      }

      // 最低 CVSS 过滤
      if (q.minCvss !== undefined && entry.cvssScore < q.minCvss) continue;

      // 严重级别过滤
      if (q.severity && entry.severity !== q.severity) continue;

      // 利用可用性过滤
      if (q.exploitAvailable !== undefined && entry.exploitAvailable !== q.exploitAvailable) {
        continue;
      }

      results.push(entry);
    }

    // 按 CVSS 评分降序排序
    results.sort((a, b) => b.cvssScore - a.cvssScore);
    return results.slice(0, q.limit ?? 50);
  }

  // ── 扫描 API ───────────────────────────────────────────────────────

  /**
   * 扫描依赖列表，返回所有命中的漏洞匹配。
   *
   * 匹配引擎按「包名 + 生态系统 + 版本范围」精确匹配，同时支持依赖描述符
   * 携带 cpe 时的 CPE 匹配。
   *
   * @param deps 依赖描述符数组
   * @returns 扫描结果（含匹配列表与统计）
   */
  scanDependencies(deps: DependencyDescriptor[]): ScanResult {
    const startTime = Date.now();
    const matches: VulnerabilityMatch[] = [];
    let transitiveScanned = 0;
    const integrityIssues: Array<{ name: string; version: string; reason: string }> = [];

    for (const dep of deps) {
      if (dep.transitive) transitiveScanned++;

      // 完整性哈希检查：缺失 sha512 视为供应链可疑
      if (dep.integrity !== undefined && !dep.integrity.startsWith('sha512')) {
        integrityIssues.push({
          name: dep.name,
          version: dep.version,
          reason: `完整性哈希算法非 sha512：${dep.integrity.slice(0, 32)}`,
        });
      }

      const depMatches = this.matchDependency(dep);
      matches.push(...depMatches);
    }

    const result = this.buildScanResult(deps.length, matches, startTime, {
      transitiveScanned,
      integrityIssues,
    });

    this.lastScannedDeps = [...deps];
    this.lastScanResult = result;
    this.lastScanAt = result.scannedAt;
    this.scanCount++;

    this.auditScan(result);
    this.recordScanMetrics(result);
    return result;
  }

  /**
   * 扫描指定路径的 package.json（含同目录 package-lock.json 的传递依赖与完整性哈希）。
   *
   * 解析 dependencies / devDependencies / peerDependencies / optionalDependencies，
   * 并在存在 package-lock.json 时合并传递依赖。该路径会被加入监听集合，供定时重扫。
   *
   * @param packageJsonPath package.json 的绝对或相对路径
   * @returns 扫描结果
   */
  scanPackageJson(packageJsonPath: string): ScanResult {
    const startTime = Date.now();
    const deps: DependencyDescriptor[] = [];
    const integrityIssues: Array<{ name: string; version: string; reason: string }> = [];
    let transitiveScanned = 0;

    try {
      const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const dir = path.dirname(packageJsonPath);

      // 解析各类依赖
      const depSections = [
        { key: 'dependencies', isDev: false },
        { key: 'devDependencies', isDev: true },
        { key: 'peerDependencies', isDev: false },
        { key: 'optionalDependencies', isDev: false },
      ] as const;

      const directNames = new Set<string>();
      for (const section of depSections) {
        const sectionDeps = pkgJson[section.key] as Record<string, string> | undefined;
        if (!sectionDeps || typeof sectionDeps !== 'object') continue;
        for (const [name, version] of Object.entries(sectionDeps)) {
          directNames.add(name);
          deps.push({
            name,
            version: this.stripSemverPrefix(String(version)),
            ecosystem: 'npm',
            isDev: section.isDev,
            transitive: false,
          });
        }
      }

      // 解析 package-lock.json（传递依赖 + 完整性哈希）
      const lockPath = path.join(dir, 'package-lock.json');
      if (fs.existsSync(lockPath)) {
        const lockDeps = this.parseLockfile(lockPath, directNames, integrityIssues);
        for (const ld of lockDeps) {
          deps.push(ld);
          if (ld.transitive) transitiveScanned++;
        }
      }

      // 记录监听路径（用于定时重扫）
      this.watchedPaths.add(path.resolve(packageJsonPath));
    } catch (err) {
      reportSilentFailure(err, 'cveDatabase.scanPackageJson');
      // 解析失败时返回空结果而非抛错
      return this.buildScanResult(0, [], startTime, {
        transitiveScanned: 0,
        integrityIssues: [
          {
            name: '<package.json>',
            version: '',
            reason: `解析失败：${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      });
    }

    const matches: VulnerabilityMatch[] = [];
    for (const dep of deps) {
      matches.push(...this.matchDependency(dep));
    }

    const result = this.buildScanResult(deps.length, matches, startTime, {
      transitiveScanned,
      integrityIssues,
    });

    this.lastScannedDeps = [...deps];
    this.lastScanResult = result;
    this.lastScanAt = result.scannedAt;
    this.scanCount++;

    this.auditScan(result);
    this.recordScanMetrics(result);
    return result;
  }

  /**
   * 解析 package-lock.json，提取传递依赖与完整性哈希信息。
   */
  private parseLockfile(
    lockPath: string,
    directNames: Set<string>,
    integrityIssues: Array<{ name: string; version: string; reason: string }>,
  ): DependencyDescriptor[] {
    const deps: DependencyDescriptor[] = [];
    let lock: Record<string, unknown>;
    try {
      lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      reportSilentFailure(err, 'cveDatabase.parseLockfile');
      return deps;
    }

    const lockfileVersion = lock.lockfileVersion as number | undefined;

    // lockfile v2/v3：packages 字段，键形如 "node_modules/foo"
    const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
    if (packages && typeof packages === 'object') {
      for (const [pkgPath, info] of Object.entries(packages)) {
        if (!pkgPath || pkgPath === '' || !info || typeof info !== 'object') continue;
        // 从路径提取包名（处理 scoped 包与嵌套）
        const name = this.extractPackageNameFromLockPath(pkgPath);
        if (!name) continue;
        const version = (info.version as string) ?? '0.0.0';
        const integrity = info.integrity as string | undefined;
        const resolved = info.resolved as string | undefined;
        const isDirect = directNames.has(name);

        if (!integrity) {
          integrityIssues.push({
            name,
            version,
            reason: 'lockfile 中缺失 integrity 完整性哈希（潜在供应链篡改风险）',
          });
        } else if (!integrity.startsWith('sha512')) {
          integrityIssues.push({
            name,
            version,
            reason: `完整性哈希算法非 sha512：${integrity.slice(0, 32)}`,
          });
        }

        deps.push({
          name,
          version,
          ecosystem: 'npm',
          integrity,
          resolved,
          transitive: !isDirect,
        });
      }
      return deps;
    }

    // lockfile v1：dependencies 字段
    const dependencies = lock.dependencies as Record<string, Record<string, unknown>> | undefined;
    if (dependencies && typeof dependencies === 'object') {
      for (const [name, info] of Object.entries(dependencies)) {
        if (!info || typeof info !== 'object') continue;
        const version = (info.version as string) ?? '0.0.0';
        const integrity = info.integrity as string | undefined;
        const isDirect = directNames.has(name);

        if (!integrity) {
          integrityIssues.push({
            name,
            version,
            reason: 'lockfile 中缺失 integrity 完整性哈希（潜在供应链篡改风险）',
          });
        }

        deps.push({
          name,
          version,
          ecosystem: 'npm',
          integrity,
          transitive: !isDirect,
        });
      }
    }

    // 兼容：若 lockfileVersion 未识别但存在上述结构，已处理
    void lockfileVersion;
    return deps;
  }

  /** 从 lockfile v2/v3 的 packages 键中提取包名 */
  private extractPackageNameFromLockPath(pkgPath: string): string | undefined {
    if (!pkgPath.startsWith('node_modules/')) return undefined;
    const rest = pkgPath.slice('node_modules/'.length);
    // scoped 包：@scope/name
    if (rest.startsWith('@')) {
      const slashIdx = rest.indexOf('/');
      if (slashIdx < 0) return rest;
      return rest.slice(0, slashIdx) + rest.slice(rest.indexOf('/', slashIdx + 1));
    }
    const slashIdx = rest.indexOf('/');
    return slashIdx < 0 ? rest : rest.slice(0, slashIdx);
  }

  /** 去除 semver 前缀（^ / ~ / >= 等），返回纯版本号 */
  private stripSemverPrefix(version: string): string {
    return version.replace(/^[^0-9]*/, '').trim() || version;
  }

  // ── 匹配引擎 ───────────────────────────────────────────────────────

  /**
   * 对单个依赖执行匹配：包名+版本范围、CPE、关键字。
   * 返回所有命中的 VulnerabilityMatch。
   */
  private matchDependency(dep: DependencyDescriptor): VulnerabilityMatch[] {
    const matches: VulnerabilityMatch[] = [];
    const ecosystem: PackageEcosystem = dep.ecosystem ?? 'npm';
    const depVersion = this.stripSemverPrefix(dep.version);

    for (const entry of this.entries.values()) {
      let matchedBy: 'package_version' | 'cpe' | 'keyword' | null = null;
      let matchedPkgName: string | null = null;

      // 1. 按包名 + 版本范围匹配
      for (const pkg of entry.affectedPackages) {
        if (
          pkg.name.toLowerCase() === dep.name.toLowerCase() &&
          (pkg.ecosystem === ecosystem || pkg.ecosystem === 'generic')
        ) {
          if (satisfiesRange(depVersion, pkg.vulnerableRange)) {
            matchedBy = 'package_version';
            matchedPkgName = pkg.name;
            break;
          }
        }
      }

      // 2. 按 CPE 匹配（依赖描述符携带 cpe 时）
      if (!matchedBy && dep.cpe) {
        const allCpes = this.collectCpes(entry);
        if (allCpes.some((c) => c === dep.cpe || c.includes(dep.cpe!) || dep.cpe!.includes(c))) {
          matchedBy = 'cpe';
          matchedPkgName = dep.name;
        }
      }

      // 3. 按关键字模糊匹配（仅当包名出现在 CVE 关键字中，避免误报）
      if (!matchedBy) {
        const nameLower = dep.name.toLowerCase();
        const keywordHit = entry.keywords.some(
          (k) => k.toLowerCase() === nameLower || k.toLowerCase().includes(nameLower),
        );
        // 关键字匹配需要额外确认版本范围（若有同名受影响包）
        if (keywordHit) {
          const pkg = entry.affectedPackages.find(
            (p) =>
              p.name.toLowerCase() === dep.name.toLowerCase() &&
              satisfiesRange(depVersion, p.vulnerableRange),
          );
          if (pkg) {
            matchedBy = 'keyword';
            matchedPkgName = pkg.name;
          }
        }
      }

      if (matchedBy && matchedPkgName) {
        const priority = this.priorityFromEntry(entry);
        const safeVersion = entry.fixedVersions[matchedPkgName];
        matches.push({
          cveId: entry.cveId,
          packageName: matchedPkgName,
          installedVersion: dep.version,
          ecosystem,
          severity: entry.severity,
          cvssScore: entry.cvssScore,
          exploitAvailable: entry.exploitAvailable,
          weaponized: entry.weaponized,
          priority,
          matchedBy,
          recommendation: this.buildRecommendationSummary(
            entry,
            matchedPkgName,
            safeVersion,
            priority,
          ),
        });
      }
    }

    return matches;
  }

  // ── 评分与优先级 ───────────────────────────────────────────────────

  /**
   * 根据 CVSS 评分计算严重级别。
   * 9.0+ = CRITICAL，7.0-8.9 = HIGH，4.0-6.9 = MEDIUM，<4.0 = LOW。
   */
  severityFromScore(score: number): CVESeverity {
    if (score >= 9.0) return 'CRITICAL';
    if (score >= 7.0) return 'HIGH';
    if (score >= 4.0) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * 根据 CVSS 评分 + 利用可能性评估修复优先级。
   * - CRITICAL（或被武器化/有 PoC 的 HIGH）→ IMMEDIATE 立即修复
   * - HIGH → THIS_WEEK 本周修复
   * - MEDIUM → THIS_MONTH 本月修复
   * - LOW → MONITOR 持续关注
   */
  priorityFromEntry(entry: CVEEntry): FixPriority {
    if (entry.severity === 'CRITICAL') return 'IMMEDIATE';
    if (entry.severity === 'HIGH') {
      return entry.weaponized || entry.publicPoc ? 'IMMEDIATE' : 'THIS_WEEK';
    }
    if (entry.severity === 'MEDIUM') return 'THIS_MONTH';
    return 'MONITOR';
  }

  // ── 修复建议 ───────────────────────────────────────────────────────

  /**
   * 获取针对特定 CVE + 包 + 已安装版本的修复建议，含安全版本、升级命令、
   * 替代包与可一键提交的修复 PR 描述（Markdown）。
   *
   * @param cveId CVE 编号
   * @param packageName 包名
   * @param installedVersion 已安装版本
   * @returns 修复建议；CVE 不存在时返回 undefined
   */
  getFixRecommendation(
    cveId: string,
    packageName: string,
    installedVersion: string,
  ): FixRecommendation | undefined {
    const entry = this.entries.get(cveId);
    if (!entry) return undefined;

    const priority = this.priorityFromEntry(entry);
    const recommendedVersion = entry.fixedVersions[packageName];
    const ecosystem =
      entry.affectedPackages.find((p) => p.name === packageName)?.ecosystem ?? 'npm';
    const upgradeCommand = recommendedVersion
      ? this.buildUpgradeCommand(packageName, recommendedVersion, ecosystem)
      : undefined;
    const alternatives = SAFE_ALTERNATIVES[packageName.toLowerCase()];

    const rationale = this.buildRationale(entry, packageName, recommendedVersion);
    const prDescription = this.generatePrDescription(
      entry,
      packageName,
      installedVersion,
      recommendedVersion,
      upgradeCommand,
      alternatives,
      priority,
    );

    return {
      cveId,
      packageName,
      installedVersion,
      severity: entry.severity,
      priority,
      recommendedVersion,
      upgradeCommand,
      alternativePackages: alternatives,
      rationale,
      prDescription,
    };
  }

  /** 构建升级命令 */
  private buildUpgradeCommand(
    packageName: string,
    version: string,
    ecosystem: PackageEcosystem,
  ): string {
    switch (ecosystem) {
      case 'npm':
        return `npm install ${packageName}@${version}`;
      case 'pypi':
        return `pip install ${packageName}==${version}`;
      case 'maven':
        return `mvn versions:use-dep-version -Dincludes=${packageName} -DdepVersion=${version}`;
      case 'go':
        return `go get ${packageName}@v${version}`;
      case 'composer':
        return `composer require ${packageName}:${version}`;
      case 'gem':
        return `gem install ${packageName} -v ${version}`;
      case 'nuget':
        return `dotnet add package ${packageName} --version ${version}`;
      default:
        return `升级 ${packageName} 至 ${version} 或更高版本`;
    }
  }

  /** 构建修复理由文本 */
  private buildRationale(
    entry: CVEEntry,
    packageName: string,
    recommendedVersion?: string,
  ): string {
    const parts: string[] = [];
    parts.push(`${entry.cveId}（CVSS ${entry.cvssScore}，${entry.severity}）影响 ${packageName}`);
    if (entry.weaponized) parts.push('该漏洞已被武器化 / 出现在野利用');
    else if (entry.publicPoc) parts.push('该漏洞存在公开 PoC');
    else if (entry.exploitAvailable) parts.push('该漏洞存在公开利用');
    if (recommendedVersion) parts.push(`建议升级至 ${recommendedVersion} 或更高版本`);
    else parts.push('暂无官方修复版本，建议关注厂商公告并采取缓解措施');
    return parts.join('；') + '。';
  }

  /** 构建简短修复建议摘要 */
  private buildRecommendationSummary(
    entry: CVEEntry,
    packageName: string,
    safeVersion?: string,
    priority?: FixPriority,
  ): string {
    const action = safeVersion ? `升级至 ${safeVersion}+` : '关注厂商修复公告并采取缓解措施';
    const urgency =
      priority === 'IMMEDIATE'
        ? '立即修复'
        : priority === 'THIS_WEEK'
          ? '本周修复'
          : priority === 'THIS_MONTH'
            ? '本月修复'
            : '持续关注';
    return `${urgency}：${packageName} 受 ${entry.cveId}（CVSS ${entry.cvssScore}）影响，${action}`;
  }

  /**
   * 生成修复 PR 描述（Markdown）。
   */
  private generatePrDescription(
    entry: CVEEntry,
    packageName: string,
    installedVersion: string,
    recommendedVersion: string | undefined,
    upgradeCommand: string | undefined,
    alternatives: Array<{ name: string; reason: string }> | undefined,
    priority: FixPriority,
  ): string {
    const exploitStatus = entry.weaponized
      ? '已被武器化 / 出现在野利用'
      : entry.publicPoc
        ? '存在公开 PoC'
        : entry.exploitAvailable
          ? '存在公开利用'
          : '暂无公开利用';
    const lines: string[] = [];
    lines.push(`## 安全修复：${entry.cveId}`);
    lines.push('');
    lines.push('### 漏洞概述');
    lines.push(entry.description);
    lines.push('');
    lines.push('| 项目 | 详情 |');
    lines.push('| --- | --- |');
    lines.push(`| CVE 编号 | ${entry.cveId} |`);
    lines.push(`| 严重级别 | ${entry.severity} (CVSS ${entry.cvssScore}) |`);
    lines.push(`| 受影响包 | \`${packageName}@${installedVersion}\` |`);
    lines.push(`| 利用状态 | ${exploitStatus} |`);
    lines.push(`| 修复优先级 | ${priority} |`);
    lines.push(`| CWE | ${(entry.cweIds ?? ['未分类']).join(', ')} |`);
    lines.push('');
    lines.push('### 修复方案');
    if (recommendedVersion && upgradeCommand) {
      lines.push(`升级 \`${packageName}\` 至 \`${recommendedVersion}\` 或更高版本：`);
      lines.push('');
      lines.push('```bash');
      lines.push(upgradeCommand);
      lines.push('```');
    } else {
      lines.push('暂无官方修复版本，建议采取以下缓解措施：');
      lines.push('');
      lines.push('- 限制受影响组件的网络暴露面');
      lines.push('- 部署 WAF / 入侵检测规则拦截已知利用特征');
      lines.push('- 持续关注厂商安全公告，修复版本发布后立即升级');
    }
    lines.push('');
    if (alternatives && alternatives.length > 0) {
      lines.push('### 替代包建议');
      for (const alt of alternatives) {
        lines.push(`- **${alt.name}**：${alt.reason}`);
      }
      lines.push('');
    }
    if (entry.references && entry.references.length > 0) {
      lines.push('### 参考');
      for (const ref of entry.references) {
        lines.push(`- ${ref}`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('_本 PR 描述由 Commander CVEDatabase 自动生成。_');
    return lines.join('\n');
  }

  // ── 定时扫描调度 ───────────────────────────────────────────────────

  /**
   * 启动定时扫描调度。
   *
   * 行为：
   *   1. 立即对已监听的 package.json 路径执行一次启动全量扫描；
   *   2. 按指定间隔执行增量扫描（重扫监听路径 + 同步外部 CVE 数据源，
   *      以捕获新发布的 CVE）；
   *   3. 依赖变更可通过 `triggerDependencyRescan()` 主动触发。
   *
   * @param intervalMs 扫描间隔（毫秒），默认 1 小时
   */
  startPeriodicScan(intervalMs: number = 60 * 60 * 1000): void {
    if (this.periodicTimer) {
      // 已在运行：先停止再以新间隔重启
      this.stopPeriodicScan();
    }
    this.periodicIntervalMs = intervalMs;

    // 启动时全量扫描
    void this.runPeriodicScan('startup');

    this.periodicTimer = setInterval(() => {
      void this.runPeriodicScan('interval');
    }, intervalMs);

    this.auditEvent(
      'periodic_scan_started',
      `定时漏洞扫描已启动，间隔 ${intervalMs} ms`,
      { intervalMs },
      'low',
    );
    try {
      getGlobalLogger().info('CVEDatabase', `定时漏洞扫描已启动（间隔 ${intervalMs} ms）`, {
        intervalMs,
        watchedPaths: this.watchedPaths.size,
      });
    } catch (err) {
      reportSilentFailure(err, 'cveDatabase.startPeriodicScan');
    }
  }

  /**
   * 停止定时扫描调度。
   */
  stopPeriodicScan(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
      this.auditEvent('periodic_scan_stopped', '定时漏洞扫描已停止', {}, 'low');
      try {
        getGlobalLogger().info('CVEDatabase', '定时漏洞扫描已停止', {});
      } catch (err) {
        reportSilentFailure(err, 'cveDatabase.stopPeriodicScan');
      }
    }
  }

  /**
   * 依赖变更时主动触发一次重新扫描（无需等待下一个定时周期）。
   * 扫描所有已监听的 package.json 路径；若无监听路径则重扫上次依赖快照。
   *
   * @returns 扫描结果
   */
  triggerDependencyRescan(): ScanResult {
    return this.runPeriodicScan('dependency_change');
  }

  /**
   * 执行一次定时 / 触发型扫描的内部实现。
   * - 增量同步外部数据源（捕获新 CVE）
   * - 重扫所有监听路径；无监听路径时重扫上次依赖快照
   */
  private runPeriodicScan(trigger: 'startup' | 'interval' | 'dependency_change'): ScanResult {
    const startTime = Date.now();

    // 增量同步外部数据源（best-effort，不阻塞扫描）
    void this.syncExternalSources().catch((err) => {
      reportSilentFailure(err, 'cveDatabase.runPeriodicScan.syncExternalSources');
    });

    let result: ScanResult;
    if (this.watchedPaths.size > 0) {
      // 合并所有监听路径的依赖
      const allDeps: DependencyDescriptor[] = [];
      const allIntegrityIssues: Array<{ name: string; version: string; reason: string }> = [];
      let transitiveScanned = 0;
      for (const pkgPath of this.watchedPaths) {
        try {
          if (!fs.existsSync(pkgPath)) continue;
          const r = this.scanPackageJson(pkgPath);
          // scanPackageJson 已写入 lastScanResult；这里合并用于汇总
          // 通过重新解析依赖来聚合 —— 简化处理：直接累加其 matches
          allIntegrityIssues.push(...(r.integrityIssues ?? []));
          transitiveScanned += r.transitiveScanned ?? 0;
          // 累加 matches（注意：scanPackageJson 已审计单次结果，
          // 这里再构建一次汇总结果用于定时扫描的统一视图）
          for (const m of r.matches) {
            allDeps.push({
              name: m.packageName,
              version: m.installedVersion,
              ecosystem: m.ecosystem,
            });
          }
        } catch (err) {
          reportSilentFailure(err, `cveDatabase.runPeriodicScan:${pkgPath}`);
        }
      }
      // 基于合并后的依赖重新匹配，得到统一扫描结果
      const matches: VulnerabilityMatch[] = [];
      // 使用上次扫描的完整依赖快照更准确
      const depsToScan = this.lastScannedDeps.length > 0 ? this.lastScannedDeps : allDeps;
      for (const dep of depsToScan) {
        matches.push(...this.matchDependency(dep));
      }
      result = this.buildScanResult(depsToScan.length, matches, startTime, {
        transitiveScanned,
        integrityIssues: allIntegrityIssues,
      });
    } else if (this.lastScannedDeps.length > 0) {
      const matches: VulnerabilityMatch[] = [];
      for (const dep of this.lastScannedDeps) {
        matches.push(...this.matchDependency(dep));
      }
      result = this.buildScanResult(this.lastScannedDeps.length, matches, startTime, {});
    } else {
      result = this.buildScanResult(0, [], startTime, {});
    }

    this.lastScanResult = result;
    this.lastScanAt = result.scannedAt;
    this.scanCount++;

    this.auditEvent(
      'periodic_scan_completed',
      `定时漏洞扫描完成（触发：${trigger}）：发现 ${result.vulnerabilitiesFound} 个漏洞`,
      {
        trigger,
        totalScanned: result.totalScanned,
        vulnerabilitiesFound: result.vulnerabilitiesFound,
        criticalCount: result.criticalCount,
        highCount: result.highCount,
        scanDurationMs: result.scanDurationMs,
      },
      result.criticalCount > 0 ? 'critical' : result.highCount > 0 ? 'high' : 'low',
    );
    this.recordScanMetrics(result);
    return result;
  }

  // ── 统计 ───────────────────────────────────────────────────────────

  /**
   * 获取 CVE 数据库与扫描的统计信息。
   */
  getStats(): CVEStats {
    const bySeverity: Record<CVESeverity, number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };
    const bySource: Record<CVESource, number> = {
      builtin: 0,
      nvd: 0,
      ghsa: 0,
      manual: 0,
    };
    let criticalExploitAvailable = 0;

    for (const entry of this.entries.values()) {
      bySeverity[entry.severity]++;
      bySource[entry.source]++;
      if (entry.severity === 'CRITICAL' && entry.exploitAvailable) {
        criticalExploitAvailable++;
      }
    }

    return {
      totalCVEs: this.entries.size,
      builtinCVEs: this.builtinCount,
      externalCVEs: this.entries.size - this.builtinCount,
      bySeverity,
      bySource,
      criticalExploitAvailable,
      lastScanAt: this.lastScanAt,
      lastScanResult: this.lastScanResult,
      periodicScanActive: this.periodicTimer !== null,
      periodicScanIntervalMs: this.periodicIntervalMs,
      totalScansRun: this.scanCount,
      watchedPathCount: this.watchedPaths.size,
    };
  }

  // ── 内部工具 ───────────────────────────────────────────────────────

  /** 构建 ScanResult 并统计严重级别分布 */
  private buildScanResult(
    totalScanned: number,
    matches: VulnerabilityMatch[],
    startTime: number,
    extra: {
      transitiveScanned?: number;
      integrityIssues?: Array<{ name: string; version: string; reason: string }>;
    },
  ): ScanResult {
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    for (const m of matches) {
      if (m.severity === 'CRITICAL') criticalCount++;
      else if (m.severity === 'HIGH') highCount++;
      else if (m.severity === 'MEDIUM') mediumCount++;
    }
    return {
      totalScanned,
      vulnerabilitiesFound: matches.length,
      criticalCount,
      highCount,
      mediumCount,
      matches,
      scanDurationMs: Date.now() - startTime,
      scannedAt: new Date().toISOString(),
      transitiveScanned: extra.transitiveScanned,
      integrityIssues: extra.integrityIssues,
    };
  }

  /** 记录扫描审计事件到 SecurityAuditLogger */
  private auditScan(result: ScanResult): void {
    try {
      const audit = getSecurityAuditLogger();
      const severity =
        result.criticalCount > 0
          ? 'critical'
          : result.highCount > 0
            ? 'high'
            : result.mediumCount > 0
              ? 'medium'
              : 'low';
      audit.logEvent({
        type: 'security_scan',
        severity,
        source: 'CVEDatabase',
        message: `依赖漏洞扫描完成：扫描 ${result.totalScanned} 个依赖，发现 ${result.vulnerabilitiesFound} 个漏洞（CRITICAL ${result.criticalCount} / HIGH ${result.highCount} / MEDIUM ${result.mediumCount}）`,
        details: {
          totalScanned: result.totalScanned,
          vulnerabilitiesFound: result.vulnerabilitiesFound,
          criticalCount: result.criticalCount,
          highCount: result.highCount,
          mediumCount: result.mediumCount,
          scanDurationMs: result.scanDurationMs,
          integrityIssueCount: result.integrityIssues?.length ?? 0,
          matches: result.matches.map((m) => ({
            cveId: m.cveId,
            package: `${m.packageName}@${m.installedVersion}`,
            severity: m.severity,
            priority: m.priority,
          })),
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'cveDatabase.auditScan');
    }
  }

  /** 通用审计事件封装 */
  private auditEvent(
    action: string,
    message: string,
    details: Record<string, unknown>,
    severity: 'low' | 'medium' | 'high' | 'critical',
  ): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_scan',
        severity,
        source: 'CVEDatabase',
        message,
        details: { action, ...details },
      });
    } catch (err) {
      reportSilentFailure(err, 'cveDatabase.auditEvent');
    }
  }

  /** 记录扫描相关指标到 MetricsCollector */
  private recordScanMetrics(result: ScanResult): void {
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('cve.scan.total', 1);
      metrics.incrementCounter('cve.scan.dependencies_scanned', result.totalScanned);
      metrics.incrementCounter('cve.scan.vulnerabilities_found', result.vulnerabilitiesFound);
      metrics.incrementCounter('cve.scan.critical', result.criticalCount);
      metrics.incrementCounter('cve.scan.high', result.highCount);
      metrics.incrementCounter('cve.scan.medium', result.mediumCount);
      metrics.setGauge('cve.scan.last_duration_ms', result.scanDurationMs);
      metrics.setGauge('cve.scan.last_vulnerabilities', result.vulnerabilitiesFound);
      metrics.recordHistogram('cve.scan.duration_ms', result.scanDurationMs);
      if (result.integrityIssues && result.integrityIssues.length > 0) {
        metrics.incrementCounter('cve.scan.integrity_issues', result.integrityIssues.length);
      }
    } catch (err) {
      reportSilentFailure(err, 'cveDatabase.recordScanMetrics');
    }
  }

  /** 通用指标记录 */
  private recordMetric(name: string, value: number, labels: Record<string, string>): void {
    try {
      getGlobalMetrics().incrementCounter(name, value, labels);
    } catch (err) {
      reportSilentFailure(err, 'cveDatabase.recordMetric');
    }
  }
}

// ============================================================================
// 类型守卫工具
// ============================================================================

/** 判断对象是否包含指定属性（用于防御性解析外部 API 响应） */
function isObjectWithProp(obj: unknown, prop: string): boolean {
  return typeof obj === 'object' && obj !== null && prop in obj;
}

// ============================================================================
// 租户感知单例
// ============================================================================

const cveDatabaseSingleton = createTenantAwareSingleton(() => new CVEDatabase(), {
  allowGlobalFallback: true,
});

/**
 * 获取 CVEDatabase 单例（租户感知）。
 *
 * 在租户上下文中返回该租户专属实例；否则返回全局回退实例。
 */
export function getCVEDatabase(): CVEDatabase {
  return cveDatabaseSingleton.get();
}

/**
 * 重置 CVEDatabase 单例（主要用于测试隔离）。
 *
 * 会停止定时扫描并清空所有租户实例。
 */
export function resetCVEDatabase(): void {
  cveDatabaseSingleton.reset();
}
