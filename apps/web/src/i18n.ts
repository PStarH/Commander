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
    'nav.onboarding': 'Onboarding',
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
    'nav.onboarding': '上手引导',
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
