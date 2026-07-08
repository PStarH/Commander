/**
 * ZeroTrustValidator — 零信任请求验证器
 *
 * 实现「永不信任，始终验证」的零信任安全原则：
 * - HMAC-SHA-256 请求签名验证（完整性）
 * - 时间戳窗口防重放攻击（新鲜性）
 * - Nonce 去重防重放攻击（唯一性）
 * - 请求体哈希验证（防篡改）
 * - 客户端身份绑定（签名密钥与租户/用户绑定）
 * - 自动密钥轮换支持
 *
 * 签名格式：
 *   X-Commander-Signature: t=<timestamp>,v1=<hmac>,nonce=<nonce>,kid=<keyId>
 *
 * 验证流程：
 *   1. 解析签名头，提取 timestamp、hmac、nonce、keyId
 *   2. 检查时间戳是否在允许窗口内（默认 ±5 分钟）
 *   3. 检查 nonce 是否已使用过（防重放）
 *   4. 使用 keyId 对应的密钥重新计算 HMAC
 *   5. 使用 timingSafeEqual 比较签名（防时序攻击）
 *   6. 验证请求体哈希是否匹配
 *
 * 使用方式：
 *   import { getZeroTrustValidator } from './security/zeroTrustValidator';
 *   const validator = getZeroTrustValidator();
 *   const result = validator.validateRequest({
 *     method: 'POST',
 *     path: '/api/v1/execute',
 *     body: requestBody,
 *     signatureHeader: req.headers['x-commander-signature'],
 *   });
 *   if (!result.valid) {
 *     res.status(401).json({ error: result.reason });
 *     return;
 *   }
 */

import * as crypto from 'node:crypto';
import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// 类型定义
// ============================================================================

/** 验证结果 */
export interface ZeroTrustValidationResult {
  /** 是否验证通过 */
  valid: boolean;
  /** 失败原因（valid=false 时有值） */
  reason?: string;
  /** 失败原因代码 */
  code?: ZeroTrustRejectReason;
  /** 验证耗时（ms） */
  durationMs: number;
  /** 请求 ID（从签名头提取或生成） */
  requestId?: string;
  /** 签名的租户 ID */
  tenantId?: string;
  /** 签名的密钥 ID */
  keyId?: string;
}

/** 拒绝原因代码 */
export type ZeroTrustRejectReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'unknown_key_id'
  | 'timestamp_expired'
  | 'timestamp_future'
  | 'nonce_replayed'
  | 'signature_mismatch'
  | 'body_hash_mismatch'
  | 'method_mismatch'
  | 'path_mismatch';

/** 签名密钥条目 */
export interface SigningKeyEntry {
  /** 密钥 ID */
  keyId: string;
  /** HMAC 签名密钥（原始字节） */
  secretKey: Buffer;
  /** 关联的租户 ID */
  tenantId?: string;
  /** 密钥创建时间 */
  createdAt: number;
  /** 密钥过期时间（0 = 永不过期） */
  expiresAt: number;
  /** 是否已撤销 */
  revoked: boolean;
}

/** 验证器配置 */
export interface ZeroTrustConfig {
  /** 时间戳允许窗口（毫秒，默认 5 分钟） */
  timestampWindowMs: number;
  /** Nonce 缓存大小（防重放，默认 100000） */
  nonceCacheSize: number;
  /** Nonce 最小长度（字节，默认 16） */
  nonceMinLength: number;
  /** 是否启用请求体哈希验证 */
  enableBodyHash: boolean;
  /** 是否启用方法验证 */
  enableMethodCheck: boolean;
  /** 是否启用路径验证 */
  enablePathCheck: boolean;
  /** 是否在签名头缺失时放行（兼容模式，生产环境应为 false） */
  allowMissingSignature: boolean;
  /** 签名头名称 */
  signatureHeader: string;
  /** 请求 ID 头名称 */
  requestIdHeader: string;
}

