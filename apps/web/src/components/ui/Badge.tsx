import type { ReactNode } from 'react';

interface BadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  children: ReactNode;
  className?: string;
  title?: string;
}

const variantStyles: Record<string, string> = {
  default: 'bdg-default',
  success: 'bdg-success',
  warning: 'bdg-warning',
  error: 'bdg-error',
  info: 'bdg-info',
};

export function Badge({ variant = 'default', children, className = '', title }: BadgeProps) {
  return (
    <span className={`bdg ${variantStyles[variant]} ${className}`} title={title}>
      {children}
    </span>
  );
}
