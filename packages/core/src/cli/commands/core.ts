import { TELOSOrchestrator } from '../../telos/telosOrchestrator';
import { UltimateOrchestrator } from '../../ultimate/orchestrator';
import { SSEStream } from '../../runtime/sseStream';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { deliberateWithLLM, deliberate } from '../../ultimate/deliberation';
import { classifyEffortLevel } from '../../ultimate/effortScaler';
import { getGlobalLogger } from '../../logging';
import { CompanyEngine } from '../../company';
import { detectProvider } from '../../config/commanderConfig';
import { createRuntime, loadTools, $, section, kv, bullet, cmdHeader, startSpinner, onboardingMessage } from './_shared';

export async function cmdPlan(task: string) {
  cmdHeader(task);
  const done = startSpinner('Analyzing task...');
  const runtime = createRuntime();
  const provider = runtime?.getProvider('openai')
    ?? runtime?.getProvider('anthropic')
    ?? runtime?.getProvider('openrouter')
    ?? runtime?.getProvider('mimo')
    ?? runtime?.getProvider('deepseek')
    ?? runtime?.getProvider('glm')
    ?? runtime?.getProvider('xiaomi')
    ?? runtime?.getProvider('google');
  const plan = runtime
    ? await deliberateWithLLM(task, provider ?? runtime.getProvider('openai')!)
    : deliberate(task);
  const effort = classifyEffortLevel(task);
  done();

  section('PLAN');
  bullet(`${plan.taskType} · ${effort} effort · ${plan.recommendedTopology} topology`, $.cyan);
  console.log();
  kv('Agents', `${plan.estimatedAgentCount}`, $.yellow);
  kv('Steps', `${plan.estimatedSteps}`, $.yellow);
  kv('Confidence', `${(plan.confidence * 100).toFixed(0)}%`, plan.confidence > 0.7 ? $.green : $.yellow);
  kv('External info', plan.requiresExternalInfo ? 'Yes' : 'No', plan.requiresExternalInfo ? $.yellow : $.dim);
  kv('Tokens', `${plan.estimatedTokens.toLocaleString()} (think: ${plan.tokenBudget.thinking.toLocaleString()}, exec: ${plan.tokenBudget.execution.toLocaleString()})`);

  if (plan.capabilitiesNeeded.length > 0) {
    section('NEEDS');
    for (const cap of plan.capabilitiesNeeded) {
      bullet(cap);
    }
  }
}

export async function cmdRun(task: string) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
    return;
  }

  cmdHeader(task);
  const rt: AgentRuntime = runtime;
  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  let lastPhase = '';
  const startTime = Date.now();

  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    goal: task,
    contextData: { availableTools: loadTools(), governanceProfile: { riskLevel: 'LOW' } },
    onProgress: (phase, detail) => {
      if (phase === 'COMPLETE') return;
      if (phase !== lastPhase) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const icons: Record<string, string> = {
          INIT: '📋', DELIBERATION: '🧠', EFFORT_SCALING: '📊',
          TOPOLOGY_ROUTING: '🔀', DECOMPOSITION: '📦', TEAM_FORMATION: '👥',
          EXECUTION: '⚡', SYNTHESIS: '🔗',
        };
        console.log(`  ${$.dim}[${elapsed}s]${$.reset} ${icons[phase] || ' '} ${$.bold}${phase}${$.reset} ${$.dim}${detail.slice(0, 70)}${$.reset}`);
        lastPhase = phase;
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();

  section('RESULTS');
  const icon = result.status === 'SUCCESS' ? '✅' : result.status === 'PARTIAL' ? '⚠️' : '❌';
  const statusColor = result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red;
  console.log(`  ${icon} ${statusColor}${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s · ${result.metrics.totalTokens.toLocaleString()} tok · $${result.metrics.totalCostUsd.toFixed(4)}${$.reset}`);

  if (result.status !== 'SUCCESS' && result.errors.length > 0) {
    console.log();
    for (const err of result.errors) {
      console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
    }
  }

  if (result.synthesis) {
    const preview = result.synthesis.split('\n').filter(l => l.trim()).slice(0, 8).join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.synthesis.split('\n').filter(l => l.trim()).length;
    if (totalLines > 8) console.log(`  ${$.dim}... (${totalLines - 8} more lines)${$.reset}`);
  }
  console.log();
}

export async function cmdWatch(task: string) {
  const runtime = createRuntime();
  if (!runtime) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
    return;
  }
  const rt: AgentRuntime = runtime;

  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  cmdHeader(task);

  const sse = new SSEStream();
  sse.onEvent((event) => {
    try {
      const data = JSON.parse(event.replace(/^data: /, '').trim());
      const ts = new Date(data.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const icons: Record<string, string> = {
        'agent.started': '▶️', 'agent.completed': '✅', 'agent.failed': '❌',
        'agent.message': '💬', 'system.alert': '⚠️', 'tool.executed': '🔧',
      };
      const icon = icons[data.topic] || '📡';
      const payload = typeof data.payload === 'object' ? JSON.stringify(data.payload).slice(0, 80) : String(data.payload ?? '').slice(0, 80);
      console.log(`  ${$.dim}${ts}${$.reset} ${icon} ${$.bold}${data.topic}${$.reset} ${$.dim}${payload}${$.reset}`);
    } catch (err) {
      getGlobalLogger().debug('CLI', 'Failed to parse SSE event', { error: err instanceof Error ? err.message : String(err) });
    }
  });

  console.log();

  const startTime = Date.now();
  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    goal: task,
    contextData: {
      availableTools: loadTools(),
      governanceProfile: { riskLevel: 'LOW' },
    },
  });

  sse.close();

  section('COMPLETE');
  const statusColor = result.status === 'SUCCESS' ? $.green : $.red;
  kv('Status', result.status, statusColor);
  kv('Duration', `${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log();
}

export async function cmdCompany(task: string) {
  const runtime = createRuntime();
  if (!runtime) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No API key found.\n`);
    onboardingMessage();
    process.exit(1);
  }

  cmdHeader(task);
  const engine = new CompanyEngine();
  engine.start();

  const done = startSpinner('Running company mode...');
  const result = await engine.submit(task, 'analysis', 'commander-cli');
  done();

  section('REVIEW');
  const passed = result.review.passed;
  console.log(`  ${passed ? '✅' : '❌'} ${$.bold}${passed ? 'Passed' : 'Failed'}${$.reset}  ${$.dim}score: ${(result.review.score * 100).toFixed(0)}%${$.reset}`);
  if (result.review.issues.length > 0) {
    console.log();
    for (const issue of result.review.issues) {
      bullet(issue, $.yellow);
    }
  }
  console.log();
  engine.stop();
}
