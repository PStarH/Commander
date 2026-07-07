/**
 * ActiveDeceptionSystem — 主动欺骗防御系统（Honeypot / 蜜罐）
 *
 * 通过部署诱饵资源来检测和诱捕攻击者，是防御未知攻击的重要补充手段。
 *
 * 核心能力：
 *   1. 蜜罐端点部署 —— 部署虚假 API 端点，任何访问均视为攻击行为
 *   2. 诱饵数据投放 —— 在响应中嵌入唯一的金丝雀令牌（Canary Token），
 *      令牌被访问/使用时触发告警
 *   3. 伪造凭证泄露检测 —— 生成格式逼真但无效的虚假凭证，投放至
 *      日志/响应中，凭证被使用时确认泄露路径
 *   4. 攻击者画像 —— 记录行为模式、推测技能水平、识别自动化扫描
 *   5. 蜜罐响应策略 —— SLOW / FEED / TRAP / BLOCK 四级响应
 *
 * 设计理念：
 *   - 蜜罐端点对合法用户不可见（不在文档/路由表中暴露），任何访问即攻击
 *   - 金丝雀令牌全局唯一，触发时精确定位泄露源
 *   - 伪造凭证与真实凭证格式一致但永不可用，使用即确认泄露
 *   - 攻击者画像基于行为分析，支持自动化 vs 人工攻击识别
 *
 * 使用方式：
 *   import { getActiveDeceptionSystem } from './security/activeDeceptionSystem';
 *   const deception = getActiveDeceptionSystem();
 *   deception.registerHoneypot('/api/v1/admin/secret', 'GET');
 *   const result = deception.handleHoneypotHit('/api/v1/admin/secret', ip, headers);
 *   if (result.shouldBlock) { /* 阻断该 IP *\/ }
 *
 * 与零信任的协同：
 *   蜜罐命中时调用 ZeroTrustValidator 验证请求签名 —— 若签名有效，
 *   说明持有合法凭证的内部人员（或被窃取凭证的攻击者）正在访问蜜罐，
 *   这是极高危的内部威胁信号。
 */

import * as crypto from 'node:crypto';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { reportSilentFailure } from '../silentFailureReporter';
import { getZeroTrustValidator } from './zeroTrustValidator';

// ============================================================================
// 类型定义
// ============================================================================

/** 金丝雀令牌类型 */
export type CanaryTokenType = 'url' | 'dns' | 'file' | 'database' | 'api_key' | 'aws_key';

/** 蜜罐响应策略 */
export type DeceptionResponse = 'SLOW' | 'FEED' | 'TRAP' | 'BLOCK';

/** 攻击者技能水平 */
export type AttackerSkillLevel =
  | 'unknown'
  | 'novice'
  | 'script_kiddie'
  | 'intermediate'
  | 'advanced'
  | 'expert';

/** 蜜罐端点接口 */
export interface HoneypotEndpoint {
  /** 端点路径（如 /api/v1/admin/secret） */
  path: string;
  /** HTTP 方法 */
  method: string;
  /** 响应模板（返回给攻击者的伪造数据） */
  responseTemplate: unknown;
  /** 关联的金丝雀令牌 */
  canaryToken: CanaryToken;
  /** 创建时间（ISO 时间戳） */
  createdAt: string;
  /** 命中次数 */
  hits: number;
}

/** 金丝雀令牌接口 */
export interface CanaryToken {
  /** 令牌唯一 ID */
  id: string;
  /** 令牌类型 */
  type: CanaryTokenType;
  /** 令牌值（用于嵌入诱饵数据中） */
  value: string;
  /** 创建时间（ISO 时间戳） */
  createdAt: string;
  /** 是否已被触发 */
  triggered: boolean;
  /** 触发时间（ISO 时间戳） */
  triggeredAt?: string;
  /** 触发来源（IP / 调用方标识） */
  triggeredBy?: string;
  /** 关联的蜜罐端点路径 */
  associatedEndpoint?: string;
}

/** 诱饵凭证接口 */
export interface DecoyCredential {
  /** 凭证唯一 ID */
  id: string;
  /** 凭证格式描述（如 api_key / aws_key） */
  keyFormat: string;
  /** 伪造的凭证值 */
  fakeKey: string;
  /** 投放时间（ISO 时间戳） */
  plantedAt: string;
  /** 投放位置（如 response:body / log:access / env:fake） */
  plantedIn: string;
  /** 被使用时间（ISO 时间戳） */
  usedAt?: string;
  /** 使用来源 IP */
  usedFromIp?: string;
}

/** 访问模式条目 */
export interface AccessPatternEntry {
  /** 访问路径 */
  path: string;
  /** HTTP 方法 */
  method: string;
  /** 访问时间（ISO 时间戳） */
  timestamp: string;
  /** 命中的蜜罐 ID */
  honeypotId?: string;
}

/** 攻击者画像接口 */
export interface AttackerProfile {
  /** 攻击者 IP 地址 */
  ip: string;
  /** 首次出现时间（ISO 时间戳） */
  firstSeen: string;
  /** 最后出现时间（ISO 时间戳） */
  lastSeen: string;
  /** 请求总数 */
  requestCount: number;
  /** 访问模式（按时间顺序） */
  accessPattern: AccessPatternEntry[];
  /** 检测到的工具（如 nmap、sqlmap、curl） */
  toolsDetected: string[];
  /** 推测的技能水平 */
  skillLevel: AttackerSkillLevel;
  /** 是否为自动化攻击 */
  isAutomated: boolean;
  /** 捕获的金丝雀令牌 ID 列表 */
  capturedTokens: string[];
  /** 是否检测到合法凭证使用（内部威胁信号） */
  hasValidCredentials: boolean;
  /** 关联的诱饵凭证 ID 列表 */
  usedDecoyCredentials: string[];
}

/** 欺骗系统配置 */
export interface DeceptionConfig {
  /** 是否启用欺骗系统 */
  enabled: boolean;
  /** 默认响应策略 */
  defaultResponseStrategy: DeceptionResponse;
  /** SLOW 策略的延迟时间（毫秒） */
  slowResponseDelayMs: number;
  /** 最大蜜罐端点数量 */
  maxHoneypots: number;
  /** 最大攻击者画像数量（LRU 淘汰） */
  maxAttackerProfiles: number;
  /** 是否启用自动部署 */
  autoDeployEnabled: boolean;
  /** 自动部署触发阈值（命中次数） */
  autoDeployThreshold: number;
  /** 金丝雀令牌 TTL（毫秒，0 = 永不过期） */
  canaryTokenTtlMs: number;
  /** 达到多少次命中后执行 BLOCK 策略 */
  blockAfterHits: number;
  /** 是否启用虚假数据投喂（FEED 策略） */
  feedFakeDataEnabled: boolean;
  /** TRAP 策略的诱饵深度（引导多少层） */
  trapDepth: number;
}

