import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import {
  DollarSign, Cpu, Hash, AlertTriangle, TrendingUp,
} from 'lucide-react';
import { MetricCard } from './ui';
import { fetchCostSummary, fetchCostRecords, fetchBudgetStatus } from '../api';
import { formatTimestamp } from '../types';
import type { CostSummary, CostRecord, BudgetStatus } from '../types';

const COLORS = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
  blue: '#4d9eff',
  purple: '#a78bfa',
  cyan: '#22d3ee',
  surface: '#050913',
  border: '#151c23',
  text: '#7f8c86',
  textPrimary: '#e5f0da',
};

const MODEL_COLORS = [COLORS.green, COLORS.blue, COLORS.purple, COLORS.amber, COLORS.cyan, COLORS.red];

export function CostPanel() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [records, setRecords] = useState<CostRecord[]>([]);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [summaryData, recordsData, budgetData] = await Promise.allSettled([
          fetchCostSummary(),
          fetchCostRecords(20),
          fetchBudgetStatus(),
        ]);
        if (cancelled) return;
        if (summaryData.status === 'fulfilled') setSummary(summaryData.value);
        if (recordsData.status === 'fulfilled') setRecords(recordsData.value.records);
        if (budgetData.status === 'fulfilled') setBudget(budgetData.value);
      } catch {
        // ignore
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="cost-panel">
        <div className="section-head">
          <div>
            <div className="section-label">Cost Transparency</div>
            <h2>Loading cost data...</h2>
          </div>
        </div>
      </div>
    );
  }

  if (!summary || summary.totalCalls === 0) {
    return (
      <div className="cost-panel">
        <div className="section-head">
          <div>
            <div className="section-label">Cost Transparency</div>
            <h2>No cost data yet</h2>
          </div>
          <span className="section-tag">Run a task to see costs</span>
        </div>
        <div className="narrative narrative-green">
          Cost tracking activates automatically when agents make LLM calls.
          Each call's token usage and cost is recorded per-model and per-agent.
        </div>
      </div>
    );
  }

  // Prepare chart data
  const modelData = Object.entries(summary.perModel)
    .map(([name, data]) => ({ name: name.split('/').pop() || name, cost: data.costUsd, tokens: data.tokens, calls: data.calls }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);

  const agentData = Object.entries(summary.perAgent)
    .map(([name, data]) => ({ name, cost: data.costUsd }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);

  const budgetPercent = budget?.usagePercent ?? 0;
  const budgetColor = budgetPercent >= 90 ? COLORS.red : budgetPercent >= 70 ? COLORS.amber : COLORS.green;

  return (
    <div className="cost-panel">
      <div className="section-head">
        <div>
          <div className="section-label">Cost Transparency</div>
          <h2>Token & budget overview</h2>
        </div>
        <span className="section-tag">
          {summary.totalCalls} LLM calls tracked
        </span>
      </div>

      {/* Metric Cards */}
      <div className="metric-row">
        <MetricCard
          label="Total cost"
          value={`$${summary.totalCostUsd.toFixed(2)}`}
          icon={<DollarSign size={14} />}
        />
        <MetricCard
          label="Total tokens"
          value={summary.totalTokens >= 1000000
            ? `${(summary.totalTokens / 1000000).toFixed(1)}M`
            : summary.totalTokens >= 1000
              ? `${(summary.totalTokens / 1000).toFixed(0)}K`
              : String(summary.totalTokens)}
          icon={<Cpu size={14} />}
        />
        <MetricCard
          label="LLM calls"
          value={String(summary.totalCalls)}
          icon={<Hash size={14} />}
        />
        <MetricCard
          label="Budget used"
          value={`${budgetPercent}%`}
          icon={budgetPercent >= 70 ? <AlertTriangle size={14} /> : <TrendingUp size={14} />}
          trend={budget
            ? { value: `$${budget.monthlyUsed.toFixed(2)}/$${budget.monthlyLimit.toFixed(2)}`, positive: budgetPercent < 70 }
            : undefined}
        />
      </div>

      {/* Budget Bar */}
      {budget && budget.monthlyLimit > 0 && (
        <div className="budget-bar-container">
          <div className="budget-bar-label">
            <span>Monthly Budget</span>
            <span style={{ color: budgetColor }}>${budget.monthlyUsed.toFixed(2)} / ${budget.monthlyLimit.toFixed(2)}</span>
          </div>
          <div className="budget-bar-track">
            <div
              className="budget-bar-fill"
              style={{
                width: `${Math.min(budgetPercent, 100)}%`,
                background: budgetColor,
              }}
            />
          </div>
        </div>
      )}

      {/* Charts */}
      <div className="chart-row">
        <div className="chart-card">
          <div className="chart-title">Cost by Model</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={modelData} margin={{ left: 0, right: 10 }}>
              <XAxis
                type="category"
                dataKey="name"
                tick={{ fill: COLORS.text, fontSize: 10 }}
                interval={0}
                angle={-20}
                textAnchor="end"
                height={50}
              />
              <YAxis type="number" tick={{ fill: COLORS.text, fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                contentStyle={{
                  background: COLORS.surface,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                itemStyle={{ color: COLORS.textPrimary }}
                formatter={(value) => [`$${Number(value).toFixed(4)}`, 'Cost']}
              />
              <Bar dataKey="cost" radius={[3, 3, 0, 0]}>
                {modelData.map((_, i) => (
                  <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <div className="chart-title">Cost by Agent</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={agentData}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={65}
                paddingAngle={3}
                dataKey="cost"
                nameKey="name"
              >
                {agentData.map((_, i) => (
                  <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} stroke="none" />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: COLORS.surface,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                itemStyle={{ color: COLORS.textPrimary }}
                formatter={(value) => [`$${Number(value).toFixed(4)}`, 'Cost']}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="chart-legend">
            {agentData.map((item, i) => (
              <span key={item.name} className="legend-item">
                <span className="legend-dot" style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                {item.name}: ${item.cost.toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Budget Alerts */}
      {budget && budget.alerts.length > 0 && (
        <div className="budget-alerts">
          <div className="chart-title">Budget Alerts</div>
          <div className="alerts-list">
            {budget.alerts.slice(0, 5).map((alert, i) => (
              <div key={i} className={`alert-item alert-${alert.type.includes('exhausted') || alert.type.includes('cap_reached') ? 'error' : 'warning'}`}>
                <AlertTriangle size={14} />
                <span>{alert.message}</span>
                <span className="alert-time">{formatTimestamp(alert.runId)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Records */}
      {records.length > 0 && (
        <div className="cost-records">
          <div className="chart-title">Recent LLM Calls</div>
          <div className="records-table">
            <div className="records-header">
              <span>Model</span>
              <span>Tokens</span>
              <span>Cost</span>
              <span>Time</span>
            </div>
            {records.slice(0, 10).map((record, i) => (
              <div key={i} className="records-row">
                <span className="record-model">{record.modelId.split('/').pop()}</span>
                <span className="record-tokens">
                  {record.totalTokens >= 1000
                    ? `${(record.totalTokens / 1000).toFixed(1)}K`
                    : record.totalTokens}
                </span>
                <span className="record-cost">${record.costUsd.toFixed(4)}</span>
                <span className="record-time">{formatTimestamp(record.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
