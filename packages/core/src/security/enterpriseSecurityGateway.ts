/**
 * EnterpriseSecurityGateway — 企业级统一安全网关
 *
 * 作为所有安全组件的统一入口和协调器，实现纵深防御策略：
 *
 * 请求生命周期（7 层防御）：
 *   1. 零信任签名验证 → 完整性 + 防重放
 *   2. 认证 → API Key 验证 + 时序安全比较
 *   3. 速率限制 → 全局令牌桶 + 分层 IP 限制
 *   4. 输入扫描 → 内容注入检测 + 输入验证
 *   5. 成本预检 → 账单爆炸防护（调用前预估）
 *   6. 请求处理 → 业务逻辑执行
 *   7. 输出扫描 → DLP 数据泄露防护 + 成本记录
 *
 * 核心设计原则：
 * - 纵深防御：每层独立运作，一层被突破不影响其他层
 * - 快速失败：安全检查失败立即拒绝，不泄露内部信息
 * - 可观测性：所有安全决策记录到审计链
 * - 租户隔离：每个租户独立的安全上下文
 * - 不可绕过：成本检查在 LLM 调用前后双重执行
 *
 * 使用方式：
 *   import { getEnterpriseSecurityGateway } from './security/enterpriseSecurityGateway';
 *   const gateway = getEnterpriseSecurityGateway();
 *
 *   // Express 中间件
 *   app.use(gateway.createExpressMiddleware());
 *
 *   // LLM 调用前检查
 *   const preCheck = gateway.preLLMCheck({ tenantId, model, estimatedTokens, source });
 *   if (!preCheck.allowed) throw new Error(preCheck.reason);
 *
 *   // LLM 调用后记录
 *   gateway.postLLMCheck({ tenantId, model, inputTokens, outputTokens, sessionId });
 *
 *   // 工具调用检查
 *   const toolCheck = gateway.preToolCheck({ tenantId, toolName, source });
 *   if (!toolCheck.allowed) throw new Error(toolCheck.reason);
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getDataLossPrevention } from './dataLossPrevention';
import { getZeroTrustValidator } from './zeroTrustValidator';
import { getGuardianAgent } from './guardianAgent';
import { getSecurityMonitor } from './securityMonitor';
import { getSecurityProfileConfig } from './securityProfile';
import { getUnifiedCostAuthority, type ToolCostTier } from './unifiedCostAuthority';
import { UniversalSanitizer } from './securityPrimitives';
import { getLiteLLMPricing } from './litellmPricing';

// ============================================================================
// 类型定义
// ============================================================================

/** 安全网关配置 */
export interface EnterpriseGatewayConfig {
  /** 是否启用零信任签名验证 */
  enableZeroTrust: boolean;
  /** 是否启用 DLP 输出扫描 */
  enableDLP: boolean;
  /** 是否启用账单爆炸防护 */
  enableBillGuard: boolean;
  /** 是否启用 Guardian Agent 监控 */
  enableGuardian: boolean;
  /** 是否启用安全监控 */
  enableSecurityMonitor: boolean;
  /** DLP 阻止 critical 级别泄露 */
  dlpBlockCritical: boolean;
  /** 安全检查超时（ms） */
  securityCheckTimeoutMs: number;
  /** 跳过安全检查的路径 */
  skipPaths: string[];
}

/** LLM 调用前检查参数 */
export interface PreLLMCheckParams {
  /** 租户 ID */
  tenantId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** Run ID（用于 UCA per-run 预算追踪） */
  runId?: string;
  /** 模型名称 */
  model: string;
  /** 预估 token 数 */
  estimatedTokens: number;
  /** 请求来源（IP/用户 ID） */
  source: string;
  /** 用户输入（用于攻击模式检测） */
  input?: string;
  /** 缓存命中率（0-1） */
  cacheHitRatio?: number;
}

/** LLM 调用后检查参数 */
export interface PostLLMCheckParams {
  /** 租户 ID */
  tenantId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** Run ID（用于 UCA per-run 预算追踪） */
  runId?: string;
  /** 模型名称 */
  model: string;
  /** 实际输入 token 数 */
  inputTokens: number;
  /** 实际输出 token 数 */
  outputTokens: number;
  /** Agent ID */
  agentId?: string;
  /** LLM 输出内容（用于 DLP 扫描） */
  output?: string;
}

