/**
 * SecuritySelfHealingEngine — 安全自愈引擎
 *
 * 当检测到攻击或安全违规时，自动执行隔离、恢复和加固操作，使系统在
 * 最短时间内回归已知安全状态。引擎围绕"响应剧本（Playbook）"组织：
 * 每种攻击类型对应一个或多个剧本，剧本定义了一系列可条件分支、可
 * 人工确认的自动执行步骤。
 *
 * 能力概览：
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 1. 攻击自动响应剧本                                                  │
 * │    - 每种攻击类型对应预置剧本（BUILTIN_PLAYBOOKS）                   │
 * │    - 支持条件分支（step.condition → if-then-else 逻辑）              │
 * │    - 支持人工确认步骤（高风险操作需 approval）                       │
 * │                                                                      │
 * │ 2. 自动隔离                                                          │
 * │    - 租户 / Agent / 工具 / 会话 / IP 五维隔离                        │
 * │    - 隔离记录可查询、可解除                                          │
 * │                                                                      │
 * │ 3. 自动恢复                                                          │
 * │    - 从安全快照回滚                                                  │
 * │    - 重置受影响基线                                                  │
 * │    - 轮换被泄露凭证                                                  │
 * │    - 重建被篡改依赖                                                  │
 * │                                                                      │
 * │ 4. 自动加固                                                          │
 * │    - 动态收紧速率限制                                                │
 * │    - 动态收紧成本上限（BillExplosionGuard）                          │
 * │    - 临时启用更严格 DLP（DataLossPrevention）                        │
 * │    - 封禁恶意 IP                                                     │
 * │                                                                      │
 * │ 5. 健康检查与验证                                                    │
 * │    - 恢复后自动验证所有安全组件                                      │
 * │    - 生成恢复报告                                                    │
 * │                                                                      │
 * │ 6. 攻击后分析                                                        │
 * │    - 完整攻击时间线（AttackTimeline）                                │
 * │    - 根因分析 / 影响摘要 / 改进建议                                  │
 * │    - 自动生成 lessons learned                                        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 集成模块：
 *   - SecurityAuditLogger：所有自愈事件落审计日志
 *   - AuditChainLedger：关键操作追加到防篡改哈希链
 *   - SecurityMonitor：健康检查、告警查询
 *   - BillExplosionGuard：成本上限收紧 / 快照恢复
 *   - DataLossPrevention：严格 DLP 策略启用
 *   - RuntimeDependencyGuard：依赖完整性重建 / 验证
 *   - getGlobalLogger / getGlobalMetrics：结构化日志与指标
 *   - createTenantAwareSingleton：多租户隔离单例
 *   - reportSilentFailure：可观测的静默错误恢复
 *
 * Usage:
 *   import { getSecuritySelfHealingEngine } from './security/securitySelfHealingEngine';
 *   const engine = getSecuritySelfHealingEngine();
 *   engine.registerPlaybook(customPlaybook);
 *   const result = await engine.triggerResponse('bill_explosion', { tenantId: 't1' }, {
 *     severity: 'critical',
 *     source: 'CostGuard',
 *   });
 *   console.log(result.success, result.systemHealthy);
 */

import { getSecurityAuditLogger, type SecurityEventType } from './securityAuditLogger';
import { getAuditChainLedger } from './auditChainLedger';
import { getSecurityMonitor } from './securityMonitor';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { reportSilentFailure } from '../silentFailureReporter';
import { getBillExplosionGuard, type BillGuardConfig } from './billExplosionGuard';
import { getDataLossPrevention, type DLPConfig } from './dataLossPrevention';
import { getRuntimeDependencyGuard } from './runtimeDependencyGuard';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 攻击类型枚举。
 *
 * 每种攻击类型对应一个或多个响应剧本。当 SecurityMonitor / CostGuard /
 * DLP 等检测层发现攻击时，会将攻击类型传递给自愈引擎以触发对应剧本。
 */
export type AttackType =
  | 'bill_explosion' // 账单爆炸攻击
  | 'data_leak' // 数据泄露
  | 'supply_chain_attack' // 供应链攻击
  | 'zero_day' // 零日攻击
  | 'ddos' // DDoS 攻击
  | 'prompt_injection' // 提示注入攻击
  | 'tool_poisoning' // 工具中毒
  | 'credential_leak' // 凭证泄露
  | 'sandbox_escape' // 沙箱逃逸
  | 'privilege_escalation' // 提权攻击
  | 'memory_poisoning' // 内存投毒
  | 'unknown'; // 未知攻击类型

/**
 * 剧本可执行的动作类型。
 *
 * - ISOLATE_*：隔离类动作（停止对应实体的活动）
 * - RESTORE_* / RESET_* / ROTATE_* / REBUILD_*：恢复类动作
 * - TIGHTEN_* / ENABLE_STRICT_DLP / BLOCK_IP：加固类动作
 * - NOTIFY_HUMAN：人工确认步骤
 * - VERIFY_HEALTH：健康检查
 * - GENERATE_REPORT：生成恢复报告
 */
export type PlaybookAction =
  | 'ISOLATE_TENANT'
  | 'ISOLATE_AGENT'
  | 'ISOLATE_TOOL'
  | 'ISOLATE_SESSION'
  | 'RESTORE_SNAPSHOT'
  | 'RESET_BASELINE'
  | 'ROTATE_CREDENTIAL'
  | 'REBUILD_DEPENDENCY'
  | 'TIGHTEN_RATE_LIMIT'
  | 'TIGHTEN_COST_LIMIT'
  | 'ENABLE_STRICT_DLP'
  | 'BLOCK_IP'
  | 'NOTIFY_HUMAN'
  | 'VERIFY_HEALTH'
  | 'GENERATE_REPORT';

/**
 * 隔离作用域。
 *
 * 描述一次隔离操作的作用范围。至少需要指定一个维度；多个维度可同时
 * 指定以实现组合隔离（例如同时隔离租户 + Agent）。
 */
export interface IsolationScope {
  /** 受影响的租户 ID */
  tenantId?: string;
  /** 受影响的 Agent ID */
  agentId?: string;
  /** 受影响的工具名称 */
  toolName?: string;
  /** 受影响的会话 ID */
  sessionId?: string;
  /** 源 IP 地址（用于 IP 封禁） */
  ipAddress?: string;
}

/**
 * 剧本步骤执行上下文。
 *
 * 在剧本执行期间在各步骤间传递的共享上下文，包含攻击类型、作用域、
 * 元数据，以及一个可在步骤间传递中间状态的 `state` 映射。
 */
export interface PlaybookExecutionContext {
  /** 触发本次执行的攻击类型 */
  attackType: AttackType;
  /** 隔离作用域 */
  scope: IsolationScope;
  /** 攻击元数据（severity、source、detectedAt 等） */
  metadata: Record<string, unknown>;
  /** 步骤间共享的状态映射（步骤可写入供后续步骤读取） */
  state: Map<string, unknown>;
  /** 本次攻击的时间线 */
  timeline: AttackTimeline;
}

/**
 * 剧本步骤。
 *
 * 每个步骤执行一个 {@link PlaybookAction}。步骤可携带条件函数以实现
 * if-then-else 分支：当 `condition` 返回 false 时该步骤被跳过。通过
 * 编写互补条件的两个步骤即可实现完整的 if-then-else 逻辑。
 */
export interface PlaybookStep {
  /** 步骤唯一 ID（剧本内唯一） */
  id: string;
  /** 执行的动作 */
  action: PlaybookAction;
  /** 动作参数（如 TIGHTEN_COST_LIMIT 的 factor、BLOCK_IP 的 ipAddress） */
  params?: Record<string, unknown>;
  /**
   * 条件函数。返回 false 时跳过此步骤，用于实现 if-then-else 分支。
   * 若不提供则无条件执行。
   */
  condition?: (context: PlaybookExecutionContext) => boolean;
  /** 单步超时时间（毫秒），超时后按 onFailure 处理 */
  timeoutMs?: number;
  /** 步骤失败时的处理策略 */
  onFailure?: 'continue' | 'abort' | 'retry' | 'escalate';
}

/**
 * 剧本触发条件。
 *
 * 描述一个剧本在何种攻击场景下被激活。引擎根据攻击类型和严重程度
 * 匹配触发条件以选择最高优先级的剧本执行。
 */
export interface PlaybookTriggerCondition {
  /** 匹配的攻击类型列表 */
  attackTypes: AttackType[];
  /** 最低触发严重程度（攻击严重程度 >= 此值才触发） */
  minSeverity?: 'low' | 'medium' | 'high' | 'critical';
  /** 是否允许自动触发（false 时仅手动执行） */
  autoTrigger?: boolean;
}

/**
 * 响应剧本。
 *
 * 定义针对特定攻击场景的一系列自动响应步骤。剧本按 `priority` 降序
 * 排列，当多个剧本匹配同一攻击时优先执行高优先级剧本。
 */
export interface Playbook {
  /** 剧本唯一 ID */
  id: string;
  /** 剧本名称 */
  name: string;
  /** 触发条件 */
  triggerCondition: PlaybookTriggerCondition;
  /** 执行步骤列表（按顺序执行） */
  steps: PlaybookStep[];
  /** 优先级（数值越大优先级越高，默认 0） */
  priority: number;
  /** 是否需要人工确认才能执行高风险步骤 */
  requiresHumanApproval: boolean;
  /** 创建时间（ISO 时间戳） */
  createdAt: string;
}

/**
 * 自愈执行结果。
 */
export interface HealingResult {
  /** 整体是否成功 */
  success: boolean;
  /** 成功执行的动作列表 */
  actionsTaken: string[];
  /** 失败的动作列表 */
  actionsFailed: string[];
  /** 总耗时（毫秒） */
  durationMs: number;
  /** 恢复报告（文本） */
  report: string;
  /** 恢复后系统是否健康 */
  systemHealthy: boolean;
}

/**
 * 攻击时间线事件。
 *
 * 时间线中的一个原子事件，记录了何时、由谁、发生了什么。
 */
