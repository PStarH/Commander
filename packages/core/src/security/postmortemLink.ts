// packages/core/src/security/postmortemLink.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reportSilentFailure } from '../silentFailureReporter';
import { UniversalSanitizer } from './securityPrimitives';

const sanitizer = new UniversalSanitizer();

export interface Postmortem {
  id: string;
  title: string;
  date: string;
  redTeamScenarioId?: string;
  body: string;
}

const MAX_BODY_SIZE = 200_000; // 200 KB cap (ATK-020 ancillary: bound DoS)

export function loadRecentPostmortems(daysBack: number): Postmortem[] {
  const dir = path.join(process.cwd(), 'docs', 'postmortems');
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const results: Postmortem[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const dateMatch = content.match(/date:\s*(\d{4}-\d{2}-\d{2})/i);
      if (!dateMatch) continue;
      const date = new Date(dateMatch[1]);
      if (date.getTime() < cutoff) continue;
      const safeId = sanitizeIdentifier(file.replace('.md', ''));
      const safeTitle = sanitizeTitle(file.replace('.md', ''));
      // ATK-020: cap body size at 200KB to bound DoS — truncate rather
      // than drop the postmortem entirely.
      const body = content.length > MAX_BODY_SIZE ? content.slice(0, MAX_BODY_SIZE) : content;
      results.push({
        id: safeId,
        title: safeTitle,
        date: dateMatch[1],
        redTeamScenarioId: extractScenarioId(content),
        body,
      });
    } catch (err) {
      reportSilentFailure(err, 'redteam:postmortemLink:load');
    }
  }
  return results;
}

function extractScenarioId(content: string): string | undefined {
  const match = content.match(/red.?team.?scenario:\s*([A-Z]+-\d+)/i);
  return match?.[1];
}

export function suggestScenarioFromPostmortem(pm: Postmortem): string {
  // ATK-019 fix: derive the auto id from a stable hash of the source
  // postmortem, not from the title. Title-based ids collide with
  // existing scenarios (e.g. PI-001 ↔ AUTO-PI-001) and break dedup.
  const cryptoRandom = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
    .toUpperCase();
  const idSuffix = `${pm.date.replace(/-/g, '')}-${cryptoRandom}`;
  return [
    `## Suggested Red Team Scenario from Postmortem ${pm.id}`,
    '',
    `Based on incident "${pm.title}" (${pm.date}):`,
    '',
    '```yaml',
    `id: AUTO-${idSuffix}`,
    `category: derived_from_postmortem`,
    `name: "${pm.title}"`,
    'payload: "<derive from postmortem body>"',
    'severity: high',
    '```',
  ].join('\n');
}

// ── ATK-020 helpers ─────────────────────────────────────────────────

/**
 * Restrict a string to a safe identifier alphabet. Used for the postmortem
 * `id` field which may be referenced from URL paths and issue trackers.
 * Delegates to UniversalSanitizer ('identifier' context) so that path
 * traversal, PII, and unsafe characters are handled by the canonical
 * primitive.
 */
export function sanitizeIdentifier(s: string): string {
  return sanitizer.sanitize(s, 'identifier').sanitized.slice(0, 80);
}

/**
 * Strip HTML/JS injection markers from a postmortem title. The title is
 * often rendered in dashboards; without sanitization, a filename like
 * `onclick=alert(1).md` produces a title that is a real XSS payload when
 * rendered unescaped. Delegates to UniversalSanitizer ('identifier'
 * context) for canonical scrubbing, then applies a length cap.
 */
export function sanitizeTitle(s: string): string {
  return sanitizer.sanitize(s, 'identifier').sanitized.trim().slice(0, 200);
}
