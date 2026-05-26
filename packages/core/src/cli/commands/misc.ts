import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { TaskPool } from '../../orchestration/taskPool';
import { executeReview, formatReviewOutput, reviewReportToJson, loadReviewGuidelines } from '../../reviewAgent';
import { createRuntime, loadTools, $, section, kv, bullet, cmdHeader, startSpinner, onboardingMessage } from './_shared';

export async function cmdWorkers(topics: string[]) {
  if (topics.length === 0) {
    topics = ['LangGraph', 'CrewAI', 'AutoGen', 'MCP', 'Pydantic', 'LlamaIndex', 'Ollama', 'vLLM'];
  }

  const runtime = createRuntime();
  if (!runtime) { console.error(`  ${$.red}No provider configured${$.reset}`); process.exit(1); }

  const pool = new TaskPool(runtime, {
    maxWorkers: topics.length,
    defaultTokenBudget: 15000,
    globalTokenBudget: 300000,
    taskTimeoutMs: 120000,
  });

  const tasks = topics.map((topic, i) => ({
    id: 'worker-' + (i + 1),
    goal: 'Use browser_search to research: ' + topic + '. What is it? Key features? GitHub stars?',
    agentId: 'worker-' + (i + 1),
  }));

  console.log(`\n  ${$.bold}Spawning ${tasks.length} workers...${$.reset}\n`);
  const t0 = Date.now();
  const results = await pool.dispatch(tasks);
  const wallTime = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n  ${$.bold}Results (${wallTime}s):${$.reset}\n`);
  for (const r of results) {
    const icon = r.status === 'success' ? '✅' : '❌';
    const summary = (r.summary || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim().slice(0, 100);
    console.log(`  ${icon} ${r.taskId}: ${(r.durationMs / 1000).toFixed(1)}s, ${r.tokens} tok`);
    if (summary) console.log(`     ${summary}`);
    console.log();
  }
  const seqTime = results.reduce((s, r) => s + r.durationMs, 0) / 1000;
  console.log(`  ${$.dim}Sequential would be: ${seqTime.toFixed(1)}s | Speedup: ${(seqTime / parseFloat(wallTime)).toFixed(1)}x${$.reset}\n`);
}

export async function cmdGui() {
  section('GUI DASHBOARD');
  const apiDir = path.join(process.cwd(), 'apps', 'api');
  const webDir = path.join(process.cwd(), 'apps', 'web');

  if (!fs.existsSync(path.join(apiDir, 'src', 'index.ts'))) {
    console.log(`  ${$.red}API server not found at apps/api/${$.reset}`);
    return;
  }

  console.log(`  ${$.green}Starting API server...${$.reset}`);
  console.log(`  ${$.dim}API:${$.reset}  http://localhost:4000`);
  console.log(`  ${$.dim}Web:${$.reset}  cd apps/web && npx vite\n`);

  const api = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: apiDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: '4000' },
  });

  api.on('exit', (code: number) => {
    console.log(`\n  ${$.dim}API server exited (code ${code})${$.reset}`);
    process.exit(code ?? 0);
  });

  await new Promise(() => {});
}