export interface AttackTimelineEvent {
  /** ISO 时间戳 */
  timestamp: string;
  /** 事件类型（如 'detection'、'isolation'、'recovery'、'hardening'） */
  type: string;
  /** 事件描述 */
  description: string;
  /** 执行者（'system'、'human'、组件名等） */
  actor: string;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 攻击时间线。
 *
 * 完整记录一次攻击从检测到恢复的全生命周期，用于攻击后分析。
 */
export interface AttackTimeline {
  /** 攻击唯一 ID */
  attackId: string;
  /** 攻击开始时间（ISO 时间戳） */
  startTime: string;
  /** 攻击结束时间（ISO 时间戳，恢复完成后设置） */
  endTime: string | null;
  /** 时间线事件列表（按时间顺序） */
  events: AttackTimelineEvent[];
  /** 根因分析 */
  rootCause: string | null;
  /** 影响摘要 */
  impactSummary: string | null;
  /** 解决摘要 */
  resolutionSummary: string | null;
  /** 经验教训 / 改进建议 */
  lessonsLearned: string[];
}

/**
 * 加固措施。
 *
 * 传递给 {@link SecuritySelfHealingEngine.harden} 方法，描述需要施加的
 * 一组加固操作。
 */
export interface HardeningMeasures {
  /** 收紧速率限制（factor < 1 表示收紧，如 0.5 表示限制减半） */
  tightenRateLimit?: { factor: number; windowMs?: number };
  /** 收紧成本上限（factor < 1 表示收紧） */
  tightenCostLimit?: { factor: number };
  /** 启用严格 DLP 策略 */
  enableStrictDlp?: boolean;
  /** 封禁的 IP 列表 */
  blockIps?: string[];
}

/**
 * 安全快照。
 *
 * 记录某一时刻安全组件的配置状态，用于恢复操作。
 */
export interface SecuritySnapshot {
  /** 快照 ID */
  id: string;
  /** 快照时间（ISO 时间戳） */
  takenAt: string;
  /** 快照作用域 */
  scope: IsolationScope;
  /** BillExplosionGuard 配置快照 */
  billGuardConfig?: Record<string, unknown>;
  /** DataLossPrevention 配置快照 */
  dlpConfig?: Record<string, unknown>;
  /** 当时的隔离状态摘要 */
  isolationCount: number;
}

/**
 * 隔离记录。
 */
export interface IsolationRecord {
  /** 隔离作用域 */
  scope: IsolationScope;
  /** 隔离原因 */
  reason: string;
  /** 隔离时间戳（毫秒） */
  isolatedAt: number;
  /** 执行隔离的操作者 */
  isolatedBy: string;
  /** 解除时间戳（毫秒，未解除则为 null） */
  liftedAt: number | null;
  /** 隔离维度键（用于快速查找） */
  dimension: 'tenant' | 'agent' | 'tool' | 'session' | 'ip';
}

/**
 * 健康验证结果。
 */
export interface HealthVerificationResult {
  /** 整体是否健康 */
  healthy: boolean;
  /** 各组件健康状态 */
  components: Array<{
    /** 组件名称 */
    name: string;
    /** 是否健康 */
    healthy: boolean;
    /** 详情描述 */
    details: string;
  }>;
  /** 检查时间（ISO 时间戳） */
  checkedAt: string;
}

/**
 * 自愈统计信息。
 */
export interface SelfHealingStats {
  /** 总触发次数 */
  totalTriggers: number;
  /** 成功次数 */
  successfulHeals: number;
  /** 失败次数 */
  failedHeals: number;
  /** 当前活跃隔离数 */
  activeIsolations: number;
  /** 历史隔离总数 */
  totalIsolations: number;
  /** 已执行的动作总数 */
  totalActionsExecuted: number;
  /** 平均恢复耗时（毫秒） */
  avgHealDurationMs: number;
  /** 按攻击类型统计 */
  byAttackType: Record<string, number>;
  /** 按动作类型统计 */
  byAction: Record<string, number>;
  /** 保存的快照数 */
  snapshotCount: number;
}

/**
 * 自愈引擎配置。
 */
export interface SelfHealingConfig {
  /** 是否启用自愈引擎 */
  enabled: boolean;
  /** 是否自动触发剧本（false 时仅手动执行） */
  autoTrigger: boolean;
  /** 人工确认超时时间（毫秒），超时视为拒绝 */
  humanApprovalTimeoutMs: number;
  /** 最大并发剧本执行数 */
  maxConcurrentPlaybooks: number;
  /** 默认单步超时时间（毫秒） */
  defaultStepTimeoutMs: number;
  /** 健康检查超时时间（毫秒） */
  healthCheckTimeoutMs: number;
  /** 隔离自动过期时间（毫秒，0 表示不过期） */
  isolationTtlMs: number;
  /** 需要人工确认的动作列表 */
  requireHumanApprovalFor: PlaybookAction[];
  /** 默认速率限制收紧因子 */
  defaultRateLimitTightenFactor: number;
  /** 默认成本上限收紧因子 */
  defaultCostLimitTightenFactor: number;
  /** 快照最大保留数量 */
  snapshotRetention: number;
}

/**
 * 人工确认处理器类型。
 *
 * 当剧本步骤需要人工确认时调用。返回 true 表示批准，false 表示拒绝。
 */
export type HumanApprovalHandler = (
  step: PlaybookStep,
  context: PlaybookExecutionContext,
) => Promise<boolean>;

/**
 * 凭证轮换处理器类型。
 *
 * 当执行 ROTATE_CREDENTIAL 动作时调用。返回轮换结果描述。
 */
export type CredentialRotationHandler = (
  scope: IsolationScope,
  params?: Record<string, unknown>,
) => Promise<{ success: boolean; message: string }>;

/** 单步动作执行结果 */
interface StepActionResult {
  success: boolean;
  message: string;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: SelfHealingConfig = {
  enabled: true,
  autoTrigger: true,
  humanApprovalTimeoutMs: 300_000, // 5 分钟
  maxConcurrentPlaybooks: 4,
  defaultStepTimeoutMs: 30_000, // 30 秒
  healthCheckTimeoutMs: 15_000, // 15 秒
  isolationTtlMs: 0, // 默认不过期
  requireHumanApprovalFor: ['ISOLATE_TENANT', 'RESTORE_SNAPSHOT', 'RESET_BASELINE'],
  defaultRateLimitTightenFactor: 0.5,
  defaultCostLimitTightenFactor: 0.5,
  snapshotRetention: 20,
};

// ============================================================================
// 内置剧本（BUILTIN_PLAYBOOKS）
// ============================================================================

/**
 * 内置响应剧本集合。
 *
 * 覆盖 8 类常见攻击场景，引擎初始化时自动注册。可通过
 * {@link SecuritySelfHealingEngine.registerPlaybook} 追加自定义剧本。
 */
export const BUILTIN_PLAYBOOKS: Playbook[] = [
  // ── 1. 账单爆炸攻击响应 ──────────────────────────────────────────
  {
    id: 'builtin-bill-explosion-response',
    name: '账单爆炸攻击响应剧本',
    triggerCondition: {
      attackTypes: ['bill_explosion'],
      minSeverity: 'high',
      autoTrigger: true,
    },
    priority: 90,
    requiresHumanApproval: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'be-1',
        action: 'TIGHTEN_COST_LIMIT',
        params: { factor: 0.3 },
        onFailure: 'continue',
      },
      {
        id: 'be-2',
        action: 'ISOLATE_SESSION',
        onFailure: 'continue',
      },
      {
        id: 'be-3',
        action: 'ISOLATE_TENANT',
        condition: (ctx) => ctx.metadata.severity === 'critical',
        onFailure: 'abort',
      },
      {
        id: 'be-4',
        action: 'ROTATE_CREDENTIAL',
        condition: (ctx) => ctx.metadata.credentialAbuse === true,
        onFailure: 'continue',
      },
      {
        id: 'be-5',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'be-6',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },

  // ── 2. 数据泄露响应 ──────────────────────────────────────────────
  {
    id: 'builtin-data-leak-response',
    name: '数据泄露响应剧本',
    triggerCondition: {
      attackTypes: ['data_leak'],
      minSeverity: 'high',
      autoTrigger: true,
    },
    priority: 95,
    requiresHumanApproval: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'dl-1',
        action: 'ENABLE_STRICT_DLP',
        onFailure: 'abort',
      },
      {
        id: 'dl-2',
        action: 'ISOLATE_SESSION',
        onFailure: 'continue',
      },
      {
        id: 'dl-3',
        action: 'ISOLATE_AGENT',
        condition: (ctx) => ctx.scope.agentId !== undefined,
        onFailure: 'continue',
      },
      {
        id: 'dl-4',
        action: 'ROTATE_CREDENTIAL',
        condition: (ctx) =>
          ctx.metadata.leakedDataTypes !== undefined &&
          Array.isArray(ctx.metadata.leakedDataTypes) &&
          (ctx.metadata.leakedDataTypes as unknown[]).includes('credential'),
        onFailure: 'escalate',
      },
      {
        id: 'dl-5',
        action: 'NOTIFY_HUMAN',
        params: { reason: '数据泄露事件需人工确认影响范围' },
        onFailure: 'continue',
      },
      {
        id: 'dl-6',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'dl-7',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },

  // ── 3. 供应链攻击响应 ────────────────────────────────────────────
  {
    id: 'builtin-supply-chain-response',
    name: '供应链攻击响应剧本',
    triggerCondition: {
      attackTypes: ['supply_chain_attack'],
      minSeverity: 'critical',
      autoTrigger: true,
    },
    priority: 100,
    requiresHumanApproval: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'sc-1',
        action: 'ISOLATE_AGENT',
        onFailure: 'abort',
      },
      {
        id: 'sc-2',
        action: 'ISOLATE_TOOL',
        condition: (ctx) => ctx.scope.toolName !== undefined,
        onFailure: 'continue',
      },
      {
        id: 'sc-3',
        action: 'NOTIFY_HUMAN',
        params: { reason: '供应链攻击需人工确认后再重建依赖' },
        onFailure: 'abort',
      },
      {
        id: 'sc-4',
        action: 'REBUILD_DEPENDENCY',
        onFailure: 'escalate',
      },
      {
        id: 'sc-5',
        action: 'RESET_BASELINE',
        onFailure: 'continue',
      },
      {
        id: 'sc-6',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'sc-7',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },

  // ── 4. 零日攻击响应 ──────────────────────────────────────────────
  {
    id: 'builtin-zero-day-response',
    name: '零日攻击响应剧本',
    triggerCondition: {
      attackTypes: ['zero_day'],
      minSeverity: 'high',
      autoTrigger: true,
    },
    priority: 98,
    requiresHumanApproval: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'zd-1',
        action: 'ISOLATE_TENANT',
        condition: (ctx) => ctx.metadata.severity === 'critical',
        onFailure: 'abort',
      },
      {
        id: 'zd-2',
        action: 'ISOLATE_AGENT',
        onFailure: 'continue',
      },
      {
        id: 'zd-3',
        action: 'TIGHTEN_RATE_LIMIT',
        params: { factor: 0.2 },
        onFailure: 'continue',
      },
      {
        id: 'zd-4',
        action: 'ENABLE_STRICT_DLP',
        onFailure: 'continue',
      },
      {
        id: 'zd-5',
        action: 'NOTIFY_HUMAN',
        params: { reason: '零日攻击需人工介入分析' },
        onFailure: 'continue',
      },
      {
        id: 'zd-6',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'zd-7',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },

  // ── 5. DDoS 攻击响应 ─────────────────────────────────────────────
  {
    id: 'builtin-ddos-response',
    name: 'DDoS 攻击响应剧本',
    triggerCondition: {
      attackTypes: ['ddos'],
      minSeverity: 'high',
      autoTrigger: true,
    },
    priority: 85,
    requiresHumanApproval: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'dd-1',
        action: 'BLOCK_IP',
        condition: (ctx) => ctx.scope.ipAddress !== undefined,
        onFailure: 'continue',
      },
      {
        id: 'dd-2',
        action: 'TIGHTEN_RATE_LIMIT',
        params: { factor: 0.1 },
        onFailure: 'continue',
      },
      {
        id: 'dd-3',
        action: 'TIGHTEN_COST_LIMIT',
        params: { factor: 0.5 },
        onFailure: 'continue',
      },
      {
        id: 'dd-4',
        action: 'ISOLATE_TENANT',
        condition: (ctx) => ctx.metadata.overwhelmed === true,
        onFailure: 'continue',
      },
      {
        id: 'dd-5',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'dd-6',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },

  // ── 6. 提示注入攻击响应 ──────────────────────────────────────────
  {
    id: 'builtin-prompt-injection-response',
    name: '提示注入攻击响应剧本',
    triggerCondition: {
      attackTypes: ['prompt_injection'],
      minSeverity: 'medium',
      autoTrigger: true,
    },
    priority: 80,
    requiresHumanApproval: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'pi-1',
        action: 'ISOLATE_SESSION',
        onFailure: 'abort',
      },
      {
        id: 'pi-2',
        action: 'ISOLATE_AGENT',
        condition: (ctx) => ctx.metadata.persistent === true,
        onFailure: 'continue',
      },
      {
        id: 'pi-3',
        action: 'ISOLATE_TOOL',
        condition: (ctx) => ctx.scope.toolName !== undefined,
        onFailure: 'continue',
      },
      {
        id: 'pi-4',
        action: 'RESET_BASELINE',
        onFailure: 'continue',
      },
      {
        id: 'pi-5',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'pi-6',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },

  // ── 7. 工具中毒响应 ──────────────────────────────────────────────
  {
    id: 'builtin-tool-poisoning-response',
    name: '工具中毒响应剧本',
    triggerCondition: {
      attackTypes: ['tool_poisoning'],
      minSeverity: 'high',
      autoTrigger: true,
    },
    priority: 92,
    requiresHumanApproval: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'tp-1',
        action: 'ISOLATE_TOOL',
        onFailure: 'abort',
      },
      {
        id: 'tp-2',
        action: 'ISOLATE_AGENT',
        condition: (ctx) => ctx.metadata.agentCompromised === true,
        onFailure: 'continue',
      },
      {
        id: 'tp-3',
        action: 'REBUILD_DEPENDENCY',
        condition: (ctx) => ctx.metadata.dependencyTampered === true,
        onFailure: 'escalate',
      },
      {
        id: 'tp-4',
        action: 'NOTIFY_HUMAN',
        params: { reason: '工具中毒需人工确认工具定义完整性' },
        onFailure: 'continue',
      },
      {
        id: 'tp-5',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'tp-6',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },

  // ── 8. 凭证泄露响应 ──────────────────────────────────────────────
  {
    id: 'builtin-credential-leak-response',
    name: '凭证泄露响应剧本',
    triggerCondition: {
      attackTypes: ['credential_leak'],
      minSeverity: 'high',
      autoTrigger: true,
    },
    priority: 97,
    requiresHumanApproval: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    steps: [
      {
        id: 'cl-1',
        action: 'ROTATE_CREDENTIAL',
        onFailure: 'abort',
      },
      {
        id: 'cl-2',
        action: 'ISOLATE_SESSION',
        onFailure: 'continue',
      },
      {
        id: 'cl-3',
        action: 'BLOCK_IP',
        condition: (ctx) => ctx.scope.ipAddress !== undefined,
        onFailure: 'continue',
      },
      {
        id: 'cl-4',
        action: 'ENABLE_STRICT_DLP',
        onFailure: 'continue',
      },
      {
        id: 'cl-5',
        action: 'ISOLATE_TENANT',
        condition: (ctx) => ctx.metadata.widespread === true,
        onFailure: 'continue',
      },
      {
        id: 'cl-6',
        action: 'NOTIFY_HUMAN',
        params: { reason: '凭证泄露需人工确认所有受影响系统' },
        onFailure: 'continue',
      },
      {
        id: 'cl-7',
        action: 'VERIFY_HEALTH',
        onFailure: 'continue',
      },
      {
        id: 'cl-8',
        action: 'GENERATE_REPORT',
        onFailure: 'continue',
      },
    ],
  },
];

// ============================================================================
// SecuritySelfHealingEngine
// ============================================================================

/**
 * 安全自愈引擎。
 *
 * 核心职责：在攻击或安全违规被检测到后，自动编排隔离、恢复、加固
 * 操作，使系统回归已知安全状态，并记录完整攻击时间线供事后分析。
 *
 * 引擎通过响应剧本（Playbook）组织响应逻辑，每个剧本定义了一组
 * 有序、可条件分支、可人工确认的步骤。内置 8 个预置剧本覆盖常见
 * 攻击场景，亦支持通过 {@link registerPlaybook} 注册自定义剧本。
 */
export class SecuritySelfHealingEngine {
  private config: SelfHealingConfig;
  private playbooks: Map<string, Playbook> = new Map();
  private isolations: Map<string, IsolationRecord> = new Map();
  private timelines: Map<string, AttackTimeline> = new Map();
  private snapshots: SecuritySnapshot[] = [];
  private blockedIps: Set<string> = new Set();
  private rateLimitOverrides: Map<string, { factor: number; windowMs: number }> = new Map();
  private credentialRotationHandler: CredentialRotationHandler | null = null;
  private humanApprovalHandler: HumanApprovalHandler | null = null;

