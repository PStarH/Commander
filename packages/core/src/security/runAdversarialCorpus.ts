/**
 * runAdversarialCorpus — CLI entry point for generating and testing
 * adversarial attack variants using LLM-as-attacker.
 *
 * Usage:
 *   npx tsx packages/core/src/security/runAdversarialCorpus.ts                       # Default config
 *   npx tsx packages/core/src/security/runAdversarialCorpus.ts --corpus-size=20       # Limit variants
 *   npx tsx packages/core/src/security/runAdversarialCorpus.ts --budget=2.00          # Lower budget cap
 *   npx tsx packages/core/src/security/runAdversarialCorpus.ts --model=claude-haiku   # Use Claude
 *   npx tsx packages/core/src/security/runAdversarialCorpus.ts --report-gaps          # File GitHub issues
 *   npx tsx packages/core/src/security/runAdversarialCorpus.ts --dry-run             # Generate only, no test
 */

import { AdversarialLLMAttacker, type AttackerConfig } from './adversarialAttacker';
import {
  ATTACK_SCENARIOS,
  RedTeamFramework,
  createComprehensiveDefender,
} from './redTeamFramework';
import { reportNovelMissedAttacks } from './gapDiscovery';
import type { RedTeamTestResult, RedTeamTestScenario } from './redTeamFramework';
import { getGlobalLogger } from '../logging';

function getArg(name: string, fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split('=')[1] ?? fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const logger = getGlobalLogger();
  const apiKey = process.env.COMMANDER_ADVERSARIAL_API_KEY;
  if (!apiKey) {
    console.error(
      '❌ COMMANDER_ADVERSARIAL_API_KEY environment variable is not set.\n' +
        '   Set it to an OpenAI or Anthropic API key to enable LLM-as-attacker.\n' +
        '   See docs/security/external-redteam-scope.md for budget policy.',
    );
    process.exit(2);
  }

  const model = getArg('model', 'gpt-4o-mini') as 'gpt-4o-mini' | 'claude-haiku';
  if (model !== 'gpt-4o-mini' && model !== 'claude-haiku') {
    console.error(`❌ Unsupported model: ${model}. Use gpt-4o-mini or claude-haiku.`);
    process.exit(2);
  }

  const config: AttackerConfig = {
    apiKey,
    attackerModel: model,
    maxTokensPerRun: 10_000,
    maxCorpusSize: parseInt(getArg('corpus-size', '50'), 10),
    weeklyBudgetUsd: parseFloat(getArg('budget', '5.00')),
  };

  const dryRun = hasFlag('dry-run');
  const reportGaps = hasFlag('report-gaps');

  console.log('\n🗡️  Commander Adversarial Corpus Generator');
  console.log('───────────────────────────────────────────────');
  console.log(`  Model:       ${config.attackerModel}`);
  console.log(`  Corpus size: ${config.maxCorpusSize}`);
  console.log(`  Budget cap:  $${config.weeklyBudgetUsd.toFixed(2)}`);
  console.log(`  Mode:        ${dryRun ? 'dry-run (generate only)' : 'generate + test'}`);
  console.log('');

  // 1. Build baseline from existing attack scenarios
  const baseline = ATTACK_SCENARIOS.map((s) => ({
    id: s.id,
    payload: s.payload,
    category: s.category,
  }));
  console.log(`📋 Baseline: ${baseline.length} scenarios`);

  // 2. Generate adversarial corpus
  const attacker = new AdversarialLLMAttacker(config);
  const corpus = await attacker.generateCorpus(baseline);
  console.log(`✨ Generated ${corpus.length} novel attack variants`);
  if (corpus.length === 0) {
    logger.warn('adversarial-corpus', 'no variants generated — check API key and budget');
    process.exit(0);
  }

  if (dryRun) {
    console.log('\n✅ Dry-run complete. No tests executed.');
    for (const v of corpus) {
      console.log(`  - [${v.hash}] from ${v.baseId}: ${v.content.slice(0, 60)}...`);
    }
    process.exit(0);
  }

  // 3. Test corpus against red team battery
  const scenarios: RedTeamTestScenario[] = corpus.map((v) => ({
    id: `ADV-${v.hash}`,
    category: 'prompt_injection',
    name: `Adversarial variant of ${v.baseId}`,
    description: 'LLM-generated attack variant',
    payload: v.content,
    expectedDefense: 'contentScanner',
    severity: 'high',
    cvssScore: 7.5,
    tags: ['adversarial', 'auto-generated'],
  }));

  const defender = createComprehensiveDefender();
  const framework = new RedTeamFramework({ scenarios });
  console.log(`\n🔍 Testing ${scenarios.length} variants against defenses...`);
  const report = await framework.runAll(defender);

  console.log('\n───────────────────────────────────────────────');
  console.log('  Results:');
  console.log(`    🛡️  Blocked: ${report.summary.blocked}`);
  console.log(`    🔴  Missed:  ${report.summary.missed}`);
  console.log(`    ⚡  Errors:  ${report.summary.error}`);

  // 4. Report novel missed attacks via gap discovery
  const novelMissed: RedTeamTestResult[] = report.results.filter((r) => r.result === 'missed');
  if (novelMissed.length > 0) {
    console.log(`\n⚠️  ${novelMissed.length} novel missed attacks detected:`);
    for (const r of novelMissed) {
      console.log(`    - ${r.scenario.id} (CVSS ${r.scenario.cvssScore}): ${r.scenario.name}`);
    }
    if (reportGaps) {
      console.log('\n📝 Filing gap issues...');
      await reportNovelMissedAttacks(novelMissed, new Set());
      console.log(`✅ Filed ${novelMissed.length} gap issues`);
    } else {
      console.log('   (pass --report-gaps to file GitHub issues)');
    }
  } else {
    console.log('\n✅ All novel variants were blocked — defenses hold.');
  }

  process.exit(novelMissed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error running adversarial corpus:', err);
  process.exit(2);
});