export async function cmdSkill(subargs: string[]) {
  const { getSkillSystem, SkillCurator } = await import('../../skills');
  const system = getSkillSystem();

  const sub = subargs[0] || 'help';

  if (sub === 'list' || sub === 'ls') {
    const catalog = await system.manager.list();
    if (catalog.length === 0) {
      console.log(`\n  ${$.dim}No skills found.${$.reset}\n`);
      return;
    }
    section(`SKILLS (${catalog.length})`);
    for (const entry of catalog) {
      const pin = entry.pinned ? '📌' : '  ';
      const qual = (entry.qualityScore * 100).toFixed(0);
      const used = entry.usageCount;
      console.log(`  ${pin} ${$.bold}${entry.name}${$.reset} ${$.dim}${entry.description.slice(0, 50)}${$.reset}`);
      console.log(`      ${$.gray}quality: ${qual}% · uses: ${used} · ${entry.category} · [${entry.tags.join(', ')}]${$.reset}`);
    }
    console.log();
    return;
  }

  if (sub === 'view') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill view <name>\n`); return; }
    const skill = await system.manager.get(name);
    if (!skill) { console.error(`  ${$.red}Skill "${name}" not found.${$.reset}\n`); return; }
    section(`SKILL: ${skill.name}`);
    kv('Description', skill.description);
    kv('Category', skill.metadata.category);
    kv('Tags', skill.metadata.tags.join(', '));
    kv('Quality', `${(skill.metadata.qualityScore * 100).toFixed(0)}%`);
    kv('Usage', `${skill.metadata.usageCount} · success rate: ${(skill.metadata.avgSuccessRate * 100).toFixed(0)}%`);
    kv('Pinned', skill.metadata.pinned ? 'Yes' : 'No', skill.metadata.pinned ? $.green : $.dim);
    kv('Source', skill.metadata.source);
    kv('Created', skill.metadata.createdAt.slice(0, 10));
    console.log(`\n  ${$.dim}${'-'.repeat(50)}${$.reset}`);
    console.log(`  ${skill.content.slice(0, 1000)}${skill.content.length > 1000 ? '\n  ...' : ''}`);
    console.log();
    return;
  }

  if (sub === 'create') {
    const name = subargs[1];
    const desc = subargs[2] || name;
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill create <name> [description]\n`); return; }
    const content = `# ${name}\n\n${desc}\n\n## Steps\n1. TBD`;
    const skill = await system.manager.create(name, content, {
      category: 'general', tags: [], source: 'user',
    });
    console.log(`  ${$.green}✓${$.reset} Created skill "${$.bold}${skill.name}${$.reset}"\n`);
    return;
  }

  if (sub === 'pin') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill pin <name>\n`); return; }
    await system.manager.setPinned(name, true);
    console.log(`  ${$.green}✓${$.reset} Pinned "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'unpin') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill unpin <name>\n`); return; }
    await system.manager.setPinned(name, false);
    console.log(`  ${$.green}✓${$.reset} Unpinned "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = subargs[1];
    if (!name) { console.error(`  ${$.red}Usage:${$.reset} commander skill delete <name>\n`); return; }
    await system.manager.delete(name);
    console.log(`  ${$.green}✓${$.reset} Deleted "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'curate') {
    section('CURATE');
    const done = startSpinner('Running curator...');
    const curator = new SkillCurator(system.manager);
    const report = await curator.curate();
    done();
    if (report.archived.length > 0) {
      console.log(`  ${$.yellow}Archived:${$.reset} ${report.archived.join(', ')}`);
    }
    if (report.consolidated.length > 0) {
      console.log(`  ${$.yellow}Consolidated:${$.reset} ${report.consolidated.join(', ')}`);
    }
    kv('Before', `${report.totalBefore}`, $.gray);
    kv('After', `${report.totalAfter}`, $.gray);
    kv('Archived', `${report.totalArchived}`, $.yellow);
    console.log();
    return;
  }

  console.log(`
  ${$.bold}SKILL COMMANDS${$.reset}
    ${$.cyan}commander skill list${$.reset}         List all skills
    ${$.cyan}commander skill view <name>${$.reset}  View skill details
    ${$.cyan}commander skill create <name>${$.reset} Create a new skill
    ${$.cyan}commander skill pin <name>${$.reset}    Pin a skill (protect from curator)
    ${$.cyan}commander skill unpin <name>${$.reset}  Unpin a skill
    ${$.cyan}commander skill delete <name>${$.reset} Delete a skill
    ${$.cyan}commander skill curate${$.reset}        Run curator (archive+consolidate)
  `);
}

