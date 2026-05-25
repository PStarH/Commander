import { detectProvider, getEffectiveModel } from '../config/commanderConfig';

// ============================================================================
// ANSI styling — zero dependencies
// ============================================================================
export const $ = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgGray: '\x1b[100m',
};

export function section(title: string) {
  console.log(`\n  ${$.bold}${$.blue}┃ ${title}${$.reset}`);
}

export function kv(key: string, value: string, valColor = '') {
  console.log(`  ${$.dim}${key}${$.reset} ${valColor}${value}${$.reset}`);
}

export function bullet(text: string, color = '') {
  console.log(`  ${color}•${$.reset} ${text}`);
}

export function cmdHeader(task: string) {
  const provider = detectProvider();
  const model = getEffectiveModel();
  const providerTag = provider ? `${provider.type} · ${model}` : 'no provider';
  console.log(`\n  ${$.bold}${$.blue}╭────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander${$.reset} ${$.dim}multi-agent orchestration${$.reset}  ${$.bold}${$.blue}│${$.reset}`);
  console.log(`  ${$.bold}${$.blue}│${$.reset}  ${$.dim}${providerTag}${$.reset}${' '.repeat(Math.max(0, 36 - providerTag.length))} ${$.bold}${$.blue}│${$.reset}`);
  console.log(`  ${$.bold}${$.blue}╰────────────────────────────────────────────╯${$.reset}`);
  console.log(`  ${$.dim}Task:${$.reset} ${task.length > 70 ? task.slice(0, 70) + '...' : task}\n`);
}

export function startSpinner(label: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r  ${$.cyan}${frames[i]}${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}`);
    i = (i + 1) % frames.length;
  }, 80);
  return () => {
    clearInterval(timer);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r  ${$.green}✓${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}\n`);
  };
}

export function onboardingMessage() {
  console.log(`\n  ${$.bold}${$.blue}╭────────────────────────────────────────────╮${$.reset}`);
  console.log(`  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Welcome to Commander${$.reset}                  ${$.bold}${$.blue}│${$.reset}`);
  console.log(`  ${$.bold}${$.blue}╰────────────────────────────────────────────╯${$.reset}`);
  console.log(`\n  To get started, set one of these environment variables:\n`);
  const vars = [
    ['OPENAI_API_KEY', 'OpenAI / DeepSeek / GLM / MiMo'],
    ['ANTHROPIC_API_KEY', 'Anthropic Claude'],
    ['GOOGLE_API_KEY', 'Google Gemini'],
    ['OPENROUTER_API_KEY', 'OpenRouter (200+ models)'],
    ['DEEPSEEK_API_KEY', 'DeepSeek (dedicated)'],
    ['ZHIPU_API_KEY', 'GLM (Zhipu AI)'],
    ['MIMO_API_KEY', 'MiMo (dedicated)'],
    ['XIAOMI_API_KEY', 'Xiaomi MiMo'],
    ['OLLAMA_HOST', 'Ollama (local) — http://localhost:11434/v1'],
    ['VLLM_BASE_URL', 'vLLM (local) — http://localhost:8000/v1'],
    ['CO_API_KEY', 'Cohere'],
    ['MISTRAL_API_KEY', 'Mistral AI'],
    ['GROQ_API_KEY', 'Groq (fast inference)'],
    ['TOGETHER_API_KEY', 'Together AI'],
    ['PERPLEXITY_API_KEY', 'Perplexity'],
    ['FIREWORKS_API_KEY', 'Fireworks AI'],
    ['REPLICATE_API_TOKEN', 'Replicate'],
    ['AWS_ACCESS_KEY_ID', 'AWS Bedrock (+ AWS_SECRET_ACCESS_KEY)'],
  ];
  for (const [key, desc] of vars) {
    console.log(`    ${$.cyan}${key.padEnd(22)}${$.reset} ${$.dim}${desc}${$.reset}`);
  }
  console.log(`\n  ${$.dim}Example:${$.reset}`);
  console.log(`    ${$.gray}$ export OPENAI_API_KEY=sk-...${$.reset}`);
  console.log(`    ${$.gray}$ commander "Hello, world!"${$.reset}\n`);
}

// ============================================================================
// Config — Multi-Provider Support
// ============================================================================

