import type { SelectHTMLAttributes, ReactNode } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
}

export function Select({ children, className = '', ...props }: SelectProps) {
  return (
    <select className={`sel ${className}`} {...props}>
      {children}
    </select>
  );
}
