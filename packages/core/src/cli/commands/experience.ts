/**
 * commander experience — Manage Commander's learned experience.
 *
 * Sub-commands:
 *   commander experience reset                    Reset ALL learned experience (interactive confirmation)
 *   commander experience reset --skills           Reset extracted skills
 *   commander experience reset --patterns         Reset failure patterns
 *   commander experience reset --meta             Reset MetaLearner (Thompson priors, reflections)
 *   commander experience reset --force            Skip confirmation prompt
 *   commander experience status                   Show what's currently learned
 */

import * as fs from 'fs';
import * as path from 'path';
import { $, startSpinner } from '../util';

// ============================================================================
// Helpers
// ============================================================================

function section(text: string): void {
  console.log(`\n  ${$.cyan}${$.bold}╭─ ${text}${$.reset}`);
}

function kv(key: string, value: string, color = $.reset): void {
  console.log(`  ${$.dim}${key.padEnd(16)}${$.reset} ${color}${value}${$.reset}`);
}

function backupDir(): string {
  const dir = path.join(process.cwd(), '.commander_memory', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupFile(sourcePath: string, label: string): string | null {
  try {
    if (!fs.existsSync(sourcePath)) return null;
    const dir = backupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `${label}_${ts}.json`);
    fs.copyFileSync(sourcePath, dest);
    return dest;
  } catch (err) {
    console.warn('[Catch]', err);
    return null;
  }
}

async function readYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`  ${$.yellow}${prompt}${$.reset} `);
    const onData = (data: Buffer) => {
      const answer = data.toString().trim().toLowerCase();
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) process.stdin.pause();
      resolve(answer === 'y' || answer === 'yes');
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// ============================================================================
// Status
// ============================================================================

async function showStatus(): Promise<void> {
  console.log(
    `\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`,
  );
  console.log(
    `  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}Commander Experience${$.reset} — Learned State                  ${$.cyan}${$.bold}│${$.reset}`,
  );
  console.log(
    `  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`,
  );

  section('META-LEARNER');
  try {
    const { getMetaLearner } = await import('../../selfEvolution/metaLearner');
    const ml = getMetaLearner();
    const stats = ml.getStats();
    kv('Experiences', `${stats.totalExperiences}`);
    kv('Strategies', `${stats.trackedStrategies}`);
    kv('Success Rate', `${(stats.avgSuccessRate * 100).toFixed(0)}%`);
    kv('Reflections', `${stats.totalReflections}`);
    const regressions = ml.getRegressionEvents(100);
    kv('Regression alerts', `${regressions.length}`);
    const verdicts = ml.getVerdicts();
    kv('Predictions', `${verdicts.length}`);
  } catch (err) {
    console.warn('[Catch]', err);
    kv('Status', 'Not initialized', $.dim);
  }

  section('EXTRACTED SKILLS');
  try {
    const { getSkillExtractor } = await import('../../intelligence/skillExtractor');
    const sx = getSkillExtractor();
    const skills = sx.getSkills();
    kv('Skills', `${skills.length}`);
    if (skills.length > 0) {
      const byCat = new Map<string, number>();
      for (const s of skills) byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
      for (const [cat, count] of byCat) {
        kv(`  ${cat}`, `${count}`);
      }
      const newest = skills.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      kv('Newest', `${newest.name}`, $.dim);
    }
  } catch (err) {
    console.warn('[Catch]', err);
    kv('Status', 'Not initialized', $.dim);
  }

  section('FAILURE PATTERNS');
  try {
    const { getFailurePatternLearner } = await import('../../intelligence/failurePatterns');
    const fl = getFailurePatternLearner();
    const patterns = fl.getPatterns();
    kv('Patterns', `${patterns.length}`);
    const warnCount = patterns.filter((p) => p.autoWarn).length;
    if (warnCount > 0) kv('Active warnings', `${warnCount}`, $.yellow);
  } catch (err) {
    console.warn('[Catch]', err);
    kv('Status', 'Not initialized', $.dim);
  }

  console.log(
    `\n  ${$.dim}Reset: ${$.cyan}commander experience reset${$.reset}${$.dim} [--skills|--patterns|--meta] [--force]${$.reset}\n`,
  );
}

// ============================================================================
// Reset
// ============================================================================