  // 统计计数器
  private stats: {
    totalTriggers: number;
    successfulHeals: number;
    failedHeals: number;
    totalIsolations: number;
    totalActionsExecuted: number;
    totalHealDurationMs: number;
    byAttackType: Record<string, number>;
    byAction: Record<string, number>;
  };

  /** 自增序列号，用于生成唯一 ID */
  private seq: number = 0;

  constructor(config?: Partial<SelfHealingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = {
      totalTriggers: 0,
      successfulHeals: 0,
      failedHeals: 0,
      totalIsolations: 0,
      totalActionsExecuted: 0,
      totalHealDurationMs: 0,
      byAttackType: {},
      byAction: {},
    };
    // 注册内置剧本
    for (const playbook of BUILTIN_PLAYBOOKS) {
      this.playbooks.set(playbook.id, playbook);
    }
  }

  // ── 生命周期与配置 ───────────────────────────────────────────────

  /**
   * 更新引擎配置。传入的部分配置将与当前配置合并。
   *
   * @param config - 部分配置项
   */
  configure(config: Partial<SelfHealingConfig>): void {
    this.config = { ...this.config, ...config };
    getGlobalLogger().info('SecuritySelfHealingEngine', '配置已更新', {
      enabled: this.config.enabled,
      autoTrigger: this.config.autoTrigger,
    });
  }

  /**
   * 重置引擎状态。
   *
   * 清除所有隔离记录、时间线、快照、封禁 IP 和统计计数器，
   * 并重新注册内置剧本。配置不重置。
   */
  reset(): void {
    this.isolations.clear();
    this.timelines.clear();
    this.snapshots = [];
    this.blockedIps.clear();
    this.rateLimitOverrides.clear();
    this.credentialRotationHandler = null;
    this.humanApprovalHandler = null;
    this.seq = 0;
    this.stats = {
      totalTriggers: 0,
      successfulHeals: 0,
      failedHeals: 0,
      totalIsolations: 0,
      totalActionsExecuted: 0,
      totalHealDurationMs: 0,
      byAttackType: {},
      byAction: {},
    };
    // 重新注册内置剧本
    this.playbooks.clear();
    for (const playbook of BUILTIN_PLAYBOOKS) {
      this.playbooks.set(playbook.id, playbook);
    }
    getGlobalLogger().info('SecuritySelfHealingEngine', '引擎状态已重置');
  }

  // ── 剧本管理 ─────────────────────────────────────────────────────

  /**
   * 注册响应剧本。若已存在同 ID 剧本则覆盖。
   *
   * @param playbook - 要注册的剧本
   */
  registerPlaybook(playbook: Playbook): void {
    this.playbooks.set(playbook.id, playbook);
    getGlobalLogger().info('SecuritySelfHealingEngine', '剧本已注册', {
      playbookId: playbook.id,
      playbookName: playbook.name,
      priority: playbook.priority,
    });
    getGlobalMetrics().incrementCounter('self_healing.playbooks_registered', 1, {
      playbookId: playbook.id,
    });
  }

