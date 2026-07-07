/**
 * EncryptedSecretsVault — 加密密钥保险库。
 *
 * 为 Commander 提供一个在内存中以加密形式存储密钥（secrets）的保险库。
 * 所有密钥在写入内存前即被加密，仅在显式读取时才进行解密，最大程度
 * 减少明文密钥在进程内存中的驻留时间。
 *
 * 安全特性：
 *   - AES-256-GCM 加密（提供机密性 + 完整性 + 认证）
 *   - HKDF-SHA-256 从主密钥派生每密钥加密密钥（NIST SP 800-56C）
 *   - 每条密钥版本使用独立的随机 salt 与 IV，防止密文关联
 *   - 密钥轮换：生成新版本，旧版本仍可解密（向后兼容）
 *   - 密钥导出/导入：加密包格式，主密钥不包含在导出中
 *   - 访问审计：每次解密操作记录到 SecurityAuditLogger
 *   - 多租户隔离：通过 createTenantAwareSingleton 实现租户级隔离
 *
 * 主密钥来源：
 *   - 优先从环境变量 COMMANDER_MASTER_KEY 读取（>= 32 字符）
 *   - 非生产环境下若未设置则自动生成并发出警告
 *   - 生产环境下若未设置则拒绝启动（与 auditChainLedger / capabilityToken
 *     保持一致的 fail-fast 契约）
 *
 * 使用示例：
 *   ```ts
 *   import { getEncryptedSecretsVault } from './security/encryptedSecretsVault';
 *
 *   const vault = getEncryptedSecretsVault();
 *   vault.setSecret('OPENAI_API_KEY', 'sk-xxxx');
 *   const key = vault.getSecret('OPENAI_API_KEY'); // 解密并返回
 *   vault.rotateSecret('OPENAI_API_KEY', 'sk-yyyy'); // 轮换为新值
 *   ```
 *
 * 标准参考：
 *   - NIST SP 800-38D (GCM 模式)
 *   - NIST SP 800-56C Rev.2 (HKDF 密钥派生)
 *   - RFC 5869 (HMAC-based Extract-and-Expand Key Derivation)
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getGlobalLogger } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import * as crypto from 'node:crypto';

// ============================================================================
// 常量
// ============================================================================

/** 主密钥环境变量名。 */
const MASTER_KEY_ENV = 'COMMANDER_MASTER_KEY';

/** 主密钥最小长度（字节）。AES-256 需要 256-bit = 32 字节密钥。 */
const MASTER_KEY_MIN_LENGTH = 32;

/** HKDF 派生的加密密钥长度（字节）。AES-256 → 32 字节。 */
const DERIVED_KEY_LENGTH = 32;

/** AES-256-GCM 的 IV（Nonce）长度（字节）。GCM 标准推荐 12 字节。 */
const GCM_IV_LENGTH = 12;

/** HKDF salt 长度（字节）。 */
const SALT_LENGTH = 32;

/** 每条密钥默认保留的最大历史版本数。 */
const DEFAULT_MAX_VERSIONS = 10;

/** 导出包格式标识。 */
const EXPORT_FORMAT = 'commander-encrypted-secrets-vault';

/** 导出包格式版本。 */
const EXPORT_VERSION = 1;

/** 审计日志来源标识。 */
const AUDIT_SOURCE = 'EncryptedSecretsVault';

// ============================================================================
// 类型与接口
// ============================================================================

/**
 * 密钥元数据。
 *
 * 描述一条已存储密钥的非敏感信息。元数据本身不加密，
 * 仅用于索引、审计和版本管理。
 */
export interface SecretMetadata {
  /** 密钥名称（唯一标识符，如 'OPENAI_API_KEY'）。 */
  name: string;
  /** 密钥版本号，从 1 开始递增。 */
  version: number;
  /** 密钥创建时间（ISO 8601 格式）。 */
  createdAt: string;
  /** 最近一次轮换时间（ISO 8601 格式），未轮换过则为 null。 */
  rotatedAt: string | null;
  /** 该版本被解密访问的累计次数。 */
  accessCount: number;
}

/**
 * 已存储的密钥（加密形态）。
 *
 * 包含密文及解密所需的全部密码学参数。明文绝不在此结构中出现。
 * 每条密钥版本对应一个独立的 StoredSecret 实例。
 */
