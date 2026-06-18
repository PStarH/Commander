/**
 * Commander CLI i18n — Lightweight internationalization.
 *
 * Supports en (English) and zh-CN (Simplified Chinese).
 * Detects locale from LANG, LC_ALL, or COMMANDER_LANG env vars.
 *
 * Usage:
 *   import { t } from './i18n';
 *   console.log(t('help.title'));  // "Commander" or "Commander — 多智能体编排系统"
 */

// ============================================================================
// Locale detection
// ============================================================================

type Locale = 'en' | 'zh-CN';

function detectLocale(): Locale {
  const lang = process.env.COMMANDER_LANG || process.env.LANG || process.env.LC_ALL || '';
  if (lang.startsWith('zh')) return 'zh-CN';
  return 'en';
}

// ============================================================================
// Translations
// ============================================================================

const translations: Record<Locale, Record<string, string>> = {
  en: {
    // General
    'app.title': 'Commander — multi-agent orchestration',
    'app.version': 'Version',

    // Help
    'help.title': 'QUICK START',
    'help.get.started': 'Set an API key and run:',
    'help.commands': 'COMMANDS',
    'help.options': 'OPTIONS',
    'help.run.help': 'Run {cmd} for command-specific help.',

    // Quickstart
    'quickstart.title': 'Commander Quickstart',
    'quickstart.subtitle': "Let's get you set up",
    'quickstart.prereqs': 'PREREQUISITES',
    'quickstart.all.passed': 'All checks passed!',
    'quickstart.ready': "You're ready to go.",
    'quickstart.try': 'Try:',

    // Doctor
    'doctor.title': 'DOCTOR',
    'doctor.env': 'ENVIRONMENT',
    'doctor.provider': 'PROVIDER',
    'doctor.workspace': 'WORKSPACE',
    'doctor.connectivity': 'CONNECTIVITY',
    'doctor.all.passed': 'All checks passed ✓',
    'doctor.needs.attention': 'Some checks need attention',

    // Status
    'status.title': 'SYSTEM STATUS',
    'status.provider': 'ACTIVE PROVIDER',
    'status.keys': 'API KEYS',
    'status.runtime': 'Runtime',

    // Config
    'config.title': 'CONFIGURATION',
    'config.set': 'Set:',
    'config.test': 'Test API connection',

    // Errors
    'error.no.apikey': 'No API key found.',
    'error.fix.apikey':
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    'error.fatal': 'ERROR',
    'error.run.doctor': 'Run commander doctor to diagnose issues.',
    'error.run.quickstart': 'Run commander quickstart for setup guidance.',

    // Mode
    'mode.title': 'APPROVAL MODE',
    'mode.set': 'Set:',
    'mode.plan': 'Analysis only, no modifications',
    'mode.readonly': 'No writes, no destructive ops',
    'mode.suggest': 'Prompts before risky operations',
    'mode.autoedit': 'Allows most operations, flags sandbox escapes',
    'mode.fullauto': 'No approval gates',

    // History
    'history.title': 'SESSION HISTORY',
    'history.none': 'No saved sessions found.',
    'history.run.first': 'Run a task first:',
    'history.view': 'View:',
    'history.prune': 'Prune:',
    'history.del': 'Del:',

    // Workflow
    'workflow.title': 'WORKFLOW COMMANDS',
    'workflow.list': 'List available and scheduled workflows',
    'workflow.run': 'Execute a workflow',
    'workflow.schedule': 'Schedule a workflow',
    'workflow.daemon': 'Start the scheduler daemon',

    // Skill
    'skill.title': 'SKILL COMMANDS',
    'skill.list': 'List all skills',
    'skill.view': 'View skill details',
    'skill.create': 'Create a new skill',
    'skill.curate': 'Run curator (archive+consolidate)',

    // Completion
    'completion.installed': 'AUTOCOMPLETION INSTALLED',
    'completion.shell': 'Shell',
    'completion.script': 'Script',
    'completion.add.to': 'Add this to your',

    // Onboarding
    'onboarding.welcome': 'Welcome to Commander',
    'onboarding.env.vars': 'To get started, set one of these environment variables:',
    'onboarding.example': 'Example:',
  },

  'zh-CN': {
    // General
    'app.title': 'Commander — 多智能体编排系统',
    'app.version': '版本',

    // Help
    'help.title': '快速开始',
    'help.get.started': '设置 API 密钥并运行：',
    'help.commands': '命令',
    'help.options': '选项',
    'help.run.help': '运行 {cmd} 查看命令帮助。',

    // Quickstart
    'quickstart.title': 'Commander 快速入门',
    'quickstart.subtitle': '让我们开始设置',
    'quickstart.prereqs': '前置检查',
    'quickstart.all.passed': '所有检查通过！',
    'quickstart.ready': '你已准备就绪。',
    'quickstart.try': '试试：',

    // Doctor
    'doctor.title': '诊断',
    'doctor.env': '环境',
    'doctor.provider': '提供者',
    'doctor.workspace': '工作区',
    'doctor.connectivity': '连接测试',
    'doctor.all.passed': '所有检查通过 ✓',
    'doctor.needs.attention': '部分检查需要关注',

    // Status
    'status.title': '系统状态',
    'status.provider': '当前提供者',
    'status.keys': 'API 密钥',
    'status.runtime': '运行时',

    // Config
    'config.title': '配置',
    'config.set': '设置：',
    'config.test': '测试 API 连接',

    // Errors
    'error.no.apikey': '未找到 API 密钥。',
    'error.fix.apikey':
      '请设置 OPENAI_API_KEY、ANTHROPIC_API_KEY 或其他提供者环境变量。运行：commander quickstart',
    'error.fatal': '错误',
    'error.run.doctor': '运行 commander doctor 诊断问题。',
    'error.run.quickstart': '运行 commander quickstart 查看设置指南。',

    // Mode
    'mode.title': '审批模式',
    'mode.set': '设置：',
    'mode.plan': '仅分析，不修改',
    'mode.readonly': '不写入，不执行破坏性操作',
    'mode.suggest': '风险操作前提示',
    'mode.autoedit': '允许大部分操作，标记沙箱逃逸',
    'mode.fullauto': '无审批门控',

    // History
    'history.title': '会话历史',
    'history.none': '未找到已保存的会话。',
    'history.run.first': '请先运行任务：',
    'history.view': '查看：',
    'history.prune': '清理：',
    'history.del': '删除：',

    // Workflow
    'workflow.title': '工作流命令',
    'workflow.list': '列出可用和已调度的工作流',
    'workflow.run': '执行工作流',
    'workflow.schedule': '调度工作流',
    'workflow.daemon': '启动调度守护进程',

    // Skill
    'skill.title': '技能命令',
    'skill.list': '列出所有技能',
    'skill.view': '查看技能详情',
    'skill.create': '创建新技能',
    'skill.curate': '运行策展器（归档+合并）',

    // Completion
    'completion.installed': '自动补全已安装',
    'completion.shell': 'Shell',
    'completion.script': '脚本',
    'completion.add.to': '添加到你的',

    // Onboarding
    'onboarding.welcome': '欢迎使用 Commander',
    'onboarding.env.vars': '要开始使用，请设置以下环境变量之一：',
    'onboarding.example': '示例：',
  },
};

// ============================================================================
// API
// ============================================================================

let currentLocale: Locale = detectLocale();

/**
 * Translate a key to the current locale.
 * Supports simple interpolation: t('key', { name: 'value' }) replaces {name} with 'value'.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = translations[currentLocale] || translations['en'];
  let text = dict[key] || translations['en'][key] || key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return text;
}

/** Set the current locale explicitly. */
export function setLocale(locale: string) {
  if (locale === 'zh-CN' || locale === 'zh' || locale === 'cn') {
    currentLocale = 'zh-CN';
  } else {
    currentLocale = 'en';
  }
}

/** Get the current locale. */
export function getLocale(): string {
  return currentLocale;
}

/** Check if current locale is Chinese. */
export function isChinese(): boolean {
  return currentLocale === 'zh-CN';
}
