/**
 * AttackCampaignTracker — 跨事件、跨天、跨 Agent 的攻击战役追踪器。
 *
 * 与 CrossAgentCorrelator 互补：
 * - CrossAgentCorrelator 在时间窗口内做近实时的跨 Agent 攻击链检测（6 条静态规则），
 *   但不会跨事件 / 跨天持久化并演化“战役模型”。
 * - AttackCampaignTracker 将离散的攻击事件聚合为持续演化的“攻击战役”，追踪其阶段
 *   演进、目标扩张、技术演化，并据此进行预测性防御。
 *
 * 四大核心能力：
 *   1. 战役检测与分组 (trackAttackEvent)
 *      - 基于同源（IP 段 / UA / 租户）、同目标（Agent / 端点 / 工具）、
 *        同技术（攻击类型 / 自适应威胁学习签名）、时序相关、演化关联，
 *        将攻击事件分组进战役。
 *   2. 战役演化追踪 (getCampaignEvolution / getCampaignTimeline)
 *      - 追踪新技术引入、严重程度升级、目标扩张、对防御的适应、攻击节奏变化。
 *   3. 战役关联 (correlateCampaigns / getCampaignGroups)
 *      - 关联共享基础设施 / 相似技术变体 / 时序接近 / 目标重叠的多个战役，合并为“战役组”。
 *   4. 预测性防御 (predictNextMove / getPredictions)
 *      - 基于战役历史与演化预测攻击者下一步，给出置信度与先发制人防御建议。
 *
 * 设计：
 *   各安全模块检测到攻击 → trackAttackEvent(event)
 *                                          → 战役分组 / 阶段检测 / 演化分析 / 预测
 *                                          → SecurityAuditLogger（审计）
 *                                          → MetricsCollector（指标）
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { getSecurityAuditLogger, type SecuritySeverity } from './securityAuditLogger';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type CampaignPhase =
  | 'reconnaissance'
  | 'probing'
  | 'exploitation'
  | 'escalation'
  | 'persistence'
  | 'detected'
  | 'blocked'
  | 'dormant';

export type CampaignSeverity = 'critical' | 'high' | 'medium' | 'low';

export type PredictionType =
  | 'next_target'
  | 'next_technique'
  | 'next_phase'
  | 'adaptation_strategy'
  | 'escalation_level';

export interface AttackEvent {
  eventId: string;
  timestamp: string;
  attackType: string;
  severity: CampaignSeverity;
  sourceModule: string;
  // Source attribution
  sourceIp?: string;
  userAgent?: string;
  tenantId?: string;
  // Target
  targetAgent?: string;
  targetEndpoint?: string;
  targetTool?: string;
  // Technique
  signatureId?: string; // from AdaptiveThreatLearningEngine
  technique: string;
  description: string;
  // Result
  blocked: boolean;
  metadata?: Record<string, unknown>;
}

export interface AttackCampaign {
  campaignId: string;
  name: string;
  phase: CampaignPhase;
  severity: CampaignSeverity;
  startTime: string;
  lastActivityTime: string;
  // Attribution
  sourceIps: Set<string>;
  userAgents: Set<string>;
  tenantIds: Set<string>;
  // Targets
  affectedAgents: Set<string>;
  affectedEndpoints: Set<string>;
  affectedTools: Set<string>;
  // Techniques
  techniquesUsed: string[];
  signatureIds: Set<string>;
  // Evolution
  incidents: AttackEvent[];
  phaseHistory: Array<{ phase: CampaignPhase; timestamp: string; trigger: string }>;
  severityProgression: Array<{ severity: CampaignSeverity; timestamp: string }>;
  // Correlation
  correlatedCampaignIds: Set<string>;
  campaignGroupId?: string;
  // Status
  active: boolean;
  totalIncidents: number;
  blocked: boolean;
}

export interface CampaignEvolution {
  campaignId: string;
  techniqueEvolution: Array<{ technique: string; firstSeen: string; occurrenceCount: number }>;
  severityTrend: 'escalating' | 'stable' | 'decreasing';
  targetExpansion: 'expanding' | 'stable' | 'narrowing';
  attackFrequency: 'accelerating' | 'steady' | 'decreasing';
  adaptationDetected: boolean;
  phaseProgression: CampaignPhase[];
  predictedNextPhase?: CampaignPhase;
  evolutionSummary: string;
}

export interface CampaignGroup {
  groupId: string;
  campaignIds: string[];
  sharedInfrastructure: string[];
  sharedTechniques: string[];
  totalIncidents: number;
  firstSeen: string;
  lastSeen: string;
  likelySameAttacker: boolean;
  confidence: number;
}

export interface CampaignPrediction {
  predictionId: string;
  campaignId: string;
  type: PredictionType;
  prediction: string;
  confidence: number; // 0-1
  recommendedDefense: string;
  preemptiveActions: string[];
  createdAt: string;
  expiresAt: string;
  fulfilled: boolean;
}

export interface CampaignTrackerConfig {
  enabled: boolean;
  // Campaign grouping
  correlationWindowMs: number; // default 86400000 (24h)
  maxCampaignAge: number; // default 2592000000 (30 days)
  maxCampaigns: number; // default 1000
  minEventsForCampaign: number; // default 2
  // Evolution
  phaseTransitionThreshold: number; // events before phase transition, default 3
  // Correlation
  correlationThreshold: number; // similarity threshold, default 0.6
  // Predictions
  predictionExpiryMs: number; // default 3600000 (1h)
  maxPredictionsPerCampaign: number; // default 10
}

/** 单条战役时间线条目，用于 getCampaignTimeline 的按时间排序视图。 */
export interface CampaignTimelineEntry {
  timestamp: string;
  kind: 'incident' | 'phase_transition' | 'severity_change' | 'prediction' | 'correlation';
  description: string;
  details?: Record<string, unknown>;
}

/** 追踪器聚合统计。 */
export interface CampaignTrackerStats {
  totalCampaigns: number;
  activeCampaigns: number;
  blockedCampaigns: number;
  dormantCampaigns: number;
  campaignGroups: number;
  totalPredictions: number;
  activePredictions: number;
  fulfilledPredictions: number;
  totalIncidents: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: CampaignTrackerConfig = {
  enabled: true,
  correlationWindowMs: 86_400_000, // 24h
  maxCampaignAge: 2_592_000_000, // 30 days
  maxCampaigns: 1000,
  minEventsForCampaign: 2,
  phaseTransitionThreshold: 3,
  correlationThreshold: 0.6,
  predictionExpiryMs: 3_600_000, // 1h
  maxPredictionsPerCampaign: 10,
};

// ============================================================================
// Static Helpers
// ============================================================================

const SEVERITY_RANK: Record<CampaignSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * 阶段排序，用于推断下一阶段。reconnaissance → probing → exploitation →
 * escalation → persistence → (detected/blocked) → dormant → (新波次)。
 */
const PHASE_NEXT: Partial<Record<CampaignPhase, CampaignPhase>> = {
  reconnaissance: 'probing',
  probing: 'exploitation',
  exploitation: 'escalation',
  escalation: 'persistence',
  persistence: 'detected',
  blocked: 'probing',
  detected: 'dormant',
  dormant: 'reconnaissance',
};

// ============================================================================
// AttackCampaignTracker
// ============================================================================

export class AttackCampaignTracker {
  private config: CampaignTrackerConfig;
  private readonly campaigns: Map<string, AttackCampaign> = new Map();
  private readonly campaignGroups: Map<string, CampaignGroup> = new Map();
  private readonly predictions: Map<string, CampaignPrediction> = new Map();
  private groupsDirty = true;