export interface StoredSecret {
  /** 密钥元数据（非敏感）。 */
  metadata: SecretMetadata;
  /** 密文（十六进制编码）。 */
  ciphertext: string;
  /** 初始化向量 / Nonce（十六进制编码，12 字节）。 */
  iv: string;
  /** GCM 认证标签（十六进制编码，16 字节）。 */
  authTag: string;
  /** HKDF 密钥派生 salt（十六进制编码，32 字节）。 */
  keyDerivationSalt: string;
}

/**
 * 保险库配置。
 */
export interface VaultConfig {
  /**
   * 显式指定主密钥。若未提供则从环境变量 COMMANDER_MASTER_KEY 解析，
   * 或在非生产环境下自动生成。
   */
  masterKey?: Buffer;
  /** 每条密钥保留的最大历史版本数，超出后自动淘汰最旧版本。默认 10。 */
  maxVersionsPerSecret?: number;
}

/**
 * 保险库导出包（加密格式）。
 *
 * 导出包中所有密钥仍以加密形态存在，主密钥不包含在内。
 * 导入方必须拥有相同的主密钥才能解密。
 */
export interface VaultExportBundle {
  /** 格式标识，固定为 'commander-encrypted-secrets-vault'。 */
  format: string;
  /** 格式版本号。 */
  version: number;
  /** 导出时间（ISO 8601 格式）。 */
  exportedAt: string;
  /** 密钥名称到其全部版本数组的映射。 */
  secrets: Record<string, StoredSecret[]>;
}

/**
 * 保险库统计信息。
 */
export interface VaultStats {
  /** 已存储的密钥名称总数。 */
  totalSecrets: number;
  /** 所有密钥的版本总数（含历史版本）。 */
  totalVersions: number;
  /** 所有密钥的累计解密访问次数。 */
  totalAccessCount: number;
  /** 每条密钥的摘要信息（仅元数据，不含密文）。 */
  secrets: SecretMetadata[];
}

// ============================================================================
// 主密钥解析
// ============================================================================

/**
 * 从环境变量解析主密钥。
 *
 * 解析优先级：
 *   1. 环境变量 COMMANDER_MASTER_KEY（>= 32 字符）
 *   2. 非生产环境：自动生成 32 字节随机密钥并发出警告
 *   3. 生产环境：抛出错误，拒绝启动
 *
 * @param env - 环境变量对象，默认为 process.env
 * @returns 32 字节主密钥 Buffer
 * @throws {Error} 生产环境下未设置主密钥时抛出
 */
export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const v = env[MASTER_KEY_ENV];
  if (v && v.length >= MASTER_KEY_MIN_LENGTH) {
    return Buffer.from(v, 'utf-8');
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      `[EncryptedSecretsVault] ${MASTER_KEY_ENV} 必须在生产环境中设置（>= 32 字符）。` +
        '拒绝以弱密钥启动加密密钥保险库——存储的密钥将不具备密码学安全性。',
    );
  }

  // 非生产环境：自动生成临时密钥并发出警告
  const generatedKey = crypto.randomBytes(MASTER_KEY_MIN_LENGTH);
  const warning =
    `[EncryptedSecretsVault] 警告：${MASTER_KEY_ENV} 未设置（非生产环境）。` +
    '已自动生成临时主密钥。重启进程后所有已存储密钥将无法解密。' +
    '请在部署前设置环境变量以确保密钥持久化。\n';
  process.stderr.write(warning);
  return generatedKey;
}

// ============================================================================
// EncryptedSecretsVault
// ============================================================================

/**
 * 加密密钥保险库。
 *
 * 在内存中以 AES-256-GCM 加密形态存储密钥，仅在显式读取时解密。
 * 支持密钥的增删改查、版本轮换、加密导出/导入，以及访问审计。
 *
 * 线程安全：构造后主密钥不可变；Map 操作在单线程 Node.js 事件循环中安全。
 * 多租户：通过 createTenantAwareSingleton 工厂实现租户级实例隔离。
 */
export class EncryptedSecretsVault {
  /** 主密钥（用于 HKDF 派生，构造后不可变）。 */
  private readonly masterKey: Buffer;
  /** 密钥存储：名称 → 版本数组（升序，末尾为最新版本）。 */
  private readonly secrets: Map<string, StoredSecret[]> = new Map();
  /** 每条密钥保留的最大版本数。 */
  private readonly maxVersionsPerSecret: number;

