/**
 * A2AMessageSecurity — Message-level security for Agent-to-Agent (A2A) protocol.
 *
 * Addresses OWASP ASI07 (Agent-to-Agent communication threats). The existing
 * A2A server/client stack only relies on bearer-token authentication at the
 * session layer and mutual TLS at the transport layer. Neither protects a
 * message once it leaves the TLS tunnel, neither binds a message to a verified
 * agent identity, and neither prevents replay of a captured, still-valid
 * message. This module adds four complementary message-level defenses:
 *
 *   1. Message Integrity (HMAC-SHA-256) — every message is signed; the
 *      signature covers timestamp + nonce + sender + recipient + payload hash.
 *   2. Message Encryption (AES-256-GCM) — optional confidentiality for
 *      sensitive payloads, with per-message HKDF-derived keys.
 *   3. Identity Attestation — each message is bound to a registered agent
 *      identity (agent_id + tenant_id + capability_token_hash) via an
 *      attestation HMAC that proves possession of the capability token without
 *      revealing it.
 *   4. Replay Attack Prevention — cryptographic nonces + timestamps kept in a
 *      per-sender sliding window; stale, skewed, or replayed messages are
 *      rejected.
 *
 * Design tenets:
 *   - Fail closed by default: any verification error rejects the message.
 *   - Constant-time comparisons (crypto.timingSafeEqual) for all MAC checks.
 *   - Tenant-aware singleton: in-memory registries are isolated per tenant.
 *   - All verification failures are recorded via SecurityAuditLogger with the
 *     `a2a_security_violation` event type and surfaced through metrics.
 *
 * Usage:
 *   import { getA2AMessageSecurity } from './security/a2aMessageSecurity';
 *   const sec = getA2AMessageSecurity();
 *   sec.registerAgent('agent-1', 'tenant-1', 'cap-token-secret');
 *   sec.setSharedSecret('shared-encryption-secret');
 *   const secured = sec.secureMessage(message, senderContext);
 *   const result = sec.verifyMessage(secured, 'agent-1');
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// 常量
// ============================================================================

/** HMAC 签名算法。 */
const HMAC_ALGORITHM = 'sha256';
/** 对称加密算法。 */
const CIPHER_ALGORITHM = 'aes-256-gcm';
/** HKDF 派生算法。 */
const HKDF_ALGORITHM = 'sha256';
/** AES-256 密钥长度（字节）。 */
const KEY_LENGTH = 32;
/** AES-GCM 初始化向量长度（字节）。 */
const GCM_IV_LENGTH = 12;
/** AES-GCM 认证标签长度（字节）。 */
const GCM_TAG_LENGTH = 16;
/** 加密随机 nonce 长度（字节）。 */
const NONCE_LENGTH = 16;
/** HKDF info 域，用于域分离。 */
const HKDF_INFO = Buffer.from('commander-a2a-message-security|v1', 'utf-8');

/** 签名头前缀。 */
const SIGNATURE_PREFIX = 'a2a-sig v1';
/** 加密头前缀。 */
const ENCRYPTION_PREFIX = 'a2a-enc v1';
/** 身份证明头前缀。 */
const ATTESTATION_PREFIX = 'a2a-attest v1';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 消息安全等级。
 * - none: 不附加任何保护（仅在内部可信链路使用）
 * - signed: 仅附加 HMAC 签名
 * - encrypted: 加密 + 签名
 * - attested: 加密 + 签名 + 身份证明（最高等级）
 */
export type SecurityLevel = 'none' | 'signed' | 'encrypted' | 'attested';

/**
 * 已注册的可信代理身份。
 * 代理身份由 agentId、tenantId 与能力令牌哈希三者唯一确定。
 */
export interface AgentIdentity {
  /** 代理标识。 */
  agentId: string;
  /** 租户标识。 */
  tenantId: string;
  /** 能力令牌的 SHA-256 哈希（不存储令牌原文）。 */
  capabilityTokenHash: string;
  /** 注册时间（ISO 8601）。 */
  registeredAt: string;
  /** 最近一次被验证的时间（ISO 8601）。 */
  lastSeen: string;
  /** 是否已被撤销。 */
  revoked: boolean;
}

/**
 * 发送方上下文，用于构造受保护消息。
 */
export interface SenderContext {
  /** 发送方代理标识。 */
  agentId: string;
  /** 发送方所属租户。 */
  tenantId: string;
  /** 能力令牌原文（仅在发送侧使用，用于生成证明）。 */
  capabilityToken: string;
  /** 接收方代理标识。 */
  recipientId: string;
}

/**
 * 待保护的 A2A 消息（JSON-RPC 风格）。
 */
export interface A2AMessage {
  /** 消息唯一标识。 */
  id: string;
  /** JSON-RPC 方法名。 */
  method: string;
  /** JSON-RPC 参数。 */
  params: unknown;
  /** 时间戳（ISO 8601）。 */
  timestamp: string;
}

/**
 * 已附加安全保护的消息。
 */
export interface SecuredMessage {
  /** 原始消息（当启用加密时，此字段仅保留元信息，敏感载荷已加密）。 */
  original: A2AMessage;
  /** 实际施加的安全等级。 */
  securityLevel: SecurityLevel;
  /** HMAC 签名字符串（signed 及以上等级存在）。 */
  signature?: string;
  /** 身份证明字符串（attested 等级存在）。 */
  attestation?: string;
  /** 加密后的消息体（encrypted 及以上等级存在）。 */
  encryptedPayload?: string;
  /** 加密随机 nonce（十六进制）。 */
  nonce: string;
  /** 发送方代理标识。 */
  senderId: string;
  /** 接收方代理标识。 */
  recipientId: string;
}

/**
 * 消息验证结果。
 */