/** 蜜罐命中处理结果 */
export interface HoneypotHitResult {
  /** 选择的响应策略 */
  strategy: DeceptionResponse;
  /** HTTP 状态码 */
  statusCode: number;
  /** 响应体 */
  body: unknown;
  /** 建议延迟时间（毫秒，SLOW 策略时 > 0） */
  delayMs: number;
  /** 是否应阻断该 IP */
  shouldBlock: boolean;
  /** 更新后的攻击者画像 */
  attackerProfile: AttackerProfile;
}

/** 蜜罐统计数据 */
export interface HoneypotStats {
  /** 蜜罐端点总数 */
  totalHoneypots: number;
  /** 总命中次数 */
  totalHits: number;
  /** 金丝雀令牌总数 */
  totalCanaryTokens: number;
  /** 已触发的金丝雀令牌数 */
  triggeredCanaryTokens: number;
  /** 诱饵凭证总数 */
  totalDecoyCredentials: number;
  /** 已使用的诱饵凭证数 */
  usedDecoyCredentials: number;
  /** 攻击者总数 */
  totalAttackers: number;
  /** 自动化攻击者数 */
  automatedAttackers: number;
  /** 命中次数最多的蜜罐 */
  topHoneypots: Array<{ path: string; method: string; hits: number }>;
  /** 最活跃的攻击者 */
  topAttackers: Array<{
    ip: string;
    requestCount: number;
    skillLevel: AttackerSkillLevel;
    isAutomated: boolean;
  }>;
  /** 按响应策略分布 */
  byResponseType: Record<DeceptionResponse, number>;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: DeceptionConfig = {
  enabled: true,
  defaultResponseStrategy: 'FEED',
  slowResponseDelayMs: 5000,
  maxHoneypots: 200,
  maxAttackerProfiles: 1000,
  autoDeployEnabled: true,
  autoDeployThreshold: 5,
  canaryTokenTtlMs: 0,
  blockAfterHits: 20,
  feedFakeDataEnabled: true,
  trapDepth: 3,
};

// ============================================================================
// 默认蜜罐端点（构造时自动注册）
// ============================================================================

interface DefaultHoneypotDef {
  path: string;
  method: string;
  responseTemplate: unknown;
}

const DEFAULT_HONEYPOTS: DefaultHoneypotDef[] = [
  {
    path: '/api/v1/admin/secret',
    method: 'GET',
    responseTemplate: {
      secret: 'prod-master-key-PLACEHOLDER',
      region: 'us-east-1',
      rotation: '2026-01-15T00:00:00Z',
    },
  },
  {
    path: '/api/internal/keys',
    method: 'GET',
    responseTemplate: {
      keys: [
        { kid: 'key-001', algorithm: 'HS256', status: 'active' },
        { kid: 'key-002', algorithm: 'RS256', status: 'active' },
      ],
      total: 2,
    },
  },
  {
    path: '/.env',
    method: 'GET',
    responseTemplate: {
      DATABASE_URL: 'postgresql://admin:PLACEHOLDER@db.internal:5432/prod',
      REDIS_URL: 'redis://cache.internal:6379',
      JWT_SECRET: 'PLACEHOLDER',
    },
  },
  {
    path: '/api/v1/admin/tokens',
    method: 'GET',
    responseTemplate: {
      tokens: [
        { id: 'tok_001', scope: 'admin', expires: '2026-12-31T23:59:59Z' },
        { id: 'tok_002', scope: 'system', expires: '2026-06-30T23:59:59Z' },
      ],
    },
  },
  {
    path: '/api/internal/config/secrets',
    method: 'GET',
    responseTemplate: {
      aws_access_key_id: 'AKIAXXXXXXXXXXXXXXXX',
      aws_secret_access_key: 'PLACEHOLDER',
      stripe_secret_key: 'sk_live_PLACEHOLDER',
    },
  },
  {
    path: '/admin',
    method: 'GET',
    responseTemplate: {
      panel: 'Commander Admin Console',
      version: '2.0.0',
      loginUrl: '/admin/login',
    },
  },
  {
    path: '/api/v1/users/credentials',
    method: 'GET',
    responseTemplate: {
      users: [
        { id: 1, username: 'admin', password_hash: '$2b$12$PLACEHOLDER' },
        { id: 2, username: 'root', password_hash: '$2b$12$PLACEHOLDER' },
      ],
    },
  },
  {
    path: '/wp-admin/admin.php',
    method: 'GET',
    responseTemplate: { error: 'WordPress admin panel', version: '6.4.2' },
  },
];

// ============================================================================
// 已知扫描器/攻击工具签名（基于 User-Agent）
// ============================================================================

const SCANNER_SIGNATURES: Array<{ pattern: RegExp; tool: string }> = [
  { pattern: /nmap/i, tool: 'nmap' },
  { pattern: /nikto/i, tool: 'nikto' },
  { pattern: /sqlmap/i, tool: 'sqlmap' },
  { pattern: /masscan/i, tool: 'masscan' },
  { pattern: /zgrab/i, tool: 'zgrab' },
  { pattern: /nuclei/i, tool: 'nuclei' },
  { pattern: /dirbuster/i, tool: 'dirbuster' },
  { pattern: /dirb/i, tool: 'dirb' },
  { pattern: /gobuster/i, tool: 'gobuster' },
  { pattern: /wpscan/i, tool: 'wpscan' },
  { pattern: /hydra/i, tool: 'hydra' },
  { pattern: /metasploit/i, tool: 'metasploit' },
  { pattern: /burp/i, tool: 'burpsuite' },
  { pattern: /owasp/i, tool: 'owasp-zap' },
  { pattern: /acunetix/i, tool: 'acunetix' },
  { pattern: /nessus/i, tool: 'nessus' },
  { pattern: /curl/i, tool: 'curl' },
  { pattern: /wget/i, tool: 'wget' },
  { pattern: /python-requests/i, tool: 'python-requests' },
  { pattern: /go-http-client/i, tool: 'go-http-client' },
  { pattern: /scrapy/i, tool: 'scrapy' },
  { pattern: /bot/i, tool: 'bot' },
];

/** 自动化攻击的典型路径前缀（扫描器常探测的路径） */
const COMMON_SCAN_PATHS: string[] = [
  '/.git/config',
  '/.git/HEAD',
  '/config.php',
  '/backup',
  '/backup.zip',
  '/dump.sql',
  '/phpinfo.php',
  '/api/v1/debug',
  '/api/debug',
  '/swagger',
  '/api-docs',
  '/actuator',
  '/actuator/env',
  '/actuator/heapdump',
  '/server-status',
  '/.well-known/security.txt',
  '/cgi-bin/',
  '/vendor/',
  '/node_modules/',
  '/composer.json',
  '/package.json',
  '/Dockerfile',
  '/docker-compose.yml',
  '/.ssh/id_rsa',
  '/id_rsa',
  '/private.key',
  '/credentials',
  '/api/v1/config',
  '/api/v1/debug/vars',
  '/metrics',
  '/prometheus',
  '/web.config',
  '/crossdomain.xml',
];

// ============================================================================
// ActiveDeceptionSystem
// ============================================================================

export class ActiveDeceptionSystem {
  private config: DeceptionConfig;
  private honeypots: Map<string, HoneypotEndpoint> = new Map();
  private canaryTokens: Map<string, CanaryToken> = new Map();
  /** 按令牌值索引，便于快速查找 */
  private canaryTokenByValue: Map<string, CanaryToken> = new Map();
  private decoyCredentials: Map<string, DecoyCredential> = new Map();
  /** 按伪造凭证值索引 */
  private decoyCredentialByKey: Map<string, DecoyCredential> = new Map();
  private attackerProfiles: Map<string, AttackerProfile> = new Map();
  private responseStrategyCounts: Record<DeceptionResponse, number> = {
    SLOW: 0,
    FEED: 0,
    TRAP: 0,
    BLOCK: 0,
  };

