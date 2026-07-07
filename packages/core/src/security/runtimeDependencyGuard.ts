/**
 * RuntimeDependencyGuard — 运行时依赖完整性防护模块。
 *
 * 背景：2026 年上半年供应链攻击频发，包括但不限于：
 *   - CVE-2026-45321：TanStack npm 包投毒
 *   - CVE-2026-48027：Nx Console VS Code 扩展供应链攻击
 *   - npm 依赖混淆攻击（dependency confusion）
 *   - 自传播供应链蠕虫劫持 npm 包窃取开发者令牌
 *
 * 本模块在运行时为 Commander 提供六层纵深防护：
 *   1. 运行时依赖完整性验证 —— 模块加载时计算 node_modules 的 SHA-256 哈希，
 *      定期重新计算并比较，检测文件篡改。
 *   2. 依赖混淆攻击检测 —— 检查 package.json 依赖是否在公共注册表存在同名包，
 *      检测私有包名被抢注、版本号异常。
 *   3. Post-install 脚本审计 —— 扫描 preinstall/install/postinstall 脚本，
 *      检测网络请求、敏感路径写入、环境变量读取、child_process.exec 等可疑行为，
 *      并阻止可疑脚本执行。
 *   4. Typosquatting 检测 —— 使用编辑距离算法检测与常用包名相似的恶意包名。
 *   5. 运行时模块加载拦截 —— 拦截 require()/import，验证模块完整性，
 *      记录加载事件，阻止加载不在白名单中的模块。
 *   6. 网络出口限制 —— 检测可疑网络请求模式，阻止向已知恶意域名发起请求，
 *      检测 DNS over HTTPS 隧道。
 *
 * 集成点：
 *   - SecurityAuditLogger：所有安全事件落审计日志
 *   - AuditChainLedger：关键事件追加到防篡改哈希链
 *   - getGlobalLogger / getGlobalMetrics：结构化日志与指标
 *   - createTenantAwareSingleton：多租户隔离单例
 *   - reportSilentFailure：可观测的静默错误恢复
 *
 * Usage:
 *   import { getRuntimeDependencyGuard } from './security/runtimeDependencyGuard';
 *   const guard = getRuntimeDependencyGuard();
 *   await guard.initializeHashes();
 *   guard.installModuleLoadInterceptor();
 *   guard.auditPostInstallScripts();
 *   const violations = guard.getViolationReport();
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger, type SecuritySeverity } from './securityAuditLogger';
import { getAuditChainLedger } from './auditChainLedger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import Module from 'node:module';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 依赖完整性记录。
 *
 * 描述单个 npm 包在初始化阶段的完整性基线：包名、版本、入口路径、
 * 复合 SHA-256 哈希、最近一次校验时间，以及是否被标记为已篡改。
 */
export interface DependencyIntegrityRecord {
  /** 包名（含 scope，如 @scope/pkg） */
  packageName: string;
  /** 包版本号 */
  version: string;
  /** 包目录绝对路径 */
  filePath: string;
  /** 包内所有受跟踪文件的复合 SHA-256 哈希（十六进制） */
  hash: string;
  /** 最近一次完整性校验的 ISO 时间戳 */
  lastVerified: string;
  /** 是否检测到篡改 */
  tampered: boolean;
  /** 参与哈希计算的文件数量 */
  fileCount: number;
}

/**
 * Post-install 脚本分析结果。
 *
 * 对依赖的 package.json 中 scripts.preinstall / install / postinstall
 * 脚本进行静态分析后的输出：脚本类型、原始内容、风险等级与具体发现。
 */
export interface PostInstallScriptAnalysis {
  /** 包名 */
  packageName: string;
  /** 脚本类型 */
  scriptType: 'preinstall' | 'install' | 'postinstall';
  /** 脚本原始内容 */
  scriptContent: string;
  /** 综合风险等级 */
  riskLevel: SecuritySeverity;
  /** 命中的可疑行为列表 */
  findings: Array<{
    /** 可疑行为标签 */
    label: string;
    /** 单条发现的严重程度 */
    severity: SecuritySeverity;
    /** 命中的文本片段 */
    match: string;
  }>;
  /** 是否被阻止执行 */
  blocked: boolean;
}

/**
 * Typosquatting 检测结果。
 *
 * 记录一个疑似抢注的包名、其疑似仿冒的目标常用包、编辑距离与置信度。
 */
export interface TyposquattingResult {
  /** 被检测的包名 */
  packageName: string;
  /** 疑似被仿冒的目标包名 */
  suspectedTarget: string;
  /** 与目标包名的编辑距离（越小越相似） */
  editDistance: number;
  /** 置信度 0-1（越大越确信是抢注） */
  confidence: number;
}

/**
 * 依赖混淆检测结果。
 *
 * 针对单个包名判断其是否为私有包、公共注册表中是否存在同名包，
 * 以及综合风险等级。
 */
export interface DependencyConfusionCheck {
  /** 被检测的包名 */
  packageName: string;
  /** 是否判定为私有包（基于 scope 启发式） */
  isPrivate: boolean;
  /** 公共注册表中是否存在同名包 */
  publicRegistryExists: boolean;
  /** 综合风险等级 */
  riskLevel: SecuritySeverity;
  /** 附加详情（版本异常、抢注线索等） */
  details?: Record<string, unknown>;
}

/**
 * 完整性违规事件。
 *
 * 当检测到哈希不匹配、文件缺失/新增、可疑 post-install、typosquatting、
 * 依赖混淆、模块加载拦截、网络出口阻断、DoH 隧道等情况时生成。
 */
export interface IntegrityViolation {
  /** 违规类型 */
  type:
    | 'hash_mismatch'
    | 'file_missing'
    | 'file_added'
    | 'tamper_detected'
    | 'suspicious_postinstall'
    | 'typosquatting'
    | 'dependency_confusion'
    | 'blacklisted_module_load'
    | 'unwhitelisted_module_load'
    | 'network_egress_blocked'
    | 'doh_tunnel_detected';
  /** 涉及的包名 */
  packageName: string;
  /** 涉及的文件路径（如有） */
  filePath?: string;
  /** 期望的哈希（如有） */
  expectedHash?: string;
  /** 实际的哈希（如有） */
  actualHash?: string;
  /** 检测到的 ISO 时间戳 */
  detectedAt: string;
  /** 严重程度 */
  severity: SecuritySeverity;
  /** 附加详情 */
  details?: Record<string, unknown>;
}

/**
 * 模块加载事件日志条目。
 */
export interface ModuleLoadEvent {
  /** ISO 时间戳 */
  timestamp: string;
  /** 原始 require/import 请求字符串 */
  request: string;
  /** 解析后的绝对路径（解析失败为 null） */
  resolvedPath: string | null;
  /** 是否被允许加载 */
  allowed: boolean;
  /** 完整性是否校验通过 */
  verified: boolean;
  /** 阻断/放行原因 */
  reason?: string;
}

/**
 * 运行时依赖防护配置。
 */
export interface RuntimeDependencyGuardConfig {
  /** node_modules 根目录，默认 process.cwd()/node_modules */
  nodeModulesPath: string;
  /** 周期性完整性校验间隔（毫秒），0 表示禁用 */
  verificationIntervalMs: number;
  /** 单个包最大哈希文件数（性能保护上限） */
  maxFilesPerPackage: number;
  /** 包发现数量上限（防止巨型 monorepo 爆炸） */
  maxDiscoveredPackages: number;
  /** 违规事件内存缓存上限 */
  maxViolations: number;
  /** typosquatting 编辑距离阈值（<= 此值视为可疑） */
  typosquattingEditDistanceThreshold: number;
  /** typosquatting 最小置信度（0-1） */
  typosquattingMinConfidence: number;
  /** 是否启用公共注册表查询（依赖混淆检测，涉及网络） */
  enableRegistryLookup: boolean;
  /** 注册表查询超时（毫秒） */
  registryLookupTimeoutMs: number;
  /** 私有包作用域列表（如 @mycompany） */
  privateScopes: string[];
  /** 是否强制模块加载白名单（阻止非白名单模块） */
  enforceModuleWhitelist: boolean;
  /** 是否记录所有模块加载事件 */
  logModuleLoads: boolean;
  /** 模块加载日志最大条数 */
  maxModuleLoadLogEntries: number;
  /** 单文件完整性校验缓存 TTL（毫秒），避免每次 require 都重算哈希 */
  moduleVerificationTtlMs: number;
  /** 是否自动阻止可疑 post-install 脚本 */
  blockSuspiciousPostInstall: boolean;
  /** post-install 阻断的风险等级阈值（达到或超过即阻断） */
  postInstallBlockRiskLevel: SecuritySeverity;
  /** 是否启用网络出口检查 */
  enableNetworkEgressCheck: boolean;
  /** 额外的已知恶意域名 */
  extraMaliciousDomains: string[];
  /** 跳过完整性校验的路径前缀（如测试目录） */
  skipPathPrefixes: string[];
}