  /**
   * 创建加密密钥保险库实例。
   *
   * @param config - 可选配置。若未提供 masterKey，则从环境变量解析或自动生成。
   */
  constructor(config?: VaultConfig) {
    this.masterKey = config?.masterKey ?? resolveMasterKey();
    this.maxVersionsPerSecret = config?.maxVersionsPerSecret ?? DEFAULT_MAX_VERSIONS;
  }

  // ── 密码学原语 ──────────────────────────────────────────────────

  /**
   * 使用 HKDF-SHA-256 从主密钥派生指定密钥的加密密钥。
   *
   * 派生过程遵循 RFC 5869：
   *   PRK = HKDF-Extract(salt, masterKey)
   *   OKM = HKDF-Expand(PRK, info, L)
   *
   * info 中包含密钥名称和版本号，确保不同密钥、不同版本之间
   * 的派生密钥相互独立（域分离 / domain separation）。
   *
   * @param name - 密钥名称
   * @param version - 密钥版本号
   * @param salt - 密钥派生 salt（每条密钥版本独立）
   * @returns 32 字节派生加密密钥
   */
  private deriveEncryptionKey(name: string, version: number, salt: Buffer): Buffer {
    const info = Buffer.from(`commander-secrets-vault|${name}|v${version}`, 'utf-8');
    return Buffer.from(crypto.hkdfSync('sha256', this.masterKey, salt, info, DERIVED_KEY_LENGTH));
  }

  /**
   * 使用 AES-256-GCM 加密明文。
   *
   * @param plaintext - 待加密的明文
   * @param key - 32 字节加密密钥
   * @returns 密文、IV 和认证标签（均为十六进制编码）
   */
  private encrypt(
    plaintext: string,
    key: Buffer,
  ): { ciphertext: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { ciphertext: encrypted, iv: iv.toString('hex'), authTag };
  }

  /**
   * 使用 AES-256-GCM 解密密文。
   *
   * @param stored - 已存储的加密密钥（包含密文、IV、认证标签和派生 salt）
   * @returns 解密后的明文
   * @throws {Error} 认证标签验证失败或密钥不匹配时抛出
   */
  private decrypt(stored: StoredSecret): string {
    const salt = Buffer.from(stored.keyDerivationSalt, 'hex');
    const key = this.deriveEncryptionKey(stored.metadata.name, stored.metadata.version, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(stored.authTag, 'hex'));
    let decrypted = decipher.update(stored.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // ── 审计日志 ────────────────────────────────────────────────────

  /**
   * 记录密钥访问审计日志。
   *
   * 每次解密操作（成功或失败）都会通过 SecurityAuditLogger 记录，
   * 确保密钥访问行为可追溯。
   *
   * @param name - 被访问的密钥名称
   * @param version - 被访问的版本号
   * @param success - 是否解密成功
   * @param reason - 失败原因（成功时为 undefined）
   */
  private logAccess(
    name: string,
    version: number | undefined,
    success: boolean,
    reason?: string,
  ): void {
    try {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'credential_access',
        severity: success ? 'low' : 'high',
        source: AUDIT_SOURCE,
        message: success
          ? `密钥解密访问: ${name}${version !== undefined ? ` (v${version})` : ''}`
          : `密钥解密失败: ${name}${version !== undefined ? ` (v${version})` : ''} — ${reason ?? '未知原因'}`,
        details: {
          vault: 'EncryptedSecretsVault',
          secretName: name,
          version,
          success,
          reason,
        },
      });
    } catch (err) {
      // 审计日志记录失败不应中断密钥访问流程
      reportSilentFailure(err, 'encryptedSecretsVault:logAccess');
    }
  }

  /**
   * 记录密钥管理操作审计日志（增删改、轮换、导出导入）。
   *
   * @param action - 操作类型描述
   * @param name - 相关密钥名称
   * @param details - 额外详情
   */
  private logManagement(
    action: string,
    name: string | undefined,
    details?: Record<string, unknown>,
  ): void {
    try {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'config_change',
        severity: 'medium',
        source: AUDIT_SOURCE,
        message: `密钥管理操作: ${action}${name ? ` — ${name}` : ''}`,
        details: {
          vault: 'EncryptedSecretsVault',
          action,
          secretName: name,
          ...details,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'encryptedSecretsVault:logManagement');
    }
  }

  // ── 内部辅助 ────────────────────────────────────────────────────

