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
    'poc.sectionLabel': 'Enterprise Pilots',
    'poc.title': 'Proof-of-Value Center',
    'poc.desc':
      'Illustrative reference scenarios for Commander pilots across finance, manufacturing, and healthcare. These are demo scenarios, not real customer pilots.',
    'poc.disclaimer':
      'These are illustrative reference scenarios, not real customer pilots. Figures are representative demo data, not customer-reported results. Real, attributable pilot case studies will be published here as they become available.',
    'poc.metric.completed': 'Completed / Live',
    'poc.metric.industries': 'Industries',
    'poc.metric.avgDuration': 'Avg. Pilot Duration',
    'poc.weeks': 'weeks',
    'poc.status.live': 'Live',
    'poc.status.completed': 'Completed',
    'poc.status.pilot': 'Pilot',
    'poc.scopeTitle': 'Scope',
    'poc.expand': 'Read more',
    'poc.collapse': 'Show less',
    'poc.footnote':
      'Figures are illustrative deltas for these demo scenarios, not customer-reported results from real pilots.',
    'poc.industry.finance': 'Financial Services',
    'poc.customer.finance': 'Tier-1 Investment Bank — Trade Surveillance',
    'poc.useCase.finance':
      'Autonomous alert triage and multi-hop evidence gathering across trade, chat, and market data.',
    'poc.scope.finance.1': 'Ingested 2.4M daily alerts via streaming pipeline',
    'poc.scope.finance.2': 'Multi-agent topology: dispatcher → analyst → verifier',
    'poc.scope.finance.3': 'Mandatory mTLS + capability-token gating on tool calls',
    'poc.metric.compliance': 'Audit accuracy',
    'poc.detail.compliance': 'human-equivalent decision quality',
    'poc.metric.review': 'Analyst review time',
    'poc.detail.review': 'automated evidence packs',
    'poc.metric.latency': 'p95 alert latency',
    'poc.detail.latency': 'end-to-end SLA',
    'poc.quote.finance':
      'The auditor could trace every decision to a signed capability token and an immutable event log.',
    'poc.industry.manufacturing': 'Manufacturing',
    'poc.customer.manufacturing': 'Global Automotive OEM — Predictive Maintenance',
    'poc.useCase.manufacturing':
      'Root-cause analysis of line stoppages using telemetry, maintenance logs, and vendor manuals.',
    'poc.scope.manufacturing.1': 'Connected 8 plant SCADA feeds through read-only adapters',
    'poc.scope.manufacturing.2': 'Compensation registry for reversible diagnostic actions',
    'poc.scope.manufacturing.3': 'Chaos benchmarks before go-live',
    'poc.metric.downtime': 'Unplanned downtime',
    'poc.detail.downtime': 'faster mean-time-to-detect',
    'poc.metric.falsePositive': 'False-positive dispatches',
    'poc.detail.falsePositive': 'verified before alerting',
    'poc.metric.rca': 'Root-cause speed',
    'poc.detail.rca': 'evidence aggregation',
    'poc.quote.manufacturing':
      'For the first time, maintenance and operations speak the same language in under a minute.',
    'poc.industry.healthcare': 'Healthcare',
    'poc.customer.healthcare': 'Regional Health System — Clinical Documentation',
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
    'poc.quote.healthcare':
      'We needed local-first control of patient data; Commander proved we could keep it.',
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
    'poc.sectionLabel': '企业试点',
    'poc.title': '价值验证中心',
    'poc.desc': '金融、制造和医疗三个行业 Commander 试点的示例参考场景。这些是演示场景，并非真实客户试点。',
    'poc.disclaimer':
      '这些是示例参考场景，并非真实客户试点。数据为代表性演示数据，不是客户报告的真实结果。真实、可归属的试点案例将在可用后在此发布。',
    'poc.metric.completed': '已完成 / 上线',
    'poc.metric.industries': '覆盖行业',
    'poc.metric.avgDuration': '平均试点周期',
    'poc.weeks': '周',
    'poc.status.live': '已上线',
    'poc.status.completed': '已完成',
    'poc.status.pilot': '试点中',
    'poc.scopeTitle': '试点范围',
    'poc.expand': '展开详情',
    'poc.collapse': '收起详情',
    'poc.footnote': '数据为这些演示场景的示例改进值，并非来自真实试点的客户报告结果。',
    'poc.industry.finance': '金融服务',
    'poc.customer.finance': '头部投资银行 — 交易监控',
    'poc.useCase.finance': '自主告警分诊，跨交易、聊天与市场数据进行多跳证据收集。',
    'poc.scope.finance.1': '通过流式管道每日摄入 240 万条告警',
    'poc.scope.finance.2': '多智能体拓扑：调度员 → 分析师 → 校验员',
    'poc.scope.finance.3': '工具调用强制 mTLS + 能力令牌管控',
    'poc.metric.compliance': '审计准确率',
    'poc.detail.compliance': '达到人工等价决策质量',
    'poc.metric.review': '分析师复核时间',
    'poc.detail.review': '证据包自动化生成',
    'poc.metric.latency': 'P95 告警延迟',
    'poc.detail.latency': '端到端 SLA',
    'poc.quote.finance': '审计员可以将每一项决策追溯到签名能力令牌和不可变事件日志。',
    'poc.industry.manufacturing': '制造业',
    'poc.customer.manufacturing': '全球汽车主机厂 — 预测性维护',
    'poc.useCase.manufacturing': '基于遥测、维修日志与供应商手册对产线停机进行根因分析。',
    'poc.scope.manufacturing.1': '通过只读适配器接入 8 个工厂 SCADA 数据流',
    'poc.scope.manufacturing.2': '可逆诊断操作的补偿注册表',
    'poc.scope.manufacturing.3': '上线前通过混沌基准测试',
    'poc.metric.downtime': '非计划停机',
    'poc.detail.downtime': '平均发现时间显著缩短',
    'poc.metric.falsePositive': '误派工单',
    'poc.detail.falsePositive': '告警前完成验证',
    'poc.metric.rca': '根因定位速度',
    'poc.detail.rca': '证据聚合效率提升',
    'poc.quote.manufacturing': '维护与运营首次能在不到一分钟内使用同一套语言沟通。',
    'poc.industry.healthcare': '医疗健康',
    'poc.customer.healthcare': '区域医疗系统 — 临床文档',
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
    'poc.quote.healthcare': '我们需要把患者数据留在本地；Commander 证明了这可以做到。',
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