  constructor(config?: Partial<CampaignTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Capability 1: Campaign Detection & Grouping ──────────────────────

  /**
   * 追踪一次攻击事件：将其分组进现有战役，或演化关联至休眠战役，或创建新战役。
   * 返回该事件所属的战役（禁用时返回 null）。
   */
  trackAttackEvent(event: AttackEvent): AttackCampaign | null {
    if (!this.config.enabled) return null;
    try {
      // 以事件时间作为时间参考推进战役时间线，避免批次/回放事件与墙钟时间不一致
      // 导致战役被误判为休眠或过早关闭。
      const eventTime = new Date(event.timestamp).getTime();

      // 1. 在活跃战役中寻找最佳匹配（同源 / 同技术 + 时序 / 同签名）
      let campaign = this.findBestCampaign(event);

      if (campaign) {
        this.addEventToCampaign(campaign, event);
      } else {
        // 2. 演化关联：检查休眠战役是否存在同源 / 变体技术，可复活该战役
        const dormant = this.findEvolutionaryCampaign(event, eventTime);
        if (dormant) {
          campaign = dormant;
          campaign.active = true;
          this.addEventToCampaign(campaign, event);
          this.recordPhaseTransition(
            campaign,
            this.detectPhase(campaign, eventTime),
            'evolutionary_link',
          );
          this.logEvolutionaryLink(campaign, event);
        } else {
          // 3. 创建新战役
          campaign = this.createCampaign(event);
          this.campaigns.set(campaign.campaignId, campaign);
          this.logCampaignCreated(campaign);
        }
      }

      // 4. 阶段检测与转换记录
      const newPhase = this.detectPhase(campaign, eventTime);
      this.recordPhaseTransition(campaign, newPhase, `event:${event.eventId}`);
      if (newPhase === 'blocked' && !campaign.blocked) {
        campaign.blocked = true;
        this.recordCampaignBlocked();
      }
      if (newPhase === 'dormant') {
        campaign.active = false;
      }

      // 5. 维护：清理过期、限制上限
      this.groupsDirty = true;
      this.pruneStaleCampaigns(eventTime);
      this.enforceMaxCampaigns();

      // 6. 预测性防御：达到最小历史（5 事件）后自动生成预测
      if (campaign.incidents.length >= 5) {
        this.generateAndStorePredictions(campaign);
      }

      // 7. 审计 + 指标
      this.logCampaignEvent(campaign, event);
      this.recordCampaignsActive();

      return campaign;
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:trackAttackEvent');
      return null;
    }
  }

  /**
   * 为新事件在活跃战役中寻找最佳匹配战役。强匹配规则（同源 / 同签名 /
   * 同技术+时序）保证相关，分数用于在多个候选中选择最优。
   */
  private findBestCampaign(event: AttackEvent): AttackCampaign | null {
    let best: AttackCampaign | null = null;
    let bestEffective = -1;
    for (const campaign of this.campaigns.values()) {
      if (!campaign.active) continue;
      const { score, strongMatch } = this.scoreCampaignCorrelation(event, campaign);
      if (!strongMatch && score < this.config.correlationThreshold) continue;
      // 强匹配给予额外权重，确保同源 / 同签名优先于纯分数接近。
      const effective = score + (strongMatch ? 0.5 : 0);
      if (effective > bestEffective) {
        bestEffective = effective;
        best = campaign;
      }
    }
    return best;
  }

  /**
   * 计算事件与战役的关联分数与是否构成强匹配。
   * 强匹配对应规范中的分组规则：同源（IP/UA）、同签名、或（同技术 + 时序窗口内）。
   */
  private scoreCampaignCorrelation(
    event: AttackEvent,
    campaign: AttackCampaign,
  ): { score: number; strongMatch: boolean } {
    let score = 0;

    const eventTime = new Date(event.timestamp).getTime();
    const lastTime = new Date(campaign.lastActivityTime).getTime();
    const withinWindow = Math.abs(eventTime - lastTime) <= this.config.correlationWindowMs;

    // 同源
    let sourceMatch = false;
    if (event.sourceIp) {
      if (campaign.sourceIps.has(event.sourceIp)) {
        score += 0.4;
        sourceMatch = true;
      } else if (this.ipRangeOverlaps(event.sourceIp, campaign.sourceIps)) {
        score += 0.3;
        sourceMatch = true;
      }
    }
    if (event.userAgent && campaign.userAgents.has(event.userAgent)) {
      score += 0.3;
      sourceMatch = true;
    }
    if (event.tenantId && campaign.tenantIds.has(event.tenantId)) {
      score += 0.1;
    }

    // 同目标
    if (event.targetAgent && campaign.affectedAgents.has(event.targetAgent)) score += 0.15;
    if (event.targetEndpoint && campaign.affectedEndpoints.has(event.targetEndpoint)) score += 0.1;
    if (event.targetTool && campaign.affectedTools.has(event.targetTool)) score += 0.1;

    // 同技术
    const techniqueMatch = campaign.techniquesUsed.includes(event.technique);
    if (techniqueMatch) score += 0.25;
    let signatureMatch = false;
    if (event.signatureId && campaign.signatureIds.has(event.signatureId)) {
      score += 0.3;
      signatureMatch = true;
    }

    // 时序相关
    if (withinWindow) score += 0.15;
    score = Math.min(1, score);

    const strongMatch = sourceMatch || signatureMatch || (techniqueMatch && withinWindow);
    return { score, strongMatch };
  }

  /**
   * 在休眠战役中寻找演化关联（变体）：同签名 / 同技术 / 同攻击类型 / 同源，
   * 且未超过最大战役年龄。返回得分最高者。
   */
  private findEvolutionaryCampaign(event: AttackEvent, nowRef: number): AttackCampaign | null {
    let best: AttackCampaign | null = null;
    let bestScore = 0;
    for (const campaign of this.campaigns.values()) {
      if (campaign.active) continue;
      const age = nowRef - new Date(campaign.lastActivityTime).getTime();
      if (age > this.config.maxCampaignAge) continue;

      let score = 0;
      if (event.signatureId && campaign.signatureIds.has(event.signatureId)) score += 0.6;
      if (campaign.techniquesUsed.includes(event.technique)) score += 0.4;
      if (campaign.incidents.some((e) => e.attackType === event.attackType)) score += 0.2;
      if (event.sourceIp && campaign.sourceIps.has(event.sourceIp)) score += 0.3;
      if (event.userAgent && campaign.userAgents.has(event.userAgent)) score += 0.3;

      if (score > bestScore) {
        bestScore = score;
        best = campaign;
      }
    }
    return bestScore >= 0.5 ? best : null;
  }

  /** 基于首个事件的规范形式生成战役 ID：camp- + SHA-256 前 16 位。 */
  private generateCampaignId(firstEvent: AttackEvent): string {
    const hash = crypto.createHash('sha256').update(this.canonicalEvent(firstEvent)).digest('hex');
    return `camp-${hash.slice(0, 16)}`;
  }

  /** 事件的规范形式（键名排序，值稳定），用于哈希。 */
  private canonicalEvent(event: AttackEvent): string {
    const fields: Record<string, string> = {
      attackType: event.attackType,
      technique: event.technique,
      sourceIp: event.sourceIp ?? '',
      userAgent: event.userAgent ?? '',
      tenantId: event.tenantId ?? '',
      targetAgent: event.targetAgent ?? '',
      targetEndpoint: event.targetEndpoint ?? '',
      targetTool: event.targetTool ?? '',
      signatureId: event.signatureId ?? '',
    };
    return Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join('|');
  }

  /** 创建新战役，首个事件计入 incidents。 */
  private createCampaign(event: AttackEvent): AttackCampaign {
    const campaignId = this.generateCampaignId(event);
    return {
      campaignId,
      name: `Campaign ${campaignId.slice(0, 12)}`,
      phase: 'reconnaissance',
      severity: event.severity,
      startTime: event.timestamp,
      lastActivityTime: event.timestamp,
      sourceIps: new Set(event.sourceIp ? [event.sourceIp] : []),
      userAgents: new Set(event.userAgent ? [event.userAgent] : []),
      tenantIds: new Set(event.tenantId ? [event.tenantId] : []),
      affectedAgents: new Set(event.targetAgent ? [event.targetAgent] : []),
      affectedEndpoints: new Set(event.targetEndpoint ? [event.targetEndpoint] : []),
      affectedTools: new Set(event.targetTool ? [event.targetTool] : []),
      techniquesUsed: [event.technique],
      signatureIds: new Set(event.signatureId ? [event.signatureId] : []),
      incidents: [event],
      phaseHistory: [
        { phase: 'reconnaissance', timestamp: event.timestamp, trigger: 'campaign_created' },
      ],
      severityProgression: [{ severity: event.severity, timestamp: event.timestamp }],
      correlatedCampaignIds: new Set(),
      active: true,
      totalIncidents: 1,
      blocked: event.blocked,
    };
  }

  /** 将事件并入战役，更新归因 / 目标 / 技术 / 严重程度。 */
  private addEventToCampaign(campaign: AttackCampaign, event: AttackEvent): void {
    campaign.incidents.push(event);
    campaign.totalIncidents = campaign.incidents.length;
    campaign.lastActivityTime = event.timestamp;
    if (new Date(event.timestamp).getTime() < new Date(campaign.startTime).getTime()) {
      campaign.startTime = event.timestamp;
    }

    if (event.sourceIp) campaign.sourceIps.add(event.sourceIp);
    if (event.userAgent) campaign.userAgents.add(event.userAgent);
    if (event.tenantId) campaign.tenantIds.add(event.tenantId);

    if (event.targetAgent) campaign.affectedAgents.add(event.targetAgent);
    if (event.targetEndpoint) campaign.affectedEndpoints.add(event.targetEndpoint);
    if (event.targetTool) campaign.affectedTools.add(event.targetTool);

    if (!campaign.techniquesUsed.includes(event.technique)) {
      campaign.techniquesUsed.push(event.technique);
    }
    if (event.signatureId) campaign.signatureIds.add(event.signatureId);

    this.updateSeverity(campaign, event);
    if (event.blocked) campaign.blocked = true;
    campaign.active = true;
  }

  /** 更新严重程度演进：仅在出现更高严重程度时记录升级。 */
  private updateSeverity(campaign: AttackCampaign, event: AttackEvent): void {
    if (campaign.severityProgression.length === 0) {
      campaign.severity = event.severity;
      campaign.severityProgression.push({ severity: event.severity, timestamp: event.timestamp });
      return;
    }
    if (SEVERITY_RANK[event.severity] > SEVERITY_RANK[campaign.severity]) {
      campaign.severity = event.severity;
      campaign.severityProgression.push({ severity: event.severity, timestamp: event.timestamp });
    }
  }

  /**
   * 阶段检测。依据近端阻断率、严重程度趋势、是否存在成功攻击、目标重复度等推断当前阶段。
   */
  private detectPhase(campaign: AttackCampaign, nowRef: number): CampaignPhase {
    const incidents = campaign.incidents;
    if (incidents.length === 0) return 'reconnaissance';

    const lastActivity = new Date(campaign.lastActivityTime).getTime();
    if (nowRef - lastActivity > this.config.correlationWindowMs * 4) return 'dormant';

    const threshold = this.config.phaseTransitionThreshold;
    const recent = incidents.slice(-Math.max(threshold, 3));
    const recentBlockedRate = recent.filter((e) => e.blocked).length / recent.length;

    // blocked：近期大部分攻击被阻断
    if (incidents.length >= threshold && recentBlockedRate >= 0.66 && campaign.blocked) {
      return 'blocked';
    }

    const half = Math.max(1, Math.floor(incidents.length / 2));
    const firstHalfAvg = this.avgSeverityRank(incidents.slice(0, half));
    const recentHalfAvg = this.avgSeverityRank(incidents.slice(half));
    const escalating = recentHalfAvg > firstHalfAvg + 0.5;
    const hasSuccessful = incidents.some((e) => !e.blocked);

    // escalation：严重程度上升且存在成功攻击
    if (escalating && hasSuccessful && incidents.length >= threshold) return 'escalation';

    // persistence：对相同目标的反复攻击
    if (incidents.length >= threshold * 2) {
      if (this.countTargetRepeats(campaign) >= threshold) return 'persistence';
    }

    // exploitation：存在成功（未阻断）攻击
    if (hasSuccessful && incidents.length >= threshold) return 'exploitation';

    // detected：部分阻断（已识别并在抵抗），但未完全阻断
    if (incidents.length >= threshold && recentBlockedRate >= 0.33 && recentBlockedRate < 0.66) {
      return 'detected';
    }

    // probing：系统化测试少量相同端点
    const distinctTargets =
      campaign.affectedAgents.size + campaign.affectedEndpoints.size + campaign.affectedTools.size;
    if (incidents.length >= threshold && distinctTargets <= 3) return 'probing';

    // reconnaissance：早期探测多个不同端点
    if (distinctTargets > 3) return 'reconnaissance';

    return incidents.length >= threshold ? 'probing' : 'reconnaissance';
  }

  /** 若新阶段与当前不同，记录阶段转换并审计。 */
  private recordPhaseTransition(
    campaign: AttackCampaign,
    newPhase: CampaignPhase,
    trigger: string,
  ): void {
    if (campaign.phase === newPhase) return;
    campaign.phaseHistory.push({ phase: newPhase, timestamp: new Date().toISOString(), trigger });
    campaign.phase = newPhase;
    this.logPhaseTransition(campaign, newPhase, trigger);
  }

  // ── Capability 2: Campaign Evolution Tracking ────────────────────────

  /** 返回战役的完整按时间排序时间线（事件 / 阶段转换 / 严重程度 / 预测 / 关联）。 */
  getCampaignTimeline(campaignId: string): CampaignTimelineEntry[] {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return [];
    const entries: CampaignTimelineEntry[] = [];

    entries.push({
      timestamp: campaign.startTime,
      kind: 'incident',
      description: 'Campaign started',
      details: { firstEvent: campaign.incidents[0]?.eventId },
    });

    for (const ph of campaign.phaseHistory) {
      entries.push({
        timestamp: ph.timestamp,
        kind: 'phase_transition',
        description: `Phase → ${ph.phase}`,
        details: { trigger: ph.trigger },
      });
    }
    for (const sp of campaign.severityProgression) {
      entries.push({
        timestamp: sp.timestamp,
        kind: 'severity_change',
        description: `Severity → ${sp.severity}`,
      });
    }
    for (const inc of campaign.incidents) {
      entries.push({
        timestamp: inc.timestamp,
        kind: 'incident',
        description: `${inc.attackType}: ${inc.description}`,
        details: { eventId: inc.eventId, blocked: inc.blocked, sourceIp: inc.sourceIp },
      });
    }
    for (const p of this.getPredictions(campaignId)) {
      entries.push({
        timestamp: p.createdAt,
        kind: 'prediction',
        description: `[${p.type}] ${p.prediction}`,
        details: { confidence: p.confidence },
      });
    }
    if (campaign.campaignGroupId) {
      entries.push({
        timestamp: campaign.lastActivityTime,
        kind: 'correlation',
        description: `Joined campaign group ${campaign.campaignGroupId}`,
      });
    }

    entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return entries;
  }

  /** 返回战役的演化分析（技术演化 / 严重程度趋势 / 目标扩张 / 节奏 / 适应）。 */
  getCampaignEvolution(campaignId: string): CampaignEvolution | undefined {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return undefined;
    return this.computeEvolution(campaign);
  }

  private computeEvolution(campaign: AttackCampaign): CampaignEvolution {
    // 技术演化：每个技术的首次出现与出现次数
    const techMap = new Map<string, { firstSeen: string; count: number }>();
    for (const e of campaign.incidents) {
      const entry = techMap.get(e.technique);
      if (entry) {
        entry.count++;
      } else {
        techMap.set(e.technique, { firstSeen: e.timestamp, count: 1 });
      }
    }
    const techniqueEvolution = [...techMap.entries()]
      .map(([technique, v]) => ({
        technique,
        firstSeen: v.firstSeen,
        occurrenceCount: v.count,
      }))
      .sort((a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime());

    const severityTrend = this.computeSeverityTrend(campaign);
    const targetExpansion = this.computeTargetExpansion(campaign);
    const attackFrequency = this.computeAttackFrequency(campaign);
    const adaptationDetected = this.detectAdaptation(campaign);
    const phaseProgression = campaign.phaseHistory.map((p) => p.phase);
    const predictedNextPhase = PHASE_NEXT[campaign.phase];
    const evolutionSummary = this.buildEvolutionSummary(campaign, {
      severityTrend,
      targetExpansion,
      attackFrequency,
      adaptationDetected,
    });

    return {
      campaignId: campaign.campaignId,
      techniqueEvolution,
      severityTrend,
      targetExpansion,
      attackFrequency,
      adaptationDetected,
      phaseProgression,
      predictedNextPhase,
      evolutionSummary,
    };
  }

  /** 严重程度趋势：比较前半段与后半段的平均严重等级。 */
  private computeSeverityTrend(campaign: AttackCampaign): 'escalating' | 'stable' | 'decreasing' {
    const inc = campaign.incidents;
    if (inc.length < 2) return 'stable';
    const half = Math.floor(inc.length / 2);
    const first = this.avgSeverityRank(inc.slice(0, half));
    const recent = this.avgSeverityRank(inc.slice(half));
    if (recent > first + 0.5) return 'escalating';
    if (recent < first - 0.5) return 'decreasing';
    return 'stable';
  }

  /** 目标扩张：比较后半段相对前半段的新增目标与放弃目标。 */
  private computeTargetExpansion(campaign: AttackCampaign): 'expanding' | 'stable' | 'narrowing' {
    const inc = campaign.incidents;
    if (inc.length < 4) return 'stable';
    const half = Math.floor(inc.length / 2);
    const firstTargets = new Set<string>();
    for (const e of inc.slice(0, half)) {
      firstTargets.add(`${e.targetAgent ?? ''}|${e.targetEndpoint ?? ''}`);
    }
    const recentTargets = new Set<string>();
    for (const e of inc.slice(half)) {
      recentTargets.add(`${e.targetAgent ?? ''}|${e.targetEndpoint ?? ''}`);
    }
    const newInRecent = [...recentTargets].filter((t) => !firstTargets.has(t)).length;
    const dropped = [...firstTargets].filter((t) => !recentTargets.has(t)).length;
    if (newInRecent > dropped + 1) return 'expanding';
    if (dropped > newInRecent + 1) return 'narrowing';
    return 'stable';
  }

  /** 攻击频率：比较前半段与后半段的平均事件间隔（间隔缩短即加速）。 */
  private computeAttackFrequency(
    campaign: AttackCampaign,
  ): 'accelerating' | 'steady' | 'decreasing' {
    const inc = campaign.incidents;
    if (inc.length < 4) return 'steady';
    const intervals: number[] = [];
    for (let i = 1; i < inc.length; i++) {
      intervals.push(
        new Date(inc[i].timestamp).getTime() - new Date(inc[i - 1].timestamp).getTime(),
      );
    }
    const half = Math.floor(intervals.length / 2);
    const firstAvg = this.avg(intervals.slice(0, half));
    const recentAvg = this.avg(intervals.slice(half));
    if (firstAvg === 0) return recentAvg === 0 ? 'steady' : 'decreasing';
    const ratio = recentAvg / firstAvg;
    if (ratio < 0.6) return 'accelerating';
    if (ratio > 1.5) return 'decreasing';
    return 'steady';
  }

  /**
   * 适应检测：在某次被阻断的攻击之后是否出现了此前未使用的新技术，
   * 即攻击者在被阻断后改变了战术。
   */
  private detectAdaptation(campaign: AttackCampaign): boolean {
    const techniquesBeforeBlock = new Set<string>();
    let blockSeen = false;
    for (const e of campaign.incidents) {
      if (blockSeen && !techniquesBeforeBlock.has(e.technique)) {
        return true;
      }
      techniquesBeforeBlock.add(e.technique);
      if (e.blocked) blockSeen = true;
    }
    return false;
  }

  // ── Capability 3: Campaign Correlation ───────────────────────────────

  /**
   * 关联多个可能来自同一攻击者的战役：共享基础设施 / 相似技术变体 /
   * 时序接近（波次间休整）/ 目标重叠。使用并查集合并为战役组。
   */
  correlateCampaigns(): CampaignGroup[] {
    // 仅对已确认的战役（达到最小事件数）进行跨战役关联，避免单次孤立事件被误并入战役组。
    const all = [...this.campaigns.values()].filter(
      (c) => c.incidents.length >= this.config.minEventsForCampaign,
    );
    const parent = new Map<string, string>();
    for (const c of all) parent.set(c.campaignId, c.campaignId);

    const find = (id: string): string => {
      let cur = id;
      while (parent.get(cur) !== cur) {
        cur = parent.get(cur) as string;
      }
      // path compression
      let node = id;
      while (parent.get(node) !== cur) {
        const next = parent.get(node) as string;
        parent.set(node, cur);
        node = next;
      }
      return cur;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    // 一次性计算两两相似度，缓存结果
    const pairCache: Array<{
      i: number;
      j: number;
      sim: ReturnType<AttackCampaignTracker['computeCampaignSimilarity']>;
    }> = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const sim = this.computeCampaignSimilarity(all[i], all[j]);
        pairCache.push({ i, j, sim });
        if (sim.score >= this.config.correlationThreshold) {
          union(all[i].campaignId, all[j].campaignId);
        }
      }
    }

    // 按根聚合元数据
    const meta = new Map<
      string,
      { infra: Set<string>; tech: Set<string>; maxScore: number; ids: Set<string> }
    >();
    const ensure = (root: string) => {
      let m = meta.get(root);
      if (!m) {
        m = { infra: new Set(), tech: new Set(), maxScore: 0, ids: new Set() };
        meta.set(root, m);
      }
      return m;
    };
    for (const c of all) {
      ensure(find(c.campaignId)).ids.add(c.campaignId);
    }
    for (const { i, j, sim } of pairCache) {
      const ri = find(all[i].campaignId);
      const rj = find(all[j].campaignId);
      if (ri === rj) {
        const m = ensure(ri);
        for (const x of sim.sharedInfra) m.infra.add(x);
        for (const x of sim.sharedTech) m.tech.add(x);
        m.maxScore = Math.max(m.maxScore, sim.score);
      }
    }

    const groups: CampaignGroup[] = [];
    for (const [, m] of meta) {
      if (m.ids.size < 2) continue;
      const groupCampaigns = [...m.ids]
        .map((id) => this.campaigns.get(id))
        .filter((c): c is AttackCampaign => c !== undefined);
      if (groupCampaigns.length < 2) continue;

      const firstSeen = groupCampaigns.map((c) => c.startTime).sort()[0];
      const lastSeen = groupCampaigns
        .map((c) => c.lastActivityTime)
        .sort()
        .reverse()[0];
      const totalIncidents = groupCampaigns.reduce((acc, c) => acc + c.totalIncidents, 0);
      const groupId = `cgroup-${crypto
        .createHash('sha256')
        .update([...m.ids].sort().join(','))
        .digest('hex')
        .slice(0, 12)}`;
      const likelySameAttacker = m.infra.size > 0 || m.maxScore >= 0.8;

      groups.push({
        groupId,
        campaignIds: [...m.ids].sort(),
        sharedInfrastructure: [...m.infra],
        sharedTechniques: [...m.tech],
        totalIncidents,
        firstSeen,
        lastSeen,
        likelySameAttacker,
        confidence: m.maxScore,
      });

      // 回写战役的关联引用
      for (const id of m.ids) {
        const c = this.campaigns.get(id);
        if (!c) continue;
        c.campaignGroupId = groupId;
        for (const other of m.ids) {
          if (other !== id) c.correlatedCampaignIds.add(other);
        }
      }
    }

    this.campaignGroups.clear();
    for (const g of groups) this.campaignGroups.set(g.groupId, g);
    this.groupsDirty = false;

    if (groups.length > 0) this.logCampaignGroups(groups);
    return groups;
  }

  /** 返回已计算的战役组（若脏则重新计算）。 */
  getCampaignGroups(): CampaignGroup[] {
    if (this.groupsDirty) {
      this.correlateCampaigns();
    }
    return [...this.campaignGroups.values()];
  }

  /**
   * 计算两个战役的相似度与共享要素：基础设施（IP/前缀/UA/租户）、技术（Jaccard）、
   * 签名、目标重叠、波次间时序接近。
   */
  private computeCampaignSimilarity(
    a: AttackCampaign,
    b: AttackCampaign,
  ): { score: number; sharedInfra: string[]; sharedTech: string[] } {
    const sharedInfra: string[] = [];

    // IP 精确重叠
    for (const ip of a.sourceIps) {
      if (b.sourceIps.has(ip)) sharedInfra.push(ip);
    }
    // IP 段（前缀）重叠
    const aPrefixes = new Set([...a.sourceIps].map((ip) => this.ipPrefix(ip)));
    for (const ip of b.sourceIps) {
      const p = this.ipPrefix(ip);
      if (aPrefixes.has(p) && !sharedInfra.includes(p)) sharedInfra.push(p);
    }
    // UA / 租户重叠
    for (const ua of a.userAgents) {
      if (b.userAgents.has(ua)) sharedInfra.push(`ua:${ua}`);
    }
    for (const t of a.tenantIds) {
      if (b.tenantIds.has(t)) sharedInfra.push(`tenant:${t}`);
    }

    const sharedTech = a.techniquesUsed.filter((t) => b.techniquesUsed.includes(t));

    let score = 0;
    const ipOverlap = this.jaccard(a.sourceIps, b.sourceIps);
    const uaOverlap = this.jaccard(a.userAgents, b.userAgents);
    const tenantOverlap = this.jaccard(a.tenantIds, b.tenantIds);
    score += Math.max(ipOverlap, uaOverlap) * 0.35;
    score += tenantOverlap * 0.1;

    const techUnion = new Set([...a.techniquesUsed, ...b.techniquesUsed]);
    const techOverlap = techUnion.size === 0 ? 0 : sharedTech.length / techUnion.size;
    score += techOverlap * 0.3;

    score += this.jaccard(a.signatureIds, b.signatureIds) * 0.15;
    score += this.jaccard(a.affectedAgents, b.affectedAgents) * 0.1;

    // 时序接近（波次间休整）：一个战役的开始接近另一个战役的结束
    const gap1 = Math.abs(new Date(a.lastActivityTime).getTime() - new Date(b.startTime).getTime());
    const gap2 = Math.abs(new Date(b.lastActivityTime).getTime() - new Date(a.startTime).getTime());
    if (Math.min(gap1, gap2) < this.config.correlationWindowMs * 7) score += 0.1;

    score = Math.min(1, score);
    return { score, sharedInfra, sharedTech };
  }

  // ── Capability 4: Predictive Defense ─────────────────────────────────

  /**
   * 基于战役历史与当前阶段预测攻击者下一步，返回最高置信度的预测。
   * 历史不足 5 事件时返回 undefined。
   */
  predictNextMove(campaignId: string): CampaignPrediction | undefined {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign || campaign.incidents.length < 5) return undefined;

    const added = this.generateAndStorePredictions(campaign);
    const all = this.getPredictions(campaignId);
    if (added.length > 0) {
      return added.reduce((best, p) => (p.confidence > best.confidence ? p : best));
    }
    return all.sort((a, b) => b.confidence - a.confidence)[0];
  }