  /**
   * 注销剧本。
   *
   * @param id - 剧本 ID
   * @returns 是否成功注销
   */
  unregisterPlaybook(id: string): boolean {
    const deleted = this.playbooks.delete(id);
    if (deleted) {
      getGlobalLogger().info('SecuritySelfHealingEngine', '剧本已注销', { playbookId: id });
    }
    return deleted;
  }

  /**
   * 获取指定剧本。
   *
   * @param id - 剧本 ID
   * @returns 剧本对象，不存在则返回 undefined
   */
  getPlaybook(id: string): Playbook | undefined {
    return this.playbooks.get(id);
  }

  /**
   * 获取所有已注册剧本。
   *
   * @returns 剧本列表（按优先级降序）
   */
  getAllPlaybooks(): Playbook[] {
    return Array.from(this.playbooks.values()).sort((a, b) => b.priority - a.priority);
  }

  // ── 响应触发 ─────────────────────────────────────────────────────

  /**
   * 触发自动响应。
   *
   * 根据攻击类型和元数据中的严重程度，匹配触发条件最优的剧本并执行。
   * 若引擎已禁用或自动触发已关闭，则仅记录时间线不执行剧本。
   *
   * @param attackType - 攻击类型
   * @param scope - 隔离作用域
   * @param metadata - 攻击元数据（应包含 severity 字段）
   * @returns 自愈执行结果
   */
  async triggerResponse(
    attackType: AttackType,
    scope: IsolationScope,
    metadata: Record<string, unknown> = {},
  ): Promise<HealingResult> {
    const startTime = Date.now();
    const attackId = this.generateId('attack');
    const nowIso = new Date().toISOString();

    // 创建攻击时间线
    const timeline: AttackTimeline = {
      attackId,
      startTime: nowIso,
      endTime: null,
      events: [],
      rootCause: null,
      impactSummary: null,
      resolutionSummary: null,
      lessonsLearned: [],
    };
    this.timelines.set(attackId, timeline);

    // 记录检测事件
    this.recordTimelineEvent(timeline, {
      timestamp: nowIso,
      type: 'detection',
      description: `检测到 ${attackType} 攻击`,
      actor: String(metadata.source ?? 'SecurityMonitor'),
      severity: this.toSeverity(metadata.severity),
      metadata: { attackType, scope, ...metadata },
    });

    this.stats.totalTriggers += 1;
    this.stats.byAttackType[attackType] = (this.stats.byAttackType[attackType] ?? 0) + 1;

    getGlobalLogger().warn('SecuritySelfHealingEngine', '检测到攻击，触发自愈响应', {
      attackId,
      attackType,
      scope,
      severity: metadata.severity,
    });

    getGlobalMetrics().incrementCounter('self_healing.triggers_total', 1, {
      attackType,
      severity: String(metadata.severity ?? 'unknown'),
    });

    // 引擎禁用时不执行
    if (!this.config.enabled) {
      const msg = '自愈引擎已禁用，仅记录时间线';
      this.recordTimelineEvent(timeline, {
        timestamp: new Date().toISOString(),
        type: 'skipped',
        description: msg,
        actor: 'system',
        severity: 'low',
      });
      this.finalizeTimeline(timeline, '引擎禁用，未执行响应', attackType);
      return {
        success: false,
        actionsTaken: [],
        actionsFailed: [],
        durationMs: Date.now() - startTime,
        report: msg,
        systemHealthy: false,
      };
    }

    // 查找匹配剧本
    const playbook = this.findBestPlaybook(attackType, metadata);

    if (!playbook) {
      const msg = `未找到匹配 ${attackType} 的响应剧本`;
      getGlobalLogger().warn('SecuritySelfHealingEngine', msg, { attackId });
      this.recordTimelineEvent(timeline, {
        timestamp: new Date().toISOString(),
        type: 'no_playbook',
        description: msg,
        actor: 'system',
        severity: 'medium',
      });
      this.finalizeTimeline(timeline, '无匹配剧本', attackType);
      return {
        success: false,
        actionsTaken: [],
        actionsFailed: [],
        durationMs: Date.now() - startTime,
        report: msg,
        systemHealthy: false,
      };
    }

    // 自动触发关闭时仅手动可执行
    if (!this.config.autoTrigger && playbook.triggerCondition.autoTrigger !== false) {
      // autoTrigger 全局关闭时仍允许 autoTrigger=false 的剧本手动执行场景
      // 但此处是自动触发入口，全局关闭则不自动执行
      const msg = '自动触发已关闭，需手动执行剧本';
      this.recordTimelineEvent(timeline, {
        timestamp: new Date().toISOString(),
        type: 'skipped',
        description: msg,
        actor: 'system',
        severity: 'low',
      });
      this.finalizeTimeline(timeline, '自动触发关闭', attackType);
      return {
        success: false,
        actionsTaken: [],
        actionsFailed: [],
        durationMs: Date.now() - startTime,
        report: msg,
        systemHealthy: false,
      };
    }

    // 执行剧本
    const result = await this.executePlaybook(playbook, scope, metadata);

    // 更新统计
    if (result.success) {
      this.stats.successfulHeals += 1;
    } else {
      this.stats.failedHeals += 1;
    }
    this.stats.totalHealDurationMs += result.durationMs;

    // 完成时间线
    this.finalizeTimeline(
      timeline,
      result.success ? '响应成功完成' : '响应未完全成功',
      attackType,
    );

    // 将执行结果摘要追加到时间线
    this.recordTimelineEvent(timeline, {
      timestamp: new Date().toISOString(),
      type: 'completion',
      description: `自愈响应完成：成功 ${result.actionsTaken.length} 项，失败 ${result.actionsFailed.length} 项，耗时 ${result.durationMs}ms`,
      actor: 'system',
      severity: result.success ? 'low' : 'high',
      metadata: {
        actionsTaken: result.actionsTaken,
        actionsFailed: result.actionsFailed,
        systemHealthy: result.systemHealthy,
      },
    });

    return result;
  }

  /**
   * 执行指定剧本。
   *
   * 按顺序执行剧本中的每个步骤：评估条件、检查人工确认需求、执行动作、
   * 处理失败策略。执行完成后自动进行健康检查并生成恢复报告。
   *
   * @param playbook - 要执行的剧本
   * @param scope - 隔离作用域
   * @param metadata - 攻击元数据
   * @returns 自愈执行结果
   */
  async executePlaybook(
    playbook: Playbook,
    scope: IsolationScope,
    metadata: Record<string, unknown>,
  ): Promise<HealingResult> {
    const startTime = Date.now();
    const actionsTaken: string[] = [];
    const actionsFailed: string[] = [];

    getGlobalLogger().info('SecuritySelfHealingEngine', '开始执行剧本', {
      playbookId: playbook.id,
      playbookName: playbook.name,
      requiresHumanApproval: playbook.requiresHumanApproval,
    });

    getGlobalMetrics().incrementCounter('self_healing.playbook_executions', 1, {
      playbookId: playbook.id,
    });

    // 构建执行上下文
    const attackId = this.generateId('attack');
    const timeline: AttackTimeline = {
      attackId,
      startTime: new Date().toISOString(),
      endTime: null,
      events: [],
      rootCause: null,
      impactSummary: null,
      resolutionSummary: null,
      lessonsLearned: [],
    };
    this.timelines.set(attackId, timeline);

    const context: PlaybookExecutionContext = {
      attackType: (metadata.attackType as AttackType) ?? 'unknown',
      scope,
      metadata,
      state: new Map<string, unknown>(),
      timeline,
    };

    this.recordTimelineEvent(timeline, {
      timestamp: new Date().toISOString(),
      type: 'playbook_start',
      description: `开始执行剧本: ${playbook.name}`,
      actor: 'system',
      severity: 'medium',
      metadata: { playbookId: playbook.id },
    });

    // 若剧本整体需要人工确认，先请求确认
    if (playbook.requiresHumanApproval) {
      const approved = await this.requestHumanApproval(
        {
          id: 'playbook-approval',
          action: 'NOTIFY_HUMAN',
          params: { reason: `剧本 ${playbook.name} 需要人工确认后执行` },
        },
        context,
      );
      if (!approved) {
        const msg = `剧本 ${playbook.name} 的人工确认被拒绝或超时`;
        actionsFailed.push(`HUMAN_APPROVAL:${playbook.id}`);
        this.recordTimelineEvent(timeline, {
          timestamp: new Date().toISOString(),
          type: 'approval_denied',
          description: msg,
          actor: 'human',
          severity: 'high',
        });
        this.finalizeTimeline(timeline, msg, context.attackType);
        return {
          success: false,
          actionsTaken,
          actionsFailed,
          durationMs: Date.now() - startTime,
          report: msg,
          systemHealthy: false,
        };
      }
      this.recordTimelineEvent(timeline, {
        timestamp: new Date().toISOString(),
        type: 'approval_granted',
        description: `剧本 ${playbook.name} 已获人工确认`,
        actor: 'human',
        severity: 'low',
      });
    }

    // 逐步执行
    let aborted = false;
    for (const step of playbook.steps) {
      if (aborted) break;

      // 评估条件
      if (step.condition !== undefined) {
        let conditionResult = false;
        try {
          conditionResult = step.condition(context);
        } catch (err) {
          reportSilentFailure(err, `SecuritySelfHealingEngine.executePlaybook.condition[${step.id}]`);
          conditionResult = false;
        }
        if (!conditionResult) {
          getGlobalLogger().debug('SecuritySelfHealingEngine', '步骤条件不满足，跳过', {
            stepId: step.id,
            action: step.action,
          });
          continue;
        }
      }

      // 检查该动作是否需要人工确认
      const needsApproval =
        this.config.requireHumanApprovalFor.includes(step.action) ||
        playbook.requiresHumanApproval;
      if (needsApproval && step.action !== 'NOTIFY_HUMAN') {
        const approved = await this.requestHumanApproval(step, context);
        if (!approved) {
          const msg = `步骤 ${step.id}(${step.action}) 人工确认被拒绝`;
          actionsFailed.push(step.action);
          this.recordTimelineEvent(timeline, {
            timestamp: new Date().toISOString(),
            type: 'approval_denied',
            description: msg,
            actor: 'human',
            severity: 'medium',
            metadata: { stepId: step.id, action: step.action },
          });
          if (step.onFailure === 'abort' || step.onFailure === 'escalate') {
            aborted = true;
          }
          continue;
        }
      }

      // 执行动作
      const result = await this.executeStep(step, context);
      this.stats.totalActionsExecuted += 1;
      this.stats.byAction[step.action] = (this.stats.byAction[step.action] ?? 0) + 1;

      if (result.success) {
        actionsTaken.push(step.action);
        this.recordTimelineEvent(timeline, {
          timestamp: new Date().toISOString(),
          type: this.getEventTypeForAction(step.action),
          description: `步骤 ${step.id}(${step.action}) 执行成功: ${result.message}`,
          actor: 'system',
          severity: 'low',
          metadata: { stepId: step.id, action: step.action },
        });
      } else {
        actionsFailed.push(step.action);
        this.recordTimelineEvent(timeline, {
          timestamp: new Date().toISOString(),
          type: 'action_failed',
          description: `步骤 ${step.id}(${step.action}) 执行失败: ${result.message}`,
          actor: 'system',
          severity: 'high',
          metadata: { stepId: step.id, action: step.action, error: result.message },
        });

        // 处理失败策略
        const strategy = step.onFailure ?? 'continue';
        if (strategy === 'abort') {
          aborted = true;
          getGlobalLogger().warn('SecuritySelfHealingEngine', '步骤失败，中止剧本执行', {
            stepId: step.id,
            action: step.action,
          });
        } else if (strategy === 'escalate') {
          // 升级：通知人工并中止
          await this.executeAction('NOTIFY_HUMAN', scope, {
            reason: `步骤 ${step.id}(${step.action}) 失败并触发升级: ${result.message}`,
          }, context);
          actionsTaken.push('NOTIFY_HUMAN');
          aborted = true;
        } else if (strategy === 'retry') {
          // 重试一次
          getGlobalLogger().info('SecuritySelfHealingEngine', '步骤失败，重试一次', {
            stepId: step.id,
            action: step.action,
          });
          const retryResult = await this.executeStep(step, context);
          if (retryResult.success) {
            actionsTaken.push(step.action);
            actionsFailed.pop(); // 移除之前的失败记录
          }
        }
        // 'continue' 则继续下一步
      }
    }

    // 健康检查
    let systemHealthy = false;
    let healthReport = '';
    try {
      const health = await this.verifyHealth();
      systemHealthy = health.healthy;
      healthReport = health.components
        .map((c) => `  - ${c.name}: ${c.healthy ? 'OK' : 'FAIL'} (${c.details})`)
        .join('\n');
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.executePlaybook.verifyHealth');
      healthReport = '健康检查异常';
    }

    const durationMs = Date.now() - startTime;
    const success = actionsFailed.length === 0 && !aborted;

    // 生成恢复报告
    const report = this.generateRecoveryReport(
      playbook,
      actionsTaken,
      actionsFailed,
      durationMs,
      systemHealthy,
      healthReport,
    );

    this.recordTimelineEvent(timeline, {
      timestamp: new Date().toISOString(),
      type: 'playbook_end',
      description: `剧本 ${playbook.name} 执行完成`,
      actor: 'system',
      severity: success ? 'low' : 'high',
      metadata: {
        success,
        actionsTaken: actionsTaken.length,
        actionsFailed: actionsFailed.length,
        durationMs,
        systemHealthy,
      },
    });

    this.finalizeTimeline(
      timeline,
      success ? '剧本执行成功' : '剧本执行完成但存在失败步骤',
      context.attackType,
    );

    getGlobalLogger().info('SecuritySelfHealingEngine', '剧本执行完成', {
      playbookId: playbook.id,
      success,
      actionsTaken: actionsTaken.length,
      actionsFailed: actionsFailed.length,
      durationMs,
      systemHealthy,
    });

    getGlobalMetrics().recordTimer('self_healing.playbook_duration_ms', durationMs, {
      playbookId: playbook.id,
      success: String(success),
    });

    return {
      success,
      actionsTaken,
      actionsFailed,
      durationMs,
      report,
      systemHealthy,
    };
  }