/** 工具调用检查参数 */
export interface PreToolCheckParams {
  /** 租户 ID */
  tenantId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** Run ID（用于 UCA per-run + per-tool 调用次数追踪） */
  runId?: string;
  /** 工具名称 */
  toolName: string;
  /** 请求来源 */
  source: string;
  /** 工具输入参数（用于扫描） */
  input?: string;
  /** 工具成本档位（未指定时 UCA 按默认 'low' 处理） */
  costTier?: ToolCostTier;
}

/** 工具调用后检查参数 */
export interface PostToolCheckParams {
  /** 租户 ID */
  tenantId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** Run ID（用于 UCA per-run 预算追踪） */
  runId?: string;
  /** 工具名称 */
  toolName: string;
  /** 工具输出结果（用于 DLP 扫描） */
  output: string;
  /** Agent ID */
  agentId?: string;
  /** 工具成本档位（与 preToolCheck 一致） */
  costTier?: ToolCostTier;
  /** 工具实际成本（美元），供 UCA 记录 */
  actualCostUsd?: number;
}

/** 安全检查结果 */
export interface SecurityCheckResult {
  /** 是否允许通过 */
  allowed: boolean;
  /** 拒绝原因（allowed=false 时有值） */
  reason?: string;
  /** 拒绝来源层 */
  rejectedBy?: SecurityLayer;
  /** 检查耗时（ms） */
  durationMs: number;
  /** 附加信息 */
  metadata?: Record<string, unknown>;
}

/** 安全层标识 */
export type SecurityLayer =
  'zero_trust' | 'authentication' | 'rate_limit' | 'input_scan' | 'bill_guard' | 'dlp' | 'guardian';

/** 安全网关状态报告 */
export interface GatewayStatus {
  /** 各层启用状态 */
  layers: Record<SecurityLayer, boolean>;
  /** 总请求数 */
  totalRequests: number;
  /** 总拒绝数 */
  totalRejections: number;
  /** 拒绝率 */
  rejectionRate: number;
  /** 按层统计拒绝数 */
  rejectionsByLayer: Record<string, number>;
  /** 平均检查耗时（ms） */
  avgCheckDurationMs: number;
  /** 账单防护状态 */
  billGuardStatus?: unknown;
  /** DLP 统计 */
  dlpStats?: unknown;
  /** 零信任统计 */
  zeroTrustStats?: unknown;
  /** Guardian 统计 */
  guardianStats?: unknown;
  /** 安全监控健康状态 */
  securityHealth?: unknown;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: EnterpriseGatewayConfig = {
  enableZeroTrust: true,
  enableDLP: true,
  enableBillGuard: true,
  enableGuardian: true,
  enableSecurityMonitor: true,
  // Cost enforcement is unified under UnifiedCostAuthority (UCA) via the
  // enableBillGuard flag. The legacy CostGuard was removed; enableBillGuard
  // is the single cost-control switch (preLLMCheck + postLLMCheck + tool calls).
  dlpBlockCritical: true,
  securityCheckTimeoutMs: 5000,
  skipPaths: ['/health', '/metrics', '/readyz', '/system/status'],
};

// ============================================================================
// EnterpriseSecurityGateway
// ============================================================================

export class EnterpriseSecurityGateway {
  private config: EnterpriseGatewayConfig;
  private totalRequests = 0;
  private totalRejections = 0;
  private rejectionsByLayer: Map<string, number> = new Map();
  private totalCheckDurationMs = 0;
  private sanitizer = new UniversalSanitizer();

  constructor(config?: Partial<EnterpriseGatewayConfig>) {
    // Apply security profile defaults first, then explicit config overrides.
    // The profile (COMMANDER_SECURITY_PROFILE=dev|standard|strict) sets the
    // initial enablement of gateway layers; explicit constructor args win.
    const profile = getSecurityProfileConfig();
    this.config = {
      ...DEFAULT_CONFIG,
      enableZeroTrust: profile.enableZeroTrust,
      enableDLP: profile.enableDLP,
      enableBillGuard: profile.enableBillGuard,
      enableGuardian: profile.enableGuardian,
      enableSecurityMonitor: profile.enableSecurityMonitor,
      dlpBlockCritical: profile.dlpBlockCritical,
      ...config,
    };
  }