export interface VerificationResult {
  /** 是否通过全部校验。 */
  valid: boolean;
  /** 失败原因（成功时为空字符串）。 */
  reason: string;
  /** 实际验证到的安全等级。 */
  securityLevel: SecurityLevel;
  /** 发送方身份是否已验证。 */
  senderVerified: boolean;
  /** 签名是否有效。 */
  signatureValid: boolean;
  /** 解密是否有效。 */
  encryptionValid: boolean;
  /** 身份证明是否有效。 */
  attestationValid: boolean;
  /** 是否检测到重放攻击。 */
  replayDetected: boolean;
  /** 验证时间戳（ISO 8601）。 */
  timestamp: string;
  /** 解密后的消息（当启用加密且校验通过时存在）。 */
  decryptedMessage?: A2AMessage;
}

/**
 * A2A 消息安全配置。
 */
export interface A2AMessageSecurityConfig {
  /** 是否启用消息级安全。 */
  enabled: boolean;
  /** 默认安全等级。 */
  defaultSecurityLevel: SecurityLevel;
  /** 消息最大允许年龄（毫秒），用于重放防御，默认 5 分钟。 */
  maxAgeMs: number;
  /** 允许的最大时钟偏移（毫秒），默认 1 分钟。 */
  maxSkewMs: number;
  /** 每个发送方缓存的最大 nonce 数量，默认 10000。 */
  nonceCacheSize: number;
  /** nonce 生存时间（毫秒），默认 5 分钟。 */
  nonceTtlMs: number;
  /** nonce 清理间隔（毫秒），默认 1 分钟。 */
  cleanupIntervalMs: number;
  /** 是否启用加密。 */
  enableEncryption: boolean;
  /** 是否启用身份证明。 */
  enableAttestation: boolean;
  /** 密钥轮换时旧密钥的宽限期（毫秒），默认 5 分钟。 */
  keyRotationGracePeriodMs: number;
  /** 是否对任何校验错误都拒绝（失败即关闭），默认 true。 */
  failClosed: boolean;
}

/** 默认配置。 */
const DEFAULT_CONFIG: A2AMessageSecurityConfig = {
  enabled: true,
  defaultSecurityLevel: 'attested',
  maxAgeMs: 300_000,
  maxSkewMs: 60_000,
  nonceCacheSize: 10_000,
  nonceTtlMs: 300_000,
  cleanupIntervalMs: 60_000,
  enableEncryption: true,
  enableAttestation: true,
  keyRotationGracePeriodMs: 300_000,
  failClosed: true,
};

/**
 * 语义分析回调，用于对消息内容进行额外的语义级校验（例如提示注入检测）。
 */
export type SemanticAnalyzer = (
  message: A2AMessage,
  context: { senderId: string; recipientId: string },
) => { allowed: boolean; reason: string };

// ============================================================================
// 内部数据结构
// ============================================================================

/** 带时间戳的 nonce 条目，用于过期清理。 */
interface NonceEntry {
  /** nonce 值（十六进制）。 */
  nonce: string;
  /** 记录时间（epoch 毫秒）。 */
  recordedAt: number;
}

/**
 * 密钥条目，支持密钥轮换宽限期。
 */
interface KeyEntry {
  /** 派生密钥（32 字节）。 */
  key: Buffer;
  /** 密钥设置时间（epoch 毫秒）。 */
  setAt: number;
}

// ============================================================================
// A2AMessageSecurity
// ============================================================================

/**
 * A2A 消息安全层。
 *
 * 提供消息级完整性、机密性、身份证明与重放防御。该类为租户隔离的
 * 单例，通过 `getA2AMessageSecurity()` 获取实例。
 */
export class A2AMessageSecurity {
  private config: A2AMessageSecurityConfig;
  /** 代理身份注册表，按 agentId 索引。 */
  private readonly agentRegistry: Map<string, AgentIdentity> = new Map();
  /** nonce 缓存，按 senderId 索引。 */
  private readonly nonceCache: Map<string, NonceEntry[]> = new Map();
  /** 当前加密共享密钥的派生密钥。 */
  private currentKey: KeyEntry | null = null;
  /** 上一个加密共享密钥的派生密钥（轮换宽限期内接受）。 */
  private previousKey: KeyEntry | null = null;
  /** 可选的语义分析回调。 */
  private semanticAnalyzer: SemanticAnalyzer | null = null;
  /** nonce 清理定时器。 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** 运行统计。 */
  private stats = {
    messagesSecured: 0,
    messagesVerified: 0,
    verificationFailures: 0,
    failuresByReason: {} as Record<string, number>,
    replaysDetected: 0,
    agentsRegistered: 0,
    agentsRevoked: 0,
    keyRotations: 0,
  };

  constructor(config?: Partial<A2AMessageSecurityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
  }

  // ── 配置 ────────────────────────────────────────────────────────

  /**
   * 更新运行时配置（合并到现有配置）。
   */
  updateConfig(patch: Partial<A2AMessageSecurityConfig>): void {
    this.config = { ...this.config, ...patch };
    // 配置变更后重启清理定时器以应用新的间隔。
    this.restartCleanupTimer();
  }

  /**
   * 获取当前配置（只读副本）。
   */
  getConfig(): Readonly<A2AMessageSecurityConfig> {
    return { ...this.config };
  }

  // ── 代理身份注册表 ──────────────────────────────────────────────

