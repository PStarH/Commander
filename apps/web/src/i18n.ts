/**
 * Web i18n — Lightweight internationalization for the War Room UI.
 *
 * Mirrors the CLI locale detection strategy (COMMANDER_LANG env / browser
 * language) so the web UI stays consistent with the CLI experience. Falls
 * back to English for any missing key, so untranslated strings NEVER throw.
 *
 * Usage:
 *   import { t } from '../i18n';
 *   t('nav.dashboard')  // "Dashboard" or "仪表盘"
 */

type Locale = 'en' | 'zh-CN';

function detectLocale(): Locale {
  // Allow server-side / build-time override first
  const explicit =
    (import.meta.env.VITE_COMMANDER_LANG as string | undefined) ??
    (typeof navigator !== 'undefined' ? navigator.language : '');
  if (explicit.startsWith('zh')) return 'zh-CN';
  return 'en';
}

const CURRENT_LOCALE: Locale = detectLocale();

export function getLocale(): Locale {
  return CURRENT_LOCALE;
}

export function isChinese(): boolean {
  return CURRENT_LOCALE === 'zh-CN';
}

// Translation tables. Keep keys namespaced (e.g. "nav.<item>").
const TRANSLATIONS: Record<Locale, Record<string, string>> = {
  en: {
    'nav.dashboard': 'Dashboard',
    'nav.chat': 'Chat',
    'nav.agents': 'Agents',
    'nav.missions': 'Missions',
    'nav.execution': 'Execution',
    'nav.memory': 'Memory',
    'nav.governance': 'Governance',
    'nav.dlq': 'DLQ',
    'nav.security': 'Security',
    'nav.audit': 'Audit Log',
    'nav.knowledge': 'Knowledge',
    'nav.cost': 'Cost',
    'nav.settings': 'Settings',
    'nav.alerts': 'Alerts',
    'nav.onboarding': 'Onboarding',
    'nav.users': 'Users',
    'nav.workflows': 'Workflows',
    'nav.sso': 'SSO',
    'nav.poc': 'POC Center',
    'nav.slo': 'SLO',
    'poc.sectionLabel': 'Enterprise Scenarios',
    'poc.title': 'Proof-of-Value Center',
    'poc.desc':
      'Illustrative reference scenarios for Commander pilots across finance, manufacturing, and healthcare. These are demo scenarios, not real customer pilots.',
    'poc.disclaimer':
      'These are illustrative reference scenarios, not real customer pilots. Figures are representative demo data, not customer-reported results. Real, attributable pilot case studies will be published here as they become available.',
    'poc.metric.scenarios': 'Illustrative scenarios',
    'poc.metric.industries': 'Industries',
    'poc.metric.avgDuration': 'Illustrative Duration',
    'poc.weeks': 'weeks',
    'poc.status.illustrative': 'Illustrative demo',
    'poc.value.illustrative': 'Illustrative',
    'poc.scopeTitle': 'Scope',
    'poc.expand': 'Read more',
    'poc.collapse': 'Show less',
    'poc.footnote':
      'Figures are illustrative deltas for these demo scenarios, not customer-reported results from real pilots.',
    'poc.industry.finance': 'Financial Services',
    'poc.customer.finance': 'Illustrative finance workflow — trade surveillance',
    'poc.useCase.finance':
      'Autonomous alert triage and multi-hop evidence gathering across trade, chat, and market data.',
    'poc.scope.finance.1': 'Example: 2.4M daily alerts via a streaming pipeline',
    'poc.scope.finance.2': 'Multi-agent topology: dispatcher → analyst → verifier',
    'poc.scope.finance.3': 'Mandatory mTLS + capability-token gating on tool calls',
    'poc.metric.compliance': 'Audit accuracy',
    'poc.detail.compliance': 'human-equivalent decision quality',
    'poc.metric.review': 'Analyst review time',
    'poc.detail.review': 'automated evidence packs',
    'poc.metric.latency': 'p95 alert latency',
    'poc.detail.latency': 'end-to-end SLA',
    'poc.industry.manufacturing': 'Manufacturing',
    'poc.customer.manufacturing': 'Illustrative manufacturing workflow — predictive maintenance',
    'poc.useCase.manufacturing':
      'Root-cause analysis of line stoppages using telemetry, maintenance logs, and vendor manuals.',
    'poc.scope.manufacturing.1': 'Example: 8 plant SCADA feeds through read-only adapters',
    'poc.scope.manufacturing.2': 'Compensation registry for reversible diagnostic actions',
    'poc.scope.manufacturing.3': 'Chaos benchmarks before go-live',
    'poc.metric.downtime': 'Unplanned downtime',
    'poc.detail.downtime': 'faster mean-time-to-detect',
    'poc.metric.falsePositive': 'False-positive dispatches',
    'poc.detail.falsePositive': 'verified before alerting',
    'poc.metric.rca': 'Root-cause speed',
    'poc.detail.rca': 'evidence aggregation',
    'poc.industry.healthcare': 'Healthcare',
    'poc.customer.healthcare': 'Illustrative healthcare workflow — clinical documentation',
    'poc.useCase.healthcare':
      'Ambient note summarization with automatic PII redaction and provider verification loops.',
    'poc.scope.healthcare.1': 'On-prem deployment with encrypted secrets vault',
    'poc.scope.healthcare.2': 'Three-layer memory with tenant isolation per hospital',
    'poc.scope.healthcare.3': 'LLM-as-judge quality gate on every note',
    'poc.metric.pii': 'PII leakage events',
    'poc.detail.pii': 'redaction + DLP verified',
    'poc.metric.document': 'Documentation throughput',
    'poc.detail.document': 'clinician time recovered',
    'poc.metric.audit': 'Audit coverage',
    'poc.detail.audit': 'all generations logged',
  },
  'zh-CN': {
    'nav.dashboard': '仪表盘',
    'nav.chat': '对话',
    'nav.agents': '智能体',
    'nav.missions': '任务',
    'nav.execution': '执行',
    'nav.memory': '记忆',
    'nav.governance': '治理',
    'nav.dlq': '死信队列',
    'nav.security': '安全',
    'nav.audit': '审计日志',
    'nav.knowledge': '知识库',
    'nav.cost': '成本',
    'nav.settings': '设置',
    'nav.alerts': '告警中心',
    'nav.onboarding': '上手引导',
    'nav.users': '用户管理',
    'nav.workflows': '工作流编排',
    'nav.sso': 'SSO 登录',
    'nav.poc': 'POC 中心',
    'nav.slo': 'SLO',
    'poc.sectionLabel': '企业示例场景',
    'poc.title': '价值验证中心',
    'poc.desc':
      '金融、制造和医疗三个行业 Commander 试点的示例参考场景。这些是演示场景，并非真实客户试点。',
    'poc.disclaimer':
      '这些是示例参考场景，并非真实客户试点。数据为代表性演示数据，不是客户报告的真实结果。真实、可归属的试点案例将在可用后在此发布。',
    'poc.metric.scenarios': '示例场景数',
    'poc.metric.industries': '覆盖行业',
    'poc.metric.avgDuration': '示例周期',
    'poc.weeks': '周',
    'poc.status.illustrative': '演示示例',
    'poc.value.illustrative': '示例',
    'poc.scopeTitle': '试点范围',
    'poc.expand': '展开详情',
    'poc.collapse': '收起详情',
    'poc.footnote': '数据为这些演示场景的示例改进值，并非来自真实试点的客户报告结果。',
    'poc.industry.finance': '金融服务',
    'poc.customer.finance': '演示：金融交易监控工作流',
    'poc.useCase.finance': '自主告警分诊，跨交易、聊天与市场数据进行多跳证据收集。',
    'poc.scope.finance.1': '示例：通过流式管道每日摄入 240 万条告警',
    'poc.scope.finance.2': '多智能体拓扑：调度员 → 分析师 → 校验员',
    'poc.scope.finance.3': '工具调用强制 mTLS + 能力令牌管控',
    'poc.metric.compliance': '审计准确率',
    'poc.detail.compliance': '达到人工等价决策质量',
    'poc.metric.review': '分析师复核时间',
    'poc.detail.review': '证据包自动化生成',
    'poc.metric.latency': 'P95 告警延迟',
    'poc.detail.latency': '端到端 SLA',
    'poc.industry.manufacturing': '制造业',
    'poc.customer.manufacturing': '演示：制造业预测性维护工作流',
    'poc.useCase.manufacturing': '基于遥测、维修日志与供应商手册对产线停机进行根因分析。',
    'poc.scope.manufacturing.1': '示例：通过只读适配器接入 8 个工厂 SCADA 数据流',
    'poc.scope.manufacturing.2': '可逆诊断操作的补偿注册表',
    'poc.scope.manufacturing.3': '上线前通过混沌基准测试',
    'poc.metric.downtime': '非计划停机',
    'poc.detail.downtime': '平均发现时间显著缩短',
    'poc.metric.falsePositive': '误派工单',
    'poc.detail.falsePositive': '告警前完成验证',
    'poc.metric.rca': '根因定位速度',
    'poc.detail.rca': '证据聚合效率提升',
    'poc.industry.healthcare': '医疗健康',
    'poc.customer.healthcare': '演示：医疗临床文档工作流',
    'poc.useCase.healthcare': '环境音病程摘要，自动脱敏 PII，并引入提供者校验闭环。',
    'poc.scope.healthcare.1': '本地部署 + 加密密钥保险箱',
    'poc.scope.healthcare.2': '按医院隔离的三层记忆与租户隔离',
    'poc.scope.healthcare.3': '每条笔记经 LLM-as-Judge 质量门',
    'poc.metric.pii': 'PII 泄露事件',
    'poc.detail.pii': '脱敏与 DLP 验证通过',
    'poc.metric.document': '文档产出效率',
    'poc.detail.document': '节省临床医生时间',
    'poc.metric.audit': '审计覆盖率',
    'poc.detail.audit': '全部生成内容可审计',
  },
};

/**
 * Translate a key. Missing locale entries fall back to English; missing
 * English entries fall back to the key itself (so problems are visible
 * instead of silently rendering empty).
 */
export function t(key: string): string {
  const zh = TRANSLATIONS['zh-CN'][key];
  if (CURRENT_LOCALE === 'zh-CN' && zh) return zh;
  return TRANSLATIONS.en[key] ?? key;
}