  constructor(config?: Partial<DeceptionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.deployDefaultHoneypots();
  }

  // ── 蜜罐端点管理 ──────────────────────────────────────────────────

  /**
   * 注册蜜罐端点。
   *
   * 将一个虚假 API 端点注册为蜜罐。任何对该端点的访问都会被视为攻击行为，
   * 系统将自动生成金丝雀令牌并嵌入响应模板中。
   *
   * @param path - 端点路径（如 /api/v1/admin/secret）
   * @param method - HTTP 方法（如 GET、POST）
   * @param responseTemplate - 返回给攻击者的伪造数据模板，未提供时使用默认模板
   * @returns 创建的蜜罐端点对象
   */
  registerHoneypot(path: string, method: string, responseTemplate?: unknown): HoneypotEndpoint {
    if (!this.config.enabled) {
      throw new Error('ActiveDeceptionSystem is disabled');
    }

    const key = this.honeypotKey(path, method);
    if (this.honeypots.has(key)) {
      // 已存在则直接返回现有端点
      return this.honeypots.get(key)!;
    }

    if (this.honeypots.size >= this.config.maxHoneypots) {
      // 淘汰命中次数最少的蜜罐
      this.evictLeastHitHoneypot();
    }

    // 为该蜜罐生成一个金丝雀令牌（默认使用 url 类型）
    const canaryToken = this.generateCanaryToken('url');
    canaryToken.associatedEndpoint = path;

    const template = responseTemplate ?? this.defaultResponseTemplate(path);

    const endpoint: HoneypotEndpoint = {
      path,
      method: method.toUpperCase(),
      responseTemplate: this.injectCanaryIntoTemplate(template, canaryToken),
      canaryToken,
      createdAt: new Date().toISOString(),
      hits: 0,
    };

    this.honeypots.set(key, endpoint);

    try {
      getGlobalLogger().info('ActiveDeceptionSystem', `Honeypot registered: ${method} ${path}`, {
        path,
        method,
        canaryTokenId: canaryToken.id,
      });
      getGlobalMetrics().incrementCounter('deception.honeypots.registered', 1, {
        method: method.toUpperCase(),
      });
    } catch (err) {
      reportSilentFailure(err, 'activeDeceptionSystem:registerHoneypot');
    }

    return endpoint;
  }

  /**
   * 获取已注册的蜜罐端点列表。
   *
   * @returns 所有蜜罐端点的数组
   */
  getHoneypots(): HoneypotEndpoint[] {
    return Array.from(this.honeypots.values());
  }

  /**
   * 检查指定路径是否为蜜罐端点。
   *
   * @param path - 请求路径
   * @param method - HTTP 方法
   * @returns 是否为蜜罐端点
   */
  isHoneypot(path: string, method: string): boolean {
    return this.honeypots.has(this.honeypotKey(path, method));
  }

  // ── 金丝雀令牌 ────────────────────────────────────────────────────