  // ── 隔离机制 ─────────────────────────────────────────────────────

  /**
   * 执行隔离操作。
   *
   * 根据作用域中指定的维度（租户、Agent、工具、会话、IP）执行隔离。
   * 每个维度独立记录，可通过 {@link isIsolated} 查询、{@link liftIsolation} 解除。
   *
   * @param scope - 隔离作用域
   * @param reason - 隔离原因
   * @returns 隔离结果描述
   */
  async isolate(scope: IsolationScope, reason: string): Promise<StepActionResult> {
    const isolatedDims: string[] = [];

    if (scope.tenantId) {
      const key = `tenant:${scope.tenantId}`;
      if (!this.isolations.has(key)) {
        this.isolations.set(key, {
          scope: { tenantId: scope.tenantId },
          reason,
          isolatedAt: Date.now(),
          isolatedBy: 'SecuritySelfHealingEngine',
          liftedAt: null,
          dimension: 'tenant',
        });
        isolatedDims.push(`tenant=${scope.tenantId}`);
        this.stats.totalIsolations += 1;
      }
    }

    if (scope.agentId) {
      const key = `agent:${scope.agentId}`;
      if (!this.isolations.has(key)) {
        this.isolations.set(key, {
          scope: { agentId: scope.agentId },
          reason,
          isolatedAt: Date.now(),
          isolatedBy: 'SecuritySelfHealingEngine',
          liftedAt: null,
          dimension: 'agent',
        });
        isolatedDims.push(`agent=${scope.agentId}`);
        this.stats.totalIsolations += 1;
      }
    }

    if (scope.toolName) {
      const key = `tool:${scope.toolName}`;
      if (!this.isolations.has(key)) {
        this.isolations.set(key, {
          scope: { toolName: scope.toolName },
          reason,
          isolatedAt: Date.now(),
          isolatedBy: 'SecuritySelfHealingEngine',
          liftedAt: null,
          dimension: 'tool',
        });
        isolatedDims.push(`tool=${scope.toolName}`);
        this.stats.totalIsolations += 1;
      }
    }

    if (scope.sessionId) {
      const key = `session:${scope.sessionId}`;
      if (!this.isolations.has(key)) {
        this.isolations.set(key, {
          scope: { sessionId: scope.sessionId },
          reason,
          isolatedAt: Date.now(),
          isolatedBy: 'SecuritySelfHealingEngine',
          liftedAt: null,
          dimension: 'session',
        });
        isolatedDims.push(`session=${scope.sessionId}`);
        this.stats.totalIsolations += 1;
      }
    }

    if (scope.ipAddress) {
      const key = `ip:${scope.ipAddress}`;
      if (!this.isolations.has(key)) {
        this.isolations.set(key, {
          scope: { ipAddress: scope.ipAddress },
          reason,
          isolatedAt: Date.now(),
          isolatedBy: 'SecuritySelfHealingEngine',
          liftedAt: null,
          dimension: 'ip',
        });
        isolatedDims.push(`ip=${scope.ipAddress}`);
        this.stats.totalIsolations += 1;
      }
    }

    const message =
      isolatedDims.length > 0
        ? `已隔离: ${isolatedDims.join(', ')}`
        : '无需隔离（作用域为空）';

    this.logSecurityEvent('security_decision', 'high', 'SecuritySelfHealingEngine', message, {
      scope,
      reason,
      isolatedDims,
    });

    getGlobalLogger().warn('SecuritySelfHealingEngine', '执行隔离', { scope, reason, isolatedDims });
    getGlobalMetrics().incrementCounter('self_healing.isolations', isolatedDims.length, {
      reason,
    });

    return { success: true, message };
  }

  /**
   * 检查指定作用域是否已被隔离。
   *
   * 只要作用域中任一维度处于隔离状态即返回 true。
   *
   * @param scope - 要检查的作用域
   * @returns 是否已隔离
   */
  isIsolated(scope: IsolationScope): boolean {
    if (scope.tenantId && this.isolations.has(`tenant:${scope.tenantId}`)) {
      const rec = this.isolations.get(`tenant:${scope.tenantId}`);
      if (rec && rec.liftedAt === null) return true;
    }
    if (scope.agentId && this.isolations.has(`agent:${scope.agentId}`)) {
      const rec = this.isolations.get(`agent:${scope.agentId}`);
      if (rec && rec.liftedAt === null) return true;
    }
    if (scope.toolName && this.isolations.has(`tool:${scope.toolName}`)) {
      const rec = this.isolations.get(`tool:${scope.toolName}`);
      if (rec && rec.liftedAt === null) return true;
    }
    if (scope.sessionId && this.isolations.has(`session:${scope.sessionId}`)) {
      const rec = this.isolations.get(`session:${scope.sessionId}`);
      if (rec && rec.liftedAt === null) return true;
    }
    if (scope.ipAddress && this.isolations.has(`ip:${scope.ipAddress}`)) {
      const rec = this.isolations.get(`ip:${scope.ipAddress}`);
      if (rec && rec.liftedAt === null) return true;
    }
    return false;
  }

  /**
   * 解除隔离。
   *
   * 解除作用域中所有维度的隔离状态。
   *
   * @param scope - 要解除隔离的作用域
   * @returns 解除的维度数量
   */
  liftIsolation(scope: IsolationScope): number {
    let lifted = 0;
    const keys: string[] = [];
    if (scope.tenantId) keys.push(`tenant:${scope.tenantId}`);
    if (scope.agentId) keys.push(`agent:${scope.agentId}`);
    if (scope.toolName) keys.push(`tool:${scope.toolName}`);
    if (scope.sessionId) keys.push(`session:${scope.sessionId}`);
    if (scope.ipAddress) keys.push(`ip:${scope.ipAddress}`);

    for (const key of keys) {
      const rec = this.isolations.get(key);
      if (rec && rec.liftedAt === null) {
        rec.liftedAt = Date.now();
        lifted += 1;
      }
    }

    if (lifted > 0) {
      this.logSecurityEvent('security_decision', 'medium', 'SecuritySelfHealingEngine', `解除隔离: ${lifted} 个维度`, {
        scope,
        lifted,
      });
      getGlobalLogger().info('SecuritySelfHealingEngine', '解除隔离', { scope, lifted });
      getGlobalMetrics().incrementCounter('self_healing.isolations_lifted', lifted);
    }

    return lifted;
  }

