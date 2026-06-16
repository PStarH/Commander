/**
 * commander intelligence — Show what Commander has learned from your usage.
 *
 * Sub-commands (flags):
 *   (none)            Dashboard summary — key stats at a glance
 *   --stats           MetaLearner: Thompson Sampling strategy scores, regression alerts, optimization suggestions
 *   --skills          Extracted skills: what patterns Commander auto-extracted from successful runs
 *   --patterns        Failure patterns: repeated mistakes and proactive warnings
 *   --all             Everything above
 */

import { $ } from '../util';

// ============================================================================
// Helpers
// ============================================================================

function header(text: string): void {
  console.log(`\n  ${$.cyan}${$.bold}╭─ ${text}${$.reset}`);
}

function subheader(text: string): void {
  console.log(`\n  ${$.bold}${text}${$.reset}`);
}

function dim(text: string): void {
  console.log(`  ${$.dim}${text}${$.reset}`);
}

function bar(label: string, pct: number, width: number = 20): string {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const color = pct >= 0.8 ? $.green : pct >= 0.5 ? $.yellow : $.red;
  return `${color}${'█'.repeat(filled)}${$.dim}${'░'.repeat(empty)}${$.reset} ${(pct * 100).toFixed(0)}%  ${label}`;
}

function trunc(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function ago(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function durationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ============================================================================
// Dashboard summary (default view)
// ============================================================================

async function showDashboard(): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}Commander Intelligence${$.reset} — What I've Learned            ${$.cyan}${$.bold}│${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`);

  try {
    const { getMetaLearner } = await import('../../selfEvolution/metaLearner');
    const { getSkillExtractor } = await import('../../intelligence/skillExtractor');
    const { getFailurePatternLearner } = await import('../../intelligence/failurePatterns');

    const ml = getMetaLearner();
    const sx = getSkillExtractor();
    const fl = getFailurePatternLearner();

    const mlStats = ml.getStats();
    const skills = sx.getSkills();
    const patterns = fl.getPatterns();

    // ── MetaLearner summary ──
    header('META-LEARNER');
    if (mlStats.totalExperiences === 0) {
      dim('  No experiences yet. Run some tasks to build up learning data.');
    } else {
      console.log([
        `  ${$.bold}Experiences:${$.reset}  ${mlStats.totalExperiences}  `,
        `  ${$.bold}Strategies:${$.reset}  ${mlStats.trackedStrategies}  `,
        `  ${$.bold}Success Rate:${$.reset}  ${(mlStats.avgSuccessRate * 100).toFixed(0)}%  `,
        `  ${$.bold}Reflections:${$.reset}  ${mlStats.totalReflections}`,
      ].join(''));

      // Top strategies
      if (mlStats.topStrategies.length > 0) {
        subheader('Top Strategies');
        for (const s of mlStats.topStrategies) {
          console.log(`  ${bar(s.strategyName, s.successRate)}  ${$.dim}${s.totalRuns} runs · p95 ${durationMs(s.p95DurationMs)}${$.reset}`);
        }
      }

      // Regression alerts
      const regressions = ml.getRegressionEvents(5);
      if (regressions.length > 0) {
        subheader('Regression Alerts');
        for (const r of regressions) {
          console.log(`  ${$.red}⚠${$.reset} ${r.strategyName} on ${r.modelId}: dropped ${(r.dropRatio * 100).toFixed(0)}% (${(r.previousSuccessRate * 100).toFixed(0)}% → ${(r.currentSuccessRate * 100).toFixed(0)}%)`);
        }
      }

      // Optimization suggestions
      const highSuggestions = ml.getSuggestions().filter(s => s.impact === 'high');
      if (highSuggestions.length > 0) {
        subheader('Suggestions');
        for (const s of highSuggestions.slice(0, 3)) {
          console.log(`  ${$.yellow}💡${$.reset} ${trunc(`${s.type}: ${s.from} → ${s.to}`, 70)}`);
        }
      }
    }

    // ── Skills ──
    header('SKILLS');
    if (skills.length === 0) {
      dim('  No skills extracted yet. Skills are auto-extracted from successful runs.');
    } else {
      const byCategory = new Map<string, number>();
      for (const s of skills) byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
      const catList = [...byCategory.entries()].map(([k, v]) => `${k}: ${v}`).join(' · ');
      console.log(`  ${skills.length} skills${catList ? ` (${catList})` : ''}`);

      for (const s of skills.slice(0, 5)) {
        const icon = s.successRate >= 0.9 ? $.green : s.successRate >= 0.7 ? $.yellow : $.red;
        console.log(`  ${icon}●${$.reset} ${trunc(s.name, 40)}  ${$.dim}${s.usageCount}× · ${(s.successRate * 100).toFixed(0)}%${$.reset}`);
      }
      if (skills.length > 5) dim(`  ... and ${skills.length - 5} more (use --skills for full list)`);
    }

    // ── Failure patterns ──
    header('FAILURE PATTERNS');
    if (patterns.length === 0) {
      dim('  No patterns yet. Patterns emerge from repeated failures.');
    } else {
      const activePatterns = patterns.filter(p => p.occurrences.length >= 2);
      console.log(`  ${patterns.length} patterns (${activePatterns.length} active with ≥2 occurrences)`);

      for (const p of activePatterns.slice(0, 3)) {
        const sev = p.occurrences.length >= 5 ? $.red : p.occurrences.length >= 3 ? $.yellow : $.dim;
        const icon = p.autoWarn ? '⚠' : '·';
        console.log(`  ${sev}${icon}${$.reset} ${trunc(p.description, 55)}  ${$.dim}${p.occurrences.length}× · ${p.confidence >= 0.7 ? 'high' : p.confidence >= 0.4 ? 'med' : 'low'} confidence${$.reset}`);
      }
      if (activePatterns.length > 3) dim(`  ... and ${activePatterns.length - 3} more (use --patterns for full list)`);
    }

    // ── Footer ──
    console.log(`\n  ${$.dim}Show details: ${$.cyan}commander intelligence --stats${$.reset}${$.dim} | ${$.cyan}--skills${$.reset}${$.dim} | ${$.cyan}--patterns${$.reset}${$.dim} | ${$.cyan}--all${$.reset}\n`);

  } catch (err) {
    console.log(`\n  ${$.red}Error loading intelligence data: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  }
}

// ============================================================================
// Stats view (MetaLearner deep dive)
// ============================================================================

async function showStats(): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}MetaLearner${$.reset} — Thompson Sampling + Reflexion           ${$.cyan}${$.bold}│${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`);

  try {
    const { getMetaLearner } = await import('../../selfEvolution/metaLearner');

    const ml = getMetaLearner();
    const stats = ml.getStats();

    if (stats.totalExperiences === 0) {
      dim('  No experiences recorded yet. Run some tasks to build up learning data.');
      console.log();
      return;
    }

    // ── Overview ──
    subheader('Overview');
    console.log(`  Experiences:  ${stats.totalExperiences}`);
    console.log(`  Strategies:   ${stats.trackedStrategies}`);
    console.log(`  Avg success:  ${(stats.avgSuccessRate * 100).toFixed(0)}%`);
    console.log(`  Reflections:  ${stats.totalReflections}`);

    // ── Strategy Performance ──
    subheader('Strategy Performance (Thompson Sampling)');
    const perf = ml.getStrategyPerformance();
    const ranked = [...perf.values()].sort((a, b) => b.successRate - a.successRate);

    if (ranked.length === 0) {
      dim('  No strategy data yet.');
    } else {
      for (const s of ranked) {
        console.log(`  ${bar(s.strategyName, s.successRate, 18)}  ${$.dim}${s.totalRuns} runs · p95 ${durationMs(s.p95DurationMs)} · avg ${durationMs(s.avgDurationMs)}${$.reset}`);
      }
    }

    // ── Per Task-Type Scores ──
    const taskTypes = ml.getTrackedTaskTypes();
    if (taskTypes.length > 0) {
      subheader('Per Task-Type Strategy Scores');
      for (const tt of taskTypes.slice(0, 5)) {
        const scores = ml.getStrategyScores(tt);
        if (scores.length === 0) continue;
        console.log(`  ${$.bold}${trunc(tt, 35)}${$.reset}`);
        for (const s of scores.slice(0, 3)) {
          console.log(`    ${s.strategy}: ${(s.score * 100).toFixed(0)}%  ${$.dim}(${s.trials} trials${s.p95DurationMs ? ` · p95 ${durationMs(s.p95DurationMs)}` : ''})${$.reset}`);
        }
      }
      if (taskTypes.length > 5) dim(`  ... and ${taskTypes.length - 5} more task types`);
    }

    // ── Regression Events ──
    const regressions = ml.getRegressionEvents(10);
    if (regressions.length > 0) {
      subheader('Regression Alerts');
      for (const r of regressions) {
        console.log(`  ${$.red}▼${$.reset} ${r.strategyName} on ${r.modelId}: ${(r.dropRatio * 100).toFixed(0)}% drop (${(r.previousSuccessRate * 100).toFixed(0)}% → ${(r.currentSuccessRate * 100).toFixed(0)}%)  ${$.dim}${ago(r.triggeredAt)}${$.reset}`);
      }
    }

    // ── Optimization Suggestions ──
    const suggestions = ml.getSuggestions();
    if (suggestions.length > 0) {
      subheader('Optimization Suggestions');
      for (const s of suggestions) {
        const impactColor = s.impact === 'high' ? $.red : s.impact === 'medium' ? $.yellow : $.dim;
        console.log(`  ${impactColor}→${$.reset} ${s.type}: ${trunc(s.from, 15)} → ${trunc(s.to, 15)}  ${$.dim}${s.evidence.slice(0, 2).join(' · ')}${$.reset}`);
      }
    }

    // ── Prediction Loop ──
    const verdicts = ml.getVerdicts();
    if (verdicts.length > 0) {
      const confirmed = verdicts.filter(v => v.netImpact === 'positive').length;
      const reverted = verdicts.filter(v => v.reverted).length;
      subheader('Prediction Loop');
      console.log(`  Total verdicts:  ${verdicts.length}`);
      console.log(`  Confirmed (✓):   ${confirmed}  (${(confirmed / verdicts.length * 100).toFixed(0)}%)`);
      console.log(`  Reverted (✗):    ${reverted}`);
    }

    // ── Recent Reflections ──
    const reflections = ml.getReflections(3);
    if (reflections.length > 0) {
      subheader('Recent Reflections');
      for (const r of reflections) {
        const firstLine = r.split('\n')[0];
        console.log(`  ${$.dim}${trunc(firstLine.replace(/^\[/, '').replace(/\]$/, ''), 65)}${$.reset}`);
      }
    }

    console.log();

  } catch (err) {
    console.log(`\n  ${$.red}Error loading stats: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  }
}

// ============================================================================
// Skills view
// ============================================================================

async function showSkills(): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}Extracted Skills${$.reset} — Auto-learned from successful runs     ${$.cyan}${$.bold}│${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`);

  try {
    const { getSkillExtractor } = await import('../../intelligence/skillExtractor');

    const sx = getSkillExtractor();
    const skills = sx.getSkills();

    if (skills.length === 0) {
      dim('  No skills extracted yet.');
      dim('  Skills are auto-extracted from successful task executions.');
      dim('  Each time Commander completes a task, it analyzes the trace and');
      dim('  extracts reusable patterns.');
      console.log();
      return;
    }

    const byCategory = new Map<string, typeof skills>();
    for (const s of skills) {
      const arr = byCategory.get(s.category) ?? [];
      arr.push(s);
      byCategory.set(s.category, arr);
    }

    for (const [category, catSkills] of byCategory) {
      subheader(`${category.toUpperCase()} (${catSkills.length})`);
      for (const s of catSkills) {
        const barWidth = 15;
        const filled = Math.round(s.successRate * barWidth);
        const color = s.successRate >= 0.9 ? $.green : s.successRate >= 0.7 ? $.yellow : $.red;
        const usageBar = `${color}${'█'.repeat(filled)}${$.dim}${'░'.repeat(barWidth - filled)}${$.reset}`;

        console.log(`  ${usageBar} ${s.name}`);
        console.log(`  ${$.dim}     ${s.usageCount} uses · ${(s.successRate * 100).toFixed(0)}% success · ${s.tools.length} tools · last used ${ago(s.lastUsed)}${$.reset}`);
        if (s.steps.length > 0) {
          console.log(`  ${$.dim}     Steps: ${s.steps.slice(0, 3).join(' → ')}${s.steps.length > 3 ? ' …' : ''}${$.reset}`);
        }
      }
    }

    console.log(`\n  ${$.dim}Skills are stored in ${$.cyan}.commander/intelligence/extracted-skills.json${$.reset}\n`);

  } catch (err) {
    console.log(`\n  ${$.red}Error loading skills: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  }
}

// ============================================================================
// Failure patterns view
// ============================================================================

async function showPatterns(): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}Failure Patterns${$.reset} — Repeated mistakes & warnings        ${$.cyan}${$.bold}│${$.reset}`);
  console.log(`  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`);

  try {
    const { getFailurePatternLearner } = await import('../../intelligence/failurePatterns');

    const fl = getFailurePatternLearner();
    const patterns = fl.getPatterns();

    if (patterns.length === 0) {
      dim('  No failure patterns recorded yet.');
      dim('  Patterns are detected when the same type of failure repeats across runs.');
      dim('  After 2+ occurrences, Commander starts warning you proactively.');
      console.log();
      return;
    }

    for (const p of patterns) {
      const severity = p.occurrences.length >= 5 ? '🔴' : p.occurrences.length >= 3 ? '🟡' : '🟢';
      const autoWarnBadge = p.autoWarn ? ` ${$.yellow}auto-warn ON${$.reset}` : '';
      const confidenceColor = p.confidence >= 0.7 ? $.red : p.confidence >= 0.4 ? $.yellow : $.dim;

      console.log(`\n  ${severity} ${$.bold}${p.category}${$.reset}${autoWarnBadge}`);
      console.log(`  ${$.dim}Pattern:${$.reset} ${trunc(p.description, 70)}`);
      console.log(`  ${$.dim}Occurrences:${$.reset} ${p.occurrences.length} · Confidence: ${confidenceColor}${(p.confidence * 100).toFixed(0)}%${$.reset} · Last: ${ago(p.lastOccurrence)}`);

      // Show recent occurrences
      const recent = p.occurrences.slice(-3);
      for (const o of recent) {
        const resolved = o.resolution ? ` ${$.green}resolved: ${o.resolution}${$.reset}` : '';
        console.log(`  ${$.dim}${ago(o.timestamp)}${$.reset} ${trunc(o.context, 60)}${resolved}`);
      }
    }

    console.log(`\n  ${$.dim}Patterns stored in ${$.cyan}.commander/intelligence/failure-patterns.json${$.reset}\n`);

  } catch (err) {
    console.log(`\n  ${$.red}Error loading patterns: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
  }
}

// ============================================================================
// Main entry point
// ============================================================================

export async function cmdIntelligence(flags: Record<string, string>): Promise<void> {
  const showAll = !!flags['--all'];
  const showStatsFlag = !!flags['--stats'] || showAll;
  const showSkillsFlag = !!flags['--skills'] || showAll;
  const showPatternsFlag = !!flags['--patterns'] || showAll;

  // Default: show dashboard
  if (!showStatsFlag && !showSkillsFlag && !showPatternsFlag) {
    await showDashboard();
    return;
  }

  if (showStatsFlag) await showStats();
  if (showSkillsFlag) await showSkills();
  if (showPatternsFlag) await showPatterns();
}
