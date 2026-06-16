/**
 * Commander War Room — Shared UI primitives.
 *
 * Lightweight presentational building blocks reused across Dashboard components.
 * These are thin wrappers around native HTML elements with Commander's
 * indigo design system applied via CSS classes.
 */

import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes, ButtonHTMLAttributes } from 'react';

// ============================================================================
// Card — Container panel with border + shadow
// ============================================================================

type CardVariant = 'default' | 'high-risk' | 'critical-risk';

interface CardProps {
  children: ReactNode;
  className?: string;
  variant?: CardVariant;
}

const cardVariantClass: Record<CardVariant, string> = {
  default: '',
  'high-risk': 'card-hr',
  'critical-risk': 'card-cr',
};

export function Card({ children, className, variant = 'default' }: CardProps) {
  const variantClass = cardVariantClass[variant];
  return (
    <div className={`card ${variantClass} ${className ?? ''}`}>
      {children}
    </div>
  );
}

// ============================================================================
// Badge — Small inline status pill
// ============================================================================

type BadgeVariant = 'success' | 'warning' | 'error' | 'info';

interface BadgeProps {
  children: ReactNode;
  variant: BadgeVariant;
}

const badgeClass: Record<BadgeVariant, string> = {
  success: 'bdg bdg-success',
  warning: 'bdg bdg-warning',
  error: 'bdg bdg-error',
  info: 'bdg bdg-info',
};

export function Badge({ children, variant }: BadgeProps) {
  return (
    <span className={badgeClass[variant] ?? 'bdg bdg-default'}>
      {children}
    </span>
  );
}

// ============================================================================
// Button — Action button with variant + size
// ============================================================================

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit';
}

const buttonVariantClass: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

const buttonSizeClass: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: 'btn-md',
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn ${buttonSizeClass[size]} ${buttonVariantClass[variant]} ${className ?? ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ============================================================================
// Input — Styled text input
// ============================================================================

interface InputProps extends InputHTMLAttributes<HTMLInputElement> { }

export function Input({ className, ...rest }: InputProps) {
  return (
    <input className={`inp ${className ?? ''}`} {...rest} />
  );
}

// ============================================================================
// Select — Styled dropdown
// ============================================================================

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> { }

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={`sel ${className ?? ''}`} {...rest}>
      {children}
    </select>
  );
}

// ============================================================================
// MetricCard — Compact KPI card with icon, label, value, trend
// ============================================================================

interface MetricCardTrendText {
  value: string;
  positive: boolean;
}

interface MetricCardProps {
  label: string;
  value: string;
  icon?: ReactNode;
  /** Accepts either a simple direction or a detailed { value, positive } object */
  trend?: 'up' | 'down' | 'neutral' | MetricCardTrendText;
  className?: string;
}

export function MetricCard({ label, value, icon, trend, className }: MetricCardProps) {
  function renderTrend() {
    if (!trend) return null;
    if (typeof trend === 'string') {
      const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—';
      return <span className={`metric-card-trend trend-${trend}`}>{arrow}</span>;
    }
    // MetricCardTrendText
    const cls = trend.positive ? 'trend-up' : 'trend-down';
    return <span className={`metric-card-trend ${cls}`}>{trend.value}</span>;
  }

  return (
    <div className={`metric-card ${className ?? ''}`}>
      <div className="metric-card-head">
        {icon && <span className="metric-card-icon">{icon}</span>}
        <span className="metric-card-label">{label}</span>
      </div>
      <div className="metric-card-body">
        <span className="metric-card-value">{value}</span>
        {renderTrend()}
      </div>
    </div>
  );
}
