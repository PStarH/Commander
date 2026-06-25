/**
 * Commander feedback — Collect user feedback for continuous improvement.
 *
 * Usage:
 *   commander feedback                  Interactive feedback prompt
 *   commander feedback --rating=5       Quick rating (1-5)
 *   commander feedback --message="..."  Feedback with message
 *   commander feedback --bug="..."      Report a bug
 *   commander feedback --feature="..."  Request a feature
 */
import { reportSilentFailure } from '../../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { $, section, kv, parseFlags } from './_shared';

// ============================================================================
// Feedback storage
// ============================================================================

interface FeedbackEntry {
  id: string;
  timestamp: string;
  type: 'rating' | 'bug' | 'feature' | 'general';
  rating?: number;
  message: string;
  context?: {
    command?: string;
    provider?: string;
    model?: string;
    platform?: string;
    version?: string;
  };
}

function getFeedbackDir(): string {
  return path.join(process.cwd(), '.commander', 'feedback');
}

function getFeedbackFile(): string {
  return path.join(getFeedbackDir(), 'feedback.jsonl');
}

function loadFeedback(): FeedbackEntry[] {
  const file = getFeedbackFile();
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (err) {
    reportSilentFailure(err, 'feedback:49');
    return [];
  }
}

function appendFeedback(entry: FeedbackEntry): void {
  const dir = getFeedbackDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = getFeedbackFile();
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function generateId(): string {
  return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getContext(): FeedbackEntry['context'] {
  const { detectProvider, getEffectiveModel } = require('../../config/commanderConfig');
  const provider = detectProvider();
  return {
    provider: provider?.type,
    model: getEffectiveModel(),
    platform: process.platform,
    version: '1.0.0-alpha.1',
  };
}

// ============================================================================
// Display feedback stats
// ============================================================================

function showFeedbackStats() {
  const entries = loadFeedback();
  if (entries.length === 0) {
    console.log(`  ${$.dim}No feedback collected yet.${$.reset}\n`);
    return;
  }

  section('FEEDBACK SUMMARY');

  const byType = { rating: 0, bug: 0, feature: 0, general: 0 };
  let totalRating = 0;
  let ratingCount = 0;

  for (const e of entries) {
    byType[e.type]++;
    if (e.rating) {
      totalRating += e.rating;
      ratingCount++;
    }
  }

  kv('Total feedback', `${entries.length}`, $.cyan);
  if (ratingCount > 0) {
    const avg = (totalRating / ratingCount).toFixed(1);
    const stars =
      '★'.repeat(Math.round(totalRating / ratingCount)) +
      '☆'.repeat(5 - Math.round(totalRating / ratingCount));
    kv('Average rating', `${avg}/5 ${stars}`, $.yellow);
  }
  kv('Ratings', `${byType.rating}`, $.dim);
  kv('Bug reports', `${byType.bug}`, byType.bug > 0 ? $.red : $.dim);
  kv('Feature requests', `${byType.feature}`, byType.feature > 0 ? $.cyan : $.dim);
  kv('General', `${byType.general}`, $.dim);

  // Show recent feedback
  const recent = entries.slice(-5).reverse();
  if (recent.length > 0) {
    console.log();
    console.log(`  ${$.dim}Recent feedback:${$.reset}`);
    for (const e of recent) {
      const typeIcon =
        e.type === 'bug'
          ? `${$.red}🐛${$.reset}`
          : e.type === 'feature'
            ? `${$.cyan}💡${$.reset}`
            : e.type === 'rating'
              ? `${$.yellow}⭐${$.reset}`
              : `${$.dim}💬${$.reset}`;
      const rating = e.rating ? ` ${'★'.repeat(e.rating)}${'☆'.repeat(5 - e.rating)}` : '';
      const time = new Date(e.timestamp).toLocaleDateString();
      const msg = e.message.slice(0, 60) + (e.message.length > 60 ? '...' : '');
      console.log(`  ${typeIcon}${rating} ${$.dim}${time}${$.reset} ${msg}`);
    }
  }
  console.log();
}

// ============================================================================
// Main command
// ============================================================================

export async function cmdFeedback(args: string[]) {
  const { positional, flags } = parseFlags(args);

  // Subcommand: stats
  if (positional[0] === 'stats' || positional[0] === 'list') {
    showFeedbackStats();
    return;
  }

  // Quick bug report
  if (flags.bug) {
    const entry: FeedbackEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: 'bug',
      message: flags.bug,
      context: getContext(),
    };
    appendFeedback(entry);
    console.log(`  ${$.green}✓${$.reset} Bug report saved ${$.dim}(${entry.id})${$.reset}`);
    console.log(`  ${$.dim}Thank you! This helps us improve Commander.${$.reset}\n`);
    return;
  }

  // Quick feature request
  if (flags.feature) {
    const entry: FeedbackEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: 'feature',
      message: flags.feature,
      context: getContext(),
    };
    appendFeedback(entry);
    console.log(`  ${$.green}✓${$.reset} Feature request saved ${$.dim}(${entry.id})${$.reset}`);
    console.log(`  ${$.dim}Thank you! We'll consider this for a future release.${$.reset}\n`);
    return;
  }

  // Quick rating
  if (flags.rating) {
    const rating = Math.min(5, Math.max(1, parseInt(flags.rating, 10) || 3));
    const entry: FeedbackEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: 'rating',
      rating,
      message: flags.message || `Rating: ${rating}/5`,
      context: getContext(),
    };
    appendFeedback(entry);
    const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
    console.log(
      `  ${$.green}✓${$.reset} Rating saved: ${$.yellow}${stars}${$.reset} ${$.dim}(${entry.id})${$.reset}\n`,
    );
    return;
  }

  // Quick message
  if (flags.message) {
    const entry: FeedbackEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: 'general',
      message: flags.message,
      context: getContext(),
    };
    appendFeedback(entry);
    console.log(`  ${$.green}✓${$.reset} Feedback saved ${$.dim}(${entry.id})${$.reset}`);
    console.log(`  ${$.dim}Thank you for your feedback!${$.reset}\n`);
    return;
  }

  // Interactive feedback prompt
  console.log(`
  ${$.bold}${$.blue}╭──────────────────────────────────────────────────╮${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander Feedback${$.reset}                             ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.dim}Help us improve Commander${$.reset}                       ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}╰──────────────────────────────────────────────────╯${$.reset}

  ${$.bold}QUICK FEEDBACK${$.reset}
    ${$.cyan}commander feedback --rating=5${$.reset}              ${$.dim}Rate your experience (1-5)${$.reset}
    ${$.cyan}commander feedback --bug="description"${$.reset}     ${$.dim}Report a bug${$.reset}
    ${$.cyan}commander feedback --feature="idea"${$.reset}        ${$.dim}Request a feature${$.reset}
    ${$.cyan}commander feedback --message="text"${$.reset}        ${$.dim}General feedback${$.reset}
    ${$.cyan}commander feedback stats${$.reset}                  ${$.dim}View feedback summary${$.reset}

  ${$.bold}EXAMPLES${$.reset}
    ${$.gray}commander feedback --rating=4 --message="Love the watch command!"${$.reset}
    ${$.gray}commander feedback --bug="crash when running with no network"${$.reset}
    ${$.gray}commander feedback --feature="add dark mode to TUI"${$.reset}
  `);

  showFeedbackStats();
}