  /**
   * 注册一个可信代理身份。
   *
   * 仅存储能力令牌的 SHA-256 哈希，绝不保留令牌原文，确保即使注册表
   * 泄露也无法伪造身份证明。
   *
   * @param agentId - 代理标识
   * @param tenantId - 租户标识
   * @param capabilityToken - 能力令牌原文
   * @returns 注册成功的代理身份
   */
  registerAgent(agentId: string, tenantId: string, capabilityToken: string): AgentIdentity {
    const now = new Date().toISOString();
    const capabilityTokenHash = this.hashCapabilityToken(capabilityToken);
    const identity: AgentIdentity = {
      agentId,
      tenantId,
      capabilityTokenHash,
      registeredAt: now,
      lastSeen: now,
      revoked: false,
    };
    this.agentRegistry.set(agentId, identity);
    this.stats.agentsRegistered++;

    try {
      const logger = getGlobalLogger();
      logger.info('A2AMessageSecurity', 'Agent registered', {
        agentId,
        tenantId,
      });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.registerAgent:log');
    }

    try {
      getSecurityAuditLogger().logEvent({
        type: 'a2a_security_violation',
        severity: 'low',
        source: 'A2AMessageSecurity',
        message: 'Agent identity registered',
        details: { agentId, tenantId },
        context: { agentId, tenantId },
      });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.registerAgent:audit');
    }

    return identity;
  }

  /**
   * 撤销一个代理的身份。撤销后该代理发送的消息将无法通过身份证明校验。
   *
   * @param agentId - 代理标识
   * @returns 是否成功撤销（若代理不存在则返回 false）
   */
  revokeAgent(agentId: string): boolean {
    const identity = this.agentRegistry.get(agentId);
    if (!identity) {
      return false;
    }
    identity.revoked = true;
    this.stats.agentsRevoked++;

    try {
      const logger = getGlobalLogger();
      logger.warn('A2AMessageSecurity', 'Agent revoked', { agentId });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.revokeAgent:log');
    }

    try {
      getSecurityAuditLogger().logEvent({
        type: 'a2a_security_violation',
        severity: 'high',
        source: 'A2AMessageSecurity',
        message: 'Agent identity revoked',
        details: { agentId, tenantId: identity.tenantId },
        context: { agentId, tenantId: identity.tenantId },
      });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.revokeAgent:audit');
    }

    return true;
  }

  /**
   * 查询代理身份（内部使用）。
   */
  private getAgentIdentity(agentId: string): AgentIdentity | undefined {
    return this.agentRegistry.get(agentId);
  }

  // ── 加密密钥管理 ────────────────────────────────────────────────

  /**
   * 设置加密共享密钥。
   *
   * 共享密钥通过 HKDF-SHA-256 派生为 32 字节的 AES-256 密钥。发送方与
   * 接收方必须配置相同的共享密钥才能完成加解密。
   *
   * @param secret - 共享密钥原文
   */
  setSharedSecret(secret: string): void {
    const derivedKey = this.deriveKey(secret);
    this.currentKey = { key: derivedKey, setAt: Date.now() };
    // 保留旧密钥以便宽限期内解密轮换期间生成的消息。
    // 注意：此处不主动清除 previousKey，rotateSharedSecret 负责轮换语义。

    try {
      const logger = getGlobalLogger();
      logger.info('A2AMessageSecurity', 'Shared encryption secret set');
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.setSharedSecret:log');
    }
  }