/** 签名参数（用于客户端生成签名） */
export interface SignRequestParams {
  /** HTTP 方法 */
  method: string;
  /** 请求路径 */
  path: string;
  /** 请求体（字符串或 Buffer） */
  body?: string | Buffer;
  /** 密钥 ID */
  keyId: string;
  /** 租户 ID（可选） */
  tenantId?: string;
}

/** 生成的签名 */
export interface GeneratedSignature {
  /** 签名头值 */
  header: string;
  /** 时间戳 */
  timestamp: number;
  /** Nonce */
  nonce: string;
  /** 请求体哈希 */
  bodyHash: string;
  /** 密钥 ID */
  keyId: string;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: ZeroTrustConfig = {
  timestampWindowMs: 5 * 60 * 1000, // 5 分钟
  nonceCacheSize: 100_000,
  nonceMinLength: 16,
  enableBodyHash: true,
  enableMethodCheck: true,
  enablePathCheck: true,
  allowMissingSignature: false,
  signatureHeader: 'x-commander-signature',
  requestIdHeader: 'x-request-id',
};

// ============================================================================
// ZeroTrustValidator
// ============================================================================

export class ZeroTrustValidator {
  private config: ZeroTrustConfig;
  private signingKeys: Map<string, SigningKeyEntry> = new Map();
  /** LRU nonce 缓存 —— 使用 Map 的插入顺序实现 FIFO 淘汰 */
  private nonceCache: Map<string, number> = new Map();
  private validationCount = 0;
  private rejectionCount = 0;