  /**
   * 生成金丝雀令牌（Canary Token）。
   *
   * 根据指定类型生成全局唯一的令牌，该令牌可嵌入诱饵数据中。
   * 当令牌被访问或使用时，系统会触发告警。
   *
   * 支持的令牌类型：
   *   - url:       嵌入响应中的唯一 URL，被访问时触发
   *   - dns:       唯一 DNS 域名，被解析时触发
   *   - file:      嵌入文件内容的唯一标识
   *   - database:  嵌入数据库记录的唯一标识
   *   - api_key:   伪造的 API Key，被使用时触发
   *   - aws_key:   伪造的 AWS 凭证，被使用时触发
   *
   * @param type - 令牌类型
   * @returns 创建的金丝雀令牌对象
   */
  generateCanaryToken(type: CanaryTokenType): CanaryToken {
    const id = `canary_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const uuid = crypto.randomUUID();
    const value = this.buildCanaryTokenValue(type, uuid);

    const token: CanaryToken = {
      id,
      type,
      value,
      createdAt: new Date().toISOString(),
      triggered: false,
    };

    this.canaryTokens.set(id, token);
    this.canaryTokenByValue.set(value, token);

    try {
      getGlobalMetrics().incrementCounter('deception.canary_tokens.generated', 1, { type });
    } catch (err) {
      reportSilentFailure(err, 'activeDeceptionSystem:generateCanaryToken');
    }

    return token;
  }

  /**
   * 检查金丝雀令牌是否被触发。
   *
   * 当系统检测到某令牌值被外部访问或使用时（如 URL 被请求、DNS 被解析、
   * API Key 被用于认证），调用此方法标记令牌为已触发并生成告警。
   *
   * @param tokenValue - 被使用的令牌值
   * @param source - 触发来源（IP 地址或调用方标识）
   * @returns 被触发的令牌对象；若令牌不存在则返回 undefined
   */
  checkCanaryTrigger(tokenValue: string, source: string): CanaryToken | undefined {
    const token = this.canaryTokenByValue.get(tokenValue);
    if (!token) {
      return undefined;
    }

    if (token.triggered) {
      // 已经触发过，更新来源信息
      return token;
    }

    token.triggered = true;
    token.triggeredAt = new Date().toISOString();
    token.triggeredBy = source;

    // 更新攻击者画像：记录捕获的令牌
    const profile = this.getOrCreateAttackerProfile(source);
    if (!profile.capturedTokens.includes(token.id)) {
      profile.capturedTokens.push(token.id);
    }
    profile.lastSeen = new Date().toISOString();

    // 记录安全审计事件
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity: 'critical',
        source: 'ActiveDeceptionSystem',
        message: `Canary token triggered — type: ${token.type}, endpoint: ${token.associatedEndpoint ?? 'N/A'}`,
        details: {
          tokenId: token.id,
          tokenType: token.type,
          source,
          associatedEndpoint: token.associatedEndpoint,
          triggeredAt: token.triggeredAt,
        },
      });

      getGlobalLogger().critical('ActiveDeceptionSystem', `Canary token triggered by ${source}`, {
        tokenId: token.id,
        tokenType: token.type,
        endpoint: token.associatedEndpoint,
      });

      getGlobalMetrics().incrementCounter('deception.canary_tokens.triggered', 1, {
        type: token.type,
      });
    } catch (err) {
      reportSilentFailure(err, 'activeDeceptionSystem:checkCanaryTrigger');
    }

    return token;
  }

  /**
   * 获取所有金丝雀令牌。
   *
   * @returns 所有令牌的数组
   */
  getCanaryTokens(): CanaryToken[] {
    return Array.from(this.canaryTokens.values());
  }

  /**
   * 获取已触发的金丝雀令牌。
   *
   * @returns 已触发令牌的数组
   */
  getTriggeredCanaryTokens(): CanaryToken[] {
    return Array.from(this.canaryTokens.values()).filter((t) => t.triggered);
  }

  // ── 诱饵凭证 ──────────────────────────────────────────────────────

  /**
   * 投放诱饵凭证。
   *
   * 生成格式与真实凭证一致但永远无效的虚假凭证，并将其"泄露"到指定位置
   * （如日志、响应体、环境变量占位等）。当虚假凭证被使用时，系统可精确
   * 定位数据泄露路径。
   *
   * @param format - 凭证格式（如 'api_key'、'aws_key'、'jwt'）
   * @param location - 投放位置描述（如 'response:body'、'log:access'）
   * @returns 创建的诱饵凭证对象
   */
  plantDecoyCredential(format: string, location: string): DecoyCredential {
    const id = `decoy_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const fakeKey = this.generateFakeCredential(format);

    const credential: DecoyCredential = {
      id,
      keyFormat: format,
      fakeKey,
      plantedAt: new Date().toISOString(),
      plantedIn: location,
    };

    this.decoyCredentials.set(id, credential);
    this.decoyCredentialByKey.set(fakeKey, credential);

    try {
      getGlobalLogger().info(
        'ActiveDeceptionSystem',
        `Decoy credential planted: ${format} in ${location}`,
        { credentialId: id, format },
      );
      getGlobalMetrics().incrementCounter('deception.decoy_credentials.planted', 1, { format });
    } catch (err) {
      reportSilentFailure(err, 'activeDeceptionSystem:plantDecoyCredential');
    }

    return credential;
  }

  /**
   * 检查诱饵凭证是否被使用。
   *
   * 当系统检测到某虚假凭证值被用于认证或 API 调用时，调用此方法标记
   * 凭证为已使用并生成告警，从而确认数据泄露的具体路径。
   *
   * @param fakeKey - 被使用的虚假凭证值
   * @param sourceIp - 使用来源 IP
   * @returns 被使用的诱饵凭证对象；若不存在则返回 undefined
   */
  checkDecoyCredentialUsed(fakeKey: string, sourceIp: string): DecoyCredential | undefined {
    const credential = this.decoyCredentialByKey.get(fakeKey);
    if (!credential) {
      return undefined;
    }

    if (!credential.usedAt) {
      credential.usedAt = new Date().toISOString();
      credential.usedFromIp = sourceIp;

      // 更新攻击者画像
      const profile = this.getOrCreateAttackerProfile(sourceIp);
      if (!profile.usedDecoyCredentials.includes(credential.id)) {
        profile.usedDecoyCredentials.push(credential.id);
      }
      profile.lastSeen = credential.usedAt;

      try {
        getSecurityAuditLogger().logEvent({
          type: 'security_decision',
          severity: 'critical',
          source: 'ActiveDeceptionSystem',
          message: `Decoy credential used — format: ${credential.keyFormat}, planted in: ${credential.plantedIn}`,
          details: {
            credentialId: credential.id,
            keyFormat: credential.keyFormat,
            plantedIn: credential.plantedIn,
            usedFromIp: sourceIp,
            usedAt: credential.usedAt,
          },
        });

        getGlobalLogger().critical(
          'ActiveDeceptionSystem',
          `Decoy credential used from ${sourceIp}`,
          {
            credentialId: credential.id,
            format: credential.keyFormat,
            plantedIn: credential.plantedIn,
          },
        );

        getGlobalMetrics().incrementCounter('deception.decoy_credentials.used', 1, {
          format: credential.keyFormat,
        });
      } catch (err) {
        reportSilentFailure(err, 'activeDeceptionSystem:checkDecoyCredentialUsed');
      }
    }

    return credential;
  }

  /**
   * 获取所有诱饵凭证。
   *
   * @returns 所有诱饵凭证的数组
   */
  getDecoyCredentials(): DecoyCredential[] {
    return Array.from(this.decoyCredentials.values());
  }

  // ── 蜜罐命中处理 ──────────────────────────────────────────────────

