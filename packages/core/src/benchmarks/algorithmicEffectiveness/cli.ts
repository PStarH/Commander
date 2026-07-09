import { runComparison } from './runner';
import { generateMarkdownReport } from './reporter';
import { getModule, getAllModules, getRegisteredModuleIds } from './registry';
import { createLiveLLM } from './liveLLM';
import { createScriptedLLM } from './scriptedLLM';
import type { ComparisonOptions, BenchmarkModule } from './types';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0] as 'scripted' | 'live';
  const moduleId = args[1];

  if (!mode || (mode !== 'scripted' && mode !== 'live')) {
    console.error('Usage: tsx cli.ts <scripted|live> [moduleId]');
    console.error(`Registered modules: ${getRegisteredModuleIds().join(', ')}`);
    process.exit(1);
  }

  const modules: BenchmarkModule[] = moduleId ? [getModule(moduleId)] : getAllModules();
  const results = [];

  for (const mod of modules) {
    console.error(`Running ${mod.id} in ${mode} mode...`);
    const opts: ComparisonOptions = {
      moduleId: mod.id,
      mode,
      n: mode === 'live' ? 30 : 30,
      seed: 42,
    };
    const result = await runComparison(
      opts,
      mod,
      mode === 'live'
        ? () => createLiveLLM({ provider: 'openai', model: 'gpt-4o-mini' })
        : () => createScriptedLLM({ responses: {} }),
    );
    results.push(result);
  }

  const report = generateMarkdownReport(results);
  console.log(report);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