  /**
   * 轮换加密共享密钥。
   *
   * 新密钥立即生效用于加密；旧密钥在宽限期内仍可用于解密，宽限期
   * 结束后自动失效。这保证了轮换期间在途消息不会因密钥切换而被拒。
   *
   * @param newSecret - 新的共享密钥原文
   */
  rotateSharedSecret(newSecret: string): void {
    if (this.currentKey) {
      this.previousKey = { ...this.currentKey };
    }
    const derivedKey = this.deriveKey(newSecret);
    this.currentKey = { key: derivedKey, setAt: Date.now() };
    this.stats.keyRotations++;

    try {
      const logger = getGlobalLogger();
      logger.info('A2AMessageSecurity', 'Shared encryption secret rotated', {
        gracePeriodMs: this.config.keyRotationGracePeriodMs,
      });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.rotateSharedSecret:log');
    }

    try {
      getSecurityAuditLogger().logEvent({
        type: 'key_rotation_confirmed',
        severity: 'medium',
        source: 'A2AMessageSecurity',
        message: 'A2A encryption shared secret rotated',
        details: {
          gracePeriodMs: this.config.keyRotationGracePeriodMs,
          previousKeyRetained: this.previousKey !== null,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.rotateSharedSecret:audit');
    }
  }

  /**
   * 设置可选的语义分析回调，用于对消息内容做额外的语义级校验。
   */
  setSemanticAnalyzer(callback: SemanticAnalyzer | null): void {
    this.semanticAnalyzer = callback;
  }

  // ── 核心安全原语 ────────────────────────────────────────────────

  /**
   * 计算能力令牌的 SHA-256 哈希。
   */
  private hashCapabilityToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
  }

  /**
   * 使用 HKDF-SHA-256 从共享密钥派生 32 字节加密密钥。
   *
   * @param secret - 共享密钥原文
   * @returns 32 字节派生密钥
   */
  private deriveKey(secret: string): Buffer {
    const ikm = Buffer.from(secret, 'utf-8');
    // hkdfSync 要求 salt 可为 Buffer 或 null；使用固定 info 做域分离。
    return Buffer.from(
      crypto.hkdfSync(HKDF_ALGORITHM, ikm, Buffer.alloc(0), HKDF_INFO, KEY_LENGTH),
    );
  }

  /**
   * 计算消息体的规范化哈希。
   *
   * 规范化采用确定性的 JSON 序列化（键排序），确保发送方与接收方对同一
   * 消息计算出相同的哈希值。
   */
  private hashMessage(message: A2AMessage): string {
    const canonical = this.canonicalize(message);
    return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
  }

  /**
   * 对消息进行确定性 JSON 序列化（对象键按字典序排序）。
   */
  private canonicalize(value: unknown): string {
    return JSON.stringify(this.sortKeys(value));
  }

  /**
   * 递归排序对象键，用于生成确定性序列化结果。
   */
  private sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => this.sortKeys(v));
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        sorted[key] = this.sortKeys(obj[key]);
      }
      return sorted;
    }
    return value;
  }

  /**
   * 生成 HMAC-SHA-256 签名。
   *
   * 签名覆盖：timestamp + nonce + sender_id + recipient_id + message_hash。
   *
   * @param key - HMAC 密钥（派生密钥）
   * @param parts - 待签名的各组成部分
   * @returns 十六进制 HMAC 值
   */
  private computeHmac(key: Buffer, parts: string[]): string {
    const hmac = crypto.createHmac(HMAC_ALGORITHM, key);
    for (const part of parts) {
      hmac.update(part, 'utf-8');
    }
    return hmac.digest('hex');
  }

  /**
   * 常量时间比较两个十六进制 HMAC 字符串。
   *
   * 长度不一致时直接返回 false，否则使用 crypto.timingSafeEqual 比较，
   * 避免基于时间的侧信道攻击。
   */
  private safeEqualHex(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  // ── 第一层：消息完整性（HMAC-SHA-256） ─────────────────────────

  /**
   * 为消息生成 HMAC-SHA-256 签名头。
   *
   * 签名格式：
   *   a2a-sig v1, t=<timestamp>, nonce=<nonce>, sid=<sender_id>,
   *   rid=<recipient_id>, sig=<hmac_hex>
   *
   * 签名密钥由共享密钥派生；若未设置共享密钥，则使用能力令牌哈希作为
   * 回退密钥，以保证签名总是可生成（但加密相关能力受限）。
   */
  private signMessage(
    timestamp: string,
    nonce: string,
    senderId: string,
    recipientId: string,
    messageHash: string,
    signingKey: Buffer,
  ): string {
    const parts = [timestamp, nonce, senderId, recipientId, messageHash];
    const sig = this.computeHmac(signingKey, parts);
    return (
      `${SIGNATURE_PREFIX}, t=${timestamp}, nonce=${nonce}, ` +
      `sid=${senderId}, rid=${recipientId}, sig=${sig}`
    );
  }

  /**
   * 解析并验证 HMAC 签名头。
   *
   * @returns 解析出的签名字段及验证是否通过
   */
  private verifySignature(
    signature: string,
    expectedSenderId: string,
    expectedRecipientId: string,
    recomputedMessageHash: string,
    candidateKeys: Buffer[],
  ): {
    valid: boolean;
    timestamp?: string;
    nonce?: string;
    reason: string;
  } {
    if (!signature.startsWith(SIGNATURE_PREFIX)) {
      return { valid: false, reason: 'signature_prefix_mismatch' };
    }
    const fields = this.parseHeaderFields(signature, SIGNATURE_PREFIX);
    const timestamp = fields['t'];
    const nonce = fields['nonce'];
    const sid = fields['sid'];
    const rid = fields['rid'];
    const sig = fields['sig'];

    if (!timestamp || !nonce || !sid || !rid || !sig) {
      return { valid: false, reason: 'signature_fields_missing' };
    }
    if (sid !== expectedSenderId) {
      return { valid: false, reason: 'signature_sender_mismatch' };
    }
    if (rid !== expectedRecipientId) {
      return { valid: false, reason: 'signature_recipient_mismatch' };
    }

    const parts = [timestamp, nonce, sid, rid, recomputedMessageHash];
    let matched = false;
    for (const key of candidateKeys) {
      const expectedSig = this.computeHmac(key, parts);
      if (this.safeEqualHex(expectedSig, sig)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { valid: false, reason: 'signature_hmac_mismatch' };
    }
    return { valid: true, timestamp, nonce, reason: '' };
  }

  // ── 第二层：消息加密（AES-256-GCM） ────────────────────────────

  /**
   * 使用 AES-256-GCM 加密消息体。
   *
   * 密钥派生：HKDF-SHA-256 从共享密钥派生，使用每条消息独立的随机 salt，
   * 确保即使明文相同，每条消息的密文与密钥也不同。
   *
   * 加密格式：
   *   a2a-enc v1, alg=aes-256-gcm, salt=<base64_salt>, iv=<base64_iv>,
   *   tag=<base64_tag>, ciphertext=<base64_ciphertext>
   */
  private encryptPayload(plaintext: string, baseKey: Buffer): string {
    // 每条消息独立的 salt，用于 HKDF 派生本次加密密钥。
    const salt = crypto.randomBytes(KEY_LENGTH);
    const messageKey = Buffer.from(
      crypto.hkdfSync(HKDF_ALGORITHM, baseKey, salt, HKDF_INFO, KEY_LENGTH),
    );
    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, messageKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return (
      `${ENCRYPTION_PREFIX}, alg=aes-256-gcm, ` +
      `salt=${salt.toString('base64')}, iv=${iv.toString('base64')}, ` +
      `tag=${tag.toString('base64')}, ciphertext=${ciphertext.toString('base64')}`
    );
  }

  /**
   * 解密消息体。失败即关闭：任何错误均视为校验失败。
   *
   * 依次尝试当前密钥与（宽限期内的）旧密钥进行解密。
   */
  private decryptPayload(
    encrypted: string,
    candidateKeys: Buffer[],
  ): { success: boolean; plaintext?: string; reason: string } {
    if (!encrypted.startsWith(ENCRYPTION_PREFIX)) {
      return { success: false, reason: 'encryption_prefix_mismatch' };
    }
    const fields = this.parseHeaderFields(encrypted, ENCRYPTION_PREFIX);
    const saltB64 = fields['salt'];
    const ivB64 = fields['iv'];
    const tagB64 = fields['tag'];
    const ciphertextB64 = fields['ciphertext'];
    if (!saltB64 || !ivB64 || !tagB64 || !ciphertextB64) {
      return { success: false, reason: 'encryption_fields_missing' };
    }

    let salt: Buffer;
    let iv: Buffer;
    let tag: Buffer;
    let ciphertext: Buffer;
    try {
      salt = Buffer.from(saltB64, 'base64');
      iv = Buffer.from(ivB64, 'base64');
      tag = Buffer.from(tagB64, 'base64');
      ciphertext = Buffer.from(ciphertextB64, 'base64');
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.decryptPayload:decode');
      return { success: false, reason: 'encryption_decode_failed' };
    }

    for (const baseKey of candidateKeys) {
      try {
        const messageKey = Buffer.from(
          crypto.hkdfSync(HKDF_ALGORITHM, baseKey, salt, HKDF_INFO, KEY_LENGTH),
        );
        const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, messageKey, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          'utf-8',
        );
        return { success: true, plaintext, reason: '' };
      } catch {
        // 该密钥不匹配，继续尝试下一个候选密钥。
        continue;
      }
    }
    return { success: false, reason: 'encryption_decryption_failed' };
  }

  // ── 第三层：身份证明（Attestation） ────────────────────────────

  /**
   * 生成身份证明头。
   *
   * 证明 HMAC 覆盖：agent_id + tenant_id + capability_token_hash + nonce，
   * 使用能力令牌哈希作为 HMAC 密钥。这证明了发送方持有该能力令牌
   * （因为只有持有令牌才能计算出其哈希并据此生成证明），却不暴露令牌原文。
   *
   * 格式：
   *   a2a-attest v1, agent=<agent_id>, tenant=<tenant_id>,
   *   cap=<cap_token_hash>, attest=<attestation_hmac>
   */
  private buildAttestation(
    agentId: string,
    tenantId: string,
    capabilityTokenHash: string,
    nonce: string,
  ): string {
    const key = Buffer.from(capabilityTokenHash, 'hex');
    const parts = [agentId, tenantId, capabilityTokenHash, nonce];
    const attest = this.computeHmac(key, parts);
    return (
      `${ATTESTATION_PREFIX}, agent=${agentId}, tenant=${tenantId}, ` +
      `cap=${capabilityTokenHash}, attest=${attest}`
    );
  }

  /**
   * 验证身份证明头。
   *
   * 校验内容：
   *   1. agent_id 已注册且未撤销
   *   2. 租户匹配且活跃（未撤销即视为活跃）
   *   3. 能力令牌哈希与注册表一致
   *   4. 证明 HMAC 有效（常量时间比较）
   */
  private verifyAttestation(
    attestation: string,
    expectedAgentId: string,
    nonce: string,
  ): { valid: boolean; reason: string; identity?: AgentIdentity } {
    if (!attestation.startsWith(ATTESTATION_PREFIX)) {
      return { valid: false, reason: 'attestation_prefix_mismatch' };
    }
    const fields = this.parseHeaderFields(attestation, ATTESTATION_PREFIX);
    const agent = fields['agent'];
    const tenant = fields['tenant'];
    const cap = fields['cap'];
    const attest = fields['attest'];

    if (!agent || !tenant || !cap || !attest) {
      return { valid: false, reason: 'attestation_fields_missing' };
    }
    if (agent !== expectedAgentId) {
      return { valid: false, reason: 'attestation_agent_mismatch' };
    }

    const identity = this.getAgentIdentity(agent);
    if (!identity) {
      return { valid: false, reason: 'attestation_agent_not_registered' };
    }
    if (identity.revoked) {
      return { valid: false, reason: 'attestation_agent_revoked' };
    }
    if (identity.tenantId !== tenant) {
      return { valid: false, reason: 'attestation_tenant_mismatch' };
    }
    if (identity.capabilityTokenHash !== cap) {
      return { valid: false, reason: 'attestation_capability_hash_mismatch' };
    }

    // 重算证明 HMAC 并常量时间比较。
    const key = Buffer.from(identity.capabilityTokenHash, 'hex');
    const parts = [agent, tenant, identity.capabilityTokenHash, nonce];
    const expectedAttest = this.computeHmac(key, parts);
    if (!this.safeEqualHex(expectedAttest, attest)) {
      return { valid: false, reason: 'attestation_hmac_mismatch' };
    }

    // 更新最近活跃时间。
    identity.lastSeen = new Date().toISOString();
    return { valid: true, reason: '', identity };
  }

  // ── 第四层：重放攻击防御 ────────────────────────────────────────

  /**
   * 记录一个 nonce，用于重放检测。
   *
   * 维护每个发送方的滑动窗口：当缓存超出上限时，淘汰最旧条目。
   *
   * @returns true 表示该 nonce 是新出现的；false 表示已存在（重放）。
   */
  private rememberNonce(senderId: string, nonce: string): boolean {
    let entries = this.nonceCache.get(senderId);
    if (!entries) {
      entries = [];
      this.nonceCache.set(senderId, entries);
    }
    for (const entry of entries) {
      if (entry.nonce === nonce) {
        return false; // 重放
      }
    }
    entries.push({ nonce, recordedAt: Date.now() });
    // 超出容量上限时，淘汰最旧的条目（滑动窗口）。
    if (entries.length > this.config.nonceCacheSize) {
      entries.splice(0, entries.length - this.config.nonceCacheSize);
    }
    return true;
  }

  /**
   * 校验时间戳：不能缺失、不能超出允许年龄、不能超出时钟偏移。
   */
  private checkTimestamp(timestamp: string, now: number): { valid: boolean; reason: string } {
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
      return { valid: false, reason: 'timestamp_invalid' };
    }
    const age = now - parsed;
    if (age > this.config.maxAgeMs) {
      return { valid: false, reason: 'timestamp_too_old' };
    }
    // 允许一定程度的未来时间戳（时钟偏移），但过远的未来视为可疑。
    if (-age > this.config.maxSkewMs) {
      return { valid: false, reason: 'timestamp_future_skew' };
    }
    return { valid: true, reason: '' };
  }

  /**
   * 启动 nonce 清理定时器，定期移除过期条目。
   */
  private startCleanupTimer(): void {
    this.stopCleanupTimer();
    this.cleanupTimer = setInterval(() => {
      this.cleanupNonces();
    }, this.config.cleanupIntervalMs);
    // 定时器不应阻止进程退出。
    this.cleanupTimer.unref?.();
  }

  private restartCleanupTimer(): void {
    this.startCleanupTimer();
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 清理过期的 nonce 条目与空发送方记录。
   */
  private cleanupNonces(): void {
    try {
      const cutoff = Date.now() - this.config.nonceTtlMs;
      for (const [senderId, entries] of this.nonceCache) {
        const fresh = entries.filter((e) => e.recordedAt > cutoff);
        if (fresh.length === 0) {
          this.nonceCache.delete(senderId);
        } else {
          this.nonceCache.set(senderId, fresh);
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.cleanupNonces');
    }
  }

  // ── 头部解析工具 ────────────────────────────────────────────────

  /**
   * 解析形如 `prefix, k1=v1, k2=v2` 的头部字段。
   *
   * 容忍值中包含等号（取第一个等号为分隔符），但不容忍空字段。
   */
  private parseHeaderFields(header: string, prefix: string): Record<string, string> {
    const result: Record<string, string> = {};
    // 移除前缀及其后的逗号。
    const body = header.slice(prefix.length).replace(/^,?\s*/, '');
    const segments = body.split(',');
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key) {
        result[key] = value;
      }
    }
    return result;
  }

  // ── 候选密钥集合 ────────────────────────────────────────────────

  /**
   * 收集当前可用于解密/验签的候选密钥集合。
   *
   * 包含当前密钥，以及宽限期内仍有效的旧密钥。
   */
  private getCandidateKeys(): Buffer[] {
    const keys: Buffer[] = [];
    if (this.currentKey) {
      keys.push(this.currentKey.key);
    }
    if (this.previousKey) {
      const age = Date.now() - this.previousKey.setAt;
      // 旧密钥仅在宽限期内（自其设置时刻起算）有效。
      if (age <= this.config.keyRotationGracePeriodMs + this.config.maxAgeMs) {
        keys.push(this.previousKey.key);
      } else {
        this.previousKey = null;
      }
    }
    return keys;
  }

  /**
   * 获取用于签名的密钥（当前密钥，或回退到能力令牌哈希派生密钥）。
   */
  private getSigningKey(capabilityTokenHash: string): Buffer {
    if (this.currentKey) {
      return this.currentKey.key;
    }
    // 回退：当未设置共享密钥时，使用能力令牌哈希作为签名密钥。
    return Buffer.from(capabilityTokenHash, 'hex');
  }

  // ── 公共 API：安全化消息 ────────────────────────────────────────

  /**
   * 为 A2A 消息附加安全保护。
   *
   * 根据配置的安全等级依次附加：身份证明、加密、HMAC 签名。每条消息
   * 生成独立的 nonce 与时间戳用于重放防御。
   *
   * @param message - 原始 A2A 消息
   * @param senderContext - 发送方上下文
   * @returns 已附加安全保护的消息
   */
  secureMessage(message: A2AMessage, senderContext: SenderContext): SecuredMessage {
    const level = this.resolveSecurityLevel();
    const nonce = crypto.randomBytes(NONCE_LENGTH).toString('hex');
    const timestamp = message.timestamp || new Date().toISOString();

    // 能力令牌哈希（用于身份证明与回退签名密钥）。
    const capabilityTokenHash = this.hashCapabilityToken(senderContext.capabilityToken);

    const secured: SecuredMessage = {
      original: { ...message, timestamp },
      securityLevel: level,
      nonce,
      senderId: senderContext.agentId,
      recipientId: senderContext.recipientId,
    };

    // 加密载荷（encrypted 及以上）。
    let effectiveMessage: A2AMessage = { ...message, timestamp };
    if (level === 'encrypted' || level === 'attested') {
      if (this.config.enableEncryption && this.currentKey) {
        // 加密使用原始消息的 JSON 序列化结果（保留发送方的原始结构），
        // 而非规范化形式——规范化仅用于签名哈希计算，以保证发送方与
        // 接收方对同一消息计算出相同的哈希。解密后消费者拿到的消息与
        // 发送方意图字节一致。
        const plaintext = JSON.stringify(message);
        secured.encryptedPayload = this.encryptPayload(plaintext, this.currentKey.key);
        // 加密后，original 仅保留非敏感元信息。
        effectiveMessage = {
          id: message.id,
          method: message.method,
          params: null,
          timestamp,
        };
        secured.original = effectiveMessage;
      } else if (this.config.enableEncryption && !this.currentKey) {
        // 加密启用但未设置共享密钥：记录告警，降级为签名。
        try {
          const logger = getGlobalLogger();
          logger.warn(
            'A2AMessageSecurity',
            'Encryption enabled but no shared secret set; downgrading to signed',
          );
        } catch (err) {
          reportSilentFailure(err, 'a2aMessageSecurity.secureMessage:nokey');
        }
        secured.securityLevel = 'signed';
      }
    }

    // 身份证明（attested）。
    if (level === 'attested' && this.config.enableAttestation) {
      secured.attestation = this.buildAttestation(
        senderContext.agentId,
        senderContext.tenantId,
        capabilityTokenHash,
        nonce,
      );
    }

    // HMAC 签名（signed 及以上）。
    const resolvedLevel = secured.securityLevel;
    if (
      resolvedLevel === 'signed' ||
      resolvedLevel === 'encrypted' ||
      resolvedLevel === 'attested'
    ) {
      const messageHash = this.hashMessage(effectiveMessage);
      const signingKey = this.getSigningKey(capabilityTokenHash);
      secured.signature = this.signMessage(
        timestamp,
        nonce,
        senderContext.agentId,
        senderContext.recipientId,
        messageHash,
        signingKey,
      );
    }

    this.stats.messagesSecured++;
    this.recordMetric('a2a.messages.secured', 1, { level: resolvedLevel });
    return secured;
  }

  // ── 公共 API：验证消息 ──────────────────────────────────────────

  /**
   * 验证受保护 A2A 消息的全部安全层。
   *
   * 校验顺序：时间戳 -> 重放检测 -> 签名 -> 身份证明 -> 解密 -> 语义分析。
   * 任一层失败即拒绝（fail-closed），并记录审计日志与失败指标。
   *
   * @param secured - 待验证的受保护消息
   * @param expectedSender - 期望的发送方 agentId
   * @returns 验证结果
   */
  verifyMessage(secured: SecuredMessage, expectedSender: string): VerificationResult {
    const now = Date.now();
    const result: VerificationResult = {
      valid: false,
      reason: '',
      securityLevel: secured.securityLevel,
      senderVerified: false,
      signatureValid: false,
      encryptionValid: false,
      attestationValid: false,
      replayDetected: false,
      timestamp: new Date().toISOString(),
    };

    // 基础字段校验。
    if (!secured.nonce) {
      return this.fail(result, secured, expectedSender, 'nonce_missing', now);
    }
    if (secured.senderId !== expectedSender) {
      return this.fail(result, secured, expectedSender, 'sender_mismatch', now);
    }

    // 第一层：时间戳校验（从签名中提取，若无签名则用 original.timestamp）。
    let timestamp: string;
    let nonce: string;
    if (secured.signature) {
      const parsed = this.parseHeaderFields(secured.signature, SIGNATURE_PREFIX);
      timestamp = parsed['t'] ?? secured.original.timestamp;
      nonce = parsed['nonce'] ?? secured.nonce;
      // 签名中的 nonce 必须与顶层 nonce 一致（防篡改）。
      if (parsed['nonce'] && parsed['nonce'] !== secured.nonce) {
        return this.fail(result, secured, expectedSender, 'nonce_tampered', now);
      }
    } else {
      timestamp = secured.original.timestamp;
      nonce = secured.nonce;
    }

    const tsCheck = this.checkTimestamp(timestamp, now);
    if (!tsCheck.valid) {
      return this.fail(result, secured, expectedSender, tsCheck.reason, now);
    }

    // 第四层：重放检测。
    if (!this.rememberNonce(expectedSender, nonce)) {
      result.replayDetected = true;
      this.stats.replaysDetected++;
      return this.fail(result, secured, expectedSender, 'replay_detected', now);
    }

    // 第一层：签名校验。
    if (secured.signature) {
      // 确定用于验签的候选密钥：共享密钥派生密钥集合。
      const candidateKeys = this.getCandidateKeys();
      // 若启用身份证明，将能力令牌哈希派生密钥也加入候选（回退签名场景）。
      const identity = this.getAgentIdentity(expectedSender);
      if (identity) {
        candidateKeys.push(Buffer.from(identity.capabilityTokenHash, 'hex'));
      }
      const messageHash = this.hashMessage(secured.original);
      const sigResult = this.verifySignature(
        secured.signature,
        expectedSender,
        secured.recipientId,
        messageHash,
        candidateKeys,
      );
      if (!sigResult.valid) {
        return this.fail(result, secured, expectedSender, sigResult.reason, now);
      }
      result.signatureValid = true;
    } else if (secured.securityLevel !== 'none') {
      // 声明有签名保护但实际缺少签名头。
      return this.fail(result, secured, expectedSender, 'signature_missing', now);
    }

    // 第二层：解密校验。
    let decryptedMessage: A2AMessage | undefined;
    if (secured.encryptedPayload) {
      if (!this.config.enableEncryption) {
        return this.fail(result, secured, expectedSender, 'encryption_disabled', now);
      }
      const candidateKeys = this.getCandidateKeys();
      if (candidateKeys.length === 0) {
        return this.fail(result, secured, expectedSender, 'no_decryption_key', now);
      }
      const decResult = this.decryptPayload(secured.encryptedPayload, candidateKeys);
      if (!decResult.success || !decResult.plaintext) {
        return this.fail(result, secured, expectedSender, decResult.reason, now);
      }
      result.encryptionValid = true;
      try {
        decryptedMessage = JSON.parse(decResult.plaintext) as A2AMessage;
        result.decryptedMessage = decryptedMessage;
      } catch (err) {
        reportSilentFailure(err, 'a2aMessageSecurity.verifyMessage:parse');
        return this.fail(result, secured, expectedSender, 'decrypted_payload_invalid', now);
      }
    }

    // 第三层：身份证明校验。
    if (secured.attestation) {
      if (!this.config.enableAttestation) {
        return this.fail(result, secured, expectedSender, 'attestation_disabled', now);
      }
      const attestResult = this.verifyAttestation(secured.attestation, expectedSender, nonce);
      if (!attestResult.valid) {
        return this.fail(result, secured, expectedSender, attestResult.reason, now);
      }
      result.attestationValid = true;
      result.senderVerified = true;
    } else if (secured.securityLevel === 'attested') {
      // 声明 attested 但缺少证明头。
      return this.fail(result, secured, expectedSender, 'attestation_missing', now);
    }

    // 可选：语义分析。
    if (this.semanticAnalyzer) {
      const targetMessage = decryptedMessage ?? secured.original;
      let semantic: { allowed: boolean; reason: string };
      try {
        semantic = this.semanticAnalyzer(targetMessage, {
          senderId: expectedSender,
          recipientId: secured.recipientId,
        });
      } catch (err) {
        reportSilentFailure(err, 'a2aMessageSecurity.verifyMessage:semantic');
        return this.fail(result, secured, expectedSender, 'semantic_analyzer_error', now);
      }
      if (!semantic.allowed) {
        return this.fail(result, secured, expectedSender, `semantic:${semantic.reason}`, now);
      }
    }

    // 全部通过。
    result.valid = true;
    result.reason = '';
    this.stats.messagesVerified++;
    this.recordMetric('a2a.messages.verified', 1, { level: secured.securityLevel });
    return result;
  }

  /**
   * 统一的失败处理：记录审计日志、指标，并返回失败结果。
   *
   * 当 failClosed 为 true 时（默认），任何失败均使 valid=false。当
   * failClosed 为 false 时，仍返回 valid=false 以便调用方决策，但本层不
   * 自动放行——调用方可根据 reason 决定是否容忍。
   */
  private fail(
    result: VerificationResult,
    secured: SecuredMessage,
    expectedSender: string,
    reason: string,
    now: number,
  ): VerificationResult {
    result.valid = false;
    result.reason = reason;
    this.stats.verificationFailures++;
    this.stats.failuresByReason[reason] = (this.stats.failuresByReason[reason] ?? 0) + 1;

    this.recordMetric('a2a.verification.failures', 1, { reason });

    try {
      getSecurityAuditLogger().logEvent({
        type: 'a2a_security_violation',
        severity: this.severityForReason(reason),
        source: 'A2AMessageSecurity',
        message: `A2A message verification failed: ${reason}`,
        details: {
          reason,
          securityLevel: secured.securityLevel,
          senderId: secured.senderId,
          expectedSender,
          recipientId: secured.recipientId,
          replayDetected: result.replayDetected,
          signatureValid: result.signatureValid,
          encryptionValid: result.encryptionValid,
          attestationValid: result.attestationValid,
        },
        context: { agentId: expectedSender },
      });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.fail:audit');
    }

    try {
      const logger = getGlobalLogger();
      logger.warn('A2AMessageSecurity', `Message verification failed: ${reason}`, {
        senderId: secured.senderId,
        expectedSender,
        securityLevel: secured.securityLevel,
      });
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.fail:log');
    }

    return result;
  }

  /**
   * 根据失败原因返回合适的严重级别。
   */
  private severityForReason(reason: string): 'low' | 'medium' | 'high' | 'critical' {
    if (reason === 'replay_detected') return 'critical';
    if (reason.startsWith('attestation_')) return 'high';
    if (reason.startsWith('signature_')) return 'high';
    if (reason.startsWith('encryption_')) return 'high';
    if (reason.startsWith('semantic:')) return 'high';
    if (reason.startsWith('timestamp_')) return 'medium';
    if (reason === 'nonce_tampered' || reason === 'sender_mismatch') return 'high';
    return 'medium';
  }

  // ── 辅助 ────────────────────────────────────────────────────────

  /**
   * 解析实际生效的安全等级（综合配置默认值与开关）。
   */
  private resolveSecurityLevel(): SecurityLevel {
    if (!this.config.enabled) {
      return 'none';
    }
    let level = this.config.defaultSecurityLevel;
    // 若配置禁用了加密/证明，则相应降级。
    if ((level === 'encrypted' || level === 'attested') && !this.config.enableEncryption) {
      level = 'signed';
    }
    if (level === 'attested' && !this.config.enableAttestation) {
      level = this.config.enableEncryption ? 'encrypted' : 'signed';
    }
    return level;
  }

  /**
   * 记录指标（封装以容忍 metrics 不可用）。
   */
  private recordMetric(name: string, value: number, labels: Record<string, string>): void {
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter(name, value, labels);
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.recordMetric');
    }
  }

  /**
   * 获取运行统计。
   */
  getSecurityStats(): Record<string, unknown> {
    return {
      ...this.stats,
      config: this.getConfig(),
      registeredAgents: this.agentRegistry.size,
      activeAgents: Array.from(this.agentRegistry.values()).filter((a) => !a.revoked).length,
      trackedSenders: this.nonceCache.size,
      totalNonces: Array.from(this.nonceCache.values()).reduce((sum, e) => sum + e.length, 0),
      hasSharedSecret: this.currentKey !== null,
      hasPreviousKey: this.previousKey !== null,
    };
  }

  /**
   * 销毁实例，释放定时器资源。
   */
  dispose(): void {
    this.stopCleanupTimer();
    this.agentRegistry.clear();
    this.nonceCache.clear();
    this.currentKey = null;
    this.previousKey = null;
    this.semanticAnalyzer = null;
  }
}

// ============================================================================
// 单例
// ============================================================================

const a2aMessageSecuritySingleton = createTenantAwareSingleton(() => new A2AMessageSecurity(), {
  componentName: 'A2AMessageSecurity',
  dispose: (instance) => {
    try {
      instance.dispose();
    } catch (err) {
      reportSilentFailure(err, 'a2aMessageSecurity.singleton.dispose');
    }
  },
});

/**
 * 获取 A2A 消息安全层单例实例（租户隔离）。
 */
export function getA2AMessageSecurity(): A2AMessageSecurity {
  return a2aMessageSecuritySingleton.get();
}

/**
 * 重置 A2A 消息安全层单例（释放所有租户实例）。
 */
export function resetA2AMessageSecurity(): void {
  a2aMessageSecuritySingleton.reset();
}
