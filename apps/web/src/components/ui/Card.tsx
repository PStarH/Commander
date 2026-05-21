import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'high-risk' | 'critical-risk';
}

export function Card({ children, className = '', variant = 'default' }: CardProps) {
  const variantClass = variant === 'high-risk' ? 'card-hr' : variant === 'critical-risk' ? 'card-cr' : '';
  return <div className={`card ${variantClass} ${className}`}>{children}</div>;
}
