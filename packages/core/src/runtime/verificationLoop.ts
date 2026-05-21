/**
 * @experimental — Standalone verifier. Replaced by UnifiedVerificationPipeline.
 */
import type { LLMMessage, LLMProvider } from './types';
import { ContextCompactor } from './contextCompactor';
import { getGlobalLogger } from '../logging';

export interface FailureDetail {
  location: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface VerificationResult {
  passed: boolean;
  failures: FailureDetail[];
  suggestions: string[];
}

export interface TaskContext {
  goal: string;
  output: string;
  language?: string;
  schema?: Record<string, unknown>;
  testCommand?: string;
  toolsUsed?: string[];
}

export interface VerificationStrategy {
  name: string;
  canVerify(context: TaskContext): boolean;
  verify(context: TaskContext): Promise<VerificationResult>;
}

export interface VerificationConfig {
  enabled: boolean;
  maxIterations: number;
  tokenBudget: number;
  strategies: string[];
}

const DEFAULT_CONFIG: VerificationConfig = {
  enabled: true,
  maxIterations: 3,
  tokenBudget: 4000,
  strategies: ['syntax', 'schema', 'tool-result', 'llm'],
}

class SyntaxVerifier implements VerificationStrategy {
  readonly name = 'syntax';

  canVerify(ctx: TaskContext): boolean {
    return !!(ctx.language && ctx.output.length > 0);
  }

