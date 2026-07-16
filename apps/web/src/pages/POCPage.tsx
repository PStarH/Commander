import { useState } from 'react';
import {
  Building2,
  Landmark,
  Stethoscope,
  TrendingDown,
  ShieldCheck,
  Clock,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { t } from '../i18n';

interface POCStudy {
  id: string;
  industry: string;
  icon: React.ReactNode;
  customer: string;
  useCase: string;
  scope: string[];
  outcomes: { label: string; value: string; detail: string }[];
  status: 'live' | 'completed' | 'pilot';
  quote?: string;
}

const POC_STUDIES: POCStudy[] = [
  {
    id: 'poc-finops',
    industry: t('poc.industry.finance'),
    icon: <Landmark size={18} />,
    customer: t('poc.customer.finance'),
    useCase: t('poc.useCase.finance'),
    scope: [t('poc.scope.finance.1'), t('poc.scope.finance.2'), t('poc.scope.finance.3')],
    outcomes: [
      { label: t('poc.metric.compliance'), value: '99.97%', detail: t('poc.detail.compliance') },
      { label: t('poc.metric.review'), value: '-78%', detail: t('poc.detail.review') },
      { label: t('poc.metric.latency'), value: '<1.2s', detail: t('poc.detail.latency') },
    ],
    status: 'live',
    quote: t('poc.quote.finance'),
  },
  {
    id: 'poc-manufacturing',
    industry: t('poc.industry.manufacturing'),
    icon: <Building2 size={18} />,
    customer: t('poc.customer.manufacturing'),
    useCase: t('poc.useCase.manufacturing'),
    scope: [
      t('poc.scope.manufacturing.1'),
      t('poc.scope.manufacturing.2'),
      t('poc.scope.manufacturing.3'),
    ],
    outcomes: [
      { label: t('poc.metric.downtime'), value: '-34%', detail: t('poc.detail.downtime') },
      {
        label: t('poc.metric.falsePositive'),
        value: '-62%',
        detail: t('poc.detail.falsePositive'),
      },
      { label: t('poc.metric.rca'), value: '4.5x', detail: t('poc.detail.rca') },
    ],
    status: 'completed',
    quote: t('poc.quote.manufacturing'),
  },
  {
    id: 'poc-healthcare',
    industry: t('poc.industry.healthcare'),
    icon: <Stethoscope size={18} />,
    customer: t('poc.customer.healthcare'),
    useCase: t('poc.useCase.healthcare'),
    scope: [t('poc.scope.healthcare.1'), t('poc.scope.healthcare.2'), t('poc.scope.healthcare.3')],
    outcomes: [
      { label: t('poc.metric.pii'), value: '0', detail: t('poc.detail.pii') },
      { label: t('poc.metric.document'), value: '+3x', detail: t('poc.detail.document') },
      { label: t('poc.metric.audit'), value: '100%', detail: t('poc.detail.audit') },
    ],
    status: 'pilot',
    quote: t('poc.quote.healthcare'),
  },
];

const STATUS_META: Record<POCStudy['status'], { label: string; className: string }> = {
  live: { label: t('poc.status.live'), className: 'status-live' },
  completed: { label: t('poc.status.completed'), className: 'status-completed' },
  pilot: { label: t('poc.status.pilot'), className: 'status-pilot' },
};

export function POCPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const completedCount = POC_STUDIES.filter(
    (s) => s.status === 'completed' || s.status === 'live',
  ).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="section-label">{t('poc.sectionLabel')}</div>
          <h1>{t('poc.title')}</h1>
        </div>
        <p className="page-desc">{t('poc.desc')}</p>
      </div>

      <div
        className="card poc-disclaimer"
        role="note"
        aria-label="Illustrative scenarios disclaimer"
      >
        <ShieldCheck size={14} style={{ color: 'var(--accent-amber)', flexShrink: 0 }} />
        <span>
          {t('poc.disclaimer')}
        </span>
      </div>

      <div className="metric-row">
        <div className="card metric" style={{ borderLeft: '2px solid var(--accent-green)' }}>
          <div className="metric-head">
            <span className="metric-icon" style={{ color: 'var(--accent-green)' }}>
              <CheckCircle2 size={14} />
            </span>
            <span className="metric-label">{t('poc.metric.completed')}</span>
          </div>
          <span className="metric-value">
            {completedCount}/{POC_STUDIES.length}
          </span>
        </div>
        <div className="card metric" style={{ borderLeft: '2px solid var(--accent-blue)' }}>
          <div className="metric-head">
            <span className="metric-icon" style={{ color: 'var(--accent-blue)' }}>
              <ShieldCheck size={14} />
            </span>
            <span className="metric-label">{t('poc.metric.industries')}</span>
          </div>
          <span className="metric-value">3</span>
        </div>
        <div className="card metric" style={{ borderLeft: '2px solid var(--accent-amber)' }}>
          <div className="metric-head">
            <span className="metric-icon" style={{ color: 'var(--accent-amber)' }}>
              <Clock size={14} />
            </span>
            <span className="metric-label">{t('poc.metric.avgDuration')}</span>
          </div>
          <span className="metric-value">6 {t('poc.weeks')}</span>
        </div>
      </div>

      <div className="poc-grid">
        {POC_STUDIES.map((study) => {
          const expanded = expandedId === study.id;
          const status = STATUS_META[study.status];
          return (
            <div key={study.id} className="card poc-card">
              <div className="poc-header">
                <div className="poc-industry">
                  <span className="poc-icon">{study.icon}</span>
                  <span>{study.industry}</span>
                </div>
                <span className={`poc-status ${status.className}`}>{status.label}</span>
              </div>

              <div className="poc-customer">{study.customer}</div>
              <div className="poc-usecase">{study.useCase}</div>

              <div className="poc-outcomes">
                {study.outcomes.map((outcome) => (
                  <div key={outcome.label} className="poc-outcome">
                    <div className="poc-outcome-value">{outcome.value}</div>
                    <div className="poc-outcome-label">{outcome.label}</div>
                    <div className="poc-outcome-detail">{outcome.detail}</div>
                  </div>
                ))}
              </div>

              {expanded && (
                <div className="poc-details">
                  <div className="poc-scope-title">{t('poc.scopeTitle')}</div>
                  <ul className="poc-scope-list">
                    {study.scope.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                  {study.quote && <blockquote className="poc-quote">“{study.quote}”</blockquote>}
                </div>
              )}

              <button
                type="button"
                className="btn btn-ghost btn-sm poc-toggle"
                onClick={() => setExpandedId(expanded ? null : study.id)}
              >
                {expanded ? t('poc.collapse') : t('poc.expand')}
                <ArrowRight
                  size={12}
                  style={{
                    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform var(--transition)',
                  }}
                />
              </button>
            </div>
          );
        })}
      </div>

      <div className="card poc-footnote">
        <TrendingDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span>{t('poc.footnote')}</span>
      </div>

      <style>{`
        .poc-disclaimer {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          margin-top: 16px;
          padding: 10px 14px;
          font-size: 0.78rem;
          line-height: 1.45;
          color: var(--text-secondary);
          border-left: 2px solid var(--accent-amber);
        }
        .poc-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 16px;
          margin-top: 20px;
        }
        .poc-card {
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 18px;
        }
        .poc-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .poc-industry {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .poc-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
        }
        .poc-status {
          font-size: 0.65rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          padding: 3px 8px;
          border: 1px solid var(--border-default);
          font-family: var(--font-mono);
        }
        .status-live {
          color: var(--accent-green);
          border-color: var(--accent-green);
          background: color-mix(in srgb, var(--accent-green) 8%, var(--bg-card));
        }
        .status-completed {
          color: var(--accent-blue);
          border-color: var(--accent-blue);
          background: color-mix(in srgb, var(--accent-blue) 8%, var(--bg-card));
        }
        .status-pilot {
          color: var(--accent-amber);
          border-color: var(--accent-amber);
          background: color-mix(in srgb, var(--accent-amber) 8%, var(--bg-card));
        }
        .poc-customer {
          font-size: 1.05rem;
          font-weight: 600;
          color: var(--text-primary);
        }
        .poc-usecase {
          font-size: 0.82rem;
          color: var(--text-secondary);
          line-height: 1.45;
        }
        .poc-outcomes {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
          padding: 12px 0;
          border-top: 1px solid var(--border-subtle);
          border-bottom: 1px solid var(--border-subtle);
        }
        .poc-outcome {
          text-align: center;
        }
        .poc-outcome-value {
          font-size: 1.15rem;
          font-weight: 700;
          color: var(--text-primary);
          font-family: var(--font-mono);
        }
        .poc-outcome-label {
          font-size: 0.65rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .poc-outcome-detail {
          font-size: 0.7rem;
          color: var(--text-secondary);
          margin-top: 4px;
          line-height: 1.3;
        }
        .poc-details {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .poc-scope-title {
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .poc-scope-list {
          margin: 0;
          padding-left: 18px;
          font-size: 0.8rem;
          color: var(--text-secondary);
          line-height: 1.6;
        }
        .poc-quote {
          margin: 4px 0 0;
          padding: 10px 12px;
          border-left: 2px solid var(--accent-amber);
          background: var(--bg-deep);
          font-size: 0.8rem;
          color: var(--text-secondary);
          font-style: italic;
        }
        .poc-toggle {
          align-self: flex-start;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-top: 2px;
        }
        .poc-footnote {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 20px;
          padding: 12px 14px;
          font-size: 0.78rem;
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}