async function doReset(flags: Record<string, string>): Promise<void> {
  const resetAll = !flags['skills'] && !flags['patterns'] && !flags['meta'];
  const resetSkills = !!flags['skills'] || resetAll;
  const resetPatterns = !!flags['patterns'] || resetAll;
  const resetMeta = !!flags['meta'] || resetAll;
  const force = !!flags['force'];

  console.log(
    `\n  ${$.cyan}${$.bold}╭────────────────────────────────────────────────────╮${$.reset}`,
  );
  console.log(
    `  ${$.cyan}${$.bold}│${$.reset}  ${$.bold}Commander Experience Reset${$.reset}                         ${$.cyan}${$.bold}│${$.reset}`,
  );
  console.log(
    `  ${$.cyan}${$.bold}╰────────────────────────────────────────────────────╯${$.reset}`,
  );

  if (resetAll) {
    console.log(`\n  ${$.yellow}${$.bold}⚠  This will reset ALL learned experience:${$.reset}`);
    console.log(
      `  ${$.yellow}   • MetaLearner (Thompson priors, reflections, strategy scores)${$.reset}`,
    );
    console.log(`  ${$.yellow}   • Extracted skills${$.reset}`);
    console.log(`  ${$.yellow}   • Failure patterns${$.reset}`);
  } else {
    console.log(`\n  ${$.yellow}Resetting:${$.reset}`);
    if (resetSkills) console.log(`  ${$.yellow}   • Extracted skills${$.reset}`);
    if (resetPatterns) console.log(`  ${$.yellow}   • Failure patterns${$.reset}`);
    if (resetMeta) console.log(`  ${$.yellow}   • MetaLearner state${$.reset}`);
  }

  if (!force) {
    const confirmed = await readYesNo('Continue? [y/N]');
    if (!confirmed) {
      console.log(`  ${$.dim}Cancelled.${$.reset}\n`);
      return;
    }
  }

  const backups: string[] = [];
  const done = startSpinner('Backing up + resetting...');

  try {
    // Backup and reset MetaLearner
    if (resetMeta) {
      const metaPath = path.join(process.cwd(), '.commander_memory', 'meta-learner.json');
      const backup = backupFile(metaPath, 'meta-learner');
      if (backup) backups.push(backup);

      const { clearMetaLearnerState } = await import('../../selfEvolution/metaLearner');
      clearMetaLearnerState();
    }

    // Backup and reset skills
    if (resetSkills) {
      const skillsPath = path.join(
        process.cwd(),
        '.commander',
        'intelligence',
        'extracted-skills.json',
      );
      const backup = backupFile(skillsPath, 'extracted-skills');
      if (backup) backups.push(backup);

      try {
        if (fs.existsSync(skillsPath)) {
          fs.writeFileSync(skillsPath, '[]');
        }
        // Also reset in-memory SkillExtractor
        const { getSkillExtractor } = await import('../../intelligence/skillExtractor');
        getSkillExtractor()['skills'].clear();
      } catch (err) {
        console.warn('[Catch]', err);
        /* best-effort */
      }
    }

    // Backup and reset failure patterns
    if (resetPatterns) {
      const patternsPath = path.join(
        process.cwd(),
        '.commander',
        'intelligence',
        'failure-patterns.json',
      );
      const backup = backupFile(patternsPath, 'failure-patterns');
      if (backup) backups.push(backup);

      try {
        if (fs.existsSync(patternsPath)) {
          fs.writeFileSync(patternsPath, '[]');
        }
        const { getFailurePatternLearner } = await import('../../intelligence/failurePatterns');
        getFailurePatternLearner()['patterns'].clear();
      } catch (err) {
        console.warn('[Catch]', err);
        /* best-effort */
      }
    }

    done();

    console.log(`\n  ${$.green}✓${$.reset} Experience reset complete.`);
    if (backups.length > 0) {
      console.log(`  ${$.dim}Backups saved to:${$.reset}`);
      for (const b of backups) {
        console.log(`  ${$.dim}  ${b}${$.reset}`);
      }
    }
    console.log(
      `  ${$.dim}Run ${$.cyan}commander experience status${$.reset}${$.dim} to verify.${$.reset}\n`,
    );
  } catch (err) {
    done();
    console.log(
      `\n  ${$.red}Error: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`,
    );
  }
}

// ============================================================================
// Main entry point
// ============================================================================

export async function cmdExperience(args: string[], flags: Record<string, string>): Promise<void> {
  const sub = args[0];

  if (sub === 'reset') {
    return doReset(flags);
  }

  if (sub === 'status' || !sub) {
    return showStatus();
  }

  console.log(`\n  ${$.yellow}Unknown subcommand: ${sub}${$.reset}`);
  console.log(
    `  ${$.dim}Usage: commander experience [status|reset [--skills|--patterns|--meta] [--force]]${$.reset}\n`,
  );
}
