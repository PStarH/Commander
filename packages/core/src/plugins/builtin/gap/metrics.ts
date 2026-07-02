// packages/core/src/plugins/builtin/gap/metrics.ts
import type { GapEntry, GapSource } from './types';
import { isOverdue } from './types';

export interface GapMetrics {
  open: number;
  overdueRepair: number;
  bySource: Record<GapSource, number>;
  avgTimeToFixDays: number;
}

export function computeMetrics(entries: GapEntry[], now: Date = new Date()): GapMetrics {
  const open = entries.filter((e) => e.status === 'open').length;
  const overdueRepair = entries.filter(
    (e) => e.status === 'open' && isOverdue(e.slaDeadline, now),
  ).length;

  const bySource = entries.reduce(
    (acc, e) => {
      acc[e.source] = (acc[e.source] || 0) + 1;
      return acc;
    },
    {} as Record<GapSource, number>,
  );

  const fixed = entries.filter((e) => e.status === 'fixed' && e.closedAt);
  const totalDays = fixed.reduce((sum, e) => {
    const diff = new Date(e.closedAt!).getTime() - new Date(e.detectedAt).getTime();
    return sum + diff / (1000 * 60 * 60 * 24);
  }, 0);
  const avgTimeToFixDays = fixed.length > 0 ? totalDays / fixed.length : 0;

  return { open, overdueRepair, bySource, avgTimeToFixDays };
}
