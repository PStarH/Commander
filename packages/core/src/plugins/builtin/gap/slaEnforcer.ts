// packages/core/src/plugins/builtin/gap/slaEnforcer.ts
import type { GapEntry } from './types';
import { getGlobalLogger } from '../../../logging';
import { UniversalSanitizer } from '../../../security/securityPrimitives';

export interface SlaEnforcerDeps {
  pagerDuty: (alert: { title: string; body: string; runbook: string }) => Promise<void> | void;
  slack: (message: string) => Promise<void> | void;
  getRunbookUrl: (source: GapEntry['source']) => string;
}

export class SlaEnforcer {
  private readonly sanitizer = new UniversalSanitizer();

  constructor(private deps: SlaEnforcerDeps) {}

  async enforce(overdueEntries: GapEntry[]): Promise<void> {
    const logger = getGlobalLogger();
    for (const entry of overdueEntries) {
      const sanitizedTitle = this.sanitizer.sanitize(entry.title, 'channel_text').sanitized;
      if (entry.severity === 'critical') {
        await this.deps.pagerDuty({
          title: `Critical gap overdue: ${sanitizedTitle} (${entry.id})`,
          body: `${entry.description}\n\nSource: ${entry.source}\nDeadline: ${entry.slaDeadline}`,
          runbook: this.deps.getRunbookUrl(entry.source),
        });
        logger.warn('SlaEnforcer', 'critical overdue → PagerDuty', { id: entry.id });
      } else if (entry.severity === 'high') {
        await this.deps.slack(
          `@security-team Gap ${entry.id} (${entry.severity}) overdue — ${sanitizedTitle}`,
        );
        logger.warn('SlaEnforcer', 'high overdue → Slack', { id: entry.id });
      }
    }
  }
}