  constructor(config?: Partial<ZeroTrustConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── 密钥管理 ──────────────────────────────────────────────────────

  /**
   * 注册签名密钥
   * @param keyId - 密钥 ID
   * @param secretKey - HMAC 密钥（字符串或 Buffer）
   * @param options - 可选配置（租户 ID、过期时间）
   */
  registerKey(
    keyId: string,
    secretKey: string | Buffer,
    options?: { tenantId?: string; expiresAt?: number },
  ): void {
    const keyBuffer = typeof secretKey === 'string' ? Buffer.from(secretKey, 'utf8') : secretKey;
    this.signingKeys.set(keyId, {
      keyId,
      secretKey: keyBuffer,
      tenantId: options?.tenantId,
      createdAt: Date.now(),
      expiresAt: options?.expiresAt ?? 0,
      revoked: false,
    });
    getGlobalLogger().info('ZeroTrustValidator', `Signing key registered: ${keyId}`, {
      keyId,
      tenantId: options?.tenantId,
      expiresAt: options?.expiresAt,
    });
  }

  /**
   * 撤销签名密钥
   * @param keyId - 密钥 ID
   */
  revokeKey(keyId: string): boolean {
    const entry = this.signingKeys.get(keyId);
    if (!entry) return false;
    entry.revoked = true;
    getSecurityAuditLogger().logEvent({
      type: 'config_change',
      severity: 'high',
      source: 'ZeroTrustValidator',
      message: `Signing key revoked: ${keyId}`,
      details: { keyId, tenantId: entry.tenantId },
    });
    return true;
  }

  /**
   * 删除签名密钥
   * @param keyId - 密钥 ID
   */
  removeKey(keyId: string): boolean {
    return this.signingKeys.delete(keyId);
  }

  /**
   * 获取已注册的密钥 ID 列表
   */
  getRegisteredKeyIds(): string[] {
    return Array.from(this.signingKeys.keys());
  }

  // ── 签名生成（客户端使用） ────────────────────────────────────────

  /**
   * 生成请求签名
   * @param params - 签名参数
   * @returns 签名头值和时间戳等信息
   */
  signRequest(params: SignRequestParams): GeneratedSignature {
    const entry = this.signingKeys.get(params.keyId);
    if (!entry) {
      throw new Error(`Unknown key ID: ${params.keyId}`);
    }
    if (entry.revoked) {
      throw new Error(`Key ${params.keyId} has been revoked`);
    }

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(32).toString('hex');
    const bodyBytes = params.body
      ? typeof params.body === 'string'
        ? Buffer.from(params.body, 'utf8')
        : params.body
      : Buffer.alloc(0);
    const bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');

    const canonicalString = this.buildCanonicalString(
      params.method,
      params.path,
      timestamp,
      nonce,
      bodyHash,
    );

    const hmac = crypto.createHmac('sha256', entry.secretKey).update(canonicalString).digest('hex');

    const header = `t=${timestamp},v1=${hmac},nonce=${nonce},kid=${params.keyId}`;

    return {
      header,
      timestamp,
      nonce,
      bodyHash,
      keyId: params.keyId,
    };
  }

  // ── 请求验证 ──────────────────────────────────────────────────────

  /**
   * 验证请求签名
   * @param params - 验证参数
   * @returns 验证结果
   */
  validateRequest(params: {
    method: string;
    path: string;
    body?: string | Buffer;
    signatureHeader?: string;
    requestId?: string;
  }): ZeroTrustValidationResult {
    const startTime = Date.now();
    this.validationCount++;

    try {
      const { method, path, body, signatureHeader, requestId } = params;

      // 1. 检查签名头是否存在
      if (!signatureHeader) {
        if (this.config.allowMissingSignature) {
          return this.result(true, undefined, undefined, startTime, requestId);
        }
        return this.result(
          false,
          'Missing signature header',
          'missing_signature',
          startTime,
          requestId,
        );
      }

      // 2. 解析签名头
      const parsed = this.parseSignatureHeader(signatureHeader);
      if (!parsed) {
        return this.result(
          false,
          'Malformed signature header',
          'malformed_signature',
          startTime,
          requestId,
        );
      }

      const { t: timestamp, v1: signature, nonce, kid: keyId } = parsed;

      // 3. 查找密钥
      const entry = this.signingKeys.get(keyId);
      if (!entry || entry.revoked) {
        return this.result(
          false,
          `Unknown or revoked key ID: ${keyId}`,
          'unknown_key_id',
          startTime,
          requestId,
          entry?.tenantId,
          keyId,
        );
      }

      // 检查密钥过期
      if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
        return this.result(
          false,
          `Key ${keyId} has expired`,
          'unknown_key_id',
          startTime,
          requestId,
          entry.tenantId,
          keyId,
        );
      }

      // 4. 时间戳窗口检查
      const now = Date.now();
      const age = now - timestamp;
      if (age > this.config.timestampWindowMs) {
        return this.result(
          false,
          `Request timestamp too old: ${Math.round(age / 1000)}s ago (max ${this.config.timestampWindowMs / 1000}s)`,
          'timestamp_expired',
          startTime,
          requestId,
          entry.tenantId,
          keyId,
        );
      }
      if (age < -this.config.timestampWindowMs) {
        return this.result(
          false,
          `Request timestamp is in the future: ${Math.round(-age / 1000)}s ahead`,
          'timestamp_future',
          startTime,
          requestId,
          entry.tenantId,
          keyId,
        );
      }

      // 5. Nonce 去重检查
      const nonceKey = `${keyId}:${nonce}`;
      if (this.nonceCache.has(nonceKey)) {
        return this.result(
          false,
          'Replay attack detected: nonce already used',
          'nonce_replayed',
          startTime,
          requestId,
          entry.tenantId,
          keyId,
        );
      }

      // 6. 请求体哈希验证
      let bodyHash = '';
      if (this.config.enableBodyHash) {
        const bodyBytes = body
          ? typeof body === 'string'
            ? Buffer.from(body, 'utf8')
            : body
          : Buffer.alloc(0);
        bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
      }

      // 7. 重新计算 HMAC
      const canonicalString = this.buildCanonicalString(
        this.config.enableMethodCheck ? method : '',
        this.config.enablePathCheck ? path : '',
        timestamp,
        nonce,
        bodyHash,
      );

      const expectedHmac = crypto
        .createHmac('sha256', entry.secretKey)
        .update(canonicalString)
        .digest('hex');

      // 8. 时序安全比较
      const signatureBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedHmac, 'hex');

      let signaturesMatch = false;
      if (signatureBuffer.length === expectedBuffer.length) {
        try {
          signaturesMatch = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
        } catch {
          signaturesMatch = false;
        }
      }

      if (!signaturesMatch) {
        this.recordRejection('signature_mismatch', entry.tenantId, keyId);
        return this.result(
          false,
          'Signature mismatch',
          'signature_mismatch',
          startTime,
          requestId,
          entry.tenantId,
          keyId,
        );
      }

      // 9. 记录 nonce（防重放）
      this.recordNonce(nonceKey, now);

      // 验证通过
      try {
        getGlobalMetrics().incrementCounter('zerotrust.validations', 1, {
          result: 'valid',
          keyId,
        });
      } catch (err) {
        reportSilentFailure(err, 'zeroTrustValidator:metrics');
      }

      return this.result(true, undefined, undefined, startTime, requestId, entry.tenantId, keyId);
    } catch (err) {
      reportSilentFailure(err, 'zeroTrustValidator:validateRequest');
      return this.result(
        false,
        `Validation error: ${(err as Error).message}`,
        'malformed_signature',
        startTime,
        params.requestId,
      );
    }
  }

