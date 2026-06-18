import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from 'recharts';
import { Activity, CheckCircle, AlertTriangle, Shield, Zap, Users } from 'lucide-react';
import { MetricCard } from './ui';
import type { BattleReport as BattleReportType } from '../types';
import { formatTimestamp } from '../types';

const COLORS = {
  green: '#4de98c',
  amber: '#ffcc66',
  red: '#ff8b9d',
  blue: '#4d9eff',
  purple: '#a78bfa',
  surface: '#050913',
  border: '#151c23',
  text: '#7f8c86',
};

interface BattleReportProps {
  report: BattleReportType;
}

export function BattleReport({ report }: BattleReportProps) {
  const missionData = [
    { name: 'Completed', value: report.completedMissionCount, color: COLORS.green },
    { name: 'Running', value: report.runningMissionCount, color: COLORS.blue },
    { name: 'Blocked', value: report.blockedMissionCount, color: COLORS.amber },
  ];

  const remaining =
    report.totalMissions -
    report.completedMissionCount -
    report.runningMissionCount -
    report.blockedMissionCount;
  if (remaining > 0) {
    missionData.push({ name: 'Planned', value: remaining, color: COLORS.text });
  }

  const completionTrend = [{ name: 'Completion', rate: report.completionRate }];
  const healthColor =
    report.health === 'GREEN'
      ? COLORS.green
      : report.health === 'AMBER'
        ? COLORS.amber
        : COLORS.red;

  const topAgentData = report.topAgents.map((a) => ({
    name: a.agentName,
    completed: a.completedMissionCount,
  }));

  return (
    <div className="battle-report">
      <div className="section-head">
        <div>
          <div className="section-label">Battle Report</div>
          <h2>Project pulse</h2>
        </div>
        <span className="section-tag">Generated {formatTimestamp(report.generatedAt)}</span>
      </div>

      <div className="metric-row">
        <MetricCard
          label="Agents online"
          value={`${report.activeAgents}/${report.totalAgents}`}
          icon={<Users size={14} />}
        />
        <MetricCard
          label="Missions complete"
          value={`${report.completedMissionCount}/${report.totalMissions}`}
          icon={<CheckCircle size={14} />}
          trend={{ value: `${report.completionRate}%`, positive: report.completionRate >= 50 }}
        />
        <MetricCard
          label="Running now"
          value={String(report.runningMissionCount)}
          icon={<Activity size={14} />}
        />
        <MetricCard
          label="Logs / 24h"
          value={String(report.logVolume24h)}
          icon={<Zap size={14} />}
        />
        <MetricCard
          label="High risk"
          value={String(report.highRiskMissionCount)}
          icon={<AlertTriangle size={14} />}
        />
        <MetricCard
          label="Needs approval"
          value={String(report.manualGovernanceMissionCount)}
          icon={<Shield size={14} />}
        />
      </div>

      <div className="chart-row">
        <div className="chart-card">
          <div className="chart-title">Mission Distribution</div>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={missionData}
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={70}
                paddingAngle={3}
                dataKey="value"
              >
                {missionData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} stroke="none" />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: '#04070f',
                  border: '1px solid #151c23',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                itemStyle={{ color: '#e5f0da' }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="chart-legend">
            {missionData.map((item) => (
              <span key={item.name} className="legend-item">
                <span className="legend-dot" style={{ background: item.color }} />
                {item.name}: {item.value}
              </span>
            ))}
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title">Top Agents</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={topAgentData} layout="vertical" margin={{ left: 0, right: 10 }}>
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="name"
                width={80}
                tick={{ fill: COLORS.text, fontSize: 11 }}
              />
              <Bar dataKey="completed" fill={COLORS.green} radius={[0, 3, 3, 0]} />
              <Tooltip
                contentStyle={{
                  background: '#04070f',
                  border: '1px solid #151c23',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                itemStyle={{ color: '#e5f0da' }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <div className="chart-title">Health Score</div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={completionTrend} margin={{ top: 10, bottom: 10 }}>
              <Line
                type="monotone"
                dataKey="rate"
                stroke={healthColor}
                strokeWidth={3}
                dot={{ fill: healthColor, r: 6, strokeWidth: 2, stroke: '#050913' }}
              />
              <XAxis hide />
              <YAxis domain={[0, 100]} tick={{ fill: COLORS.text, fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  background: '#04070f',
                  border: '1px solid #151c23',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                itemStyle={{ color: '#e5f0da' }}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="chart-big-number">
            <span className="big-number">{report.completionRate}%</span>
            <span className="big-label">completion rate — current snapshot</span>
          </div>
        </div>
      </div>

      <div className={`narrative narrative-${report.health.toLowerCase()}`}>{report.narrative}</div>
    </div>
  );
}