  /**
   * 获取指定密钥的最新版本（数组末尾元素）。
   *
   * @param name - 密钥名称
   * @returns 最新版本的 StoredSecret，若不存在则返回 undefined
   */
  private getLatestVersion(name: string): StoredSecret | undefined {
    const versions = this.secrets.get(name);
    if (!versions || versions.length === 0) return undefined;
    return versions[versions.length - 1];
  }

  /**
   * 获取指定密钥的指定版本。
   *
   * @param name - 密钥名称
   * @param version - 版本号
   * @returns 对应版本的 StoredSecret，若不存在则返回 undefined
   */
  private getVersion(name: string, version: number): StoredSecret | undefined {
    const versions = this.secrets.get(name);
    if (!versions) return undefined;
    return versions.find((s) => s.metadata.version === version);
  }

  /**
   * 对明文进行加密并构造 StoredSecret。
   *
   * @param name - 密钥名称
   * @param version - 版本号
   * @param plaintext - 明文
   * @param createdAt - 创建时间
   * @param rotatedAt - 轮换时间（首次创建时为 null）
   * @returns 完整的 StoredSecret
   */
  private buildStoredSecret(
    name: string,
    version: number,
    plaintext: string,
    createdAt: string,
    rotatedAt: string | null,
  ): StoredSecret {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = this.deriveEncryptionKey(name, version, salt);
    const { ciphertext, iv, authTag } = this.encrypt(plaintext, key);

    return {
      metadata: {
        name,
        version,
        createdAt,
        rotatedAt,
        accessCount: 0,
      },
      ciphertext,
      iv,
      authTag,
      keyDerivationSalt: salt.toString('hex'),
    };
  }

  /**
   * 裁剪密钥版本数组，保留最新的 maxVersionsPerSecret 个版本。
   *
   * @param name - 密钥名称
   */
  private trimVersions(name: string): void {
    const versions = this.secrets.get(name);
    if (!versions) return;
    if (versions.length > this.maxVersionsPerSecret) {
      const removed = versions.splice(0, versions.length - this.maxVersionsPerSecret);
      if (removed.length > 0) {
        try {
          getGlobalLogger().warn(
            AUDIT_SOURCE,
            `密钥 ${name} 版本数超出上限 ${this.maxVersionsPerSecret}，已淘汰 ${removed.length} 个最旧版本`,
          );
        } catch (err) {
          reportSilentFailure(err, 'encryptedSecretsVault:trimVersions');
        }
      }
    }
  }

  // ── 公共 API：增删改查 ──────────────────────────────────────────

  /**
   * 存储或更新一条密钥。
   *
   * 若密钥名称已存在，则创建新版本（版本号递增），旧版本保留并可解密。
   * 若密钥名称不存在，则创建版本 1。
   *
   * 明文在写入内存前即被加密，绝不以明文形态驻留。
   *
   * @param name - 密钥名称（唯一标识符）
   * @param plaintext - 密钥明文值
   * @returns 新创建版本的元数据
   */
  setSecret(name: string, plaintext: string): SecretMetadata {
    if (!name || typeof name !== 'string') {
      throw new Error('[EncryptedSecretsVault] 密钥名称不能为空');
    }
    if (plaintext === undefined || plaintext === null) {
      throw new Error('[EncryptedSecretsVault] 密钥明文不能为空');
    }

    const now = new Date().toISOString();
    const existing = this.secrets.get(name);
    const version =
      existing && existing.length > 0 ? existing[existing.length - 1]!.metadata.version + 1 : 1;
    const rotatedAt = version > 1 ? now : null;

    const stored = this.buildStoredSecret(name, version, plaintext, now, rotatedAt);

    if (!existing) {
      this.secrets.set(name, [stored]);
    } else {
      existing.push(stored);
      this.trimVersions(name);
    }

    this.logManagement('set', name, { version, isNew: version === 1 });

    try {
      getGlobalLogger().info(AUDIT_SOURCE, `密钥已存储: ${name} (v${version})`);
    } catch (err) {
      reportSilentFailure(err, 'encryptedSecretsVault:setSecret');
    }

    return { ...stored.metadata };
  }