/**
 * 违规报告汇总。
 */
export interface RuntimeDependencyGuardReport {
  /** 报告生成 ISO 时间戳 */
  generatedAt: string;
  /** 违规总数 */
  totalViolations: number;
  /** 按类型统计 */
  violationsByType: Record<string, number>;
  /** 按严重程度统计 */
  violationsBySeverity: Record<SecuritySeverity, number>;
  /** 关键（critical）违规列表 */
  criticalViolations: IntegrityViolation[];
  /** 最近违规列表（倒序） */
  recentViolations: IntegrityViolation[];
  /** 已篡改的包名列表 */
  tamperedPackages: string[];
  /** 是否已完成初始化哈希 */
  initialized: boolean;
}

/**
 * 运行时依赖防护统计信息。
 */
export interface RuntimeDependencyGuardStats {
  /** 已跟踪的包数量 */
  packagesTracked: number;
  /** 完整性违规总数 */
  integrityViolations: number;
  /** 已篡改的包数量 */
  tamperedPackages: number;
  /** 已审计的 post-install 脚本数 */
  postInstallScriptsAudited: number;
  /** 可疑 post-install 脚本数 */
  suspiciousPostInstallScripts: number;
  /** 被阻断的 post-install 脚本数 */
  blockedPostInstallScripts: number;
  /** 检测到的 typosquatting 数量 */
  typosquattingDetected: number;
  /** 检测到的依赖混淆数量 */
  dependencyConfusionDetected: number;
  /** 已记录的模块加载事件数 */
  moduleLoadsLogged: number;
  /** 被阻断的模块加载数 */
  moduleLoadsBlocked: number;
  /** 网络出口检查次数 */
  networkEgressChecks: number;
  /** 被阻断的网络出口数 */
  networkEgressBlocked: number;
  /** 检测到的 DoH 隧道数 */
  dohTunnelsDetected: number;
  /** 白名单大小 */
  whitelistSize: number;
  /** 黑名单大小 */
  blacklistSize: number;
  /** 最近一次完整性校验 ISO 时间戳 */
  lastVerificationAt: string | null;
  /** 最近一次初始化哈希 ISO 时间戳 */
  lastInitializedAt: string | null;
  /** 模块加载拦截器是否已安装 */
  interceptorInstalled: boolean;
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 常用 npm 包名白名单（typosquatting 检测基线）。
 * 抢注包通常与这些高频包名仅相差 1-2 个字符的编辑距离。
 * 至少包含 100 个常用包名。
 */
export const COMMON_PACKAGE_NAMES: readonly string[] = [
  'express',
  'lodash',
  'lodash-es',
  'react',
  'react-dom',
  'vue',
  'vue-router',
  'axios',
  'chalk',
  'commander',
  'typescript',
  'webpack',
  'eslint',
  'jest',
  'mocha',
  'chai',
  'moment',
  'dayjs',
  'uuid',
  'rxjs',
  'ramda',
  'underscore',
  'jquery',
  'bootstrap',
  'dotenv',
  'cors',
  'body-parser',
  'morgan',
  'nodemon',
  'vite',
  'rollup',
  'parcel',
  'gulp',
  'grunt',
  'electron',
  'next',
  'nuxt',
  'gatsby',
  'astro',
  'svelte',
  'solid-js',
  'preact',
  'inferno',
  'backbone',
  'ember-source',
  'lit',
  'three',
  'd3',
  'chart.js',
  'highcharts',
  'echarts',
  'plotly.js',
  'leaflet',
  'immutable',
  'immer',
  'redux',
  'mobx',
  'zustand',
  'recoil',
  'jotai',
  'xstate',
  'react-query',
  'swr',
  '@apollo/client',
  'urql',
  'graphql',
  'prisma',
  'typeorm',
  'sequelize',
  'mongoose',
  'knex',
  'pg',
  'mysql2',
  'mongodb',
  'redis',
  'ioredis',
  'bull',
  'bullmq',
  'amqplib',
  'kafkajs',
  'pino',
  'winston',
  'bunyan',
  'debug',
  'consola',
  'signale',
  'ora',
  'inquirer',
  'prompts',
  'yargs',
  'meow',
  'prettier',
  'stylelint',
  'postcss',
  'tailwindcss',
  'sass',
  'emotion',
  'styled-components',
  'vitest',
  'ava',
  'sinon',
  'nock',
  'msw',
  'supertest',
  'puppeteer',
  'playwright',
  'cypress',
  'got',
  'node-fetch',
  'undici',
  'fastify',
  'koa',
  'hapi',
  'polka',
  'zod',
  'joi',
  'yup',
  'ajv',
  'nanoid',
];

/**
 * 已知恶意/高频被滥用的域名集合（网络出口检查基线）。
 * 注意：部分域名（如 raw.githubusercontent.com）本身并非恶意，
 * 但在供应链投毒中常被用作 payload 托管，因此默认列入高危。
 */
const KNOWN_MALICIOUS_DOMAINS: ReadonlySet<string> = new Set([
  'pastebin.com',
  'gist.githubusercontent.com',
  'raw.githubusercontent.com',
  'ngrok.io',
  'loca.lt',
  'serveo.net',
  'pagekite.me',
  'webhook.site',
  'pipedream.net',
  'hookbin.com',
  'requestbin.com',
  'ipinfo.io',
  'api.ipify.org',
  'ifconfig.me',
  'icanhazip.com',
  'transfer.sh',
  'file.io',
  '0x0.st',
  'discord.com',
  'discordapp.com',
  'discordapp.net',
  'api.telegram.org',
  't.me',
  'storj.io',
  'keybase.io',
  'ngrok.com',
]);

/**
 * 已知 DNS over HTTPS (DoH) 端点集合。
 * 攻击者常利用 DoH 绕过企业 DNS 监控建立隐蔽命令与控制信道。
 */
const KNOWN_DOH_ENDPOINTS: ReadonlySet<string> = new Set([
  'dns.google',
  'cloudflare-dns.com',
  '1.1.1.1',
  '1.0.0.1',
  'doh.opendns.com',
  'doh.cleanbrowsing.org',
  'doh.pub',
  'dns.adguard.com',
  'doh.familyshield.opendns.com',
  'mozilla.cloudflare-dns.com',
  'sm2.doh.pub',
  'dns.quad9.net',
  'dns11.quad9.net',
  'doh.applied-privacy.net',
  'dns.nextdns.io',
  'doh.crypto.sx',
]);

/**
 * Post-install 脚本可疑行为正则模式表。
 * 每条规则包含匹配正则、行为标签与严重程度。
 */
const SUSPICIOUS_SCRIPT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
  severity: SecuritySeverity;
}> = [
  {
    pattern: /curl\s+https?:|wget\s+https?:|fetch\s*\(\s*['"`]https?:/i,
    label: 'network_request',
    severity: 'high',
  },
  { pattern: /https?:\/\/[^\s'"`)]+/i, label: 'url_reference', severity: 'medium' },
  {
    pattern: /child_process|\.exec\s*\(|execSync|\.spawn\s*\(|spawnSync|\.fork\s*\(/i,
    label: 'child_process_exec',
    severity: 'high',
  },
  { pattern: /process\.env\.[A-Z0-9_]+/i, label: 'env_var_read', severity: 'high' },
  {
    pattern: /\.(ssh|aws|gnupg|kube|docker|config)\b/i,
    label: 'sensitive_path_write',
    severity: 'critical',
  },
  {
    pattern: /\/etc\/passwd|\/etc\/shadow|\/root\/\.|\/Users\/[^/]+\/\.(ssh|aws)/i,
    label: 'system_file_access',
    severity: 'critical',
  },
  { pattern: /\b(HOME|USERPROFILE|APPDATA)\b/i, label: 'home_dir_access', severity: 'medium' },
  { pattern: /base64\b[\s\S]*?decode|atob\s*\(/i, label: 'base64_decode', severity: 'high' },
  { pattern: /\beval\s*\(|new\s+Function\s*\(/i, label: 'dynamic_eval', severity: 'high' },
  { pattern: /chmod\s+\+x|chmod\s+[0-7]{3,4}/i, label: 'permission_change', severity: 'medium' },
  { pattern: /\bnpm\s+(publish|install|run\s+script)/i, label: 'npm_mutation', severity: 'medium' },
  { pattern: /\bnc\b\s+-|ncat|netcat/i, label: 'reverse_shell', severity: 'critical' },
  {
    pattern: /curl[\s\S]*?\|\s*(sh|bash|zsh)|wget[\s\S]*?\|\s*(sh|bash|zsh)/i,
    label: 'pipe_to_shell',
    severity: 'critical',
  },
  { pattern: /registry\.(npmjs|yarnpkg)\.org/i, label: 'registry_access', severity: 'low' },
  {
    pattern: /\b(token|secret|password|apikey|api_key)\b/i,
    label: 'credential_keyword',
    severity: 'high',
  },
  { pattern: /\bpython\b[\s\S]*?-c\s+['"`]/i, label: 'python_eval', severity: 'high' },
  { pattern: /\bperl\b[\s\S]*?-e\s+['"`]/i, label: 'perl_eval', severity: 'high' },
  { pattern: /\bruby\b[\s\S]*?-e\s+['"`]/i, label: 'ruby_eval', severity: 'high' },
];

/** 严重程度排序权重，用于比较 post-install 阻断阈值。 */
const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Node.js 内建模块集合（模块加载拦截时默认放行）。 */
const BUILTIN_MODULES_SET: ReadonlySet<string> = new Set(
  (Module as unknown as { builtinModules?: readonly string[] }).builtinModules ?? [],
);

/**
 * Node.js 内部 Module 对象的类型化视图。
 * `_load` / `_resolveFilename` / `_cache` 并未在 @types/node 公开类型中声明，
 * 因此通过受控的类型断言访问，避免使用 any。
 */
interface NodeModuleInternals {
  _load: (request: string, parent: NodeJS.Module | undefined, isMain: boolean) => unknown;
  _resolveFilename: (
    request: string,
    parent: NodeJS.Module | undefined,
    isMain: boolean,
    options?: unknown,
  ) => string;
  _cache: Record<string, NodeJS.Module>;
}

/** 最小化的 package.json 结构。 */
interface MinimalPackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  private?: boolean;
}

/** 默认配置。 */
const DEFAULT_CONFIG: RuntimeDependencyGuardConfig = {
  nodeModulesPath: path.join(process.cwd(), 'node_modules'),
  verificationIntervalMs: 5 * 60 * 1000,
  maxFilesPerPackage: 5000,
  maxDiscoveredPackages: 10000,
  maxViolations: 10000,
  typosquattingEditDistanceThreshold: 2,
  typosquattingMinConfidence: 0.6,
  enableRegistryLookup: false,
  registryLookupTimeoutMs: 5000,
  privateScopes: [],
  enforceModuleWhitelist: false,
  logModuleLoads: true,
  maxModuleLoadLogEntries: 5000,
  moduleVerificationTtlMs: 60_000,
  blockSuspiciousPostInstall: true,
  postInstallBlockRiskLevel: 'high',
  enableNetworkEgressCheck: true,
  extraMaliciousDomains: [],
  skipPathPrefixes: [],
};

// ============================================================================
// 辅助函数（模块私有）
// ============================================================================

/** 返回当前 ISO 时间戳。 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 读取并解析 package.json；失败返回 null（永不抛出）。
 */
function readPackageJson(filePath: string): MinimalPackageJson | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as MinimalPackageJson;
  } catch (err) {
    reportSilentFailure(err, 'runtimeDependencyGuard.readPackageJson');
    return null;
  }
}

/**
 * 计算单个文件的 SHA-256 哈希（十六进制）。
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 计算包目录的复合哈希。
 *
 * 策略：遍历包目录下所有文件（受 maxFiles 限制，跳过符号链接以避免循环），
 * 对每个文件计算 SHA-256，再以「相对路径:文件哈希」排序后拼接做最终 SHA-256，
 * 得到稳定的包级完整性指纹。同时返回每文件哈希索引，供模块加载拦截复用。
 */
function hashPackageDir(
  packageDir: string,
  maxFiles: number,
): { hash: string; fileCount: number; fileHashes: Map<string, string> } {
  const fileHashes = new Map<string, string>();
  const relHashes: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [packageDir];

  while (stack.length > 0 && relHashes.length < maxFiles) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.hashPackageDir.readdir');
      continue;
    }
    for (const entry of entries) {
      if (relHashes.length >= maxFiles) break;
      // 跳过符号链接，避免符号链接环与重复计数
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!seen.has(full)) {
          seen.add(full);
          stack.push(full);
        }
      } else if (entry.isFile()) {
        try {
          const h = computeFileHash(full);
          fileHashes.set(full, h);
          relHashes.push(`${path.relative(packageDir, full)}:${h}`);
        } catch (err) {
          reportSilentFailure(err, 'runtimeDependencyGuard.hashPackageDir.hashFile');
          /* 跳过不可读文件 */
        }
      }
    }
  }

  relHashes.sort();
  const composite = crypto.createHash('sha256').update(relHashes.join('\n')).digest('hex');
  return { hash: composite, fileCount: relHashes.length, fileHashes };
}

/**
 * 在 node_modules 树中发现所有包（兼容 npm / pnpm 布局）。
 *
 * 遍历策略：递归进入 `node_modules`、`@scope` 目录与 `.pnpm` store，
 * 对每个含 package.json 的目录读取包名/版本，按真实路径去重。
 */
function discoverPackages(
  root: string,
  maxPackages: number,
): Array<{ name: string; version: string; dir: string }> {
  const found: Array<{ name: string; version: string; dir: string }> = [];
  const seenReal = new Set<string>();

  const scanDir = (dir: string): void => {
    if (found.length >= maxPackages) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.discoverPackages.readdir');
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxPackages) return;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const pkgJsonPath = path.join(full, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = readPackageJson(pkgJsonPath);
        if (pkg?.name && pkg.version) {
          let real: string;
          try {
            real = fs.realpathSync(full);
          } catch (err) {
            reportSilentFailure(err, 'runtimeDependencyGuard.discoverPackages.realpath');
            real = full;
          }
          if (!seenReal.has(real)) {
            seenReal.add(real);
            found.push({ name: pkg.name, version: pkg.version, dir: full });
          }
        }
        // 继续发现包内嵌套的 node_modules
        const nestedNm = path.join(full, 'node_modules');
        if (fs.existsSync(nestedNm)) scanDir(nestedNm);
      } else if (entry.name.startsWith('@') || entry.name === '.pnpm') {
        // 作用域目录或 pnpm store，继续下钻
        scanDir(full);
      } else {
        // 兜底：若目录内含 node_modules 也下钻（覆盖 .pnpm/<pkg>@<ver>）
        const nestedNm = path.join(full, 'node_modules');
        if (fs.existsSync(nestedNm)) scanDir(nestedNm);
      }
    }
  };

  scanDir(root);
  return found;
}

/**
 * 计算两个字符串的 Levenshtein 编辑距离。
 * 用于 typosquatting 检测：抢注包名与常用包名通常仅相差 1-2 个编辑操作。
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * 从 require/import 请求字符串中提取包名。
 * 支持 @scope/pkg 子路径、裸包名；相对/绝对路径返回空串。
 */
function extractPackageName(request: string): string {
  if (request.startsWith('node:') || request.startsWith('.') || request.startsWith('/')) {
    return '';
  }
  if (request.startsWith('@')) {
    const parts = request.split('/');
    return parts.slice(0, 2).join('/');
  }
  return request.split('/')[0];
}

/**
 * 判断包名是否为私有包（基于 scope 启发式）。
 *
 * 规则：
 *   - 显式私有 scope 列表命中 → 私有
 *   - 已知公共 scope（@types/@babel/@vue 等）→ 非私有
 *   - 其它未知 scope → 视为潜在私有（默认保守判定）
 */
function isPrivatePackageName(name: string, privateScopes: readonly string[]): boolean {
  if (!name.startsWith('@')) return false;
  const scope = name.split('/')[0];
  const publicScopes = new Set<string>([
    '@types',
    '@babel',
    '@vue',
    '@angular',
    '@nestjs',
    '@sveltejs',
    '@vitejs',
    '@rollup',
    '@eslint',
    '@storybook',
    '@docusaurus',
    '@testing-library',
    '@emotion',
    '@reduxjs',
    '@tanstack',
    '@remix-run',
    '@grpc',
    '@aws-sdk',
    '@google-cloud',
    '@azure',
    '@opentelemetry',
    '@octokit',
    '@vercel',
    '@netlify',
    '@cloudflare',
    '@modelcontextprotocol',
    '@commander',
  ]);
  if (privateScopes.includes(scope)) return true;
  if (publicScopes.has(scope)) return false;
  // 未知 scope —— 默认视为私有，便于在混淆检测中保守告警
  return true;
}

/**
 * 判断请求是否为内建模块或相对/绝对路径（模块加载拦截默认放行）。
 */
function isBuiltInOrRelative(request: string): boolean {
  return (
    request.startsWith('node:') ||
    request.startsWith('.') ||
    request.startsWith('/') ||
    BUILTIN_MODULES_SET.has(request)
  );
}

// ============================================================================
// RuntimeDependencyGuard
// ============================================================================

/**
 * 运行时依赖完整性防护器。
 *
 * 负责在模块加载与运行期对 node_modules 进行完整性校验、post-install 脚本审计、
 * typosquatting / 依赖混淆检测、require/import 拦截以及网络出口限制。
 * 通过 {@link getRuntimeDependencyGuard} 获取租户隔离的单例实例。
 */
export class RuntimeDependencyGuard {
  private readonly config: RuntimeDependencyGuardConfig;
  private readonly moduleInternals: NodeModuleInternals;

  /** 包名@version → 完整性记录 */
  private readonly integrityRecords: Map<string, DependencyIntegrityRecord> = new Map();
  /** 绝对文件路径 → 文件 SHA-256（用于模块加载拦截按文件校验） */
  private readonly fileHashIndex: Map<string, string> = new Map();
  /** 绝对文件路径 → 包名（违规定位用） */
  private readonly fileToPackage: Map<string, string> = new Map();

  /** 包名白名单集合 */
  private readonly whitelist: Set<string> = new Set();
  /** 包名白名单期望哈希（可选，包名 → 期望哈希） */
  private readonly whitelistHashes: Map<string, string> = new Map();
  /** 包名黑名单集合 */
  private readonly blacklist: Set<string> = new Set();

  /** 已记录的违规事件 */
  private violations: IntegrityViolation[] = [];
  /** 已记录的 typosquatting 结果 */
  private readonly typosquattingResults: TyposquattingResult[] = [];
  /** 已记录的依赖混淆结果 */
  private readonly confusionResults: Map<string, DependencyConfusionCheck> = new Map();
  /** 已记录的 post-install 分析结果 */
  private readonly postInstallAnalyses: PostInstallScriptAnalysis[] = [];
  /** 已记录的模块加载事件 */
  private moduleLoadLog: ModuleLoadEvent[] = [];

  /** 单文件完整性校验缓存：文件路径 → 上次校验时间戳(ms) */
  private readonly moduleVerifyCache: Map<string, number> = new Map();
  /** 公共注册表存在性缓存：包名 → 是否存在 */
  private readonly registryCache: Map<string, boolean> = new Map();
  /** 已知版本历史：包名 → 已知版本数组（用于版本跳变检测） */
  private readonly knownVersions: Map<string, string[]> = new Map();

  /** 模块加载拦截器是否已安装 */
  private interceptorInstalled = false;
  /** 原始 Module._load（卸载时恢复） */
  private originalModuleLoad: NodeModuleInternals['_load'] | null = null;

  /** 周期性校验定时器 */
  private verificationTimer: ReturnType<typeof setInterval> | null = null;

  /** 统计计数器 */
  private stats: RuntimeDependencyGuardStats = {
    packagesTracked: 0,
    integrityViolations: 0,
    tamperedPackages: 0,
    postInstallScriptsAudited: 0,
    suspiciousPostInstallScripts: 0,
    blockedPostInstallScripts: 0,
    typosquattingDetected: 0,
    dependencyConfusionDetected: 0,
    moduleLoadsLogged: 0,
    moduleLoadsBlocked: 0,
    networkEgressChecks: 0,
    networkEgressBlocked: 0,
    dohTunnelsDetected: 0,
    whitelistSize: 0,
    blacklistSize: 0,
    lastVerificationAt: null,
    lastInitializedAt: null,
    interceptorInstalled: false,
  };

  /**
   * @param config - 可选配置，缺省字段以 {@link DEFAULT_CONFIG} 补齐。
   */
  constructor(config?: Partial<RuntimeDependencyGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    this.moduleInternals = Module as unknown as NodeModuleInternals;
    // 常用包名默认加入白名单，降低误报
    for (const name of COMMON_PACKAGE_NAMES) {
      this.whitelist.add(name);
    }
    this.stats.whitelistSize = this.whitelist.size;
  }

  // --------------------------------------------------------------------------
  // 1. 运行时依赖完整性验证
  // --------------------------------------------------------------------------

  /**
   * 初始化阶段：计算所有 node_modules 依赖的 SHA-256 哈希基线。
   *
   * 遍历 {@link RuntimeDependencyGuardConfig.nodeModulesPath} 下所有包，
   * 为每个包生成复合哈希与每文件哈希索引，建立完整性基线。
   * 基线建立后即可供 {@link verifyIntegrity} 与模块加载拦截比对。
   *
   * @returns 已建立基线的包数量
   */
  initializeHashes(): number {
    let nodeModulesRoot = this.config.nodeModulesPath;
    try {
      nodeModulesRoot = fs.realpathSync(nodeModulesRoot);
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.initializeHashes.realpath');
      this.log('warn', 'node_modules 路径不可访问，跳过初始化', {
        nodeModulesPath: this.config.nodeModulesPath,
      });
      this.stats.lastInitializedAt = nowIso();
      return 0;
    }

    if (!fs.existsSync(nodeModulesRoot)) {
      this.log('warn', 'node_modules 目录不存在，跳过初始化', { nodeModulesRoot });
      this.stats.lastInitializedAt = nowIso();
      return 0;
    }

    const packages = discoverPackages(nodeModulesRoot, this.config.maxDiscoveredPackages);
    let tracked = 0;

    for (const pkg of packages) {
      if (this.shouldSkipPath(pkg.dir)) continue;
      try {
        const { hash, fileCount, fileHashes } = hashPackageDir(
          pkg.dir,
          this.config.maxFilesPerPackage,
        );
        if (fileCount === 0) continue;
        const key = `${pkg.name}@${pkg.version}`;
        const record: DependencyIntegrityRecord = {
          packageName: pkg.name,
          version: pkg.version,
          filePath: pkg.dir,
          hash,
          lastVerified: nowIso(),
          tampered: false,
          fileCount,
        };
        this.integrityRecords.set(key, record);
        for (const [filePath, fileHash] of fileHashes) {
          this.fileHashIndex.set(filePath, fileHash);
          this.fileToPackage.set(filePath, pkg.name);
        }
        tracked++;
      } catch (err) {
        reportSilentFailure(err, 'runtimeDependencyGuard.initializeHashes.hashPackage');
      }
    }

    this.stats.packagesTracked = this.integrityRecords.size;
    this.stats.lastInitializedAt = nowIso();
    this.log('info', '依赖完整性基线已建立', { packagesTracked: tracked });
    this.audit('security_scan', 'low', '依赖完整性基线建立', {
      packagesTracked: tracked,
      nodeModulesRoot,
    });
    return tracked;
  }

  /**
   * 定期/按需验证依赖完整性。
   *
   * 重新计算所有已跟踪包的复合哈希，与基线比对：
   *   - 哈希不匹配 → 记录 hash_mismatch 违规并标记篡改
   *   - 包目录缺失 → 记录 file_missing 违规
   * 同时更新最近校验时间戳与统计。
   *
   * @returns 本次校验发现的违规数量
   */
  verifyIntegrity(): number {
    if (this.integrityRecords.size === 0) {
      this.log('warn', '尚未建立完整性基线，跳过校验（请先调用 initializeHashes）');
      return 0;
    }

    let newViolations = 0;
    const stamp = nowIso();

    for (const [key, record] of this.integrityRecords) {
      if (this.shouldSkipPath(record.filePath)) continue;

      if (!fs.existsSync(record.filePath)) {
        newViolations += this.recordViolation({
          type: 'file_missing',
          packageName: record.packageName,
          filePath: record.filePath,
          detectedAt: stamp,
          severity: 'critical',
          details: { version: record.version, expectedHash: record.hash },
        });
        record.tampered = true;
        continue;
      }

      try {
        const { hash: actualHash, fileCount } = hashPackageDir(
          record.filePath,
          this.config.maxFilesPerPackage,
        );
        record.lastVerified = stamp;
        if (actualHash !== record.hash) {
          record.tampered = true;
          newViolations += this.recordViolation({
            type: 'hash_mismatch',
            packageName: record.packageName,
            filePath: record.filePath,
            expectedHash: record.hash,
            actualHash,
            detectedAt: stamp,
            severity: 'critical',
            details: {
              version: record.version,
              expectedFileCount: record.fileCount,
              actualFileCount: fileCount,
            },
          });
        } else {
          record.tampered = false;
        }
      } catch (err) {
        reportSilentFailure(err, 'runtimeDependencyGuard.verifyIntegrity.rehash');
        newViolations += this.recordViolation({
          type: 'tamper_detected',
          packageName: record.packageName,
          filePath: record.filePath,
          detectedAt: stamp,
          severity: 'high',
          details: { reason: 'rehash_failed', version: record.version },
        });
        record.tampered = true;
      }
    }

    // 检测基线之外新增的可执行文件（file_added 线索）：扫描 node_modules 顶层入口
    newViolations += this.detectAddedFiles(stamp);

    this.stats.tamperedPackages = Array.from(this.integrityRecords.values()).filter(
      (r) => r.tampered,
    ).length;
    this.stats.lastVerificationAt = stamp;
    this.stats.integrityViolations = this.violations.length;

    this.log(newViolations > 0 ? 'warn' : 'info', '完整性校验完成', {
      newViolations,
      tamperedPackages: this.stats.tamperedPackages,
    });
    this.audit('security_scan', newViolations > 0 ? 'high' : 'low', '依赖完整性校验完成', {
      newViolations,
      tamperedPackages: this.stats.tamperedPackages,
    });
    return newViolations;
  }

  /**
   * 检测基线之外新增的可疑文件（file_added 线索）。
   * 仅扫描各包目录顶层新增的 .js/.mjs/.cjs/.sh 文件，控制开销。
   */
  private detectAddedFiles(stamp: string): number {
    let count = 0;
    const suspiciousExt = /\.(js|mjs|cjs|sh)$/i;
    for (const record of this.integrityRecords.values()) {
      try {
        const entries = fs.readdirSync(record.filePath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!suspiciousExt.test(entry.name)) continue;
          const full = path.join(record.filePath, entry.name);
          if (!this.fileHashIndex.has(full)) {
            count += this.recordViolation({
              type: 'file_added',
              packageName: record.packageName,
              filePath: full,
              detectedAt: stamp,
              severity: 'high',
              details: { reason: 'new_executable_file_outside_baseline', version: record.version },
            });
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'runtimeDependencyGuard.detectAddedFiles');
      }
    }
    return count;
  }

  // --------------------------------------------------------------------------
  // 2. 依赖混淆攻击检测
  // --------------------------------------------------------------------------

  /**
   * 检查单个包名是否存在依赖混淆风险。
   *
   * 判定逻辑：
   *   - 基于 scope 启发式判断是否私有包
   *   - （可选）查询公共注册表是否存在同名包：私有包在公共注册表存在 → 高危抢注
   *   - 版本号异常跳变（如从 1.x 突然到 99.x）→ 中危
   *
   * @param packageName - 待检测的包名
   * @returns 依赖混淆检测结果
   */
  checkDependencyConfusion(packageName: string): DependencyConfusionCheck {
    const isPrivate = isPrivatePackageName(packageName, this.config.privateScopes);
    const publicRegistryExists = this.checkPublicRegistryExists(packageName);

    let riskLevel: SecuritySeverity = 'low';
    const details: Record<string, unknown> = { isPrivate, publicRegistryExists };

    // 私有包却出现在公共注册表 —— 典型依赖混淆抢注
    if (isPrivate && publicRegistryExists) {
      riskLevel = 'critical';
      details.reason = 'private_package_squatted_on_public_registry';
      this.stats.dependencyConfusionDetected++;
      this.recordViolation({
        type: 'dependency_confusion',
        packageName,
        detectedAt: nowIso(),
        severity: 'critical',
        details,
      });
    } else if (isPrivate && !publicRegistryExists) {
      riskLevel = 'low';
    } else if (!isPrivate && publicRegistryExists) {
      // 公共包存在于公共注册表 —— 正常，但仍做版本异常检测
      riskLevel = 'low';
    }

    // 版本号异常跳变检测
    const versionAnomaly = this.detectVersionAnomaly(packageName);
    if (versionAnomaly) {
      details.versionAnomaly = versionAnomaly;
      if (SEVERITY_RANK[riskLevel] < SEVERITY_RANK['high']) riskLevel = 'high';
      this.recordViolation({
        type: 'dependency_confusion',
        packageName,
        detectedAt: nowIso(),
        severity: 'high',
        details: { ...details, anomaly: versionAnomaly },
      });
    }

    const result: DependencyConfusionCheck = {
      packageName,
      isPrivate,
      publicRegistryExists,
      riskLevel,
      details,
    };
    this.confusionResults.set(packageName, result);
    this.audit('security_scan', riskLevel, '依赖混淆检测完成', { packageName, riskLevel });
    return result;
  }

  /**
   * 查询公共注册表是否存在同名包（best-effort，带缓存）。
   * 当 {@link RuntimeDependencyGuardConfig.enableRegistryLookup} 为 false 时，
   * 默认保守认为存在（以便对私有包触发混淆告警）。
   */
  private checkPublicRegistryExists(packageName: string): boolean {
    const cached = this.registryCache.get(packageName);
    if (cached !== undefined) return cached;

    if (!this.config.enableRegistryLookup) {
      // 未启用网络查询时保守假定存在，确保私有包抢注场景被覆盖
      this.registryCache.set(packageName, true);
      return true;
    }

    try {
      execFileSync('npm', ['view', packageName, 'name'], {
        encoding: 'utf8',
        timeout: this.config.registryLookupTimeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.registryCache.set(packageName, true);
      return true;
    } catch (err) {
      // npm view 对不存在的包返回非零退出码
      reportSilentFailure(err, 'runtimeDependencyGuard.checkPublicRegistryExists');
      this.registryCache.set(packageName, false);
      return false;
    }
  }

  /**
   * 检测版本号异常跳变（如突然跳到大版本号）。
   * @returns 异常描述，无异常返回 null
   */
  private detectVersionAnomaly(packageName: string): string | null {
    const record = this.findIntegrityRecord(packageName);
    if (!record) return null;
    const current = record.version;
    const known = this.knownVersions.get(packageName) ?? [];
    if (known.length === 0) {
      this.knownVersions.set(packageName, [current]);
      return null;
    }
    const prev = known[known.length - 1];
    if (prev === current) return null;

    const prevMajor = this.parseMajor(prev);
    const currMajor = this.parseMajor(current);
    if (prevMajor !== null && currMajor !== null && currMajor > prevMajor + 2) {
      this.knownVersions.get(packageName)!.push(current);
      return `major_version_jump: ${prev} -> ${current}`;
    }
    this.knownVersions.get(packageName)!.push(current);
    return null;
  }

  /** 从版本字符串解析主版本号，失败返回 null。 */
  private parseMajor(version: string): number | null {
    const match = /^v?(\d+)/.exec(version);
    if (!match) return null;
    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  /** 按包名查找任一版本的完整性记录。 */
  private findIntegrityRecord(packageName: string): DependencyIntegrityRecord | undefined {
    for (const record of this.integrityRecords.values()) {
      if (record.packageName === packageName) return record;
    }
    return undefined;
  }

  // --------------------------------------------------------------------------
  // 3. Post-install 脚本审计
  // --------------------------------------------------------------------------

  /**
   * 审计所有依赖的 post-install 类脚本。
   *
   * 扫描 node_modules 中每个 package.json 的 scripts.preinstall / install / postinstall，
   * 逐条匹配可疑行为正则表，输出 {@link PostInstallScriptAnalysis}。
   * 当综合风险达到阈值且 {@link RuntimeDependencyGuardConfig.blockSuspiciousPostInstall}
   * 开启时，标记 blocked=true（建议在安装流水线据此阻断）。
   *
   * @returns 全部分析结果
   */
  auditPostInstallScripts(): PostInstallScriptAnalysis[] {
    const analyses: PostInstallScriptAnalysis[] = [];
    const nodeModulesRoot = this.resolveNodeModulesRoot();
    if (!nodeModulesRoot) return analyses;

    const packages = discoverPackages(nodeModulesRoot, this.config.maxDiscoveredPackages);
    const scriptTypes: Array<'preinstall' | 'install' | 'postinstall'> = [
      'preinstall',
      'install',
      'postinstall',
    ];

    for (const pkg of packages) {
      const pkgJsonPath = path.join(pkg.dir, 'package.json');
      const pkgJson = readPackageJson(pkgJsonPath);
      if (!pkgJson?.scripts) continue;
      for (const scriptType of scriptTypes) {
        const scriptContent = pkgJson.scripts[scriptType];
        if (!scriptContent) continue;
        const analysis = this.analyzeScript(pkg.name, scriptType, scriptContent);
        analyses.push(analysis);
        this.postInstallAnalyses.push(analysis);
        this.stats.postInstallScriptsAudited++;

        if (analysis.findings.length > 0) {
          this.stats.suspiciousPostInstallScripts++;
          if (analysis.blocked) this.stats.blockedPostInstallScripts++;
          this.recordViolation({
            type: 'suspicious_postinstall',
            packageName: pkg.name,
            filePath: pkgJsonPath,
            detectedAt: nowIso(),
            severity: analysis.riskLevel,
            details: {
              scriptType,
              findings: analysis.findings,
              blocked: analysis.blocked,
              version: pkg.version,
            },
          });
        }
      }
    }

    this.log('info', 'Post-install 脚本审计完成', {
      audited: this.stats.postInstallScriptsAudited,
      suspicious: this.stats.suspiciousPostInstallScripts,
      blocked: this.stats.blockedPostInstallScripts,
    });
    this.audit(
      'security_scan',
      this.stats.blockedPostInstallScripts > 0 ? 'high' : 'low',
      'Post-install 脚本审计完成',
      {
        audited: this.stats.postInstallScriptsAudited,
        suspicious: this.stats.suspiciousPostInstallScripts,
        blocked: this.stats.blockedPostInstallScripts,
      },
    );
    return analyses;
  }

  /**
   * 分析单条安装脚本内容，给出风险等级与发现列表。
   */
  private analyzeScript(
    packageName: string,
    scriptType: 'preinstall' | 'install' | 'postinstall',
    scriptContent: string,
  ): PostInstallScriptAnalysis {
    const findings: PostInstallScriptAnalysis['findings'] = [];
    let maxRank = 0;
    let maxSeverity: SecuritySeverity = 'low';

    for (const rule of SUSPICIOUS_SCRIPT_PATTERNS) {
      const match = rule.pattern.exec(scriptContent);
      if (match) {
        findings.push({
          label: rule.label,
          severity: rule.severity,
          match: match[0].slice(0, 120),
        });
        if (SEVERITY_RANK[rule.severity] > maxRank) {
          maxRank = SEVERITY_RANK[rule.severity];
          maxSeverity = rule.severity;
        }
      }
    }

    const riskLevel: SecuritySeverity = maxSeverity;
    const blocked =
      this.config.blockSuspiciousPostInstall &&
      findings.length > 0 &&
      SEVERITY_RANK[riskLevel] >= SEVERITY_RANK[this.config.postInstallBlockRiskLevel];

    return {
      packageName,
      scriptType,
      scriptContent,
      riskLevel,
      findings,
      blocked,
    };
  }

  // --------------------------------------------------------------------------
  // 4. Typosquatting 检测
  // --------------------------------------------------------------------------

  /**
   * 检测 typosquatting（包名抢注）。
   *
   * 对入参中的每个包名（排除常用包名白名单自身），计算其与常用包名列表的
   * 最小编辑距离。若距离 <= 阈值且置信度 >= 最小置信度，则判定为疑似抢注。
   * 置信度 = 1 - (editDistance / max(len(a), len(b)))。
   *
   * @param packages - 待检测的包名列表
   * @returns 命中的疑似抢注结果列表
   */
  detectTyposquatting(packages: readonly string[]): TyposquattingResult[] {
    const results: TyposquattingResult[] = [];
    const commonSet = new Set<string>(COMMON_PACKAGE_NAMES);

    for (const pkg of packages) {
      // 常用包名自身不检测
      if (commonSet.has(pkg)) continue;
      // 无 scope 的子路径取首段
      const candidate = pkg.includes('/') && !pkg.startsWith('@') ? pkg.split('/')[0] : pkg;
      if (commonSet.has(candidate)) continue;

      let bestTarget = '';
      let bestDistance = Infinity;
      for (const common of COMMON_PACKAGE_NAMES) {
        const dist = editDistance(candidate.toLowerCase(), common.toLowerCase());
        if (dist < bestDistance) {
          bestDistance = dist;
          bestTarget = common;
        }
        if (bestDistance === 0) break;
      }

      const maxLen = Math.max(candidate.length, bestTarget.length);
      const confidence = maxLen > 0 ? 1 - bestDistance / maxLen : 0;

      if (
        bestDistance > 0 &&
        bestDistance <= this.config.typosquattingEditDistanceThreshold &&
        confidence >= this.config.typosquattingMinConfidence
      ) {
        const result: TyposquattingResult = {
          packageName: pkg,
          suspectedTarget: bestTarget,
          editDistance: bestDistance,
          confidence: Math.round(confidence * 100) / 100,
        };
        results.push(result);
        this.typosquattingResults.push(result);
        this.stats.typosquattingDetected++;
        this.recordViolation({
          type: 'typosquatting',
          packageName: pkg,
          detectedAt: nowIso(),
          severity: 'high',
          details: {
            suspectedTarget: bestTarget,
            editDistance: bestDistance,
            confidence: result.confidence,
          },
        });
      }
    }

    this.log(results.length > 0 ? 'warn' : 'info', 'Typosquatting 检测完成', {
      scanned: packages.length,
      detected: results.length,
    });
    this.audit('security_scan', results.length > 0 ? 'high' : 'low', 'Typosquatting 检测完成', {
      scanned: packages.length,
      detected: results.length,
    });
    return results;
  }

  // --------------------------------------------------------------------------
  // 5. 运行时模块加载拦截
  // --------------------------------------------------------------------------

  /**
   * 安装 require()/import 加载拦截器。
   *
   * 通过劫持 Node.js 内部 `Module._load` 实现：
   *   - 命中黑名单的包 → 抛错阻断加载
   *   - 开启白名单强制且不在白名单 → 抛错阻断加载
   *   - 加载成功后按文件哈希做完整性校验（带 TTL 缓存）
   *   - 记录所有模块加载事件
   *
   * 幂等：重复调用安全。可通过 {@link uninstallModuleLoadInterceptor} 卸载。
   */
  installModuleLoadInterceptor(): void {
    if (this.interceptorInstalled) {
      this.log('warn', '模块加载拦截器已安装，跳过重复安装');
      return;
    }
    this.originalModuleLoad = this.moduleInternals._load;
    const self = this;
    const interceptedLoad: NodeModuleInternals['_load'] = (
      request: string,
      parent: NodeJS.Module | undefined,
      isMain: boolean,
    ): unknown => {
      // 内建模块与相对/绝对路径默认放行
      if (!isBuiltInOrRelative(request)) {
        const pkgName = extractPackageName(request);
        // 黑名单阻断
        if (pkgName && self.blacklist.has(pkgName)) {
          self.handleBlockedLoad(request, null, false, 'blacklisted', false);
          throw new Error(`[RuntimeDependencyGuard] 已阻止加载黑名单模块: ${request}`);
        }
        // 白名单强制
        if (self.config.enforceModuleWhitelist && !self.whitelist.has(pkgName)) {
          self.handleBlockedLoad(request, null, false, 'unwhitelisted', false);
          throw new Error(`[RuntimeDependencyGuard] 已阻止加载非白名单模块: ${request}`);
        }
      }

      // 调用原始加载逻辑
      const moduleExports = (self.originalModuleLoad as NodeModuleInternals['_load'])(
        request,
        parent,
        isMain,
      );

      // 解析文件路径用于日志与按文件校验（best-effort）
      let resolvedPath: string | null = null;
      try {
        resolvedPath = self.moduleInternals._resolveFilename(request, parent, isMain);
      } catch (err) {
        reportSilentFailure(err, 'runtimeDependencyGuard.installModuleLoadInterceptor.resolve');
        resolvedPath = null;
      }

      const verified = resolvedPath ? self.verifyModuleIntegrity(resolvedPath, request) : false;

      if (self.config.logModuleLoads) {
        self.logModuleLoad(request, resolvedPath, true, 'loaded', verified);
      }
      return moduleExports;
    };

    this.moduleInternals._load = interceptedLoad;
    this.interceptorInstalled = true;
    this.stats.interceptorInstalled = true;
    this.log('info', '模块加载拦截器已安装', {
      enforceWhitelist: this.config.enforceModuleWhitelist,
    });
    this.audit('config_change', 'medium', '模块加载拦截器已安装', {
      enforceWhitelist: this.config.enforceModuleWhitelist,
    });
  }

  /**
   * 卸载模块加载拦截器，恢复原始 `Module._load`。
   */
  uninstallModuleLoadInterceptor(): void {
    if (!this.interceptorInstalled || this.originalModuleLoad === null) {
      this.interceptorInstalled = false;
      this.stats.interceptorInstalled = false;
      return;
    }
    this.moduleInternals._load = this.originalModuleLoad;
    this.originalModuleLoad = null;
    this.interceptorInstalled = false;
    this.stats.interceptorInstalled = false;
    this.log('info', '模块加载拦截器已卸载');
    this.audit('config_change', 'medium', '模块加载拦截器已卸载', {});
  }

  /**
   * 处理被阻断的模块加载事件：记录违规、日志与审计。
   */
  private handleBlockedLoad(
    request: string,
    resolvedPath: string | null,
    allowed: boolean,
    reason: string,
    verified: boolean,
  ): void {
    this.stats.moduleLoadsBlocked++;
    const type: IntegrityViolation['type'] =
      reason === 'blacklisted' ? 'blacklisted_module_load' : 'unwhitelisted_module_load';
    this.recordViolation({
      type,
      packageName: extractPackageName(request) || request,
      filePath: resolvedPath ?? undefined,
      detectedAt: nowIso(),
      severity: 'critical',
      details: { request, reason },
    });
    this.logModuleLoad(request, resolvedPath, allowed, reason, verified);
  }

  /**
   * 校验单个已加载文件的完整性（带 TTL 缓存）。
   * @returns true 表示校验通过或未跟踪；false 表示校验失败
   */
  private verifyModuleIntegrity(resolvedPath: string, request: string): boolean {
    const expected = this.fileHashIndex.get(resolvedPath);
    if (!expected) {
      // 不在基线索引中（如源码、内建模块）—— 不视为违规
      return false;
    }
    const now = Date.now();
    const lastVerified = this.moduleVerifyCache.get(resolvedPath);
    if (lastVerified !== undefined && now - lastVerified < this.config.moduleVerificationTtlMs) {
      return true;
    }

    let actualHash: string;
    try {
      actualHash = computeFileHash(resolvedPath);
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.verifyModuleIntegrity.hash');
      return false;
    }

    if (actualHash !== expected) {
      const pkgName =
        this.fileToPackage.get(resolvedPath) ?? extractPackageName(request) ?? 'unknown';
      this.recordViolation({
        type: 'hash_mismatch',
        packageName: pkgName,
        filePath: resolvedPath,
        expectedHash: expected,
        actualHash,
        detectedAt: nowIso(),
        severity: 'critical',
        details: { request, source: 'module_load_interceptor' },
      });
      return false;
    }

    this.moduleVerifyCache.set(resolvedPath, now);
    return true;
  }

  /**
   * 记录一条模块加载事件日志。
   */
  private logModuleLoad(
    request: string,
    resolvedPath: string | null,
    allowed: boolean,
    reason: string,
    verified: boolean,
  ): void {
    const entry: ModuleLoadEvent = {
      timestamp: nowIso(),
      request,
      resolvedPath,
      allowed,
      verified,
      reason,
    };
    this.moduleLoadLog.push(entry);
    if (this.moduleLoadLog.length > this.config.maxModuleLoadLogEntries) {
      this.moduleLoadLog.shift();
    }
    this.stats.moduleLoadsLogged++;
  }

  // --------------------------------------------------------------------------
  // 6. 网络出口限制
  // --------------------------------------------------------------------------

  /**
   * 检查网络出口是否允许。
   *
   * 依次执行：
   *   - DoH 隧道检测（命中已知 DoH 端点或特征 → 阻断）
   *   - 已知恶意域名检测（命中或为其子域 → 阻断）
   *
   * @param hostname - 目标主机名
   * @param port - 可选端口
   * @returns 是否允许及原因
   */
  checkNetworkEgress(hostname: string, port?: number): { allowed: boolean; reason?: string } {
    if (!this.config.enableNetworkEgressCheck) {
      return { allowed: true };
    }
    this.stats.networkEgressChecks++;
    const host = hostname.toLowerCase().trim();

    if (this.detectDoHTunneling(host)) {
      this.stats.dohTunnelsDetected++;
      this.stats.networkEgressBlocked++;
      this.recordViolation({
        type: 'doh_tunnel_detected',
        packageName: 'runtime',
        detectedAt: nowIso(),
        severity: 'critical',
        details: { hostname: host, port },
      });
      return { allowed: false, reason: 'doh_tunnel_endpoint' };
    }

    if (this.isMaliciousDomain(host)) {
      this.stats.networkEgressBlocked++;
      this.recordViolation({
        type: 'network_egress_blocked',
        packageName: 'runtime',
        detectedAt: nowIso(),
        severity: 'critical',
        details: { hostname: host, port },
      });
      return { allowed: false, reason: 'known_malicious_domain' };
    }

    return { allowed: true };
  }

  /**
   * 检测 DNS over HTTPS (DoH) 隧道。
   *
   * 命中条件：
   *   - 主机名在已知 DoH 端点集合中
   *   - 主机名包含 doh / dns-over-https 等特征子串
   *
   * @param hostname - 目标主机名
   * @returns 是否疑似 DoH 隧道
   */
  detectDoHTunneling(hostname: string): boolean {
    const host = hostname.toLowerCase().trim();
    if (KNOWN_DOH_ENDPOINTS.has(host)) return true;
    if (/doh|dns-over-https|\bdot\b/.test(host)) return true;
    return false;
  }

  /**
   * 判断主机名是否为已知恶意域名或其子域。
   */
  private isMaliciousDomain(host: string): boolean {
    const extra = this.config.extraMaliciousDomains;
    const allMalicious =
      extra.length > 0
        ? new Set<string>([...KNOWN_MALICIOUS_DOMAINS, ...extra])
        : KNOWN_MALICIOUS_DOMAINS;
    if (allMalicious.has(host)) return true;
    for (const domain of allMalicious) {
      if (host.endsWith(`.${domain}`)) return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // 白名单 / 黑名单管理
  // --------------------------------------------------------------------------

  /**
   * 将包加入白名单。
   *
   * @param name - 包名
   * @param hash - 可选期望哈希；提供后模块加载拦截将按此哈希校验
   */
  whitelistPackage(name: string, hash?: string): void {
    this.whitelist.add(name);
    if (hash) this.whitelistHashes.set(name, hash);
    this.stats.whitelistSize = this.whitelist.size;
    this.log('info', '包已加入白名单', { name, hasHash: !!hash });
    this.audit('config_change', 'low', '包加入白名单', { name, hasHash: !!hash });
  }

  /**
   * 将包加入黑名单。
   *
   * 加入黑名单后，模块加载拦截器将阻断对该包的 require/import。
   *
   * @param name - 包名
   */
  blacklistPackage(name: string): void {
    this.blacklist.add(name);
    this.stats.blacklistSize = this.blacklist.size;
    this.log('warn', '包已加入黑名单', { name });
    this.audit('config_change', 'high', '包加入黑名单', { name });
  }

  // --------------------------------------------------------------------------
  // 周期性校验调度
  // --------------------------------------------------------------------------

  /**
   * 启动周期性完整性校验。
   * 间隔由 {@link RuntimeDependencyGuardConfig.verificationIntervalMs} 决定，0 表示不启动。
   * 定时器已 unref，不会阻止进程退出。
   */
  startPeriodicVerification(): void {
    if (this.verificationTimer !== null) {
      this.log('warn', '周期性校验已在运行，跳过');
      return;
    }
    if (this.config.verificationIntervalMs <= 0) {
      this.log('info', '周期性校验间隔为 0，未启动');
      return;
    }
    this.verificationTimer = setInterval(() => {
      try {
        this.verifyIntegrity();
      } catch (err) {
        reportSilentFailure(err, 'runtimeDependencyGuard.startPeriodicVerification.tick');
      }
    }, this.config.verificationIntervalMs);
    this.verificationTimer.unref();
    this.log('info', '周期性完整性校验已启动', {
      intervalMs: this.config.verificationIntervalMs,
    });
  }

  /**
   * 停止周期性完整性校验。
   */
  stopPeriodicVerification(): void {
    if (this.verificationTimer !== null) {
      clearInterval(this.verificationTimer);
      this.verificationTimer = null;
      this.log('info', '周期性完整性校验已停止');
    }
  }

  // --------------------------------------------------------------------------
  // 报告与统计
  // --------------------------------------------------------------------------

  /**
   * 获取违规报告汇总。
   *
   * @returns 按类型/严重程度聚合的违规报告，含关键违规与最近违规列表
   */
  getViolationReport(): RuntimeDependencyGuardReport {
    const violationsByType: Record<string, number> = {};
    const violationsBySeverity: Record<SecuritySeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    for (const v of this.violations) {
      violationsByType[v.type] = (violationsByType[v.type] ?? 0) + 1;
      violationsBySeverity[v.severity] += 1;
    }
    const criticalViolations = this.violations.filter((v) => v.severity === 'critical');
    const recentViolations = [...this.violations].reverse().slice(0, 50);
    const tamperedPackages = Array.from(this.integrityRecords.values())
      .filter((r) => r.tampered)
      .map((r) => r.packageName);

    return {
      generatedAt: nowIso(),
      totalViolations: this.violations.length,
      violationsByType,
      violationsBySeverity,
      criticalViolations,
      recentViolations,
      tamperedPackages,
      initialized: this.stats.lastInitializedAt !== null,
    };
  }

  /**
   * 获取统计信息快照。
   *
   * @returns 当前统计计数
   */
  getStats(): RuntimeDependencyGuardStats {
    return { ...this.stats };
  }

  /** 获取已记录的模块加载事件（只读副本）。 */
  getModuleLoadLog(): readonly ModuleLoadEvent[] {
    return [...this.moduleLoadLog];
  }

  /** 获取已记录的 post-install 分析结果（只读副本）。 */
  getPostInstallAnalyses(): readonly PostInstallScriptAnalysis[] {
    return [...this.postInstallAnalyses];
  }

  /** 获取已记录的 typosquatting 结果（只读副本）。 */
  getTyposquattingResults(): readonly TyposquattingResult[] {
    return [...this.typosquattingResults];
  }

  /** 获取已记录的依赖混淆结果（只读副本）。 */
  getDependencyConfusionResults(): readonly DependencyConfusionCheck[] {
    return Array.from(this.confusionResults.values());
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  /**
   * 释放资源：停止定时器、卸载拦截器。供单例 reset 调用。
   */
  dispose(): void {
    this.stopPeriodicVerification();
    this.uninstallModuleLoadInterceptor();
  }

  // --------------------------------------------------------------------------
  // 内部工具
  // --------------------------------------------------------------------------

  /**
   * 记录一条违规事件，并同步落审计日志、审计链与指标。
   * @returns 固定返回 1，便于调用方累加计数
   */
  private recordViolation(violation: IntegrityViolation): 1 {
    this.violations.push(violation);
    if (this.violations.length > this.config.maxViolations) {
      this.violations.shift();
    }
    this.log(
      violation.severity === 'critical' || violation.severity === 'high' ? 'error' : 'warn',
      `依赖防护违规: ${violation.type}`,
      {
        packageName: violation.packageName,
        filePath: violation.filePath,
        severity: violation.severity,
        details: violation.details,
      },
    );
    this.audit('security_decision', violation.severity, `依赖防护违规: ${violation.type}`, {
      ...violation.details,
      packageName: violation.packageName,
      filePath: violation.filePath,
      expectedHash: violation.expectedHash,
      actualHash: violation.actualHash,
    });
    try {
      getGlobalMetrics().incrementCounter('runtime_dependency_guard_violations_total', 1, {
        type: violation.type,
        severity: violation.severity,
      });
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.recordViolation.metrics');
    }
    return 1;
  }

  /**
   * 写入安全审计日志 + 防篡改哈希链。
   */
  private audit(
    type: 'security_scan' | 'security_decision' | 'config_change',
    severity: SecuritySeverity,
    message: string,
    details: Record<string, unknown>,
  ): void {
    try {
      getSecurityAuditLogger().logEvent({
        type,
        severity,
        source: 'RuntimeDependencyGuard',
        message,
        details,
      });
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.audit.securityAuditLogger');
    }
    try {
      getAuditChainLedger().append({
        event: type,
        source: 'RuntimeDependencyGuard',
        severity,
        message,
        ...details,
      });
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.audit.auditChainLedger');
    }
  }

  /**
   * 通过全局 Logger 输出结构化日志。
   */
  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>,
  ): void {
    try {
      const logger = getGlobalLogger();
      switch (level) {
        case 'debug':
          logger.debug('RuntimeDependencyGuard', message, context);
          break;
        case 'info':
          logger.info('RuntimeDependencyGuard', message, context);
          break;
        case 'warn':
          logger.warn('RuntimeDependencyGuard', message, context);
          break;
        case 'error':
          logger.error('RuntimeDependencyGuard', message, undefined, context);
          break;
      }
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.log');
    }
  }

  /**
   * 解析 node_modules 根目录的真实路径，不可访问返回 null。
   */
  private resolveNodeModulesRoot(): string | null {
    try {
      const real = fs.realpathSync(this.config.nodeModulesPath);
      if (!fs.existsSync(real)) return null;
      return real;
    } catch (err) {
      reportSilentFailure(err, 'runtimeDependencyGuard.resolveNodeModulesRoot');
      return null;
    }
  }

  /**
   * 判断路径是否应跳过校验（匹配 skipPathPrefixes 之一）。
   */
  private shouldSkipPath(targetPath: string): boolean {
    if (this.config.skipPathPrefixes.length === 0) return false;
    let normalized = targetPath;
    try {
      normalized = fs.realpathSync(targetPath);
    } catch {
      /* 保留原路径 */
    }
    return this.config.skipPathPrefixes.some((prefix) => normalized.startsWith(prefix));
  }
}

// ============================================================================
// 租户隔离单例
// ============================================================================

const runtimeDependencyGuardSingleton = createTenantAwareSingleton(
  () => new RuntimeDependencyGuard(),
  {
    allowGlobalFallback: true,
    componentName: 'RuntimeDependencyGuard',
    dispose: (instance) => instance.dispose(),
  },
);

/**
 * 获取运行时依赖防护器的租户隔离单例。
 *
 * @returns RuntimeDependencyGuard 实例
 */
export function getRuntimeDependencyGuard(): RuntimeDependencyGuard {
  return runtimeDependencyGuardSingleton.get();
}

/**
 * 重置运行时依赖防护器单例（释放定时器与拦截器）。
 * 仅用于测试隔离。
 */
export function resetRuntimeDependencyGuard(): void {
  runtimeDependencyGuardSingleton.reset();
}