export async function cmdReview(args: string[]) {
  const scope = args.includes('--commit') ? 'commit' as const
    : args.includes('--branch') ? 'branch' as const
    : 'uncommitted' as const;

  const baseIdx = args.indexOf('--base');
  const baseRef = baseIdx >= 0 && baseIdx + 1 < args.length ? args[baseIdx + 1] : undefined;

  const commitIdx = args.indexOf('--commit');
  const commitSha = commitIdx >= 0 && commitIdx + 1 < args.length ? args[commitIdx + 1] : undefined;

  const useJson = args.includes('--json');

  const guidelines = loadReviewGuidelines();

  const customGuidelineIdx = args.indexOf('--guidelines');
  const customGuidelines = customGuidelineIdx >= 0 && customGuidelineIdx + 1 < args.length
    ? args[customGuidelineIdx + 1].split('|')
    : [];

  section('CODE REVIEW');
  bullet(`Scope: ${scope}${baseRef ? ` (base: ${baseRef})` : ''}${commitSha ? ` (commit: ${commitSha})` : ''}`);
  if (guidelines.length > 0 || customGuidelines.length > 0) {
    bullet(`Guidelines: ${[...guidelines, ...customGuidelines].length} rule(s)`);
  }
  console.log();

  const done = startSpinner('Reviewing changes...');
  try {
    const report = await executeReview({
      scope,
      baseRef,
      commitSha,
      guidelines: [...guidelines, ...customGuidelines],
      outputFormat: useJson ? 'json' : 'text',
    });
    done();

    if (useJson) {
      console.log(reviewReportToJson(report));
    } else {
      console.log(formatReviewOutput(report));
    }

    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    done();
    console.error(`\n  ${$.red}Review failed: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`);
    process.exit(1);
  }
}

export function cmdHelp() {
  console.log(`
  ${$.bold}${$.blue}╭──────────────────────────────────────────────╮${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander${$.reset} — multi-agent orchestration      ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.dim}619+ tests · 20 providers · GAIA 69.7%${$.reset}       ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}╰──────────────────────────────────────────────╯${$.reset}

  ${$.bold}GET STARTED${$.reset}
    Set an API key and run:
    ${$.gray}$ export OPENAI_API_KEY=sk-...${$.reset}
    ${$.gray}$ commander "Hello, world!"${$.reset}

  ${$.bold}COMMANDS${$.reset}
    ${$.cyan}commander <task>${$.reset}        Quick task analysis
    ${$.cyan}commander run <task>${$.reset}     Full multi-agent execution
    ${$.cyan}commander plan <task>${$.reset}    Show deliberation plan
    ${$.cyan}commander watch <task>${$.reset}   Real-time execution stream
    ${$.cyan}commander status${$.reset}         System status
    ${$.cyan}commander config${$.reset}         View / change settings
    ${$.cyan}commander doctor${$.reset}         Run diagnostics
    ${$.cyan}commander gui${$.reset}            Start the Agent War Room dashboard
    ${$.cyan}commander tui${$.reset}            Terminal dashboard (live events, sessions)
    ${$.cyan}commander workers <topics>${$.reset}  Parallel research workers
    ${$.cyan}commander company <task>${$.reset}   Company mode execution
    ${$.cyan}commander goal <task>${$.reset}      Multi-agent goal loop
    ${$.cyan}commander swarm <task>${$.reset}     Recursive swarm (fission + fusion)
    ${$.cyan}commander drive <task>${$.reset}     Autonomous drive
    ${$.cyan}commander skill${$.reset}             Manage learnable skills
    ${$.cyan}commander mode${$.reset}              Show/set approval mode
    ${$.cyan}commander review${$.reset}            Review code changes
    ${$.cyan}commander workflow${$.reset}            Schedule and run repeatable workflows
    ${$.cyan}commander history${$.reset}           List past execution sessions

  ${$.bold}OPTIONS${$.reset}
    ${$.cyan}--version${$.reset}              Show version
    ${$.cyan}--help${$.reset}                 Show this help
  `);
}