  /**
   * 获取验证统计
   */
  getStats(): {
    totalValidations: number;
    totalRejections: number;
    rejectionRate: number;
    activeKeys: number;
    nonceCacheSize: number;
  } {
    const activeKeys = Array.from(this.signingKeys.values()).filter(
      (k) => !k.revoked && (k.expiresAt === 0 || k.expiresAt > Date.now()),
    ).length;
    return {
      totalValidations: this.validationCount,
      totalRejections: this.rejectionCount,
      rejectionRate: this.validationCount > 0 ? this.rejectionCount / this.validationCount : 0,
      activeKeys,
      nonceCacheSize: this.nonceCache.size,
    };
  }

  /**
   * 更新配置
   */
  configure(config: Partial<ZeroTrustConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 重置状态（测试用）
   */
  reset(): void {
    this.signingKeys.clear();
    this.nonceCache.clear();
    this.validationCount = 0;
    this.rejectionCount = 0;
  }

  /**
   * 清理过期的 nonce 缓存
   */
  cleanupNonceCache(): void {
    const cutoff = Date.now() - this.config.timestampWindowMs * 2;
    for (const [key, timestamp] of this.nonceCache) {
      if (timestamp < cutoff) {
        this.nonceCache.delete(key);
      }
    }
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 构建规范化字符串（用于 HMAC 签名）
   * 格式：METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
   */
  private buildCanonicalString(
    method: string,
    path: string,
    timestamp: number,
    nonce: string,
    bodyHash: string,
  ): string {
    return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  }

  /**
   * 解析签名头
   * 格式：t=<timestamp>,v1=<hmac>,nonce=<nonce>,kid=<keyId>
   */
  private parseSignatureHeader(
    header: string,
  ): { t: number; v1: string; nonce: string; kid: string } | null {
    try {
      const parts: Record<string, string> = {};
      for (const part of header.split(',')) {
        const [key, ...valueParts] = part.trim().split('=');
        if (key && valueParts.length > 0) {
          parts[key.trim()] = valueParts.join('=').trim();
        }
      }

      const t = parseInt(parts['t'] ?? '', 10);
      const v1 = parts['v1'] ?? '';
      const nonce = parts['nonce'] ?? '';
      const kid = parts['kid'] ?? '';

      if (isNaN(t) || !v1 || !nonce || !kid) {
        return null;
      }

      if (nonce.length < this.config.nonceMinLength) {
        return null;
      }

      return { t, v1, nonce, kid };
    } catch {
      return null;
    }
  }

  /**
   * 记录 nonce（带 LRU 淘汰）
   */
  private recordNonce(key: string, timestamp: number): void {
    // 如果缓存已满，淘汰最旧的条目
    if (this.nonceCache.size >= this.config.nonceCacheSize) {
      const oldestKey = this.nonceCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.nonceCache.delete(oldestKey);
      }
    }
    this.nonceCache.set(key, timestamp);
  }

  /**
   * 记录拒绝事件
   */
  private recordRejection(reason: string, tenantId?: string, keyId?: string): void {
    this.rejectionCount++;
    try {
      getGlobalMetrics().incrementCounter('zerotrust.rejections', 1, {
        reason,
        keyId: keyId ?? '',
      });
    } catch (err) {
      reportSilentFailure(err, 'zeroTrustValidator:rejectionMetrics');
    }
    getSecurityAuditLogger().logEvent({
      type: 'auth_failure',
      severity: reason === 'nonce_replayed' || reason === 'signature_mismatch' ? 'high' : 'medium',
      source: 'ZeroTrustValidator',
      message: `Request rejected: ${reason}`,
      details: { reason, tenantId, keyId },
    });
  }

  /**
   * 构建验证结果
   */
  private result(
    valid: boolean,
    reason?: string,
    code?: ZeroTrustRejectReason,
    startTime?: number,
    requestId?: string,
    tenantId?: string,
    keyId?: string,
  ): ZeroTrustValidationResult {
    const durationMs = startTime ? Date.now() - startTime : 0;
    if (!valid && code) {
      this.recordRejection(code, tenantId, keyId);
    }
    return { valid, reason, code, durationMs, requestId, tenantId, keyId };
  }
}

// ============================================================================
// Express 中间件
// ============================================================================

/**
 * 零信任验证 Express 中间件
 *
 * 用法：
 *   app.use(zeroTrustMiddleware());
 *
 * 可选配置：
 *   app.use(zeroTrustMiddleware({ skipPaths: ['/health', '/metrics'] }));
 */
export function zeroTrustMiddleware(options?: { skipPaths?: string[]; skipIfNoKeys?: boolean }) {
  const skipPaths = new Set(options?.skipPaths ?? ['/health', '/metrics', '/readyz']);
  const skipIfNoKeys = options?.skipIfNoKeys ?? true;

  return (req: unknown, res: unknown, next: (err?: unknown) => void) => {
    const request = req as {
      path: string;
      method: string;
      body?: unknown;
      headers: Record<string, string | string[] | undefined>;
    };
    const response = res as {
      status: (code: number) => { json: (data?: unknown) => unknown };
    };

    // 跳过健康检查等路径
    if (skipPaths.has(request.path)) {
      return next();
    }

    const validator = getZeroTrustValidator();

    // 如果没有注册任何密钥且配置为跳过，则放行（兼容模式）
    if (skipIfNoKeys && validator.getRegisteredKeyIds().length === 0) {
      return next();
    }

    const signatureHeader =
      (request.headers[DEFAULT_CONFIG.signatureHeader] as string) ?? undefined;
    const requestId = (request.headers[DEFAULT_CONFIG.requestIdHeader] as string) ?? undefined;

    // 获取请求体（Express body-parser 已解析）
    const body = request.body ? JSON.stringify(request.body) : undefined;

    const result = validator.validateRequest({
      method: request.method,
      path: request.path,
      body,
      signatureHeader,
      requestId,
    });

    if (!result.valid) {
      response.status(401).json({
        error: 'Request signature validation failed',
        reason: result.reason,
        code: result.code,
        requestId: result.requestId,
      });
      return;
    }

    // 将租户信息附加到请求
    (request as { zeroTrustTenantId?: string }).zeroTrustTenantId = result.tenantId;

    next();
  };
}

// ============================================================================
// 单例
// ============================================================================

const zeroTrustSingleton = createTenantAwareSingleton(() => new ZeroTrustValidator(), {});

/**
 * 获取全局 ZeroTrustValidator（单租户）或租户范围的实例
 */
export function getZeroTrustValidator(): ZeroTrustValidator {
  return zeroTrustSingleton.get();
}

/**
 * 重置 ZeroTrustValidator 单例（用于测试隔离）
 */
export function resetZeroTrustValidator(): void {
  zeroTrustSingleton.reset();
}