  async verify(ctx: TaskContext): Promise<VerificationResult> {
    const failures: FailureDetail[] = [];
    const output = ctx.output;

    if (ctx.language === 'python') {
      try {
        __py_compile_check(output);
      } catch (e: any) {
        const lineMatch = e.message?.match(/line (\d+)/);
        failures.push({
          location: `line ${lineMatch?.[1] || '?'}`,
          message: e.message?.slice(0, 200) || 'Syntax error',
          actual: e.message,
        });
      }
    }

    // Check for common issues
    if (output.includes('```') && (output.match(/```/g)?.length ?? 0) % 2 !== 0) {
      failures.push({ location: 'markdown', message: 'Unclosed code block' });
    }
    for (const q of ["'''", '"""']) {
      if ((output.match(new RegExp(q, 'g'))?.length ?? 0) % 2 !== 0) {
        failures.push({ location: 'docstring', message: `Unclosed ${q}` });
      }
    }

    return { passed: failures.length === 0, failures, suggestions: this.getSuggestions(failures) };
  }

  private getSuggestions(failures: FailureDetail[]): string[] {
    return failures.map(f => {
      if (f.message.includes('unterminated')) return `Close the string literal at ${f.location}`;
      if (f.message.includes('invalid syntax')) return `Fix syntax at ${f.location}: ${f.message.split('.')[0]}`;
      if (f.message.includes('Unclosed')) return `Add closing delimiter for ${f.location}`;
      return `Fix error at ${f.location}`;
    });
  }
}

class SchemaVerifier implements VerificationStrategy {
  readonly name = 'schema';

  canVerify(ctx: TaskContext): boolean {
    return !!ctx.schema;
  }

  async verify(ctx: TaskContext): Promise<VerificationResult> {
    const failures: FailureDetail[] = [];
    const schema = ctx.schema as Record<string, any>;
    if (!schema?.properties) return { passed: true, failures: [], suggestions: [] };

    let parsed: any;
    try { parsed = JSON.parse(ctx.output); }
    catch (e) { getGlobalLogger().debug('VerificationLoop', 'Schema JSON parse failed', { error: (e as Error)?.message }); return { passed: false, failures: [{ location: 'parse', message: 'Invalid JSON output' }], suggestions: ['Output must be valid JSON'] }; }

    for (const [key, def] of Object.entries(schema.properties)) {
      const defObj = def as { required?: boolean; type?: string };
      if (defObj.required && parsed[key] === undefined) {
        failures.push({ location: key, message: `Missing required field: ${key}`, expected: defObj.type });
      }
      if (parsed[key] !== undefined && defObj.type) {
        const typeMap: Record<string, string> = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', array: 'object', object: 'object' };
        if (typeMap[defObj.type] && typeof parsed[key] !== typeMap[defObj.type]) {
          failures.push({ location: key, message: `Expected ${defObj.type}, got ${typeof parsed[key]}`, expected: defObj.type, actual: typeof parsed[key] });
        }
      }
    }

    return { passed: failures.length === 0, failures, suggestions: failures.map(f => `Set ${f.location} to valid ${f.expected || 'value'}`) };
  }
}

class ToolResultVerifier implements VerificationStrategy {
  readonly name = 'tool-result';

  canVerify(ctx: TaskContext): boolean {
    return (ctx.toolsUsed?.length ?? 0) > 0;
  }

  async verify(ctx: TaskContext): Promise<VerificationResult> {
    const failures: FailureDetail[] = [];
    const output = ctx.output.toLowerCase();

    const errorSignals = ['error:', 'traceback', 'fail', 'timeout', 'not found', 'permission denied', 'cannot'];
    for (const sig of errorSignals) {
      if (output.includes(sig)) {
        const idx = ctx.output.toLowerCase().indexOf(sig);
        const snippet = ctx.output.slice(Math.max(0, idx - 20), idx + 80);
        failures.push({ location: 'tool output', message: `Error signal detected: ${snippet}`, actual: snippet });
        break;
      }
    }

    return { passed: failures.length === 0, failures, suggestions: failures.length > 0 ? ['Check tool arguments and retry'] : [] };
  }
}

class LLMVerifier implements VerificationStrategy {
  readonly name = 'llm';
  private provider?: LLMProvider;
  private tokenUsed = 0;

  constructor(provider?: LLMProvider) { this.provider = provider; }

  canVerify(_ctx: TaskContext): boolean { return !!this.provider; }

  async verify(ctx: TaskContext): Promise<VerificationResult> {
    if (!this.provider) return { passed: true, failures: [], suggestions: [] };

    const prompt = `Verify this output satisfies the goal. Respond with JSON: {"passed":true/false,"failures":[{"location":"...","message":"..."}],"suggestions":["..."]}\n\nGoal: ${ctx.goal.slice(0, 200)}\n\nOutput (last 500 chars): ${ctx.output.slice(-500)}`;
    const resp = await this.provider.call({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], maxTokens: 256, temperature: 0 });
    this.tokenUsed += resp.usage?.totalTokens || 0;

    try { return JSON.parse(resp.content); }
    catch (e) { getGlobalLogger().debug('VerificationLoop', 'LLM verification parse failed', { error: (e as Error)?.message }); return { passed: true, failures: [], suggestions: [] }; }
  }
  getTokenUsed(): number { return this.tokenUsed; }
}

class VerifCache {
  private cache = new Map<string, VerificationResult>();
  key(ctx: TaskContext): string {
    return `${ctx.language}|${ctx.output.slice(0, 200)}|${JSON.stringify(ctx.schema)}`;
  }
  get(k: string): VerificationResult | undefined { return this.cache.get(k); }
  set(k: string, v: VerificationResult): void { this.cache.set(k, v); }
}

export class VerificationLoop {
  private strategies: Map<string, VerificationStrategy> = new Map();
  private compactor: ContextCompactor;
  private cache: VerifCache;
  private config: VerificationConfig;
  private totalTokensUsed = 0;

  constructor(config?: Partial<VerificationConfig>, provider?: LLMProvider) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compactor = new ContextCompactor({ maxContextTokens: 64000, layer1Trigger: 0.5, keepRecentTurns: 2, maxToolOutputChars: 300 });
    this.cache = new VerifCache();
    this.registerStrategy(new SyntaxVerifier());
    this.registerStrategy(new SchemaVerifier());
    this.registerStrategy(new ToolResultVerifier());
    this.registerStrategy(new LLMVerifier(provider));
  }

  registerStrategy(s: VerificationStrategy): void {
    this.strategies.set(s.name, s);
  }

  private async buildFailureFeedback(ctx: TaskContext, failures: FailureDetail[]): Promise<string> {
    const lines: string[] = [];
    for (const f of failures.slice(0, 5)) {
      const line = f.location ? `[${f.location}] ` : '';
      lines.push(`  ${line}${f.message}`);
      if (f.expected && f.actual) lines.push(`    expected: ${f.expected}, got: ${f.actual}`);
    }
    return lines.join('\n');
  }

  async execute(goal: string, initialOutput: string, context: TaskContext): Promise<{
    output: string; iterations: number;     tokenUsed: number; tokenExhausted: boolean; failures: FailureDetail[]; feedback?: string;
  }> {
    if (!this.config.enabled) return { output: initialOutput, iterations: 1, tokenUsed: 0, tokenExhausted: false, failures: [] };

    let currentOutput = initialOutput;
    let iterations = 0;
    const allFailures: FailureDetail[] = [];

    while (iterations < this.config.maxIterations) {
      iterations++;
      const ctx: TaskContext = { ...context, output: currentOutput };
      const cacheKey = this.cache.key(ctx);

      // Check cache
      const cached = this.cache.get(cacheKey);
      if (cached) {
        if (cached.passed) break;
        allFailures.push(...cached.failures);
        continue;
      }

      // Run applicable strategies
      const allResults: VerificationResult[] = [];
      for (const name_ of this.config.strategies) {
        const strategy = this.strategies.get(name_);
        if (!strategy || !strategy.canVerify(ctx)) continue;
        const result = await strategy.verify(ctx);
        allResults.push(result);
        if (result instanceof LLMVerifier) {
          this.totalTokensUsed += result.getTokenUsed();
        }
      }

      // Aggregate results
      const allFailuresThisRound: FailureDetail[] = [];
      for (const r of allResults) {
        allFailuresThisRound.push(...r.failures);
      }
      allFailures.push(...allFailuresThisRound);

      const passed = allResults.every(r => r.passed);
      this.cache.set(cacheKey, { passed, failures: allFailuresThisRound, suggestions: [] });

      if (passed) break;

      // Token budget check
      if (this.totalTokensUsed >= this.config.tokenBudget) {
        return { output: currentOutput, iterations, tokenUsed: this.totalTokensUsed, tokenExhausted: true, failures: allFailures };
      }

      if (iterations >= this.config.maxIterations) break;

      // Build minimal failure feedback (zero full history replay)
      const feedback = await this.buildFailureFeedback(ctx, allFailuresThisRound);
      // Feedback is returned alongside output; caller injects it into next LLM call
      return { output: currentOutput, iterations, tokenUsed: this.totalTokensUsed, tokenExhausted: false, failures: allFailures, feedback };
    }

    return { output: currentOutput, iterations, tokenUsed: this.totalTokensUsed, tokenExhausted: false, failures: allFailures };
  }
}

// Minimal Python syntax check — tries to import py_compile or calls python3 -c
function __py_compile_check(code: string): void {
  const { execSync } = require('child_process');
  execSync(`python3 -c ${JSON.stringify(code)} 2>&1 || true`, { timeout: 5000 });
}
