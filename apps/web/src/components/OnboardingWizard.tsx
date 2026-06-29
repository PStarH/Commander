/**
 * OnboardingWizard — Web 端上手引导向导核心组件。
 *
 * 设计目标（来自 POC→生产鸿沟调研）：
 *   - 为新用户提供首次登录后的多步骤引导（provider 配置 → 首个任务 → 完成）
 *   - 支持 "跳过引导" 链接，不强制阻断主流程
 *   - 复用 useOnboarding hook 管理状态，与 Dashboard 顶部提示条共享数据源
 *   - 使用项目已有的 CSS 变量与组件风格（参考 LoginPage / ChatPage）
 *
 * 组件契约：
 *   - onComplete(): 用户完成全部步骤后调用（由父组件负责导航）
 *   - onSkip(): 用户点击 "跳过引导" 时调用（由父组件负责导航）
 *
 * 纯展示 + 交互逻辑，不包含路由导航——路由由父组件 OnboardingPage 负责。
 */
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  CheckCircle,
  Shield,
  Activity,
  Layers,
  Zap,
  Users,
  ChevronRight,
  ChevronLeft,
  Loader,
  Play,
  BookOpen,
  MessageSquare,
  DollarSign,
  AlertTriangle,
  AlertCircle,
  Settings,
  Lightbulb,
  Rocket,
  KeyRound,
  Cpu,
  SkipForward,
} from 'lucide-react';
import { useOnboarding } from '../hooks/useOnboarding';
import {
  testProvider,
  saveOnboardingConfig,
  runFirstTask,
  completeOnboarding,
  fetchSampleTasks,
  type OnboardingProvider,
  type OnboardingProviderTestResult,
  type OnboardingSampleTask,
} from '../api';

// ── 常量 ───────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

const STEP_LABELS = ['欢迎', 'Provider', '首个任务', '完成'];

const PROVIDER_OPTIONS: {
  id: OnboardingProvider;
  label: string;
  defaultModel: string;
  hint: string;
}[] = [
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o', hint: 'OPENAI_API_KEY' },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-3-5-sonnet-20241022',
    hint: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    hint: 'GOOGLE_API_KEY',
  },
  { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat', hint: 'DEEPSEEK_API_KEY' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4o-mini',
    hint: 'OPENROUTER_API_KEY',
  },
  { id: 'ollama', label: 'Ollama (Local)', defaultModel: 'llama3.2', hint: '无需 API Key（本地）' },
];

/** 当 sample-tasks API 不可用时的 fallback 任务列表。 */
const FALLBACK_TASKS: OnboardingSampleTask[] = [
  {
    id: 'explain-orchestration',
    title: '解释多 Agent 编排',
    description: '让 Agent 用一句话解释什么是多 Agent 编排',
    prompt: '用一句话解释什么是多 Agent 编排',
  },
  {
    id: 'summarize-security',
    title: '总结安全能力',
    description: '总结 Commander 框架的核心安全治理能力',
    prompt: '总结 Commander 框架的核心安全治理能力',
  },
  {
    id: 'generate-tests',
    title: '生成测试用例',
    description: '为登录接口生成 3 条测试用例',
    prompt: '为登录接口生成 3 条测试用例',
  },
];

// ── Props ─────────────────────────────────────────────────────────────────

export interface OnboardingWizardProps {
  /** 用户完成全部步骤后调用。 */
  onComplete?: () => void;
  /** 用户点击 "跳过引导" 时调用。 */
  onSkip?: () => void;
}

// ── 主组件 ─────────────────────────────────────────────────────────────────

