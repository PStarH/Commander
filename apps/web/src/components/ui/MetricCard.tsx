import type { ReactNode } from 'react';
import { Card } from './Card';

interface MetricCardProps {
  label: string;
  value: string;
  icon?: ReactNode;
  trend?: { value: string; positive: boolean };
}

export function MetricCard({ label, value, icon, trend }: MetricCardProps) {
  return (
    <Card className="metric">
      <div className="metric-head">
        {icon && <span className="metric-icon">{icon}</span>}
        <span className="metric-label">{label}</span>
      </div>
      <strong className="metric-value">{value}</strong>
      {trend && (
        <span className={`metric-trend ${trend.positive ? 'trend-up' : 'trend-down'}`}>
          {trend.value}
        </span>
      )}
    </Card>
  );
}