  /** 返回战役所有未过期的预测（已按创建时间倒序）。 */
  getPredictions(campaignId: string): CampaignPrediction[] {
    this.pruneExpiredPredictions();
    const out: CampaignPrediction[] = [];
    for (const p of this.predictions.values()) {
      if (p.campaignId === campaignId) out.push(p);
    }
    return out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** 标记某条预测已应验（被攻击者行为证实）。 */
  markPredictionFulfilled(predictionId: string): boolean {
    const p = this.predictions.get(predictionId);
    if (!p) return false;
    p.fulfilled = true;
    try {
      getGlobalMetrics().incrementCounter('predictions_fulfilled', 1);
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:markPredictionFulfilled');
    }
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity: 'low',
        source: 'AttackCampaignTracker',
        message: `Prediction fulfilled: ${p.prediction}`,
        details: { predictionId, campaignId: p.campaignId },
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:markPredictionFulfilled');
    }
    return true;
  }

  /**
   * 依据当前阶段构建一组预测。每个阶段产出对应类型的预测（下一阶段 / 下一目标 /
   * 下一技术 / 升级等级 / 适应策略），含置信度、防御建议与先发制人动作。
   */
  private buildPredictions(campaign: AttackCampaign): CampaignPrediction[] {
    const preds: CampaignPrediction[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.predictionExpiryMs).toISOString();
    const createdAt = now.toISOString();
    const base = {
      campaignId: campaign.campaignId,
      createdAt,
      expiresAt,
      fulfilled: false,
    };

    const probingTargets = this.predictProbingTargets(campaign);

    switch (campaign.phase) {
      case 'reconnaissance':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_phase',
          prediction: 'Likely transitioning to systematic probing of identified targets',
          confidence: 0.6,
          recommendedDefense: 'Increase logging on discovered endpoints; prepare rate limits',
          preemptiveActions: [
            'Enable detailed audit logging on probed endpoints',
            'Pre-warm rate-limit rules for likely-probed targets',
          ],
        });
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_target',
          prediction: `Likely to probe: ${probingTargets.join(', ') || 'additional endpoints on affected agents'}`,
          confidence: 0.55,
          recommendedDefense: 'Harden endpoints not yet probed but in the same agent/tenant',
          preemptiveActions: [
            'Audit sibling endpoints on affected agents',
            'Add input validation to unprobed endpoints',
          ],
        });
        break;
      case 'probing':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_phase',
          prediction: 'Likely transitioning to active exploitation of vulnerable targets',
          confidence: 0.65,
          recommendedDefense: 'Patch and verify the systematically probed endpoints',
          preemptiveActions: [
            'Patch probed endpoints',
            'Enable exploit-prevention rules',
            'Block IPs hitting probed endpoints',
          ],
        });
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_technique',
          prediction: 'Likely to attempt exploitation techniques matching probed weaknesses',
          confidence: 0.55,
          recommendedDefense: 'Prepare signatures for likely exploit techniques',
          preemptiveActions: ['Load exploit signatures', 'Tighten tool allowlists'],
        });
        break;
      case 'exploitation':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_phase',
          prediction: 'Likely escalating to higher-privilege targets after initial foothold',
          confidence: 0.7,
          recommendedDefense: 'Contain compromised agents; rotate credentials',
          preemptiveActions: [
            'Isolate compromised agents',
            'Rotate credentials on affected tenants',
            'Block lateral tool calls',
          ],
        });
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_target',
          prediction: 'Likely to target higher-privilege agents and credential stores',
          confidence: 0.6,
          recommendedDefense: 'Harden privileged agents and credential access',
          preemptiveActions: [
            'Lock down privileged agents',
            'Require approval for credential access',
          ],
        });
        break;
      case 'escalation':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_phase',
          prediction: 'Likely attempting persistence on compromised systems',
          confidence: 0.7,
          recommendedDefense: 'Hunt for persistence mechanisms; audit scheduled tasks and configs',
          preemptiveActions: [
            'Audit persistence surfaces',
            'Monitor for config/scheduled-task changes',
            'Snapshot affected agents',
          ],
        });
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'escalation_level',
          prediction: 'Severity likely to reach critical if not contained',
          confidence: 0.65,
          recommendedDefense: 'Raise alerting threshold; engage incident response',
          preemptiveActions: ['Escalate to incident response', 'Enable enhanced monitoring'],
        });
        break;
      case 'persistence':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_phase',
          prediction: 'Likely to be detected and blocked, or attempt further lateral movement',
          confidence: 0.55,
          recommendedDefense: 'Aggressively hunt and eradicate persistence',
          preemptiveActions: [
            'Scan for backdoors',
            'Re-verify agent integrity',
            'Force re-deployment of affected agents',
          ],
        });
        break;
      case 'blocked':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'adaptation_strategy',
          prediction: 'Attacker likely to adapt: rotate source IP/UA, or switch techniques',
          confidence: 0.75,
          recommendedDefense:
            'Prepare for variant attacks; broaden detection to technique families',
          preemptiveActions: [
            'Extend blocks to IP ranges',
            'Add technique-family signatures',
            'Watch for new source IPs hitting same targets',
          ],
        });
        break;
      case 'detected':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'adaptation_strategy',
          prediction: 'Attacker may go dormant or switch tactics to evade detection',
          confidence: 0.6,
          recommendedDefense: 'Maintain heightened monitoring; watch for low-and-slow variants',
          preemptiveActions: ['Keep enhanced logging active', 'Monitor for dormant-period probing'],
        });
        break;
      case 'dormant':
        preds.push({
          ...base,
          predictionId: this.predId(),
          type: 'next_phase',
          prediction: 'Potential new wave of reconnaissance if attacker resumes',
          confidence: 0.4,
          recommendedDefense: 'Keep monitoring; retain defensive hardening',
          preemptiveActions: ['Retain IP/UA blocks', 'Keep signatures loaded'],
        });
        break;
    }
    return preds;
  }

  /**
   * 生成并存储预测：对未过期且同类型不重复的预测进行补充，遵循每战役上限。
   * 仅在历史 >= 5 事件时生效。
   */
  private generateAndStorePredictions(campaign: AttackCampaign): CampaignPrediction[] {
    if (campaign.incidents.length < 5) return [];
    const built = this.buildPredictions(campaign);
    const existing = this.getPredictions(campaign.campaignId);
    const existingTypes = new Set(existing.map((p) => p.type));
    const added: CampaignPrediction[] = [];

    for (const pred of built) {
      if (existingTypes.has(pred.type)) continue;
      if (this.countPredictions(campaign.campaignId) >= this.config.maxPredictionsPerCampaign)
        break;
      this.predictions.set(pred.predictionId, pred);
      this.recordPredictionMade();
      this.logPrediction(campaign, pred);
      added.push(pred);
    }
    return added;
  }

  /** 预测可能被探测的目标：当前受影响端点 / 工具的邻接集合。 */
  private predictProbingTargets(campaign: AttackCampaign): string[] {
    const targets: string[] = [];
    for (const ep of campaign.affectedEndpoints) {
      targets.push(ep);
      if (targets.length >= 3) break;
    }
    for (const t of campaign.affectedTools) {
      targets.push(`tool:${t}`);
      if (targets.length >= 5) break;
    }
    return targets;
  }

  private predId(): string {
    return `pred_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  }

  private countPredictions(campaignId: string): number {
    let n = 0;
    for (const p of this.predictions.values()) {
      if (p.campaignId === campaignId) n++;
    }
    return n;
  }

  private pruneExpiredPredictions(): void {
    const now = Date.now();
    for (const [id, p] of this.predictions) {
      if (now > new Date(p.expiresAt).getTime()) {
        this.predictions.delete(id);
      }
    }
  }

  // ── Maintenance ──────────────────────────────────────────────────────

  /** 清理过期战役：超过 maxCampaignAge 删除；超过休眠阈值标记 dormant。 */
  private pruneStaleCampaigns(nowRef: number): void {
    const dormantThreshold = this.config.correlationWindowMs * 4;
    for (const campaign of [...this.campaigns.values()]) {
      const age = nowRef - new Date(campaign.lastActivityTime).getTime();
      if (age > this.config.maxCampaignAge) {
        this.campaigns.delete(campaign.campaignId);
        continue;
      }
      if (age > dormantThreshold && campaign.active) {
        campaign.active = false;
        if (campaign.phase !== 'dormant') {
          campaign.phaseHistory.push({
            phase: 'dormant',
            timestamp: new Date().toISOString(),
            trigger: 'inactivity',
          });
          campaign.phase = 'dormant';
        }
      }
    }
  }

  /** 限制战役数量上限：优先淘汰休眠战役，再淘汰最久未活动的活跃战役。 */
  private enforceMaxCampaigns(): void {
    if (this.campaigns.size <= this.config.maxCampaigns) return;
    const byAge = [...this.campaigns.values()].sort(
      (a, b) => new Date(a.lastActivityTime).getTime() - new Date(b.lastActivityTime).getTime(),
    );
    for (const c of byAge) {
      if (this.campaigns.size <= this.config.maxCampaigns) break;
      if (!c.active) this.campaigns.delete(c.campaignId);
    }
    while (this.campaigns.size > this.config.maxCampaigns) {
      const remaining = [...this.campaigns.values()].sort(
        (a, b) => new Date(a.lastActivityTime).getTime() - new Date(b.lastActivityTime).getTime(),
      );
      if (remaining.length === 0) break;
      this.campaigns.delete(remaining[0].campaignId);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private avgSeverityRank(events: AttackEvent[]): number {
    if (events.length === 0) return 0;
    const sum = events.reduce((acc, e) => acc + SEVERITY_RANK[e.severity], 0);
    return sum / events.length;
  }

  private avg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /** 统计对已见目标的重复攻击次数（衡量持久化倾向）。 */
  private countTargetRepeats(campaign: AttackCampaign): number {
    const seen = new Set<string>();
    let repeats = 0;
    for (const e of campaign.incidents) {
      const key = `${e.targetAgent ?? ''}|${e.targetEndpoint ?? ''}|${e.targetTool ?? ''}`;
      if (seen.has(key)) repeats++;
      else seen.add(key);
    }
    return repeats;
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  /** 提取 IP 所属网段：IPv4 取 /24，IPv6 取 /64，其余原样返回。 */
  private ipPrefix(ip: string): string {
    const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
    if (v4) return `${v4[1]}.0/24`;
    if (ip.includes(':')) {
      const parts = ip.split(':');
      return `${parts.slice(0, 4).join(':')}::/64`;
    }
    return ip;
  }

  /** 事件 IP 是否与战役已知 IP 共享网段。 */
  private ipRangeOverlaps(ip: string, ips: Set<string>): boolean {
    const prefix = this.ipPrefix(ip);
    for (const existing of ips) {
      if (this.ipPrefix(existing) === prefix) return true;
    }
    return false;
  }

  private buildEvolutionSummary(
    campaign: AttackCampaign,
    e: {
      severityTrend: string;
      targetExpansion: string;
      attackFrequency: string;
      adaptationDetected: boolean;
    },
  ): string {
    const parts: string[] = [];
    parts.push(`Campaign ${campaign.name} (${campaign.phase})`);
    parts.push(
      `${campaign.totalIncidents} incidents across ${campaign.affectedAgents.size} agent(s)`,
    );
    parts.push(`severity ${e.severityTrend}`);
    parts.push(`targets ${e.targetExpansion}`);
    parts.push(`frequency ${e.attackFrequency}`);
    if (e.adaptationDetected)
      parts.push('attacker adaptation detected (technique shift after block)');
    parts.push(`${campaign.techniquesUsed.length} technique(s) used`);
    return parts.join('; ');
  }

  // ── Audit & Metrics ──────────────────────────────────────────────────

  private logCampaignCreated(campaign: AttackCampaign): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity: campaign.severity,
        source: 'AttackCampaignTracker',
        message: `New attack campaign detected: ${campaign.name}`,
        details: {
          campaignId: campaign.campaignId,
          phase: campaign.phase,
          technique: campaign.techniquesUsed[0],
          sourceIp: campaign.incidents[0]?.sourceIp,
        },
        context: {
          tenantId: [...campaign.tenantIds][0],
          agentId: [...campaign.affectedAgents][0],
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logCampaignCreated');
    }
    try {
      getGlobalLogger().info('AttackCampaignTracker', `Campaign created: ${campaign.campaignId}`, {
        phase: campaign.phase,
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logCampaignCreated');
    }
  }

  private logCampaignEvent(campaign: AttackCampaign, event: AttackEvent): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity: event.severity,
        source: 'AttackCampaignTracker',
        message: `Attack event tracked in campaign ${campaign.name}: ${event.attackType} — ${event.description}`,
        details: {
          campaignId: campaign.campaignId,
          eventId: event.eventId,
          phase: campaign.phase,
          blocked: event.blocked,
          sourceModule: event.sourceModule,
          sourceIp: event.sourceIp,
          targetAgent: event.targetAgent,
        },
        context: { tenantId: event.tenantId, agentId: event.targetAgent },
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logCampaignEvent');
    }
  }

  private logPhaseTransition(
    campaign: AttackCampaign,
    phase: CampaignPhase,
    trigger: string,
  ): void {
    try {
      const severity: SecuritySeverity =
        phase === 'exploitation' || phase === 'escalation' || phase === 'persistence'
          ? 'high'
          : phase === 'blocked' || phase === 'detected'
            ? 'medium'
            : 'low';
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity,
        source: 'AttackCampaignTracker',
        message: `Campaign ${campaign.name} phase transition → ${phase}`,
        details: {
          campaignId: campaign.campaignId,
          phase,
          trigger,
          totalIncidents: campaign.totalIncidents,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logPhaseTransition');
    }
    try {
      getGlobalLogger().warn(
        'AttackCampaignTracker',
        `Phase transition: ${campaign.campaignId} → ${phase}`,
        {
          trigger,
        },
      );
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logPhaseTransition');
    }
  }

  private logEvolutionaryLink(campaign: AttackCampaign, event: AttackEvent): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity: 'high',
        source: 'AttackCampaignTracker',
        message: `Evolutionary link detected: campaign ${campaign.name} reactivated by variant attack`,
        details: {
          campaignId: campaign.campaignId,
          eventId: event.eventId,
          technique: event.technique,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logEvolutionaryLink');
    }
  }

  private logPrediction(campaign: AttackCampaign, pred: CampaignPrediction): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: 'security_decision',
        severity: pred.confidence >= 0.7 ? 'high' : 'medium',
        source: 'AttackCampaignTracker',
        message: `Prediction for ${campaign.name}: [${pred.type}] ${pred.prediction}`,
        details: {
          campaignId: campaign.campaignId,
          predictionId: pred.predictionId,
          confidence: pred.confidence,
          recommendedDefense: pred.recommendedDefense,
        },
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logPrediction');
    }
    try {
      getGlobalLogger().info('AttackCampaignTracker', `Prediction: ${pred.prediction}`, {
        campaignId: campaign.campaignId,
        confidence: pred.confidence,
      });
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logPrediction');
    }
  }

  private logCampaignGroups(groups: CampaignGroup[]): void {
    try {
      for (const g of groups) {
        getSecurityAuditLogger().logEvent({
          type: 'security_decision',
          severity: g.likelySameAttacker ? 'high' : 'medium',
          source: 'AttackCampaignTracker',
          message: `Campaign group formed: ${g.campaignIds.length} campaigns correlated`,
          details: {
            groupId: g.groupId,
            campaignIds: g.campaignIds,
            confidence: g.confidence,
            sharedInfrastructure: g.sharedInfrastructure,
            sharedTechniques: g.sharedTechniques,
            likelySameAttacker: g.likelySameAttacker,
          },
        });
      }
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:logCampaignGroups');
    }
  }

  private recordCampaignsActive(): void {
    try {
      const active = [...this.campaigns.values()].filter((c) => c.active).length;
      getGlobalMetrics().setGauge('campaigns_active', active);
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:recordCampaignsActive');
    }
  }

  private recordCampaignBlocked(): void {
    try {
      getGlobalMetrics().incrementCounter('campaigns_blocked', 1);
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:recordCampaignBlocked');
    }
  }

  private recordPredictionMade(): void {
    try {
      getGlobalMetrics().incrementCounter('predictions_made', 1);
    } catch (err) {
      reportSilentFailure(err, 'attackCampaignTracker:recordPredictionMade');
    }
  }

  // ── Public Accessors ─────────────────────────────────────────────────

  /** 获取单个战役。 */
  getCampaign(campaignId: string): AttackCampaign | undefined {
    return this.campaigns.get(campaignId);
  }

  /** 获取所有活跃战役。 */
  getActiveCampaigns(): AttackCampaign[] {
    return [...this.campaigns.values()].filter((c) => c.active);
  }

  /** 获取所有战役（活跃 + 休眠）。 */
  getAllCampaigns(): AttackCampaign[] {
    return [...this.campaigns.values()];
  }

  /** 获取追踪器聚合统计。 */
  getStats(): CampaignTrackerStats {
    let active = 0;
    let blocked = 0;
    let dormant = 0;
    let totalIncidents = 0;
    let fulfilled = 0;
    for (const c of this.campaigns.values()) {
      if (c.active) active++;
      if (c.blocked) blocked++;
      if (c.phase === 'dormant') dormant++;
      totalIncidents += c.totalIncidents;
    }
    this.pruneExpiredPredictions();
    let totalPredictions = 0;
    let activePredictions = 0;
    for (const p of this.predictions.values()) {
      totalPredictions++;
      if (p.fulfilled) fulfilled++;
      else activePredictions++;
    }
    return {
      totalCampaigns: this.campaigns.size,
      activeCampaigns: active,
      blockedCampaigns: blocked,
      dormantCampaigns: dormant,
      campaignGroups: this.campaignGroups.size,
      totalPredictions,
      activePredictions,
      fulfilledPredictions: fulfilled,
      totalIncidents,
    };
  }

  /** 更新配置（合并）。 */
  updateConfig(config: Partial<CampaignTrackerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置副本。 */
  getConfig(): CampaignTrackerConfig {
    return { ...this.config };
  }

  /** 重置追踪器状态（用于测试隔离）。 */
  reset(): void {
    this.campaigns.clear();
    this.campaignGroups.clear();
    this.predictions.clear();
    this.groupsDirty = true;
  }
}

// ============================================================================
// Singleton
// ============================================================================

const trackerSingleton = createTenantAwareSingleton(() => new AttackCampaignTracker(), {
  allowGlobalFallback: true,
});

/**
 * 获取 AttackCampaignTracker 单例。可选配置仅在尚无战役时应用一次，
 * 以避免在运行期反复覆盖配置。
 */
export function getAttackCampaignTracker(
  config?: Partial<CampaignTrackerConfig>,
): AttackCampaignTracker {
  const tracker = trackerSingleton.get();
  if (config && tracker.getAllCampaigns().length === 0) {
    tracker.updateConfig(config);
  }
  return tracker;
}

/** 重置 AttackCampaignTracker 单例（用于测试隔离）。 */
export function resetAttackCampaignTracker(): void {
  trackerSingleton.reset();
}