export function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const { onboardingStatus, isLoading, checkStatus } = useOnboarding();
  const [step, setStep] = useState(1);

  // 若服务端检测到 onboarding 已完成，直接跳到完成页
  useEffect(() => {
    if (onboardingStatus?.isComplete) {
      setStep(4);
    }
  }, [onboardingStatus?.isComplete]);

  const goNext = useCallback(() => {
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }, []);
  const goPrev = useCallback(() => {
    setStep((s) => Math.max(s - 1, 1));
  }, []);

  // 跳过引导：标记完成后回调
  const handleSkip = useCallback(async () => {
    try {
      await completeOnboarding(['skipped']);
    } catch {
      // 即使标记失败也允许跳过
    } finally {
      onSkip?.();
    }
  }, [onSkip]);

  // 完成并回调
  const handleFinish = useCallback(async () => {
    try {
      await completeOnboarding(['welcome', 'provider', 'first-task', 'complete']);
    } catch {
      // 即使标记失败也允许进入控制台
    } finally {
      onComplete?.();
    }
  }, [onComplete]);

  return (
    <div className="page" style={{ maxWidth: '760px', margin: '0 auto' }}>
      <div className="page-head">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="section-label">Onboarding</div>
            <h1>上手引导向导</h1>
            <p className="page-desc">
              几分钟内完成首次配置：连接 LLM provider、运行首个任务、探索 Commander 的多 Agent
              编排与安全治理能力。
            </p>
          </div>
          {/* 跳过引导链接 */}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleSkip}
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <SkipForward size={12} />
            跳过引导
          </button>
        </div>
      </div>

      {/* 步骤进度条 */}
      <Stepper current={step} total={TOTAL_STEPS} />

      <div className="card" style={{ padding: '24px 22px', marginTop: '16px' }}>
        {isLoading && !onboardingStatus ? (
          <div className="loading-screen" style={{ minHeight: '40vh' }}>
            <div className="loader" />
            <p>正在检测当前配置…</p>
          </div>
        ) : (
          <>
            {step === 1 && <WelcomeStep />}
            {step === 2 && <ProviderStep status={onboardingStatus} onSaved={checkStatus} />}
            {step === 3 && <FirstTaskStep status={onboardingStatus} onRan={checkStatus} />}
            {step === 4 && <CompleteStep />}

            {/* 步骤导航按钮 */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '12px',
                marginTop: '24px',
                paddingTop: '18px',
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <button
                type="button"
                className="btn btn-ghost btn-md"
                onClick={goPrev}
                disabled={step === 1}
                style={{ visibility: step === 1 ? 'hidden' : 'visible' }}
              >
                <ChevronLeft size={14} />
                上一步
              </button>

              <span
                style={{ fontSize: '0.72rem', color: 'var(--text-muted)', alignSelf: 'center' }}
              >
                {step} / {TOTAL_STEPS}
              </span>

              {step < TOTAL_STEPS ? (
                <button type="button" className="btn btn-primary btn-md" onClick={goNext}>
                  下一步
                  <ChevronRight size={14} />
                </button>
              ) : (
                <button type="button" className="btn btn-primary btn-md" onClick={handleFinish}>
                  <Rocket size={14} />
                  进入控制台
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 步骤进度条 ─────────────────────────────────────────────────────────────

function Stepper({ current, total }: { current: number; total: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      {Array.from({ length: total }, (_, i) => {
        const idx = i + 1;
        const done = idx < current;
        const active = idx === current;
        return (
          <div
            key={idx}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div
              style={{
                height: '4px',
                borderRadius: '2px',
                background: done
                  ? 'var(--accent-green)'
                  : active
                    ? 'var(--accent-green-bg)'
                    : 'var(--border-default)',
                border: active ? `1px solid var(--accent-green-border)` : 'none',
                transition: 'all 180ms ease',
              }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '0.7rem',
                color: active
                  ? 'var(--accent-green)'
                  : done
                    ? 'var(--text-secondary)'
                    : 'var(--text-muted)',
              }}
            >
              <span
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.62rem',
                  fontWeight: 700,
                  border: `1px solid ${
                    active
                      ? 'var(--accent-green-border)'
                      : done
                        ? 'var(--accent-green)'
                        : 'var(--border-hover)'
                  }`,
                  background: done
                    ? 'var(--accent-green-bg)'
                    : active
                      ? 'var(--accent-green-bg)'
                      : 'transparent',
                  color: active || done ? 'var(--accent-green)' : 'var(--text-muted)',
                }}
              >
                {done ? <CheckCircle size={10} /> : idx}
              </span>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {STEP_LABELS[i]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: 欢迎 ───────────────────────────────────────────────────────────

function WelcomeStep() {
  const capabilities: { icon: ReactNode; title: string; desc: string }[] = [
    {
      icon: <Layers size={16} />,
      title: '多 Agent 编排',
      desc: '顺序 / 并行 / Saga 补偿编排，内置 A2A 协议与子 Agent 调度。',
    },
    {
      icon: <Shield size={16} />,
      title: '安全治理',
      desc: '审批沙箱、工具策略、治理检查点与质量门禁，fail-closed 默认。',
    },
    {
      icon: <Activity size={16} />,
      title: '可观测性',
      desc: '端到端 trace、置信度评估、幻觉检测与成本仪表盘。',
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--accent-green-bg)',
            border: '1px solid var(--accent-green-border)',
            color: 'var(--accent-green)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Rocket size={22} />
        </div>
        <div>
          <h2 style={{ fontSize: '1.2rem' }}>欢迎使用 Commander</h2>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
            生产级多 Agent 编排框架 — 从 POC 到生产的可靠路径
          </p>
        </div>
      </div>

      <p
        style={{
          fontSize: '0.88rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
          marginBottom: '18px',
        }}
      >
        调研显示 93% 的企业 Agent 项目卡在 POC→生产阶段，上手体验是关键。本向导将带你完成 LLM
        provider 连接、首个任务运行，并熟悉核心能力。
      </p>

      <div style={{ display: 'grid', gap: '10px' }}>
        {capabilities.map((c) => (
          <div
            key={c.title}
            style={{
              display: 'flex',
              gap: '12px',
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
            }}
          >
            <div style={{ color: 'var(--accent-green)', flexShrink: 0 }}>{c.icon}</div>
            <div>
              <div style={{ fontSize: '0.86rem', fontWeight: 600, marginBottom: '2px' }}>
                {c.title}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {c.desc}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div
        className="narrative"
        style={{ marginTop: '18px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}
      >
        <Lightbulb size={14} style={{ flexShrink: 0, marginTop: '2px' }} />
        <span style={{ fontSize: '0.8rem' }}>
          提示：你也可以在 CLI 端运行 <code>commander quickstart</code> 获得同样的检查与引导。
        </span>
      </div>
    </div>
  );
}

// ── Step 2: Provider 配置 ──────────────────────────────────────────────────

function ProviderStep({
  status,
  onSaved,
}: {
  status: import('../api').OnboardingStatus | null;
  onSaved: () => Promise<unknown>;
}) {
  // 初始 provider：优先用检测到的，否则默认 openai
  const detectedProvider = status?.provider as OnboardingProvider | undefined;
  const [provider, setProvider] = useState<OnboardingProvider>(detectedProvider ?? 'openai');
  const [model, setModel] = useState<string>(status?.model ?? 'gpt-4o');
  const [apiKey, setApiKey] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<OnboardingProviderTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 切换 provider 时同步默认 model（若用户未自定义）
  useEffect(() => {
    const opt = PROVIDER_OPTIONS.find((o) => o.id === provider);
    if (opt) {
      setModel(opt.defaultModel);
    }
  }, [provider]);

  // 当 status 到达后，回填检测到的值
  useEffect(() => {
    if (detectedProvider && !apiKey) {
      setProvider(detectedProvider);
    }
    if (status?.model && !model) {
      setModel(status.model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await testProvider(provider, model, apiKey || undefined);
      setTestResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '测试失败');
    } finally {
      setTesting(false);
    }
  }, [provider, model, apiKey]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      await saveOnboardingConfig({
        provider,
        model,
        apiKey: apiKey || undefined,
      });
      setSavedMsg('配置已保存到 .commander.json');
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [provider, model, apiKey, onSaved]);

  const opt = PROVIDER_OPTIONS.find((o) => o.id === provider);

  return (
    <div>
      <h2 style={{ fontSize: '1.1rem', marginBottom: '6px' }}>配置 LLM Provider</h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)', marginBottom: '16px' }}>
        选择一个 provider 并测试连通性。API Key 仅保存到本地 <code>.commander.json</code>
        ，不会写入环境变量。
      </p>

      {/* 检测到的状态 */}
      {status && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: '16px',
          }}
        >
          <StatusPill
            ok={status.hasProvider}
            label={
              status.hasProvider
                ? `已检测到 ${status.providerLabel ?? status.provider}`
                : '未检测到 Provider'
            }
          />
          <StatusPill
            ok={status.hasApiKey}
            label={status.hasApiKey ? '已具备 API Key' : '缺少 API Key'}
          />
        </div>
      )}

      {/* Provider 选择 */}
      <Field label="Provider">
        <select
          className="sel"
          value={provider}
          onChange={(e) => setProvider(e.target.value as OnboardingProvider)}
          style={{ width: '100%' }}
        >
          {PROVIDER_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Model" hint={opt?.hint}>
        <input
          className="inp"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={opt?.defaultModel}
          style={{ width: '100%' }}
        />
      </Field>

      <Field label="API Key">
        <input
          className="inp"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider === 'ollama' ? '本地 provider 无需 API Key' : 'sk-...'}
          autoComplete="off"
          style={{ width: '100%' }}
        />
      </Field>

      {/* 错误 / 成功提示 */}
      {error && (
        <div className="banner error" style={{ marginBottom: '12px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertCircle size={14} /> {error}
          </span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {savedMsg && (
        <div className="banner" style={{ marginBottom: '12px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <CheckCircle size={14} /> {savedMsg}
          </span>
          <button type="button" className="banner-close" onClick={() => setSavedMsg(null)}>
            ×
          </button>
        </div>
      )}

      {/* 测试结果 */}
      {testResult && (
        <div
          style={{
            marginBottom: '14px',
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            border: `1px solid ${
              testResult.success ? 'var(--accent-green-border)' : 'var(--accent-red-border)'
            }`,
            background: testResult.success ? 'var(--accent-green-bg)' : 'var(--accent-red-bg)',
            fontSize: '0.8rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
            {testResult.success ? (
              <CheckCircle size={14} style={{ color: 'var(--accent-green)' }} />
            ) : (
              <AlertTriangle size={14} style={{ color: 'var(--accent-red)' }} />
            )}
            <span
              style={{ color: testResult.success ? 'var(--accent-green)' : 'var(--accent-red)' }}
            >
              {testResult.success ? '连接成功' : '连接失败'}
            </span>
            {testResult.success && (
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
                延时 {testResult.latency}ms · {testResult.provider} / {testResult.model}
              </span>
            )}
          </div>
          {!testResult.success && testResult.error && (
            <div
              style={{
                marginTop: '6px',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.74rem',
                wordBreak: 'break-word',
              }}
            >
              {testResult.error}
            </div>
          )}
        </div>
      )}

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-secondary btn-md"
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? <Loader size={14} className="spin" /> : <Zap size={14} />}
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-md"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? <Loader size={14} className="spin" /> : <Settings size={14} />}
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>
    </div>
  );
}

// ── Step 3: 首个任务 ───────────────────────────────────────────────────────

function FirstTaskStep({
  status,
  onRan,
}: {
  status: import('../api').OnboardingStatus | null;
  onRan: () => Promise<unknown>;
}) {
  // 从 sample-tasks API 加载示例任务，失败时使用 fallback
  const [sampleTasks, setSampleTasks] = useState<OnboardingSampleTask[]>(FALLBACK_TASKS);
  const [task, setTask] = useState<string>(FALLBACK_TASKS[0].prompt);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultSuccess, setResultSuccess] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 加载示例任务
  useEffect(() => {
    let cancelled = false;
    fetchSampleTasks()
      .then((tasks) => {
        if (!cancelled && tasks.length > 0) {
          setSampleTasks(tasks);
          setTask(tasks[0].prompt);
        }
      })
      .catch(() => {
        // 使用 fallback 任务，不阻塞流程
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRun = useCallback(async () => {
    if (!task.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setResultSuccess(null);
    try {
      const res = await runFirstTask(task.trim());
      setResult(res.result ?? '');
      setResultSuccess(res.success);
      await onRan();
    } catch (err) {
      setError(err instanceof Error ? err.message : '运行失败');
    } finally {
      setRunning(false);
    }
  }, [task, onRan]);

  return (
    <div>
      <h2 style={{ fontSize: '1.1rem', marginBottom: '6px' }}>运行首个任务</h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)', marginBottom: '14px' }}>
        选择一个示例任务或输入自定义任务，验证 provider 配置可用。 Commander 会将任务路由到 LLM
        并返回结果。
      </p>

      {status && !status.hasProvider && (
        <div
          className="banner"
          style={{
            marginBottom: '14px',
            background: 'var(--accent-amber-bg)',
            borderColor: 'var(--accent-amber-border)',
            color: 'var(--accent-amber)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={14} /> 未检测到
            provider，将返回示例结果。请先在「Provider」步骤配置。
          </span>
        </div>
      )}

      {/* 示例任务卡片 */}
      <div style={{ display: 'grid', gap: '8px', marginBottom: '12px' }}>
        {sampleTasks.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTask(t.prompt)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${
                task === t.prompt ? 'var(--accent-green-border)' : 'var(--border-default)'
              }`,
              background: task === t.prompt ? 'var(--accent-green-bg)' : 'var(--bg-elevated)',
              textAlign: 'left',
              cursor: 'pointer',
              transition: 'all 150ms ease',
            }}
          >
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              {t.title}
            </span>
            <span style={{ fontSize: '0.74rem', color: 'var(--text-tertiary)' }}>
              {t.description}
            </span>
          </button>
        ))}
      </div>

      <Field label="任务描述">
        <textarea
          className="inp"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          placeholder="输入要让 Agent 执行的任务…"
          style={{
            width: '100%',
            resize: 'vertical',
            padding: '8px 10px',
            fontFamily: 'var(--font-mono)',
          }}
        />
      </Field>

      {error && (
        <div className="banner error" style={{ marginBottom: '12px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertCircle size={14} /> {error}
          </span>
          <button type="button" className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* 运行结果 */}
      {result !== null && (
        <div
          style={{
            marginBottom: '14px',
            padding: '12px 14px',
            borderRadius: 'var(--radius-md)',
            border: `1px solid ${
              resultSuccess ? 'var(--accent-green-border)' : 'var(--accent-amber-border)'
            }`,
            background: resultSuccess ? 'var(--accent-green-bg)' : 'var(--accent-amber-bg)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '0.78rem',
              fontWeight: 600,
              marginBottom: '8px',
              color: resultSuccess ? 'var(--accent-green)' : 'var(--accent-amber)',
            }}
          >
            {resultSuccess ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
            {resultSuccess ? '执行成功' : '已返回示例结果'}
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.76rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.55,
            }}
          >
            {result}
          </pre>
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-md"
        onClick={handleRun}
        disabled={running || !task.trim()}
      >
        {running ? <Loader size={14} className="spin" /> : <Play size={14} />}
        {running ? '运行中…' : '运行任务'}
      </button>
    </div>
  );
}

// ── Step 4: 完成 ───────────────────────────────────────────────────────────

function CompleteStep() {
  const features: { icon: ReactNode; title: string; desc: string; to: string }[] = [
    {
      icon: <BookOpen size={16} />,
      title: '知识库 / RAG',
      desc: '上传企业文档，语义检索后注入 LLM 上下文。',
      to: '/memory',
    },
    {
      icon: <MessageSquare size={16} />,
      title: '对话',
      desc: '与 Agent 流式对话，实时查看思考与工具调用。',
      to: '/chat',
    },
    {
      icon: <DollarSign size={16} />,
      title: '成本仪表盘',
      desc: '按模型 / 工具 / 用户聚合 LLM 成本与趋势。',
      to: '/cost',
    },
    {
      icon: <Shield size={16} />,
      title: '治理与安全',
      desc: '审批沙箱、工具策略、安全态势监控。',
      to: '/security',
    },
    {
      icon: <Cpu size={16} />,
      title: '执行与回放',
      desc: '暂停 / 恢复运行，逐步回放 trace。',
      to: '/execution',
    },
    {
      icon: <Users size={16} />,
      title: 'Agent 与任务',
      desc: '查看 Agent 花名册，创建并跟踪 Mission。',
      to: '/agents',
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: 'var(--accent-green-bg)',
            border: '1px solid var(--accent-green-border)',
            color: 'var(--accent-green)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CheckCircle size={22} />
        </div>
        <div>
          <h2 style={{ fontSize: '1.2rem' }}>配置完成</h2>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)' }}>
            你已具备运行生产级多 Agent 任务的基础配置
          </p>
        </div>
      </div>

      <p
        style={{
          fontSize: '0.86rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
          marginBottom: '18px',
        }}
      >
        Commander 远不止于此。以下是你接下来可以探索的核心功能：
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: '10px',
        }}
      >
        {features.map((f) => (
          <div
            key={f.title}
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ color: 'var(--accent-green)' }}>{f.icon}</span>
              <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>{f.title}</span>
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {f.desc}
            </div>
          </div>
        ))}
      </div>

      <div className="narrative" style={{ marginTop: '18px' }}>
        <span style={{ fontSize: '0.8rem' }}>
          点击下方「进入控制台」开始使用。你随时可以在侧边栏点击「上手引导」重新打开本向导。
        </span>
      </div>
    </div>
  );
}

// ── 通用子组件 ─────────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span
          style={{
            fontSize: '0.7rem',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-tertiary)',
          }}
        >
          {label}
        </span>
        {hint && (
          <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
            <KeyRound size={10} style={{ verticalAlign: 'middle', marginRight: '3px' }} />
            {hint}
          </span>
        )}
      </div>
      {children}
    </label>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`bdg ${ok ? 'bdg-success' : 'bdg-warning'}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
    >
      {ok ? <CheckCircle size={11} /> : <AlertTriangle size={11} />}
      {label}
    </span>
  );
}