  // ── 配置管理 ──────────────────────────────────────────────────────

  /**
   * 更新网关配置
   */
  configure(config: Partial<EnterpriseGatewayConfig>): void {
    this.config = { ...this.config, ...config };
    getGlobalLogger().info('EnterpriseSecurityGateway', 'Configuration updated', {
      enableZeroTrust: this.config.enableZeroTrust,
      enableDLP: this.config.enableDLP,
      enableBillGuard: this.config.enableBillGuard,
    });
  }

  /**
   * 获取当前配置
   */
  getConfig(): EnterpriseGatewayConfig {
    return { ...this.config };
  }

  // ── LLM 调用安全检查 ──────────────────────────────────────────────

  /**
   * LLM 调用前安全检查
   *
   * 执行以下检查（按顺序）：
   * 1. 账单爆炸防护 —— 预估成本检查
   * 2. 输入内容扫描 —— 攻击模式检测
   * 3. Guardian Agent —— 行为基线检查
   * 4. 旧版 CostGuard —— 二次成本验证
   *
   * @param params - 检查参数
   * @returns 检查结果
   */
  preLLMCheck(params: PreLLMCheckParams): SecurityCheckResult {
    const startTime = Date.now();
    this.totalRequests++;

    try {
      // 1. 成本预检 —— 委托给 UnifiedCostAuthority（单一成本真相源）
      //    取代之前 BillExplosionGuard + CostGuard 的双重检查。
      if (this.config.enableBillGuard) {
        const uca = getUnifiedCostAuthority();
        const decision = uca.preCall({
          runId: params.runId ?? params.sessionId ?? params.source,
          tenantId: params.tenantId,
          sessionId: params.sessionId,
          model: params.model,
          estimatedTokens: params.estimatedTokens,
          cacheHitRatio: params.cacheHitRatio,
        });

        if (!decision.allowed) {
          return this.reject('bill_guard', decision.reason ?? 'Cost budget rejected', startTime, {
            estimatedCostUsd: decision.estimatedCostUsd,
            action: decision.action,
            snapshot: decision.snapshot,
          });
        }
      }

      // 2. Universal input sanitization —— PII + XSS + path traversal.
      //    This runs before the attack-pattern scan so scanners see a clean
      //    surface and secrets never reach the LLM provider.
      if (params.input) {
        const sanitizeResult = this.sanitizer.sanitize(params.input, 'input');
        params.input = sanitizeResult.sanitized;
        if (sanitizeResult.modified) {
          getSecurityAuditLogger().logEvent({
            type: 'security_scan',
            severity: 'medium',
            source: 'enterpriseSecurityGateway',
            message: `Input sanitized before LLM call (${sanitizeResult.patterns.join(', ')})`,
            context: {
              tenantId: params.tenantId,
              runId: params.runId,
            },
            details: {
              patterns: sanitizeResult.patterns,
            },
          });
        }
      }

      // 3. 输入内容扫描 —— 攻击模式检测
      if (params.input) {
        const scanResult = this.scanInput(params.input);
        if (!scanResult.allowed) {
          return this.reject('input_scan', scanResult.reason!, startTime, scanResult.metadata);
        }
      }

      // 3. Guardian Agent —— 行为基线检查
      if (this.config.enableGuardian && params.sessionId) {
        const guardian = getGuardianAgent();
        if (guardian.isPaused(params.sessionId)) {
          return this.reject(
            'guardian',
            'Agent is paused by Guardian due to anomalous behavior',
            startTime,
          );
        }
      }

      // 所有检查通过
      this.recordCheckDuration(startTime);
      return {
        allowed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:preLLMCheck');
      // 安全失败 —— 出错时拒绝请求
      return this.reject(
        'bill_guard',
        'Security check error — request denied for safety',
        startTime,
      );
    }
  }

  /**
   * LLM 调用后安全处理
   *
   * 执行以下操作：
   * 1. 记录实际成本到账单防护
   * 2. DLP 扫描 LLM 输出
   * 3. Guardian Agent 行为监控
   * 4. 记录到安全监控
   *
   * @param params - 检查参数
   * @returns 处理结果（如果 DLP 阻止了输出，返回脱敏后的内容）
   */
  postLLMCheck(params: PostLLMCheckParams): {
    allowed: boolean;
    sanitizedOutput?: string;
    reason?: string;
    durationMs: number;
  } {
    const startTime = Date.now();

    try {
      // 1. 记录实际成本 —— 委托给 UnifiedCostAuthority
      if (this.config.enableBillGuard) {
        try {
          const uca = getUnifiedCostAuthority();
          // 用 LiteLLM 实时定价计算实际成本
          const litellm = getLiteLLMPricing();
          const ratePer1M = litellm.getCostPer1MTokens(params.model) ?? 5.0;
          const costUsd = ((params.inputTokens + params.outputTokens) / 1_000_000) * ratePer1M;
          uca.postCall(
            {
              runId: params.runId ?? params.sessionId ?? 'unknown',
              tenantId: params.tenantId,
              sessionId: params.sessionId,
              model: params.model,
            },
            {
              costUsd,
              promptTokens: params.inputTokens,
              completionTokens: params.outputTokens,
            },
          );
        } catch (err) {
          reportSilentFailure(err, 'enterpriseSecurityGateway:postLLMCheck:uca');
        }
      }

      // 2. DLP 扫描输出
      let sanitizedOutput = params.output;
      if (this.config.enableDLP && params.output) {
        const dlp = getDataLossPrevention();
        const scanResult = dlp.scan(params.output, 'agent_output');

        if (!scanResult.isClean) {
          if (this.config.dlpBlockCritical && scanResult.riskLevel === 'critical') {
            // Critical 级别泄露 —— 阻止输出
            getSecurityAuditLogger().logEvent({
              type: 'content_threat',
              severity: 'critical',
              source: 'EnterpriseSecurityGateway',
              message: `DLP blocked critical data leak in LLM output (${scanResult.matches.length} matches)`,
              details: {
                tenantId: params.tenantId,
                matchTypes: scanResult.matches.map((m) => m.type),
              },
            });
            return {
              allowed: false,
              reason: 'Output blocked: critical sensitive data detected',
              durationMs: Date.now() - startTime,
            };
          }
          // 非 critical —— 脱敏后放行
          sanitizedOutput = scanResult.sanitizedContent;
        }
      }

      // 3. Guardian Agent 行为监控
      if (this.config.enableGuardian && params.agentId) {
        const guardian = getGuardianAgent();
        guardian.monitor({
          agentId: params.agentId,
          runId: params.sessionId,
          timestamp: Date.now(),
          type: 'llm_call',
          content: sanitizedOutput ?? '',
          metadata: { tokens: params.inputTokens + params.outputTokens, model: params.model },
        });
        guardian.recordTokens(params.agentId, params.inputTokens + params.outputTokens);
      }

      return {
        allowed: true,
        sanitizedOutput,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:postLLMCheck');
      // Fail-closed: never return unsanitized LLM output when DLP/post-check throws.
      return {
        allowed: false,
        reason: 'Post-LLM security check failed — output withheld',
        sanitizedOutput: '[REDACTED]',
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ── 工具调用安全检查 ──────────────────────────────────────────────

  /**
   * 工具调用前安全检查
   *
   * @param params - 检查参数
   * @returns 检查结果
   */
  preToolCheck(params: PreToolCheckParams): SecurityCheckResult {
    const startTime = Date.now();
    this.totalRequests++;

    try {
      // 1. 成本预检 —— 委托给 UnifiedCostAuthority（per-tool costTier 门控）
      //    取代之前 BillExplosionGuard.checkToolCall 的频率检测。
      if (this.config.enableBillGuard) {
        const uca = getUnifiedCostAuthority();
        const tier: ToolCostTier = params.costTier ?? 'low';
        const decision = uca.preCall({
          runId: params.runId ?? params.sessionId ?? params.source,
          tenantId: params.tenantId,
          sessionId: params.sessionId,
          tool: { name: params.toolName, costTier: tier },
        });

        if (!decision.allowed) {
          return this.reject(
            'bill_guard',
            decision.reason ?? 'Tool call rejected by cost authority',
            startTime,
            {
              estimatedCostUsd: decision.estimatedCostUsd,
              action: decision.action,
              costTier: tier,
            },
          );
        }
      }

      // 2. 输入扫描
      if (params.input) {
        const scanResult = this.scanInput(params.input);
        if (!scanResult.allowed) {
          return this.reject('input_scan', scanResult.reason!, startTime, scanResult.metadata);
        }
      }

      // 3. Guardian Agent 检查
      if (this.config.enableGuardian && params.sessionId) {
        const guardian = getGuardianAgent();
        if (guardian.isPaused(params.sessionId)) {
          return this.reject('guardian', 'Agent paused by Guardian', startTime);
        }
      }

      this.recordCheckDuration(startTime);
      return { allowed: true, durationMs: Date.now() - startTime };
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:preToolCheck');
      return this.reject('bill_guard', 'Security check error', startTime);
    }
  }

  /**
   * 工具调用后安全处理
   *
   * @param params - 检查参数
   * @returns 处理结果
   */
  postToolCheck(params: PostToolCheckParams): {
    allowed: boolean;
    sanitizedOutput?: string;
    reason?: string;
    durationMs: number;
  } {
    const startTime = Date.now();

    try {
      // 1. DLP 扫描工具输出
      let sanitizedOutput = params.output;
      if (this.config.enableDLP) {
        const dlp = getDataLossPrevention();
        const scanResult = dlp.scan(params.output, 'tool_result');

        if (!scanResult.isClean) {
          if (this.config.dlpBlockCritical && scanResult.riskLevel === 'critical') {
            getSecurityAuditLogger().logEvent({
              type: 'content_threat',
              severity: 'critical',
              source: 'EnterpriseSecurityGateway',
              message: `DLP blocked critical data leak in tool output: ${params.toolName}`,
              details: {
                tenantId: params.tenantId,
                toolName: params.toolName,
                matchTypes: scanResult.matches.map((m) => m.type),
              },
            });
            return {
              allowed: false,
              reason: 'Tool output blocked: critical sensitive data detected',
              durationMs: Date.now() - startTime,
            };
          }
          sanitizedOutput = scanResult.sanitizedContent;
        }
      }

      // 2. 记录工具成本到 UnifiedCostAuthority（advisory，不阻断）
      if (this.config.enableBillGuard) {
        try {
          const uca = getUnifiedCostAuthority();
          const tier: ToolCostTier = params.costTier ?? 'low';
          // 工具实际成本：优先用调用方提供的 actualCostUsd；否则按 output 长度估算
          const estimatedOutputTokens = Math.ceil((params.output?.length ?? 0) / 4);
          const fallbackCostUsd = (estimatedOutputTokens / 1_000_000) * 5.0;
          uca.postCall(
            {
              runId: params.runId ?? params.sessionId ?? 'unknown',
              tenantId: params.tenantId,
              sessionId: params.sessionId,
              tool: { name: params.toolName, costTier: tier },
            },
            { costUsd: params.actualCostUsd ?? fallbackCostUsd },
          );
        } catch (err) {
          reportSilentFailure(err, 'enterpriseSecurityGateway:postToolCheck:uca');
        }
      }

      // 3. Guardian Agent 监控
      if (this.config.enableGuardian && params.agentId) {
        const guardian = getGuardianAgent();
        guardian.monitor({
          agentId: params.agentId,
          runId: params.sessionId,
          timestamp: Date.now(),
          type: 'tool_result',
          content: sanitizedOutput ?? '',
          metadata: { toolName: params.toolName },
        });
      }

      return {
        allowed: true,
        sanitizedOutput,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:postToolCheck');
      // Fail-closed: never return unsanitized tool output when DLP/post-check throws.
      return {
        allowed: false,
        reason: 'Post-tool security check failed — output withheld',
        sanitizedOutput: '[REDACTED]',
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ── Express 中间件 ────────────────────────────────────────────────

  /**
   * 创建 Express 安全中间件链
   *
   * 按顺序应用：
   * 1. 零信任签名验证
   * 2. DLP 响应扫描
   *
   * 注意：认证和速率限制由现有的 authMiddleware 和 rateLimitMiddleware 处理
   */
  createExpressMiddleware(): (req: unknown, res: unknown, next: (err?: unknown) => void) => void {
    return (req, res, next) => {
      const request = req as {
        method: string;
        path: string;
        body?: unknown;
        headers: Record<string, string | string[] | undefined>;
      };
      const response = res as {
        status: (code: number) => { json: (data?: unknown) => unknown };
        json: (data?: unknown) => unknown;
        send: (body?: unknown) => unknown;
        statusCode?: number;
      };
      // 跳过指定路径
      if (this.config.skipPaths.includes(request.path)) {
        return next();
      }

      this.totalRequests++;
      const startTime = Date.now();

      try {
        // 1. 零信任签名验证
        if (this.config.enableZeroTrust) {
          const validator = getZeroTrustValidator();
          if (validator.getRegisteredKeyIds().length > 0) {
            const signatureHeader =
              (request.headers['x-commander-signature'] as string) ?? undefined;
            const requestId = (request.headers['x-request-id'] as string) ?? undefined;
            const body = request.body ? JSON.stringify(request.body) : undefined;

            const result = validator.validateRequest({
              method: request.method,
              path: request.path,
              body,
              signatureHeader,
              requestId,
            });

            if (!result.valid) {
              this.reject('zero_trust', result.reason ?? 'Zero trust validation failed', startTime);
              response.status(401).json({
                error: 'Request signature validation failed',
                reason: result.reason,
                code: result.code,
              });
              return;
            }
          }
        }

        // 2. DLP 响应拦截 —— 包装 response.json 和 response.send
        if (this.config.enableDLP) {
          const dlp = getDataLossPrevention();
          const originalJson = response.json.bind(response);
          const originalSend = response.send.bind(response);

          response.json = (data?: unknown) => {
            try {
              const bodyStr = JSON.stringify(data);
              const scanResult = dlp.scan(bodyStr, 'api_response');
              if (!scanResult.isClean) {
                if (this.config.dlpBlockCritical && scanResult.riskLevel === 'critical') {
                  getSecurityAuditLogger().logEvent({
                    type: 'content_threat',
                    severity: 'critical',
                    source: 'EnterpriseSecurityGateway',
                    message: `DLP blocked critical data leak in API response: ${request.path}`,
                    details: {
                      path: request.path,
                      matchTypes: scanResult.matches.map((m) => m.type),
                    },
                  });
                  return originalJson({ error: 'Response blocked by security policy' });
                }
                // 脱敏后返回
                const sanitized = JSON.parse(scanResult.sanitizedContent);
                return originalJson(sanitized);
              }
            } catch (err) {
              reportSilentFailure(err, 'enterpriseSecurityGateway:dlpJson');
            }
            return originalJson(data);
          };

          response.send = (body?: unknown) => {
            if (typeof body === 'string') {
              try {
                const scanResult = dlp.scan(body, 'api_response');
                if (!scanResult.isClean) {
                  if (this.config.dlpBlockCritical && scanResult.riskLevel === 'critical') {
                    return originalSend('Response blocked by security policy');
                  }
                  return originalSend(scanResult.sanitizedContent);
                }
              } catch (err) {
                reportSilentFailure(err, 'enterpriseSecurityGateway:dlpSend');
              }
            }
            return originalSend(body);
          };
        }

        this.recordCheckDuration(startTime);
        next();
      } catch (err) {
        reportSilentFailure(err, 'enterpriseSecurityGateway:middleware');
        this.reject('zero_trust', 'Security middleware error', startTime);
        response.status(500).json({ error: 'Internal security error' });
      }
    };
  }

  // ── 状态报告 ──────────────────────────────────────────────────────

  /**
   * 获取安全网关状态报告
   */
  getStatus(): GatewayStatus {
    const layers: Record<SecurityLayer, boolean> = {
      zero_trust: this.config.enableZeroTrust,
      authentication: true, // 始终启用，由外部中间件处理
      rate_limit: true, // 始终启用，由外部中间件处理
      input_scan: true,
      bill_guard: this.config.enableBillGuard,
      dlp: this.config.enableDLP,
      guardian: this.config.enableGuardian,
    };

    const rejectionsByLayerObj: Record<string, number> = {};
    for (const [layer, count] of this.rejectionsByLayer) {
      rejectionsByLayerObj[layer] = count;
    }

    const status: GatewayStatus = {
      layers,
      totalRequests: this.totalRequests,
      totalRejections: this.totalRejections,
      rejectionRate: this.totalRequests > 0 ? this.totalRejections / this.totalRequests : 0,
      rejectionsByLayer: rejectionsByLayerObj,
      avgCheckDurationMs:
        this.totalRequests > 0 ? this.totalCheckDurationMs / this.totalRequests : 0,
    };

    // 附加各组件状态
    try {
      if (this.config.enableBillGuard) {
        // 从 UnifiedCostAuthority 获取成本快照（单一真相源）
        const uca = getUnifiedCostAuthority();
        status.billGuardStatus = { ucaActive: true, ledgerSize: uca.readLedger().length };
      }
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:billGuardStatus');
    }

    try {
      if (this.config.enableDLP) {
        status.dlpStats = getDataLossPrevention().getStats();
      }
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:dlpStats');
    }

    try {
      if (this.config.enableZeroTrust) {
        status.zeroTrustStats = getZeroTrustValidator().getStats();
      }
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:zeroTrustStats');
    }

    try {
      if (this.config.enableGuardian) {
        status.guardianStats = getGuardianAgent().getStats();
      }
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:guardianStats');
    }

    try {
      if (this.config.enableSecurityMonitor) {
        status.securityHealth = getSecurityMonitor().getHealth();
      }
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:securityHealth');
    }

    return status;
  }

  /**
   * 获取安全态势摘要（用于仪表板）
   */
  getSecurityPosture(): {
    overallStatus: 'healthy' | 'elevated' | 'critical';
    activeThreats: number;
    costProtectionActive: boolean;
    dlpActive: boolean;
    zeroTrustActive: boolean;
    recommendations: string[];
  } {
    const status = this.getStatus();
    const recommendations: string[] = [];

    let overallStatus: 'healthy' | 'elevated' | 'critical' = 'healthy';

    // 检查拒绝率
    if (status.rejectionRate > 0.1) {
      overallStatus = 'elevated';
      recommendations.push('High rejection rate — investigate potential attack patterns');
    }

    // 检查成本防护（通过 UnifiedCostAuthority ledger 判断是否有熔断记录）
    if (this.config.enableBillGuard) {
      try {
        const uca = getUnifiedCostAuthority();
        const ledger = uca.readLedger();
        // 检查最近的记录是否有熔断事件（通过 audit logger 已记录）
        // 这里简单检查 ledger 是否有大量条目（可能表示异常活动）
        if (ledger.length > 1000) {
          overallStatus = 'elevated';
          recommendations.push('High cost activity — review UCA ledger for anomalies');
        }
      } catch (err) {
        reportSilentFailure(err, 'enterpriseSecurityGateway:postureBillGuard');
      }
    }

    // 检查安全监控
    if (this.config.enableSecurityMonitor) {
      try {
        const monitor = getSecurityMonitor();
        const health = monitor.getHealth();
        if (health.status === 'critical') {
          overallStatus = 'critical';
          recommendations.push(
            'Security monitor reports critical status — immediate investigation required',
          );
        } else if (health.status === 'elevated') {
          overallStatus = 'elevated';
        }
      } catch (err) {
        reportSilentFailure(err, 'enterpriseSecurityGateway:postureMonitor');
      }
    }

    // 检查未启用的安全层
    if (!this.config.enableZeroTrust) {
      recommendations.push('Enable Zero Trust signature validation for request integrity');
    }
    if (!this.config.enableDLP) {
      recommendations.push('Enable DLP to prevent sensitive data leakage');
    }
    if (!this.config.enableBillGuard) {
      recommendations.push('Enable Bill Explosion Guard to prevent cost attacks');
    }

    return {
      overallStatus,
      activeThreats: status.rejectionsByLayer['bill_guard'] ?? 0,
      costProtectionActive: this.config.enableBillGuard,
      dlpActive: this.config.enableDLP,
      zeroTrustActive: this.config.enableZeroTrust,
      recommendations,
    };
  }

  // ── 内部方法 ──────────────────────────────────────────────────────

  /**
   * 扫描输入内容（轻量级，用于请求预处理）
   */
  private scanInput(input: string): {
    allowed: boolean;
    reason?: string;
    metadata?: Record<string, unknown>;
  } {
    // 检查输入长度
    if (input.length > 500_000) {
      return {
        allowed: false,
        reason: 'Input exceeds maximum length (500KB)',
        metadata: { length: input.length },
      };
    }

    // 检查已知攻击模式
    const attackPatterns = [
      {
        pattern: /(?:recursive|infinite|forever|endless).{0,10}(?:loop|search|call|query)/i,
        reason: 'Potential recursive attack pattern detected',
      },
      {
        pattern: /(?:repeat|loop).{0,10}(?:until|forever|indefinitely|infinite)/i,
        reason: 'Potential infinite loop pattern detected',
      },
      {
        pattern: /(?:process|analyze).{0,10}(?:all|every|each).{0,20}(?:file|page|result|line)/i,
        reason: 'Potential resource exhaustion pattern detected',
      },
    ];

    for (const { pattern, reason } of attackPatterns) {
      if (pattern.test(input)) {
        return { allowed: false, reason, metadata: { pattern: pattern.source } };
      }
    }

    // Security (OWASP ASI02): DLP scan on tool call parameters — detect sensitive
    // data exfiltration attempts via outbound tools (web_search, http, a2a, shell).
    // Per OWASP — scan both tool inputs and outputs for sensitive information.
    const dlpPatterns = [
      { pattern: /(?:sk-|pk-|sk_)[a-zA-Z0-9]{20,}/, reason: 'API key detected in tool parameters' },
      {
        pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
        reason: 'Private key detected in tool parameters',
      },
      {
        pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/,
        reason: 'AWS access key detected in tool parameters',
      },
      { pattern: /ghp_[a-zA-Z0-9]{36}/, reason: 'GitHub token detected in tool parameters' },
      {
        pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
        reason: 'JWT token detected in tool parameters',
      },
      {
        pattern: /(?:password|passwd|pwd)["\s:=]+[^\s"']{8,}/i,
        reason: 'Password detected in tool parameters',
      },
    ];

    for (const { pattern, reason } of dlpPatterns) {
      if (pattern.test(input)) {
        return { allowed: false, reason, metadata: { pattern: pattern.source, dlp: true } };
      }
    }

    return { allowed: true };
  }

  /**
   * 记录拒绝
   */
  private reject(
    layer: SecurityLayer,
    reason: string,
    startTime: number,
    metadata?: Record<string, unknown>,
  ): SecurityCheckResult {
    this.totalRejections++;
    const count = this.rejectionsByLayer.get(layer) ?? 0;
    this.rejectionsByLayer.set(layer, count + 1);
    this.recordCheckDuration(startTime);

    // 记录到审计日志
    getSecurityAuditLogger().logEvent({
      type: 'security_scan',
      severity: layer === 'bill_guard' ? 'high' : 'medium',
      source: 'EnterpriseSecurityGateway',
      message: `[${layer}] Request rejected: ${reason}`,
      details: { layer, reason, ...metadata },
    });

    // 记录指标
    try {
      getGlobalMetrics().incrementCounter('gateway.rejections', 1, { layer });
    } catch (err) {
      reportSilentFailure(err, 'enterpriseSecurityGateway:rejectMetrics');
    }

    return {
      allowed: false,
      reason,
      rejectedBy: layer,
      durationMs: Date.now() - startTime,
      metadata,
    };
  }

  /**
   * 记录检查耗时
   */
  private recordCheckDuration(startTime: number): void {
    this.totalCheckDurationMs += Date.now() - startTime;
  }

  /**
   * 重置状态（测试用）
   */
  reset(): void {
    this.totalRequests = 0;
    this.totalRejections = 0;
    this.rejectionsByLayer.clear();
    this.totalCheckDurationMs = 0;
  }
}

// ============================================================================
// 单例
// ============================================================================

const gatewaySingleton = createTenantAwareSingleton(() => new EnterpriseSecurityGateway(), {});

/**
 * 获取全局 EnterpriseSecurityGateway（单租户）或租户范围的实例
 */
export function getEnterpriseSecurityGateway(
  config?: Partial<EnterpriseGatewayConfig>,
): EnterpriseSecurityGateway {
  const gateway = gatewaySingleton.get();
  if (config) {
    gateway.configure(config);
  }
  return gateway;
}

/**
 * 重置 EnterpriseSecurityGateway 单例（用于测试隔离）
 */
export function resetEnterpriseSecurityGateway(): void {
  gatewaySingleton.reset();
}