  /**
   * 获取所有隔离记录（含已解除）。
   *
   * @returns 隔离记录列表
   */
  getIsolations(): IsolationRecord[] {
    return Array.from(this.isolations.values());
  }

  // ── 恢复机制 ─────────────────────────────────────────────────────

  /**
   * 从安全快照恢复。
   *
   * 若提供了 snapshot 参数则从指定快照恢复；否则尝试使用最近的快照。
   * 恢复操作会还原 BillExplosionGuard 和 DLP 的配置到快照时的状态。
   *
   * @param scope - 恢复作用域
   * @param snapshot - 指定快照（可选，不提供则使用最近快照）
   * @returns 恢复结果
   */
  async restore(
    scope: IsolationScope,
    snapshot?: SecuritySnapshot,
  ): Promise<StepActionResult> {
    const target = snapshot ?? this.snapshots[this.snapshots.length - 1];

    if (!target) {
      const msg = '无可用安全快照，无法恢复';
      getGlobalLogger().warn('SecuritySelfHealingEngine', msg, { scope });
      return { success: false, message: msg };
    }

    const restoredItems: string[] = [];

    // 恢复 BillExplosionGuard 配置
    if (target.billGuardConfig) {
      try {
        getBillExplosionGuard().reconfigure(
          target.billGuardConfig as Partial<BillGuardConfig>,
        );
        restoredItems.push('BillExplosionGuard 配置');
      } catch (err) {
        reportSilentFailure(err, 'SecuritySelfHealingEngine.restore.billGuardConfig');
      }
    }

    // 恢复 DLP 配置
    if (target.dlpConfig) {
      try {
        getDataLossPrevention().configure(
          target.dlpConfig as Partial<DLPConfig>,
        );
        restoredItems.push('DataLossPrevention 配置');
      } catch (err) {
        reportSilentFailure(err, 'SecuritySelfHealingEngine.restore.dlpConfig');
      }
    }

    const message =
      restoredItems.length > 0
        ? `从快照 ${target.id} 恢复: ${restoredItems.join(', ')}`
        : `快照 ${target.id} 无可恢复配置`;

    this.logSecurityEvent('security_decision', 'high', 'SecuritySelfHealingEngine', message, {
      scope,
      snapshotId: target.id,
      restoredItems,
    });

    getGlobalLogger().info('SecuritySelfHealingEngine', '执行快照恢复', {
      scope,
      snapshotId: target.id,
      restoredItems,
    });

    getGlobalMetrics().incrementCounter('self_healing.restores', 1, {
      snapshotId: target.id,
    });

    return { success: true, message };
  }

  /**
   * 拍摄安全快照。
   *
   * 捕获当前 BillExplosionGuard 和 DLP 的配置状态，保存为快照供后续恢复使用。
   *
   * @param scope - 快照作用域
   * @returns 安全快照
   */
  takeSnapshot(scope: IsolationScope = {}): SecuritySnapshot {
    let billGuardConfig: Record<string, unknown> | undefined;
    let dlpConfig: Record<string, unknown> | undefined;

    try {
      const billConfig = getBillExplosionGuard().getConfig();
      billGuardConfig = billConfig as unknown as Record<string, unknown>;
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.takeSnapshot.billGuard');
    }

    try {
      // DLP 没有公开的 getConfig，使用当前已知启用状态
      dlpConfig = { enabled: getDataLossPrevention().isEnabled() };
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.takeSnapshot.dlp');
    }

    const snapshot: SecuritySnapshot = {
      id: this.generateId('snapshot'),
      takenAt: new Date().toISOString(),
      scope,
      billGuardConfig,
      dlpConfig,
      isolationCount: this.isolations.size,
    };

    this.snapshots.push(snapshot);
    // 保留限制
    while (this.snapshots.length > this.config.snapshotRetention) {
      this.snapshots.shift();
    }

    getGlobalLogger().info('SecuritySelfHealingEngine', '已拍摄安全快照', {
      snapshotId: snapshot.id,
      scope,
    });

    return snapshot;
  }

  // ── 加固机制 ─────────────────────────────────────────────────────

  /**
   * 执行加固操作。
   *
   * 根据传入的加固措施，动态收紧速率限制、成本上限、启用严格 DLP、
   * 封禁 IP 等。
   *
   * @param scope - 加固作用域
   * @param measures - 加固措施集合
   * @returns 加固结果
   */
  async harden(
    scope: IsolationScope,
    measures: HardeningMeasures,
  ): Promise<StepActionResult> {
    const applied: string[] = [];

    // 收紧速率限制
    if (measures.tightenRateLimit) {
      const factor = measures.tightenRateLimit.factor;
      const windowMs = measures.tightenRateLimit.windowMs ?? 60_000;
      const key = scope.ipAddress ?? scope.tenantId ?? 'global';
      this.rateLimitOverrides.set(key, { factor, windowMs });
      applied.push(`速率限制收紧(factor=${factor}, key=${key})`);
    }

    // 收紧成本上限
    if (measures.tightenCostLimit) {
      try {
        const billGuard = getBillExplosionGuard();
        const currentConfig = billGuard.getConfig();
        const factor = measures.tightenCostLimit.factor;
        const tightened: Partial<BillGuardConfig> = {};
        // 收紧所有成本上限字段
        const costFields = [
          'maxCostPerRequest',
          'maxTokensPerRequest',
          'maxCostPerSession',
          'maxTokensPerSession',
          'maxCostPerTenantDaily',
          'maxCostPerTenantMonthly',
          'maxCostGlobalDaily',
        ] as const;
        for (const field of costFields) {
          const currentVal = currentConfig[field];
          if (typeof currentVal === 'number') {
            (tightened as Record<string, unknown>)[field] = Math.floor(currentVal * factor);
          }
        }
        billGuard.reconfigure(tightened);
        applied.push(`成本上限收紧(factor=${factor})`);
      } catch (err) {
        reportSilentFailure(err, 'SecuritySelfHealingEngine.harden.costLimit');
      }
    }

    // 启用严格 DLP
    if (measures.enableStrictDlp) {
      try {
        const dlp = getDataLossPrevention();
        dlp.configure({
          enabled: true,
          blockOnCritical: true,
        });
        applied.push('严格 DLP 策略已启用');
      } catch (err) {
        reportSilentFailure(err, 'SecuritySelfHealingEngine.harden.dlp');
      }
    }

    // 封禁 IP
    if (measures.blockIps && measures.blockIps.length > 0) {
      for (const ip of measures.blockIps) {
        this.blockedIps.add(ip);
        // 同时创建隔离记录
        const key = `ip:${ip}`;
        if (!this.isolations.has(key)) {
          this.isolations.set(key, {
            scope: { ipAddress: ip },
            reason: '加固措施：IP 封禁',
            isolatedAt: Date.now(),
            isolatedBy: 'SecuritySelfHealingEngine',
            liftedAt: null,
            dimension: 'ip',
          });
          this.stats.totalIsolations += 1;
        }
      }
      applied.push(`封禁 IP: ${measures.blockIps.join(', ')}`);
    }

    const message =
      applied.length > 0 ? `加固完成: ${applied.join('; ')}` : '无加固措施需执行';

    this.logSecurityEvent('security_decision', 'medium', 'SecuritySelfHealingEngine', message, {
      scope,
      applied,
    });

    getGlobalLogger().info('SecuritySelfHealingEngine', '执行加固', { scope, applied });
    getGlobalMetrics().incrementCounter('self_healing.hardening_applied', applied.length);

    return { success: true, message };
  }

  /**
   * 检查 IP 是否被封禁。
   *
   * @param ipAddress - IP 地址
   * @returns 是否被封禁
   */
  isIpBlocked(ipAddress: string): boolean {
    return this.blockedIps.has(ipAddress);
  }

  /**
   * 获取速率限制覆盖配置。
   *
   * @param key - 作用域键（IP 或租户 ID）
   * @returns 速率限制覆盖配置，不存在则返回 undefined
   */
  getRateLimitOverride(key: string): { factor: number; windowMs: number } | undefined {
    return this.rateLimitOverrides.get(key);
  }

  // ── 健康检查 ─────────────────────────────────────────────────────

