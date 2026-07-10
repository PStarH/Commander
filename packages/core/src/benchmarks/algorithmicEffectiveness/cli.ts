import { runComparison } from './runner';
import { generateMarkdownReport } from './reporter';
import { getModule, getAllModules, getRegisteredModuleIds } from './registry';
import { createLiveLLM } from './liveLLM';
import { createScriptedLLM } from './scriptedLLM';
import type { ComparisonOptions, BenchmarkModule, LLMClient } from './types';

type Provider = 'openai' | 'anthropic';

function detectProvider(): Provider {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error('No API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.');
}

function createLiveClient(provider: Provider): LLMClient {
  const model =
    provider === 'openai'
      ? (process.env.OPENAI_LIVE_MODEL ?? 'gpt-4o-mini')
      : (process.env.ANTHROPIC_LIVE_MODEL ?? 'claude-3-5-haiku-latest');
  return createLiveLLM({ provider, model });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0] as 'scripted' | 'live';
  const providerArg = args[1] as Provider | undefined;
  const moduleId = args[2];

  if (!mode || (mode !== 'scripted' && mode !== 'live')) {
    console.error('Usage: tsx cli.ts <scripted|live> [openai|anthropic] [moduleId]');
    console.error(`Registered modules: ${getRegisteredModuleIds().join(', ')}`);
    process.exit(1);
  }

  const provider = mode === 'live' ? (providerArg ?? detectProvider()) : undefined;
  if (mode === 'live') {
    console.error(`Using live provider: ${provider}`);
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
        ? () => createLiveClient(provider as Provider)
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