  /**
   * 处理蜜罐命中。
   *
   * 当检测到对蜜罐端点的访问时调用此方法。系统将：
   *   1. 记录命中并更新攻击者画像
   *   2. 调用零信任验证器检查请求签名（合法签名 = 内部威胁）
   *   3. 根据配置和攻击者画像选择响应策略
   *   4. 返回策略对应的响应数据
   *
   * @param path - 被访问的蜜罐路径
   * @param ip - 攻击者 IP 地址
   * @param headers - 请求头（用于工具检测和签名验证）
   * @returns 命中处理结果，包含响应策略和伪造数据
   */
  handleHoneypotHit(
    path: string,
    ip: string,
    headers: Record<string, string | string[] | undefined>,
  ): HoneypotHitResult {
    const startTime = Date.now();

    // 查找匹配的蜜罐（尝试 GET 作为默认方法）
    let endpoint: HoneypotEndpoint | undefined;
    for (const hp of this.honeypots.values()) {
      if (hp.path === path) {
        endpoint = hp;
        break;
      }
    }

    if (!endpoint) {
      // 路径不是已注册的蜜罐，但仍被当作可疑访问处理
      endpoint = this.registerHoneypot(path, 'GET');
    }

    // 增加命中计数
    endpoint.hits++;

    // 获取/创建攻击者画像
    const profile = this.getOrCreateAttackerProfile(ip);

    // 检测工具与自动化特征
    const detectedTools = this.detectTools(headers);
    for (const tool of detectedTools) {
      if (!profile.toolsDetected.includes(tool)) {
        profile.toolsDetected.push(tool);
      }
    }

    // 更新访问模式
    profile.accessPattern.push({
      path,
      method: endpoint.method,
      timestamp: new Date().toISOString(),
      honeypotId: endpoint.canaryToken.id,
    });
    profile.requestCount++;
    profile.lastSeen = new Date().toISOString();

    // 判断是否为自动化攻击
    profile.isAutomated = this.assessAutomation(profile, headers);

    // 推测技能水平
    profile.skillLevel = this.assessSkillLevel(profile);

    // 零信任验证：检查是否有合法签名（内部威胁信号）
    const hasValidSig = this.checkZeroTrustSignature(path, endpoint.method, headers);
    if (hasValidSig) {
      profile.hasValidCredentials = true;
    }

    // 选择响应策略
    const strategy = this.selectResponseStrategy(profile, endpoint);

    // 构建响应
    const result = this.buildHitResponse(strategy, endpoint, profile);

    // 记录审计事件
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity: strategy === 'BLOCK' ? 'critical' : 'high',
        source: 'ActiveDeceptionSystem',
        message: `Honeypot hit — path: ${path}, strategy: ${strategy}, automated: ${profile.isAutomated}`,
        details: {
          path,
          method: endpoint.method,
          ip,
          hits: endpoint.hits,
          strategy,
          toolsDetected: profile.toolsDetected,
          skillLevel: profile.skillLevel,
          isAutomated: profile.isAutomated,
          hasValidCredentials: profile.hasValidCredentials,
          durationMs: Date.now() - startTime,
        },
      });

      getGlobalMetrics().incrementCounter('deception.honeypots.hits', 1, {
        path,
        strategy,
        automated: String(profile.isAutomated),
      });