  /**
   * 验证系统健康状态。
   *
   * 检查所有安全组件（SecurityMonitor、AuditChainLedger、
   * BillExplosionGuard、DataLossPrevention、RuntimeDependencyGuard）
   * 是否正常工作，并返回逐组件的健康状态。
   *
   * @returns 健康验证结果
   */
  async verifyHealth(): Promise<HealthVerificationResult> {
    const checkedAt = new Date().toISOString();
    const components: HealthVerificationResult['components'] = [];

    // 1. SecurityMonitor 健康检查
    try {
      const monitor = getSecurityMonitor();
      const health = monitor.getHealth();
      const healthy = health.status !== 'critical';
      components.push({
        name: 'SecurityMonitor',
        healthy,
        details: `status=${health.status}, alerts=${health.activeAlerts}, rate=${health.eventRate.toFixed(1)}/min`,
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.verifyHealth.monitor');
      components.push({ name: 'SecurityMonitor', healthy: false, details: '检查异常' });
    }

    // 2. AuditChainLedger 完整性验证
    try {
      const ledger = getAuditChainLedger();
      const verifyResult = ledger.verify();
      components.push({
        name: 'AuditChainLedger',
        healthy: verifyResult.ok,
        details: verifyResult.ok
          ? `链完整, ${verifyResult.totalEntries} 条记录, ${verifyResult.chainsInspected} 条链`
          : `链断裂: ${verifyResult.brokenChain?.reason ?? '未知'}`,
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.verifyHealth.ledger');
      components.push({ name: 'AuditChainLedger', healthy: false, details: '验证异常' });
    }

    // 3. BillExplosionGuard 状态检查
    try {
      const billGuard = getBillExplosionGuard();
      const state = billGuard.getState();
      const healthy = !state.melted && !state.globalMelted;
      components.push({
        name: 'BillExplosionGuard',
        healthy,
        details: `melted=${state.melted}, globalMelted=${state.globalMelted}, dailyCost=$${state.dailyCost.toFixed(2)}`,
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.verifyHealth.billGuard');
      components.push({ name: 'BillExplosionGuard', healthy: false, details: '检查异常' });
    }

    // 4. DataLossPrevention 状态检查
    try {
      const dlp = getDataLossPrevention();
      const enabled = dlp.isEnabled();
      const stats = dlp.getStats();
      components.push({
        name: 'DataLossPrevention',
        healthy: enabled,
        details: `enabled=${enabled}, scans=${stats.totalScans}, leaks=${stats.totalLeaksDetected}`,
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.verifyHealth.dlp');
      components.push({ name: 'DataLossPrevention', healthy: false, details: '检查异常' });
    }

    // 5. RuntimeDependencyGuard 完整性检查
    try {
      const depGuard = getRuntimeDependencyGuard();
      const report = depGuard.getViolationReport();
      const healthy = report.totalViolations === 0 && report.tamperedPackages.length === 0;
      components.push({
        name: 'RuntimeDependencyGuard',
        healthy,
        details: `violations=${report.totalViolations}, tampered=${report.tamperedPackages.length}, initialized=${report.initialized}`,
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.verifyHealth.depGuard');
      components.push({ name: 'RuntimeDependencyGuard', healthy: false, details: '检查异常' });
    }

    const healthy = components.every((c) => c.healthy);

    getGlobalLogger().info('SecuritySelfHealingEngine', '健康检查完成', {
      healthy,
      componentCount: components.length,
    });

    getGlobalMetrics().setGauge('self_healing.system_healthy', healthy ? 1 : 0, {});
    getGlobalMetrics().incrementCounter('self_healing.health_checks', 1, {
      healthy: String(healthy),
    });

    return { healthy, components, checkedAt };
  }

  // ── 攻击时间线 ───────────────────────────────────────────────────

  /**
   * 获取指定攻击的时间线。
   *
   * @param attackId - 攻击 ID
   * @returns 攻击时间线，不存在则返回 undefined
   */
  getAttackTimeline(attackId: string): AttackTimeline | undefined {
    return this.timelines.get(attackId);
  }

  /**
   * 获取所有攻击时间线。
   *
   * @returns 时间线列表（按开始时间降序）
   */
  getAllTimelines(): AttackTimeline[] {
    return Array.from(this.timelines.values()).sort((a, b) =>
      b.startTime.localeCompare(a.startTime),
    );
  }

  // ── 统计 ─────────────────────────────────────────────────────────

  /**
   * 获取自愈统计信息。
   *
   * @returns 统计信息快照
   */
  getHealingStats(): SelfHealingStats {
    const activeIsolations = Array.from(this.isolations.values()).filter(
      (r) => r.liftedAt === null,
    ).length;

    return {
      totalTriggers: this.stats.totalTriggers,
      successfulHeals: this.stats.successfulHeals,
      failedHeals: this.stats.failedHeals,
      activeIsolations,
      totalIsolations: this.stats.totalIsolations,
      totalActionsExecuted: this.stats.totalActionsExecuted,
      avgHealDurationMs:
        this.stats.totalTriggers > 0
          ? Math.round(this.stats.totalHealDurationMs / this.stats.totalTriggers)
          : 0,
      byAttackType: { ...this.stats.byAttackType },
      byAction: { ...this.stats.byAction },
      snapshotCount: this.snapshots.length,
    };
  }

  // ── 人工确认与凭证轮换处理器注册 ─────────────────────────────────

  /**
   * 设置人工确认处理器。
   *
   * 当剧本步骤需要人工确认时调用此处理器。若未设置，默认行为为：
   * 自动批准（记录警告日志）。
   *
   * @param handler - 人工确认处理器
   */
  setHumanApprovalHandler(handler: HumanApprovalHandler): void {
    this.humanApprovalHandler = handler;
    getGlobalLogger().info('SecuritySelfHealingEngine', '人工确认处理器已设置');
  }

  /**
   * 注册凭证轮换处理器。
   *
   * 当执行 ROTATE_CREDENTIAL 动作时调用此处理器。若未注册，该动作
   * 将被标记为失败并记录警告。
   *
   * @param handler - 凭证轮换处理器
   */
  registerCredentialRotationHandler(handler: CredentialRotationHandler): void {
    this.credentialRotationHandler = handler;
    getGlobalLogger().info('SecuritySelfHealingEngine', '凭证轮换处理器已注册');
  }

  // ── 私有方法 ─────────────────────────────────────────────────────

  /**
   * 执行单个剧本步骤（含超时控制）。
   */
  private async executeStep(
    step: PlaybookStep,
    context: PlaybookExecutionContext,
  ): Promise<StepActionResult> {
    const timeoutMs = step.timeoutMs ?? this.config.defaultStepTimeoutMs;

    try {
      const result = await this.withTimeout(
        this.executeAction(step.action, context.scope, step.params ?? {}, context),
        timeoutMs,
        step.action,
      );
      return result;
    } catch (err) {
      reportSilentFailure(err, `SecuritySelfHealingEngine.executeStep[${step.id}]`);
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 执行具体动作。
   */
  private async executeAction(
    action: PlaybookAction,
    scope: IsolationScope,
    params: Record<string, unknown>,
    context: PlaybookExecutionContext,
  ): Promise<StepActionResult> {
    switch (action) {
      case 'ISOLATE_TENANT':
        return this.isolate(
          { tenantId: scope.tenantId },
          String(params.reason ?? `攻击隔离: ${context.attackType}`),
        );

      case 'ISOLATE_AGENT':
        return this.isolate(
          { agentId: scope.agentId },
          String(params.reason ?? `攻击隔离: ${context.attackType}`),
        );

      case 'ISOLATE_TOOL':
        return this.isolate(
          { toolName: scope.toolName },
          String(params.reason ?? `攻击隔离: ${context.attackType}`),
        );

      case 'ISOLATE_SESSION':
        return this.isolate(
          { sessionId: scope.sessionId },
          String(params.reason ?? `攻击隔离: ${context.attackType}`),
        );

      case 'RESTORE_SNAPSHOT':
        return this.restore(scope);

      case 'RESET_BASELINE':
        return this.resetBaseline(scope);

      case 'ROTATE_CREDENTIAL':
        return this.rotateCredential(scope, params);

      case 'REBUILD_DEPENDENCY':
        return this.rebuildDependency(scope);

      case 'TIGHTEN_RATE_LIMIT':
        return this.harden(scope, {
          tightenRateLimit: {
            factor: typeof params.factor === 'number'
              ? params.factor
              : this.config.defaultRateLimitTightenFactor,
            windowMs: typeof params.windowMs === 'number' ? params.windowMs : 60_000,
          },
        });

      case 'TIGHTEN_COST_LIMIT':
        return this.harden(scope, {
          tightenCostLimit: {
            factor: typeof params.factor === 'number'
              ? params.factor
              : this.config.defaultCostLimitTightenFactor,
          },
        });

      case 'ENABLE_STRICT_DLP':
        return this.harden(scope, { enableStrictDlp: true });

      case 'BLOCK_IP': {
        const ip = params.ipAddress ?? scope.ipAddress;
        if (typeof ip !== 'string') {
          return { success: false, message: '未指定 IP 地址' };
        }
        return this.harden(scope, { blockIps: [ip] });
      }

      case 'NOTIFY_HUMAN':
        return this.notifyHuman(params, context);

      case 'VERIFY_HEALTH': {
        const health = await this.verifyHealth();
        return {
          success: health.healthy,
          message: health.healthy
            ? '所有安全组件健康'
            : `存在不健康组件: ${health.components
                .filter((c) => !c.healthy)
                .map((c) => c.name)
                .join(', ')}`,
        };
      }

      case 'GENERATE_REPORT':
        return { success: true, message: '恢复报告已生成' };

      default:
        return { success: false, message: `未知动作: ${action}` };
    }
  }

  /**
   * 重置安全基线。
   *
   * 重新初始化依赖完整性哈希基线，并清除安全监控器的告警状态。
   */
  private async resetBaseline(scope: IsolationScope): Promise<StepActionResult> {
    const items: string[] = [];

    try {
      const depGuard = getRuntimeDependencyGuard();
      const count = depGuard.initializeHashes();
      items.push(`依赖基线重置(${count} 个包)`);
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.resetBaseline.depGuard');
    }

    try {
      // 拍摄新快照作为新基线
      const snapshot = this.takeSnapshot(scope);
      items.push(`新基线快照(${snapshot.id})`);
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.resetBaseline.snapshot');
    }

    const message =
      items.length > 0 ? `基线重置: ${items.join(', ')}` : '基线重置未完成';
    return { success: items.length > 0, message };
  }

  /**
   * 轮换凭证。
   */
  private async rotateCredential(
    scope: IsolationScope,
    params: Record<string, unknown>,
  ): Promise<StepActionResult> {
    if (!this.credentialRotationHandler) {
      const msg = '未注册凭证轮换处理器，无法轮换凭证';
      getGlobalLogger().warn('SecuritySelfHealingEngine', msg, { scope });
      this.logSecurityEvent('security_decision', 'critical', 'SecuritySelfHealingEngine', msg, {
        scope,
      });
      return { success: false, message: msg };
    }

    try {
      const result = await this.credentialRotationHandler(scope, params);
      this.logSecurityEvent(
        'credential_access',
        'high',
        'SecuritySelfHealingEngine',
        `凭证轮换: ${result.message}`,
        { scope, success: result.success },
      );
      return result;
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.rotateCredential');
      return {
        success: false,
        message: err instanceof Error ? err.message : '凭证轮换异常',
      };
    }
  }

  /**
   * 重建被篡改的依赖。
   *
   * 重新初始化依赖完整性哈希，并验证完整性。
   */
  private async rebuildDependency(scope: IsolationScope): Promise<StepActionResult> {
    const items: string[] = [];

    try {
      const depGuard = getRuntimeDependencyGuard();
      // 重新初始化哈希基线
      const initCount = depGuard.initializeHashes();
      items.push(`重新初始化 ${initCount} 个包哈希`);

      // 验证完整性
      const violationCount = depGuard.verifyIntegrity();
      if (violationCount > 0) {
        const report = depGuard.getViolationReport();
        return {
          success: false,
          message: `依赖重建后仍检测到 ${violationCount} 个违规，篡改包: ${report.tamperedPackages.join(', ')}`,
        };
      }
      items.push('完整性验证通过');
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.rebuildDependency');
      return {
        success: false,
        message: err instanceof Error ? err.message : '依赖重建异常',
      };
    }

    this.logSecurityEvent(
      'security_decision',
      'high',
      'SecuritySelfHealingEngine',
      `依赖重建: ${items.join(', ')}`,
      { scope },
    );

    return { success: true, message: `依赖重建完成: ${items.join(', ')}` };
  }

  /**
   * 通知人工（记录事件并调用处理器）。
   */
  private async notifyHuman(
    params: Record<string, unknown>,
    context: PlaybookExecutionContext,
  ): Promise<StepActionResult> {
    const reason = String(params.reason ?? '需要人工介入');
    const attackType = context.attackType;
    const scope = context.scope;

    this.logSecurityEvent(
      'security_decision',
      'high',
      'SecuritySelfHealingEngine',
      `人工通知: ${reason}`,
      { attackType, scope, reason },
    );

    getGlobalLogger().warn('SecuritySelfHealingEngine', '人工介入通知', {
      attackType,
      scope,
      reason,
    });

    getGlobalMetrics().incrementCounter('self_healing.human_notifications', 1, {
      attackType,
    });

    return { success: true, message: `已通知人工: ${reason}` };
  }

  /**
   * 请求人工确认。
   *
   * 若注册了人工确认处理器则调用它（带超时）；否则默认自动批准。
   */
  private async requestHumanApproval(
    step: PlaybookStep,
    context: PlaybookExecutionContext,
  ): Promise<boolean> {
    if (!this.humanApprovalHandler) {
      // 未注册处理器时默认自动批准，但记录警告
      getGlobalLogger().warn('SecuritySelfHealingEngine', '未注册人工确认处理器，默认自动批准', {
        stepId: step.id,
        action: step.action,
      });
      return true;
    }

    try {
      const approved = await this.withTimeout(
        this.humanApprovalHandler(step, context),
        this.config.humanApprovalTimeoutMs,
        `humanApproval:${step.id}`,
      );
      return approved;
    } catch (err) {
      reportSilentFailure(err, `SecuritySelfHealingEngine.requestHumanApproval[${step.id}]`);
      // 超时或异常视为拒绝
      return false;
    }
  }

  /**
   * 为 Promise 添加超时控制。
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    if (timeoutMs <= 0) {
      return promise;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`操作超时(${label}, ${timeoutMs}ms)`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * 查找匹配攻击的最佳剧本。
   *
   * 按优先级降序返回第一个匹配触发条件的剧本。
   */
  private findBestPlaybook(
    attackType: AttackType,
    metadata: Record<string, unknown>,
  ): Playbook | undefined {
    const severity = this.toSeverity(metadata.severity);
    const severityRank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

    const candidates = Array.from(this.playbooks.values())
      .filter((pb) => {
        const cond = pb.triggerCondition;
        if (!cond.attackTypes.includes(attackType)) return false;
        if (cond.minSeverity) {
          const minRank = severityRank[cond.minSeverity] ?? 0;
          const actualRank = severityRank[severity] ?? 0;
          if (actualRank < minRank) return false;
        }
        return true;
      })
      .sort((a, b) => b.priority - a.priority);

    return candidates[0];
  }

  /**
   * 记录时间线事件。
   */
  private recordTimelineEvent(
    timeline: AttackTimeline,
    event: AttackTimelineEvent,
  ): void {
    timeline.events.push(event);
  }

  /**
   * 完成时间线，生成根因分析、影响摘要、解决摘要和经验教训。
   */
  private finalizeTimeline(
    timeline: AttackTimeline,
    resolutionSummary: string,
    attackType: AttackType,
  ): void {
    timeline.endTime = new Date().toISOString();
    timeline.resolutionSummary = resolutionSummary;

    // 根因分析（基于事件类型推断）
    const detectionEvent = timeline.events.find((e) => e.type === 'detection');
    timeline.rootCause = detectionEvent
      ? `${attackType} 攻击由 ${detectionEvent.actor} 检测到`
      : `${attackType} 攻击`;

    // 影响摘要
    const isolationEvents = timeline.events.filter(
      (e) => e.type === 'isolation' || e.type === 'action_failed',
    );
    timeline.impactSummary =
      isolationEvents.length > 0
        ? `共触发 ${isolationEvents.length} 个关键事件`
        : '无显著影响事件';

    // 经验教训
    const failedActions = timeline.events.filter((e) => e.type === 'action_failed');
    if (failedActions.length > 0) {
      timeline.lessonsLearned.push(
        `存在 ${failedActions.length} 个失败动作，建议检查对应组件的可靠性`,
      );
    }
    const approvalDenied = timeline.events.filter((e) => e.type === 'approval_denied');
    if (approvalDenied.length > 0) {
      timeline.lessonsLearned.push(
        '存在人工确认被拒绝的步骤，建议优化剧本以减少不必要的阻断',
      );
    }
    if (timeline.lessonsLearned.length === 0) {
      timeline.lessonsLearned.push('响应流程顺利完成，建议定期复审剧本有效性');
    }

    // 将时间线写入审计链
    try {
      getAuditChainLedger().logEvent({
        type: 'security_decision',
        severity: 'high',
        source: 'SecuritySelfHealingEngine',
        message: `攻击时间线完成: ${timeline.attackId}`,
        details: {
          attackId: timeline.attackId,
          attackType,
          eventCount: timeline.events.length,
          resolutionSummary,
          lessonsLearned: timeline.lessonsLearned,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.finalizeTimeline.auditChain');
    }
  }

  /**
   * 生成恢复报告。
   */
  private generateRecoveryReport(
    playbook: Playbook,
    actionsTaken: string[],
    actionsFailed: string[],
    durationMs: number,
    systemHealthy: boolean,
    healthReport: string,
  ): string {
    const lines: string[] = [];
    lines.push('========== 安全自愈恢复报告 ==========');
    lines.push(`剧本: ${playbook.name} (${playbook.id})`);
    lines.push(`执行时间: ${new Date().toISOString()}`);
    lines.push(`总耗时: ${durationMs}ms`);
    lines.push('');
    lines.push('--- 执行动作 ---');
    lines.push(`成功 (${actionsTaken.length}):`);
    for (const a of actionsTaken) {
      lines.push(`  [OK] ${a}`);
    }
    lines.push(`失败 (${actionsFailed.length}):`);
    for (const a of actionsFailed) {
      lines.push(`  [FAIL] ${a}`);
    }
    lines.push('');
    lines.push('--- 系统健康状态 ---');
    lines.push(`整体健康: ${systemHealthy ? '是' : '否'}`);
    lines.push(healthReport);
    lines.push('');
    lines.push('--- 建议 ---');
    if (actionsFailed.length > 0) {
      lines.push('1. 检查失败动作对应的组件状态');
    }
    if (!systemHealthy) {
      lines.push('2. 修复不健康的组件后重新验证');
    }
    if (actionsFailed.length === 0 && systemHealthy) {
      lines.push('1. 系统已恢复至安全状态，建议持续监控');
    }
    lines.push('======================================');

    return lines.join('\n');
  }

  /**
   * 记录安全审计事件（同时写入 SecurityAuditLogger 和 AuditChainLedger）。
   *
   * @param type - 安全事件类型（须为合法的 SecurityEventType）
   * @param severity - 严重程度
   * @param source - 事件来源组件
   * @param message - 事件描述
   * @param details - 附加详情
   */
  private logSecurityEvent(
    type: SecurityEventType,
    severity: 'low' | 'medium' | 'high' | 'critical',
    source: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    try {
      getSecurityAuditLogger().logEvent({
        type,
        severity,
        source,
        message,
        details,
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.logSecurityEvent.auditLogger');
    }

    try {
      getAuditChainLedger().logEvent({
        type,
        severity,
        source,
        message,
        details,
      });
    } catch (err) {
      reportSilentFailure(err, 'SecuritySelfHealingEngine.logSecurityEvent.auditChain');
    }
  }

  /**
   * 将元数据中的 severity 值转换为标准严重程度。
   */
  private toSeverity(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
    if (
      value === 'low' ||
      value === 'medium' ||
      value === 'high' ||
      value === 'critical'
    ) {
      return value;
    }
    return 'medium';
  }

  /**
   * 根据动作类型获取时间线事件类型。
   */
  private getEventTypeForAction(action: PlaybookAction): string {
    if (action.startsWith('ISOLATE_')) return 'isolation';
    if (action === 'RESTORE_SNAPSHOT' || action === 'RESET_BASELINE' ||
        action === 'ROTATE_CREDENTIAL' || action === 'REBUILD_DEPENDENCY') {
      return 'recovery';
    }
    if (action === 'TIGHTEN_RATE_LIMIT' || action === 'TIGHTEN_COST_LIMIT' ||
        action === 'ENABLE_STRICT_DLP' || action === 'BLOCK_IP') {
      return 'hardening';
    }
    if (action === 'NOTIFY_HUMAN') return 'notification';
    if (action === 'VERIFY_HEALTH') return 'health_check';
    return 'action';
  }

  /**
   * 生成唯一 ID。
   */
  private generateId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// ============================================================================
// 单例
// ============================================================================

const securitySelfHealingEngineSingleton = createTenantAwareSingleton(
  () => new SecuritySelfHealingEngine(),
  { componentName: 'SecuritySelfHealingEngine' },
);

/**
 * 获取安全自愈引擎单例实例。
 *
 * 在多租户环境下返回当前租户的隔离实例；在单租户环境下返回全局实例。
 *
 * @returns SecuritySelfHealingEngine 实例
 */
export function getSecuritySelfHealingEngine(): SecuritySelfHealingEngine {
  return securitySelfHealingEngineSingleton.get();
}

/**
 * 重置安全自愈引擎单例。
 *
 * 销毁当前实例（及所有租户实例），下次调用 {@link getSecuritySelfHealingEngine}
 * 时将创建新实例。主要用于测试场景。
 */
export function resetSecuritySelfHealingEngine(): void {
  securitySelfHealingEngineSingleton.reset();
}