  /**
   * 读取并解密一条密钥。
   *
   * 默认返回最新版本的明文。可指定 version 参数读取历史版本。
   * 每次调用都会：
   *   1. 递增对应版本的 accessCount
   *   2. 向 SecurityAuditLogger 记录访问审计日志
   *
   * 解密仅在调用时发生，明文返回后不在保险库中缓存。
   *
   * @param name - 密钥名称
   * @param version - 可选版本号，省略则读取最新版本
   * @returns 解密后的明文；密钥不存在时返回 null
   * @throws {Error} 解密失败（认证标签不匹配、密钥不匹配等）时抛出
   */
  getSecret(name: string, version?: number): string | null {
    const stored =
      version !== undefined ? this.getVersion(name, version) : this.getLatestVersion(name);

    if (!stored) {
      this.logAccess(name, version, false, '密钥或版本不存在');
      return null;
    }

    try {
      const plaintext = this.decrypt(stored);
      // 递增访问计数
      stored.metadata.accessCount++;
      // 记录审计日志
      this.logAccess(name, stored.metadata.version, true);
      return plaintext;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logAccess(name, stored.metadata.version, false, reason);
      throw new Error(
        `[EncryptedSecretsVault] 密钥 ${name} (v${stored.metadata.version}) 解密失败: ${reason}`,
      );
    }
  }

  /**
   * 检查密钥是否存在。
   *
   * @param name - 密钥名称
   * @returns 密钥存在则返回 true，否则返回 false
   */
  hasSecret(name: string): boolean {
    const versions = this.secrets.get(name);
    return !!versions && versions.length > 0;
  }

  /**
   * 删除一条密钥及其所有版本。
   *
   * 删除后密文从内存中移除，无法恢复。
   *
   * @param name - 密钥名称
   * @returns 删除成功返回 true，密钥不存在返回 false
   */
  deleteSecret(name: string): boolean {
    const existed = this.secrets.delete(name);
    if (existed) {
      this.logManagement('delete', name);
      try {
        getGlobalLogger().info(AUDIT_SOURCE, `密钥已删除: ${name}（含全部历史版本）`);
      } catch (err) {
        reportSilentFailure(err, 'encryptedSecretsVault:deleteSecret');
      }
    }
    return existed;
  }

  // ── 公共 API：轮换 ──────────────────────────────────────────────

  /**
   * 轮换一条密钥。
   *
   * 生成新的密钥版本：
   *   - 若提供 newPlaintext，则使用新值加密
   *   - 若未提供 newPlaintext，则解密当前版本并以新派生密钥重新加密
   *     （即更换加密密钥而不改变密钥值）
   *
   * 旧版本保留在版本历史中，仍可通过 getSecret(name, oldVersion) 解密。
   * 这确保轮换期间正在使用旧版本的消费者不会中断。
   *
   * @param name - 密钥名称
   * @param newPlaintext - 可选的新密钥值。省略则以新密钥重新加密当前值
   * @returns 新版本的元数据
   * @throws {Error} 密钥不存在时抛出
   */
  rotateSecret(name: string, newPlaintext?: string): SecretMetadata {
    const latest = this.getLatestVersion(name);
    if (!latest) {
      throw new Error(`[EncryptedSecretsVault] 无法轮换不存在的密钥: ${name}`);
    }

    const now = new Date().toISOString();
    const newVersion = latest.metadata.version + 1;

    // 确定明文来源
    let plaintext: string;
    if (newPlaintext !== undefined && newPlaintext !== null) {
      plaintext = newPlaintext;
    } else {
      // 解密当前版本以重新加密
      try {
        plaintext = this.decrypt(latest);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logAccess(name, latest.metadata.version, false, `轮换时解密失败: ${reason}`);
        throw new Error(`[EncryptedSecretsVault] 轮换密钥 ${name} 时解密当前版本失败: ${reason}`);
      }
    }

    // 构造新版本（rotatedAt 设为当前时间）
    const stored = this.buildStoredSecret(name, newVersion, plaintext, now, now);
    const versions = this.secrets.get(name)!;
    versions.push(stored);
    this.trimVersions(name);

    // 记录审计日志
    try {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'key_rotation_confirmed',
        severity: 'medium',
        source: AUDIT_SOURCE,
        message: `密钥轮换完成: ${name} (v${latest.metadata.version} → v${newVersion})`,
        details: {
          vault: 'EncryptedSecretsVault',
          secretName: name,
          fromVersion: latest.metadata.version,
          toVersion: newVersion,
          valueChanged: newPlaintext !== undefined,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'encryptedSecretsVault:rotateSecret:audit');
    }

    this.logManagement('rotate', name, {
      fromVersion: latest.metadata.version,
      toVersion: newVersion,
      valueChanged: newPlaintext !== undefined,
    });

    try {
      getGlobalLogger().info(
        AUDIT_SOURCE,
        `密钥已轮换: ${name} (v${latest.metadata.version} → v${newVersion})`,
      );
    } catch (err) {
      reportSilentFailure(err, 'encryptedSecretsVault:rotateSecret');
    }

    return { ...stored.metadata };
  }

