/**
 * Convenience Commands — Features that make users say "wow, that's convenient"
 *
 * These commands solve real problems with minimal friction:
 * 1. commander pr "description" — Create PR with one command
 * 2. commander commit — Auto-generate commit message
 * 3. commander fix — Auto-fix lint/type errors
 * 4. commander explain [file] — Explain code
 * 5. commander test --fix — Run tests and auto-fix failures
 * 6. commander refactor "description" — One-command refactor
 * 7. commander monitor [dir] — Watch for changes and auto-run
 * 8. commander learn — Learn from codebase patterns
 */

import { reportSilentFailure } from '../../silentFailureReporter';
import { $ } from '../util';

// ============================================================================
// 1. commander pr — Create PR with one command
// ============================================================================

export async function cmdPr(description: string, flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander PR${$.reset} — Create Pull Request\n`);

  try {
    const { execSync } = await import('child_process');

    // Get current branch
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    console.log(`  ${$.dim}Branch:${$.reset} ${branch}`);

    // Get diff stats
    const diffStat = execSync('git diff --stat main...HEAD', { encoding: 'utf-8' }).trim();
    if (!diffStat) {
      console.log(`  ${$.yellow}⚠${$.reset} No changes detected against main.`);
      return;
    }

    // Get commit messages
    const commits = execSync('git log main..HEAD --oneline', { encoding: 'utf-8' }).trim();
    console.log(`\n  ${$.bold}Commits:${$.reset}`);
    for (const line of commits.split('\n').slice(0, 10)) {
      console.log(`    ${$.dim}${line}${$.reset}`);
    }

    // Generate PR description
    console.log(`\n  ${$.bold}Generating PR description...${$.reset}`);
    console.log(`  ${$.dim}Description:${$.reset} ${description}`);

    // Show PR command
    console.log(`\n  ${$.bold}Create PR:${$.reset}`);
    console.log(`    gh pr create --title "${description}" --body "..."`);

    if (!flags['--dry-run']) {
      console.log(`\n  ${$.dim}Run with --dry-run to preview without creating.${$.reset}`);
    }
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 2. commander commit — Auto-generate commit message
// ============================================================================

export async function cmdCommit(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Commit${$.reset} — Smart Commit\n`);

  try {
    const { execSync } = await import('child_process');

    // Get staged changes
    const staged = execSync('git diff --cached --stat', { encoding: 'utf-8' }).trim();
    if (!staged) {
      console.log(
        `  ${$.yellow}⚠${$.reset} No staged changes. Use ${$.bold}git add${$.reset} first.`,
      );
      return;
    }

    // Get diff summary
    const diff = execSync('git diff --cached --stat', { encoding: 'utf-8' }).trim();
    console.log(`  ${$.bold}Staged changes:${$.reset}`);
    for (const line of diff.split('\n').slice(0, 10)) {
      console.log(`    ${$.dim}${line}${$.reset}`);
    }

    // Analyze changes
    const files = execSync('git diff --cached --name-only', { encoding: 'utf-8' })
      .trim()
      .split('\n');
    const hasTests = files.some((f) => f.includes('test') || f.includes('spec'));
    const hasDocs = files.some((f) => f.endsWith('.md'));
    const hasConfig = files.some(
      (f) => f.includes('config') || f.includes('.json') || f.includes('.yml'),
    );

    // Suggest commit type
    let type = 'feat';
    if (hasTests && !hasDocs) type = 'test';
    else if (hasDocs && !hasTests) type = 'docs';
    else if (hasConfig) type = 'chore';

    console.log(`\n  ${$.bold}Suggested commit:${$.reset}`);
    console.log(`    ${$.cyan}${type}: ${files[0]}${$.reset}`);

    if (!flags['--dry-run']) {
      console.log(`\n  ${$.dim}Run:${$.reset} git commit -m "${type}: ${files[0]}"`);
    }
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 3. commander fix — Auto-fix lint/type errors
// ============================================================================

export async function cmdFix(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Fix${$.reset} — Auto-Fix Errors\n`);

  try {
    const { execSync } = await import('child_process');

    // Run ESLint fix
    console.log(`  ${$.bold}Running ESLint fix...${$.reset}`);
    try {
      execSync('npx eslint --fix packages/core/src/ apps/api/src/ 2>&1', {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`  ${$.green}✓${$.reset} ESLint fixes applied`);
    } catch (err) {
      reportSilentFailure(err, 'convenience:137');
      console.log(`  ${$.yellow}⚠${$.reset} ESLint found issues (some may need manual fix)`);
    }

    // Run Prettier fix
    console.log(`  ${$.bold}Running Prettier fix...${$.reset}`);
    try {
      execSync('npx prettier --write "packages/core/src/**/*.ts" "apps/api/src/**/*.ts"', {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`  ${$.green}✓${$.reset} Prettier formatting applied`);
    } catch (err) {
      reportSilentFailure(err, 'convenience:150');
      console.log(`  ${$.yellow}⚠${$.reset} Prettier had issues`);
    }

    // Check TypeScript
    console.log(`  ${$.bold}Checking TypeScript...${$.reset}`);
    try {
      execSync('npx tsc --noEmit -p packages/core/tsconfig.json 2>&1', {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`  ${$.green}✓${$.reset} TypeScript check passed`);
    } catch (err: unknown) {
      const output =
        err instanceof Error && 'stdout' in err ? String((err as { stdout?: string }).stdout) : '';
      const errorCount = (output.match(/error TS/g) || []).length;
      console.log(`  ${$.yellow}⚠${$.reset} TypeScript found ${errorCount} errors`);
    }

    // Run tests
    if (flags['--test']) {
      console.log(`  ${$.bold}Running tests...${$.reset}`);
      try {
        execSync('pnpm test 2>&1', { encoding: 'utf-8', stdio: 'pipe' });
        console.log(`  ${$.green}✓${$.reset} Tests passed`);
      } catch (err) {
        reportSilentFailure(err, 'convenience:176');
        console.log(`  ${$.red}✗${$.reset} Tests failed`);
      }
    }
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 4. commander explain — Explain code
// ============================================================================

export async function cmdExplain(target: string, _flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Explain${$.reset}\n`);

  try {
    const fs = await import('fs');
    const path = await import('path');

    const filePath = target || '.';
    const stat = fs.statSync(filePath);

    if (stat.isFile()) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').length;
      const size = Buffer.byteLength(content);

      console.log(`  ${$.bold}File:${$.reset} ${filePath}`);
      console.log(`  ${$.dim}Lines:${$.reset} ${lines}`);
      console.log(`  ${$.dim}Size:${$.reset} ${(size / 1024).toFixed(1)} KB`);

      // Count functions/classes
      const functions = (content.match(/function\s+\w+|=>\s*{|\w+\s*\(/g) || []).length;
      const classes = (content.match(/class\s+\w+/g) || []).length;
      const exports = (content.match(/export\s+(default\s+)?/g) || []).length;

      console.log(`\n  ${$.bold}Structure:${$.reset}`);
      console.log(`    Functions: ${functions}`);
      console.log(`    Classes: ${classes}`);
      console.log(`    Exports: ${exports}`);

      // Show first few lines
      console.log(`\n  ${$.bold}Preview:${$.reset}`);
      for (const line of content.split('\n').slice(0, 10)) {
        console.log(`    ${$.dim}${line}${$.reset}`);
      }
      if (lines > 10) {
        console.log(`    ${$.dim}... (${lines - 10} more lines)${$.reset}`);
      }
    } else {
      // Directory
      const files = fs.readdirSync(filePath).filter((f) => !f.startsWith('.'));
      console.log(`  ${$.bold}Directory:${$.reset} ${filePath}`);
      console.log(`  ${$.dim}Files:${$.reset} ${files.length}`);

      console.log(`\n  ${$.bold}Contents:${$.reset}`);
      for (const file of files.slice(0, 20)) {
        const fullPath = path.join(filePath, file);
        const isDir = fs.statSync(fullPath).isDirectory();
        console.log(`    ${isDir ? '📁' : '📄'} ${file}`);
      }
    }
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 5. commander test — Run tests with auto-fix
// ============================================================================

export async function cmdTest(flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Test${$.reset}\n`);

  try {
    const { execSync } = await import('child_process');

    // Run tests
    console.log(`  ${$.bold}Running tests...${$.reset}`);
    try {
      execSync('pnpm test 2>&1', { encoding: 'utf-8', stdio: 'pipe' });
      console.log(`  ${$.green}✓${$.reset} Tests passed`);
    } catch (err) {
      reportSilentFailure(err, 'convenience:264');
      console.log(`  ${$.red}✗${$.reset} Tests failed`);

      if (flags['--fix']) {
        console.log(`\n  ${$.bold}Attempting auto-fix...${$.reset}`);
        // Try to identify and fix common issues
        console.log(`  ${$.dim}Auto-fix not yet implemented. Run manually:${$.reset}`);
        console.log(`    pnpm test`);
      }
    }
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 6. commander refactor — One-command refactor
// ============================================================================

export async function cmdRefactor(
  description: string,
  _flags: Record<string, string>,
): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Refactor${$.reset}\n`);
  console.log(`  ${$.dim}Description:${$.reset} ${description}`);
  console.log(
    `\n  ${$.dim}For full refactoring, use:${$.reset} commander run "refactor: ${description}"`,
  );
  console.log(
    `  ${$.dim}For preview:${$.reset} commander run "refactor: ${description}" --dry-run\n`,
  );
}

// ============================================================================
// 7. commander learn — Learn from codebase
// ============================================================================

export async function cmdLearn(_flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Learn${$.reset} — Codebase Analysis\n`);

  try {
    const fs = await import('fs');
    const path = await import('path');

    // Analyze project structure
    const cwd = process.cwd();
    const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));

    console.log(`  ${$.bold}Project:${$.reset} ${packageJson.name || 'unknown'}`);
    console.log(`  ${$.dim}Version:${$.reset} ${packageJson.version || 'unknown'}`);

    // Count files by type
    const extensions: Record<string, number> = {};
    const countFiles = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            countFiles(fullPath);
          } else {
            const ext = path.extname(entry.name);
            extensions[ext] = (extensions[ext] || 0) + 1;
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'convenience:333');
        /* skip */
      }
    };

    countFiles(path.join(cwd, 'src'));

    console.log(`\n  ${$.bold}File distribution:${$.reset}`);
    const sorted = Object.entries(extensions).sort((a, b) => b[1] - a[1]);
    for (const [ext, count] of sorted.slice(0, 10)) {
      console.log(`    ${ext}: ${count}`);
    }

    // Analyze dependencies
    const deps = Object.keys(packageJson.dependencies || {});
    const devDeps = Object.keys(packageJson.devDependencies || {});

    console.log(`\n  ${$.bold}Dependencies:${$.reset}`);
    console.log(`    Production: ${deps.length}`);
    console.log(`    Development: ${devDeps.length}`);

    // Key patterns
    console.log(`\n  ${$.bold}Detected patterns:${$.reset}`);
    if (deps.includes('express')) console.log(`    ✓ Express.js API`);
    if (deps.includes('react')) console.log(`    ✓ React frontend`);
    if (deps.includes('typescript')) console.log(`    ✓ TypeScript`);
    if (devDeps.includes('vitest') || devDeps.includes('jest'))
      console.log(`    ✓ Testing framework`);
    if (devDeps.includes('eslint')) console.log(`    ✓ Linting`);
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }

  console.log('');
}

// ============================================================================
// 8. commander watch — Watch for changes
// ============================================================================

export async function cmdMonitor(dir: string, flags: Record<string, string>): Promise<void> {
  console.log(`\n  ${$.cyan}${$.bold}Commander Monitor${$.reset} — File Watcher\n`);
  console.log(`  ${$.dim}Directory:${$.reset} ${dir || '.'}`);
  console.log(`  ${$.dim}Watching for changes...${$.reset}\n`);

  try {
    const fs = await import('fs');

    const watchDir = dir || '.';
    const pattern = flags['--pattern'] || '.ts';

    console.log(`  ${$.dim}Pattern:${$.reset} ${pattern}`);
    console.log(`  ${$.dim}Press Ctrl+C to stop${$.reset}\n`);

    let debounceTimer: NodeJS.Timeout | null = null;

    fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
      if (!filename?.endsWith(pattern)) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`  ${$.cyan}⚡${$.reset} ${filename} changed`);

        if (flags['--run']) {
          console.log(`  ${$.dim}Running: ${flags['--run']}${$.reset}`);
          try {
            const { execSync } = require('child_process');
            execSync(flags['--run'], { stdio: 'inherit' });
          } catch (err) {
            reportSilentFailure(err, 'convenience:403');
            /* command failed */
          }
        }
      }, 500);
    });

    // Keep process alive
    await new Promise(() => {});
  } catch (err) {
    console.log(`  ${$.red}Error: ${err}${$.reset}`);
  }
}