      this.responseStrategyCounts[strategy]++;
    } catch (err) {
      reportSilentFailure(err, 'activeDeceptionSystem:handleHoneypotHit');
    }

    // 自动部署检查
    if (this.config.autoDeployEnabled && endpoint.hits >= this.config.autoDeployThreshold) {
      try {
        this.autoDeployHoneypots();
      } catch (err) {
        reportSilentFailure(err, 'activeDeceptionSystem:autoDeployTrigger');
      }
    }

    return result;
  }

  // ── 攻击者画像 ────────────────────────────────────────────────────

  /**
   * 获取指定 IP 的攻击者画像。
   *
   * @param ip - 攻击者 IP 地址
   * @returns 攻击者画像；若不存在则返回 undefined
   */
  getAttackerProfile(ip: string): AttackerProfile | undefined {
    return this.attackerProfiles.get(ip);
  }

  /**
   * 获取所有攻击者画像。
   *
   * @returns 所有攻击者画像的数组
   */
  getAllAttackerProfiles(): AttackerProfile[] {
    return Array.from(this.attackerProfiles.values());
  }

  // ── 统计 ──────────────────────────────────────────────────────────

  /**
   * 获取蜜罐统计数据。
   *
   * 汇总当前欺骗系统的运行状态，包括蜜罐数量、命中次数、令牌状态、
   * 攻击者数量及分布等。
   *
   * @returns 蜜罐统计对象
   */
  getHoneypotStats(): HoneypotStats {
    const honeypots = Array.from(this.honeypots.values());
    const tokens = Array.from(this.canaryTokens.values());
    const decoys = Array.from(this.decoyCredentials.values());
    const attackers = Array.from(this.attackerProfiles.values());

    const topHoneypots = [...honeypots]
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 10)
      .map((h) => ({ path: h.path, method: h.method, hits: h.hits }));

    const topAttackers = [...attackers]
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, 10)
      .map((a) => ({
        ip: a.ip,
        requestCount: a.requestCount,
        skillLevel: a.skillLevel,
        isAutomated: a.isAutomated,
      }));

    return {
      totalHoneypots: honeypots.length,
      totalHits: honeypots.reduce((sum, h) => sum + h.hits, 0),
      totalCanaryTokens: tokens.length,
      triggeredCanaryTokens: tokens.filter((t) => t.triggered).length,
      totalDecoyCredentials: decoys.length,
      usedDecoyCredentials: decoys.filter((d) => d.usedAt).length,
      totalAttackers: attackers.length,
      automatedAttackers: attackers.filter((a) => a.isAutomated).length,
      topHoneypots,
      topAttackers,
      byResponseType: { ...this.responseStrategyCounts },
    };
  }

  // ── 虚假凭证生成 ──────────────────────────────────────────────────

  /**
   * 批量生成虚假 API Key。
   *
   * 生成格式与真实 API Key 一致但永远无效的虚假凭证。
   * 格式：cmdr_live_<40位随机字符>
   *
   * @param count - 生成数量
   * @returns 虚假 API Key 数组
   */
  generateFakeApiKeys(count: number): string[] {
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
      keys.push(`cmdr_live_${this.randomBase62(40)}`);
    }
    return keys;
  }

  /**
   * 批量生成虚假 AWS 凭证。
   *
   * 生成格式与真实 AWS 凭证一致但永远无效的虚假凭证对。
   * Access Key ID 格式：AKIA + 16位大写字母数字（共20位）
   * Secret Access Key 格式：40位 Base64 字符
   *
   * @param count - 生成数量
   * @returns 虚假 AWS 凭证对数组
   */
  generateFakeAwsKeys(count: number): Array<{ accessKeyId: string; secretAccessKey: string }> {
    const keys: Array<{ accessKeyId: string; secretAccessKey: string }> = [];
    for (let i = 0; i < count; i++) {
      const accessKeyId = `AKIA${this.randomUpperAlphanumeric(16)}`;
      const secretAccessKey = this.randomBase64(40);
      keys.push({ accessKeyId, secretAccessKey });
    }
    return keys;
  }

  // ── 自动部署 ──────────────────────────────────────────────────────

  /**
   * 基于攻击模式自动部署蜜罐。
   *
   * 分析近期攻击者的访问模式，识别尚未覆盖的常见扫描路径，
   * 自动为这些路径部署新的蜜罐端点。系统还会根据攻击者探测的
   * 路径模式生成变体蜜罐。
   *
   * @returns 本次自动部署的蜜罐数量
   */
  autoDeployHoneypots(): number {
    if (!this.config.autoDeployEnabled) {
      return 0;
    }

    let deployed = 0;

    // 收集攻击者已访问但尚未成为蜜罐的路径
    const knownPaths = new Set<string>();
    for (const hp of this.honeypots.values()) {
      knownPaths.add(hp.path);
    }

    const probedPaths = new Set<string>();
    for (const profile of this.attackerProfiles.values()) {
      for (const entry of profile.accessPattern) {
        if (!knownPaths.has(entry.path)) {
          probedPaths.add(entry.path);
        }
      }
    }

    // 为被探测但未注册的路径部署蜜罐
    for (const path of probedPaths) {
      if (this.honeypots.size >= this.config.maxHoneypots) break;
      try {
        this.registerHoneypot(path, 'GET');
        deployed++;
      } catch (err) {
        reportSilentFailure(err, 'activeDeceptionSystem:autoDeployHoneypots:probed');
      }
    }

    // 部署常见扫描路径的蜜罐
    for (const scanPath of COMMON_SCAN_PATHS) {
      if (this.honeypots.size >= this.config.maxHoneypots) break;
      if (knownPaths.has(scanPath) || probedPaths.has(scanPath)) continue;
      try {
        this.registerHoneypot(scanPath, 'GET');
        deployed++;
        knownPaths.add(scanPath);
      } catch (err) {
        reportSilentFailure(err, 'activeDeceptionSystem:autoDeployHoneypots:common');
      }
    }

    // 基于高频命中蜜罐的路径模式生成变体蜜罐
    const topHoneypots = Array.from(this.honeypots.values())
      .filter((h) => h.hits >= this.config.autoDeployThreshold)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 5);

    for (const hp of topHoneypots) {
      const variants = this.generatePathVariants(hp.path);
      for (const variant of variants) {
        if (this.honeypots.size >= this.config.maxHoneypots) break;
        if (knownPaths.has(variant)) continue;
        try {
          this.registerHoneypot(variant, hp.method);
          deployed++;
          knownPaths.add(variant);
        } catch (err) {
          reportSilentFailure(err, 'activeDeceptionSystem:autoDeployHoneypots:variant');
        }
      }
    }

    if (deployed > 0) {
      try {
        getGlobalLogger().info(
          'ActiveDeceptionSystem',
          `Auto-deployed ${deployed} honeypots based on attack patterns`,
          { deployed, totalHoneypots: this.honeypots.size },
        );
        getGlobalMetrics().incrementCounter('deception.honeypots.auto_deployed', deployed);
      } catch (err) {
        reportSilentFailure(err, 'activeDeceptionSystem:autoDeployHoneypots:log');
      }
    }

    return deployed;
  }

  // ── 配置与重置 ────────────────────────────────────────────────────

  /**
   * 更新配置。
   *
   * @param config - 配置增量（仅更新提供的字段）
   */
  configure(config: Partial<DeceptionConfig>): void {
    this.config = { ...this.config, ...config };

    try {
      getSecurityAuditLogger().logConfigChange(
        'ActiveDeceptionSystem',
        'Deception system configuration updated',
        { updatedFields: Object.keys(config) },
      );
    } catch (err) {
      reportSilentFailure(err, 'activeDeceptionSystem:configure');
    }
  }

  /**
   * 获取当前配置。
   *
   * @returns 当前配置的副本
   */
  getConfig(): DeceptionConfig {
    return { ...this.config };
  }

  /**
   * 重置状态。
   *
   * 清除所有蜜罐端点、金丝雀令牌、诱饵凭证和攻击者画像，
   * 并重新部署默认蜜罐。用于测试隔离或系统重置。
   */
  reset(): void {
    this.honeypots.clear();
    this.canaryTokens.clear();
    this.canaryTokenByValue.clear();
    this.decoyCredentials.clear();
    this.decoyCredentialByKey.clear();
    this.attackerProfiles.clear();
    this.responseStrategyCounts = { SLOW: 0, FEED: 0, TRAP: 0, BLOCK: 0 };
    this.deployDefaultHoneypots();
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 部署默认蜜罐端点（构造时调用）。
   * @private
   */
  private deployDefaultHoneypots(): void {
    for (const def of DEFAULT_HONEYPOTS) {
      try {
        this.registerHoneypot(def.path, def.method, def.responseTemplate);
      } catch (err) {
        reportSilentFailure(err, 'activeDeceptionSystem:deployDefaultHoneypots');
      }
    }
  }

  /**
   * 生成蜜罐存储键。
   * @private
   */
  private honeypotKey(path: string, method: string): string {
    return `${method.toUpperCase()}:${path}`;
  }

  /**
   * 淘汰命中次数最少的蜜罐端点。
   * @private
   */
  private evictLeastHitHoneypot(): void {
    let leastKey: string | undefined;
    let leastHits = Infinity;
    for (const [key, hp] of this.honeypots) {
      if (hp.hits < leastHits) {
        leastHits = hp.hits;
        leastKey = key;
      }
    }
    if (leastKey !== undefined) {
      this.honeypots.delete(leastKey);
    }
  }

  /**
   * 根据类型构建金丝雀令牌值。
   * @private
   */
  private buildCanaryTokenValue(type: CanaryTokenType, uuid: string): string {
    switch (type) {
      case 'url':
        return `https://canary.cmdr.sec/${uuid}/callback`;
      case 'dns':
        return `${uuid}.canary.cmdr.sec`;
      case 'file':
        return `CMDR_CANARY_FILE_${uuid}`;
      case 'database':
        return `canary_db_${uuid}`;
      case 'api_key':
        return `cmdr_canary_${this.randomBase62(40)}`;
      case 'aws_key':
        return `AKIA${this.randomUpperAlphanumeric(16)}`;
      default:
        return uuid;
    }
  }

  /**
   * 将金丝雀令牌注入响应模板。
   * @private
   */
  private injectCanaryIntoTemplate(template: unknown, token: CanaryToken): unknown {
    if (typeof template !== 'object' || template === null) {
      return template;
    }
    // 深拷贝后注入令牌字段
    const clone = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
    clone['__canary_token__'] = token.value;
    clone['__canary_url__'] = `https://canary.cmdr.sec/${token.id}/verify`;
    return clone;
  }

  /**
   * 为未提供模板的路径生成默认响应模板。
   * @private
   */
  private defaultResponseTemplate(path: string): unknown {
    return {
      path,
      status: 'ok',
      data: { token: 'PLACEHOLDER', secret: 'PLACEHOLDER' },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 根据格式生成虚假凭证值。
   * @private
   */
  private generateFakeCredential(format: string): string {
    switch (format) {
      case 'api_key':
        return this.generateFakeApiKeys(1)[0]!;
      case 'aws_key':
        return this.generateFakeAwsKeys(1)[0]!.accessKeyId;
      case 'aws_secret':
        return this.generateFakeAwsKeys(1)[0]!.secretAccessKey;
      case 'jwt':
        return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${this.randomBase64Url(32)}.${this.randomBase64Url(43)}`;
      case 'bearer':
        return `Bearer ${this.randomBase62(64)}`;
      case 'database_url':
        return `postgresql://decoy:${this.randomBase62(16)}@db-decoy.internal:5432/decoy`;
      default:
        return `cmdr_decoy_${this.randomBase62(32)}`;
    }
  }

  /**
   * 从请求头检测攻击工具。
   * @private
   */
  private detectTools(headers: Record<string, string | string[] | undefined>): string[] {
    const tools: string[] = [];
    const userAgent = this.getHeader(headers, 'user-agent');
    if (!userAgent) {
      tools.push('no-user-agent');
      return tools;
    }

    for (const sig of SCANNER_SIGNATURES) {
      if (sig.pattern.test(userAgent)) {
        tools.push(sig.tool);
      }
    }

    return tools;
  }

  /**
   * 评估是否为自动化攻击。
   * @private
   */
  private assessAutomation(
    profile: AttackerProfile,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    // 信号1：检测到已知扫描器工具
    const scannerTools = profile.toolsDetected.filter((t) =>
      [
        'nmap',
        'nikto',
        'sqlmap',
        'masscan',
        'zgrab',
        'nuclei',
        'dirbuster',
        'dirb',
        'gobuster',
        'wpscan',
        'hydra',
        'metasploit',
        'acunetix',
        'nessus',
        'scrapy',
      ].includes(t),
    );
    if (scannerTools.length > 0) {
      return true;
    }

    // 信号2：缺少典型浏览器头
    const hasAcceptLanguage = !!this.getHeader(headers, 'accept-language');
    const hasAcceptEncoding = !!this.getHeader(headers, 'accept-encoding');
    const hasReferer = !!this.getHeader(headers, 'referer');
    if (!hasAcceptLanguage && !hasAcceptEncoding && !hasReferer && profile.requestCount > 1) {
      return true;
    }

    // 信号3：请求频率过高（短时间内大量请求）
    if (profile.accessPattern.length >= 5) {
      const recent = profile.accessPattern.slice(-5);
      const timeSpan =
        new Date(recent[recent.length - 1]!.timestamp).getTime() -
        new Date(recent[0]!.timestamp).getTime();
      // 5 个请求在 2 秒内 = 自动化
      if (timeSpan > 0 && timeSpan < 2000) {
        return true;
      }
    }

    return false;
  }

  /**
   * 推测攻击者技能水平。
   * @private
   */
  private assessSkillLevel(profile: AttackerProfile): AttackerSkillLevel {
    let score = 0;

    // 使用高级工具加分
    if (profile.toolsDetected.includes('metasploit')) score += 3;
    if (profile.toolsDetected.includes('burpsuite')) score += 3;
    if (profile.toolsDetected.includes('sqlmap')) score += 2;
    if (profile.toolsDetected.includes('nuclei')) score += 2;
    if (profile.toolsDetected.includes('hydra')) score += 2;
    if (profile.toolsDetected.includes('nmap')) score += 1;
    if (profile.toolsDetected.includes('nikto')) score += 1;

    // 持有合法凭证（内部威胁）大幅加分
    if (profile.hasValidCredentials) score += 4;

    // 触发了金丝雀令牌（说明使用了泄露的诱饵数据）
    if (profile.capturedTokens.length > 0) score += 3;

    // 使用了诱饵凭证
    if (profile.usedDecoyCredentials.length > 0) score += 2;

    // 访问了多个不同端点（广泛探测）
    const uniquePaths = new Set(profile.accessPattern.map((e) => e.path));
    if (uniquePaths.size > 10) score += 2;
    else if (uniquePaths.size > 5) score += 1;

    // 访问深度（深入访问特定端点）
    if (profile.requestCount > 20) score += 1;

    if (score >= 8) return 'expert';
    if (score >= 5) return 'advanced';
    if (score >= 3) return 'intermediate';
    if (profile.isAutomated && profile.toolsDetected.length > 0) return 'script_kiddie';
    if (score >= 1) return 'novice';
    return 'unknown';
  }

  /**
   * 调用零信任验证器检查请求签名。
   *
   * 如果蜜罐请求携带了有效的零信任签名，说明持有合法凭证的实体
   * 正在访问蜜罐 —— 这是内部威胁或凭证泄露的强烈信号。
   *
   * @private
   */
  private checkZeroTrustSignature(
    path: string,
    method: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    try {
      const validator = getZeroTrustValidator();
      const keyIds = validator.getRegisteredKeyIds();
      if (keyIds.length === 0) {
        // 未注册任何签名密钥，无法验证
        return false;
      }

      const signatureHeader = this.getHeader(headers, 'x-commander-signature');
      if (!signatureHeader) {
        return false;
      }

      const result = validator.validateRequest({
        method,
        path,
        signatureHeader,
      });

      return result.valid;
    } catch (err) {
      reportSilentFailure(err, 'activeDeceptionSystem:checkZeroTrustSignature');
      return false;
    }
  }

  /**
   * 根据攻击者画像和蜜罐命中情况选择响应策略。
   * @private
   */
  private selectResponseStrategy(
    profile: AttackerProfile,
    endpoint: HoneypotEndpoint,
  ): DeceptionResponse {
    // 达到阻断阈值 → BLOCK
    if (profile.requestCount >= this.config.blockAfterHits) {
      return 'BLOCK';
    }

    // 检测到合法凭证使用（内部威胁）→ BLOCK
    if (profile.hasValidCredentials && profile.requestCount >= 3) {
      return 'BLOCK';
    }

    // 触发了金丝雀令牌 → TRAP（引导到更深的蜜罐）
    if (profile.capturedTokens.length > 0) {
      return 'TRAP';
    }

    // 高级攻击者 → TRAP
    if (profile.skillLevel === 'expert' || profile.skillLevel === 'advanced') {
      return 'TRAP';
    }

    // 自动化扫描器 → SLOW（消耗时间）
    if (profile.isAutomated) {
      return 'SLOW';
    }

    // 默认策略
    return this.config.defaultResponseStrategy;
  }

  /**
   * 构建蜜罐命中响应。
   * @private
   */
  private buildHitResponse(
    strategy: DeceptionResponse,
    endpoint: HoneypotEndpoint,
    profile: AttackerProfile,
  ): HoneypotHitResult {
    let statusCode = 200;
    let body: unknown = endpoint.responseTemplate;
    let delayMs = 0;
    let shouldBlock = false;

    switch (strategy) {
      case 'SLOW': {
        // 延迟响应消耗攻击者时间
        delayMs = this.config.slowResponseDelayMs;
        statusCode = 200;
        body = endpoint.responseTemplate;
        break;
      }
      case 'FEED': {
        // 返回虚假数据误导攻击者
        if (this.config.feedFakeDataEnabled) {
          body = this.generateFakeFeedData(endpoint);
        }
        statusCode = 200;
        break;
      }
      case 'TRAP': {
        // 引导攻击者到更深的蜜罐
        const trapLinks = this.generateTrapLinks(endpoint, profile);
        body = {
          ...(endpoint.responseTemplate as Record<string, unknown>),
          __next_steps: trapLinks,
          __admin_panel: `https://internal.cmdr.sec/trap/${endpoint.canaryToken.id}`,
        };
        statusCode = 200;
        // 为陷阱链接生成新的金丝雀令牌
        for (const link of trapLinks) {
          const trapToken = this.generateCanaryToken('url');
          trapToken.associatedEndpoint = link;
        }
        break;
      }
      case 'BLOCK': {
        // 确认攻击后阻断
        shouldBlock = true;
        statusCode = 403;
        body = { error: 'Access denied', reason: 'security_policy_violation' };
        delayMs = 0;
        break;
      }
    }

    return {
      strategy,
      statusCode,
      body,
      delayMs,
      shouldBlock,
      attackerProfile: profile,
    };
  }

  /**
   * 生成虚假投喂数据（FEED 策略）。
   * @private
   */
  private generateFakeFeedData(endpoint: HoneypotEndpoint): unknown {
    const template = endpoint.responseTemplate as Record<string, unknown>;
    // 投放一个诱饵凭证到响应中
    const decoy = this.plantDecoyCredential('api_key', `response:${endpoint.path}`);
    return {
      ...template,
      __api_key: decoy.fakeKey,
      __expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      __scope: 'admin',
    };
  }

  /**
   * 生成陷阱链接（TRAP 策略）。
   * @private
   */
  private generateTrapLinks(endpoint: HoneypotEndpoint, _profile: AttackerProfile): string[] {
    const links: string[] = [];
    const basePath = endpoint.path;

    // 生成更深的陷阱路径
    const trapSuffixes = ['/credentials', '/tokens', '/config', '/secrets', '/backup'];
    for (const suffix of trapSuffixes.slice(0, this.config.trapDepth)) {
      links.push(`${basePath}${suffix}`);
      // 自动注册陷阱蜜罐
      try {
        this.registerHoneypot(`${basePath}${suffix}`, 'GET');
      } catch (err) {
        reportSilentFailure(err, 'activeDeceptionSystem:generateTrapLinks');
      }
    }

    return links;
  }

  /**
   * 基于路径生成变体路径。
   * @private
   */
  private generatePathVariants(path: string): string[] {
    const variants: string[] = [];
    // 路径变体：大小写、尾部斜杠、.bak 后缀等
    variants.push(`${path}/`);
    variants.push(`${path}.bak`);
    variants.push(`${path}.old`);
    variants.push(`${path}~`);
    variants.push(path.replace(/\/api\//i, '/api/v2/'));
    variants.push(path.replace(/\/api\//i, '/api/internal/'));
    return variants.filter((v) => v !== path);
  }

  /**
   * 获取或创建攻击者画像。
   * @private
   */
  private getOrCreateAttackerProfile(ip: string): AttackerProfile {
    let profile = this.attackerProfiles.get(ip);
    if (!profile) {
      // LRU 淘汰
      if (this.attackerProfiles.size >= this.config.maxAttackerProfiles) {
        this.evictOldestAttackerProfile();
      }

      const now = new Date().toISOString();
      profile = {
        ip,
        firstSeen: now,
        lastSeen: now,
        requestCount: 0,
        accessPattern: [],
        toolsDetected: [],
        skillLevel: 'unknown',
        isAutomated: false,
        capturedTokens: [],
        hasValidCredentials: false,
        usedDecoyCredentials: [],
      };
      this.attackerProfiles.set(ip, profile);
    }
    return profile;
  }

  /**
   * 淘汰最旧的攻击者画像。
   * @private
   */
  private evictOldestAttackerProfile(): void {
    let oldestIp: string | undefined;
    let oldestTime = Infinity;
    for (const [ip, profile] of this.attackerProfiles) {
      const seenTime = new Date(profile.firstSeen).getTime();
      if (seenTime < oldestTime) {
        oldestTime = seenTime;
        oldestIp = ip;
      }
    }
    if (oldestIp !== undefined) {
      this.attackerProfiles.delete(oldestIp);
    }
  }

  /**
   * 从请求头中安全获取单值。
   * @private
   */
  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }

  /**
   * 生成随机 Base62 字符串。
   * @private
   */
  private randomBase62(length: number): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[bytes[i]! % charset.length];
    }
    return result;
  }

  /**
   * 生成随机大写字母数字字符串。
   * @private
   */
  private randomUpperAlphanumeric(length: number): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[bytes[i]! % charset.length];
    }
    return result;
  }

  /**
   * 生成随机 Base64 字符串。
   * @private
   */
  private randomBase64(length: number): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[bytes[i]! % charset.length];
    }
    return result;
  }

  /**
   * 生成随机 Base64URL 字符串。
   * @private
   */
  private randomBase64Url(length: number): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[bytes[i]! % charset.length];
    }
    return result;
  }
}

// ============================================================================
// 单例
// ============================================================================

const deceptionSingleton = createTenantAwareSingleton(() => new ActiveDeceptionSystem(), {
  allowGlobalFallback: true,
});

/**
 * 获取全局 ActiveDeceptionSystem 实例（单租户）或租户范围的实例。
 *
 * @returns ActiveDeceptionSystem 单例
 */
export function getActiveDeceptionSystem(): ActiveDeceptionSystem {
  return deceptionSingleton.get();
}

/**
 * 重置 ActiveDeceptionSystem 单例（用于测试隔离）。
 */
export function resetActiveDeceptionSystem(): void {
  deceptionSingleton.reset();
}