  // ── 公共 API：查询 ──────────────────────────────────────────────

  /**
   * 列出所有密钥的最新版本元数据。
   *
   * 仅返回元数据（名称、版本、时间戳、访问次数），不包含密文，
   * 也不进行任何解密操作。
   *
   * @returns 所有密钥最新版本的元数据数组
   */
  listSecrets(): SecretMetadata[] {
    const result: SecretMetadata[] = [];
    for (const versions of this.secrets.values()) {
      const latest = versions[versions.length - 1];
      if (latest) {
        result.push({ ...latest.metadata });
      }
    }
    return result;
  }

  /**
   * 获取指定密钥的元数据（最新版本）。
   *
   * @param name - 密钥名称
   * @returns 最新版本的元数据，密钥不存在则返回 undefined
   */
  getSecretMetadata(name: string): SecretMetadata | undefined {
    const latest = this.getLatestVersion(name);
    return latest ? { ...latest.metadata } : undefined;
  }

  /**
   * 获取指定密钥的全部版本元数据。
   *
   * 返回的数组按版本号升序排列。仅包含元数据，不包含密文。
   *
   * @param name - 密钥名称
   * @returns 所有版本的元数据数组，密钥不存在则返回空数组
   */
  getSecretVersions(name: string): SecretMetadata[] {
    const versions = this.secrets.get(name);
    if (!versions) return [];
    return versions.map((s) => ({ ...s.metadata }));
  }

  /**
   * 获取保险库统计信息。
   *
   * @returns 包含密钥总数、版本总数、访问总次数和每条密钥摘要的对象
   */
  getStats(): VaultStats {
    let totalVersions = 0;
    let totalAccessCount = 0;
    const secrets: SecretMetadata[] = [];

    for (const versions of this.secrets.values()) {
      totalVersions += versions.length;
      const latest = versions[versions.length - 1];
      if (latest) {
        totalAccessCount += latest.metadata.accessCount;
        secrets.push({ ...latest.metadata });
      }
    }

    return {
      totalSecrets: this.secrets.size,
      totalVersions,
      totalAccessCount,
      secrets,
    };
  }

  // ── 公共 API：导出 / 导入 ───────────────────────────────────────

