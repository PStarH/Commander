// packages/core/src/plugins/builtin/gap/issueAutoCreate.ts
import { getGlobalLogger } from '../../../logging';
import { reportSilentFailure } from '../../../silentFailureReporter';
import type { GapConfig } from './config';

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
  assignees?: string[];
}

export interface CreateResult {
  id: number;
  url: string;
}

export class IssueAutoCreate {
  constructor(private config: GapConfig) {}

  async create(draft: IssueDraft): Promise<CreateResult | null> {
    const logger = getGlobalLogger();
    const fullTitle = `${this.config.titlePrefix} ${draft.title}`;

    if (this.config.dryRun) {
      logger.info('IssueAutoCreate', 'dry-run, would create', { title: fullTitle });
      return null;
    }

    if (this.config.dedupEnabled) {
      const dup = await this.findDuplicate(fullTitle);
      if (dup) {
        logger.info('IssueAutoCreate', 'duplicate skipped', { id: dup.number, title: fullTitle });
        return null;
      }
    }

    return this.callGitHubApi({ ...draft, title: fullTitle });
  }

  private async findDuplicate(title: string): Promise<{ number: number } | null> {
    const url = `https://api.github.com/repos/${this.config.repo}/issues?state=open&labels=${encodeURIComponent(this.config.defaultLabels.join(','))}&per_page=100`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) return null;
      const issues = (await res.json()) as Array<{ number: number; title: string; state: string }>;
      const match = issues.find((i) => i.title === title || i.title.startsWith(title));
      return match ? { number: match.number } : null;
    } catch (err) {
      reportSilentFailure(err, 'gap:issueAutoCreate:findDuplicate');
      return null;
    }
  }

  private async callGitHubApi(draft: IssueDraft): Promise<CreateResult> {
    const url = `https://api.github.com/repos/${this.config.repo}/issues`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: draft.title,
        body: draft.body,
        labels: [...this.config.defaultLabels, ...draft.labels],
        assignees: draft.assignees,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { number: number; html_url: string };
    return { id: data.number, url: data.html_url };
  }
}