  /**
   * 导出保险库为加密包格式。
   *
   * 导出包中所有密钥仍以加密形态存在（密文 + 密码学参数），
   * 主密钥不包含在导出包中。导入方必须拥有相同的主密钥才能解密。
   *
   * 适用场景：备份、跨实例迁移（需共享主密钥）、灾备恢复。
   *
   * @returns 加密包格式的导出对象
   */
  exportVault(): VaultExportBundle {
    const secretsRecord: Record<string, StoredSecret[]> = {};
    for (const [name, versions] of this.secrets) {
      // 深拷贝以避免外部修改影响内部状态
      secretsRecord[name] = versions.map((s) => ({
        metadata: { ...s.metadata },
        ciphertext: s.ciphertext,
        iv: s.iv,
        authTag: s.authTag,
        keyDerivationSalt: s.keyDerivationSalt,
      }));
    }

    this.logManagement('export', undefined, {
      secretCount: this.secrets.size,
      versionCount: Object.values(secretsRecord).reduce((sum, v) => sum + v.length, 0),
    });

    try {
      getGlobalLogger().info(AUDIT_SOURCE, `保险库已导出: ${this.secrets.size} 条密钥`);
    } catch (err) {
      reportSilentFailure(err, 'encryptedSecretsVault:exportVault');
    }

    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      secrets: secretsRecord,
    };
  }

  /**
   * 从加密包导入密钥。
   *
   * 导入的密钥仍为加密形态，无需解密即可导入。导入方的主密钥
   * 必须与导出方一致，否则后续 getSecret 解密会失败。
   *
   * @param bundle - 加密包格式的导出对象
   * @param mode - 导入模式：'merge'（合并，保留现有密钥）或 'replace'（替换，清空后导入）
   * @throws {Error} 导出包格式不合法时抛出
   */
  importVault(bundle: VaultExportBundle, mode: 'merge' | 'replace' = 'merge'): void {
    // 格式校验
    if (!bundle || bundle.format !== EXPORT_FORMAT) {
      throw new Error(
        `[EncryptedSecretsVault] 无效的导出包格式: 期望 "${EXPORT_FORMAT}"，实际 "${bundle?.format ?? 'undefined'}"`,
      );
    }
    if (bundle.version !== EXPORT_VERSION) {
      throw new Error(
        `[EncryptedSecretsVault] 不支持的导出包版本: 期望 ${EXPORT_VERSION}，实际 ${bundle.version}`,
      );
    }
    if (!bundle.secrets || typeof bundle.secrets !== 'object') {
      throw new Error('[EncryptedSecretsVault] 导出包缺少 secrets 字段或格式不正确');
    }

    if (mode === 'replace') {
      this.secrets.clear();
    }

    let importedCount = 0;
    let versionCount = 0;

    for (const [name, versions] of Object.entries(bundle.secrets)) {
      if (!Array.isArray(versions)) continue;

      // 深拷贝以隔离外部引用
      const copied: StoredSecret[] = versions.map((s) => ({
        metadata: { ...s.metadata },
        ciphertext: s.ciphertext,
        iv: s.iv,
        authTag: s.authTag,
        keyDerivationSalt: s.keyDerivationSalt,
      }));

      if (mode === 'merge') {
        // 合并模式：保留现有版本，追加导入版本中不存在的版本号
        const existing = this.secrets.get(name) ?? [];
        const existingVersionSet = new Set(existing.map((s) => s.metadata.version));
        for (const s of copied) {
          if (!existingVersionSet.has(s.metadata.version)) {
            existing.push(s);
          }
        }
        // 按版本号排序
        existing.sort((a, b) => a.metadata.version - b.metadata.version);
        this.secrets.set(name, existing);
        this.trimVersions(name);
      } else {
        this.secrets.set(name, copied);
      }

      importedCount++;
      versionCount += copied.length;
    }

    this.logManagement('import', undefined, {
      mode,
      secretCount: importedCount,
      versionCount,
    });

    try {
      getGlobalLogger().info(
        AUDIT_SOURCE,
        `保险库已导入 (${mode} 模式): ${importedCount} 条密钥, ${versionCount} 个版本`,
      );
    } catch (err) {
      reportSilentFailure(err, 'encryptedSecretsVault:importVault');
    }
  }

  // ── 公共 API：清理 ──────────────────────────────────────────────

  /**
   * 清空保险库中的所有密钥。
   *
   * 从内存中移除所有密钥及其全部版本。此操作不可逆。
   */
  clear(): void {
    const count = this.secrets.size;
    this.secrets.clear();
    this.logManagement('clear', undefined, { secretCount: count });
    try {
      getGlobalLogger().info(AUDIT_SOURCE, `保险库已清空: 移除 ${count} 条密钥`);
    } catch (err) {
      reportSilentFailure(err, 'encryptedSecretsVault:clear');
    }
  }
}

// ============================================================================
// 单例（多租户隔离）
// ============================================================================

/**
 * 租户感知的加密密钥保险库单例。
 *
 * 通过 createTenantAwareSingleton 实现：
 *   - 在租户上下文中，每个租户获得独立的保险库实例
 *   - 在非租户上下文中，使用全局回退实例
 *   - 租户间数据在内存层面完全隔离
 */
const vaultSingleton = createTenantAwareSingleton(() => new EncryptedSecretsVault(), {
  allowGlobalFallback: true,
  componentName: 'EncryptedSecretsVault',
  dispose: (instance) => {
    // 释放时清空保险库，减少密文在内存中的残留
    instance.clear();
  },
});

/**
 * 获取当前上下文的加密密钥保险库单例。
 *
 * 在租户上下文中返回该租户专属的实例；
 * 在非租户上下文中返回全局回退实例。
 *
 * @returns EncryptedSecretsVault 实例
 */
export function getEncryptedSecretsVault(): EncryptedSecretsVault {
  return vaultSingleton.get();
}

/**
 * 重置加密密钥保险库单例。
 *
 * 清除所有租户实例和全局实例，释放内存。
 * 主要用于测试和优雅关闭场景。
 */
export function resetEncryptedSecretsVault(): void {
  vaultSingleton.reset();
}
