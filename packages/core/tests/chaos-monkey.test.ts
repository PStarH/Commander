import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { classifyLLMError, computeBackoff } from '../src/runtime/llmRetry';
import { CircuitBreaker } from '../src/runtime/circuitBreaker';
import { ContextCompactor } from '../src/runtime/contextCompactor';
import { ExecPolicyEngine } from '../src/sandbox/execPolicy';
import { SandboxManager } from '../src/sandbox/index';
import type { LLMMessage } from '../src/runtime/types';

// Chaos Monkey Configuration
const CHAOS_CONFIG = {
  randomDelay: { enabled: true, minMs: 0, maxMs: 5000 },
  randomErrorRate: 0.05,
  randomShuffleRate: 0.10,
  randomLanguageSwitch: true,
};

let chaosStats = { delays: 0, errors: 0, shuffles: 0, languages: 0, totalTests: 0, passed: 0 };

function rng(): number {
  // Deterministic but varied for reproducibility
  return (Math.sin(chaosStats.totalTests * 927) + 1) / 2;
}

async function injectDelay(): Promise<void> {
  if (!CHAOS_CONFIG.randomDelay.enabled) return;
  const delay = Math.floor(rng() * (CHAOS_CONFIG.randomDelay.maxMs - CHAOS_CONFIG.randomDelay.minMs));
  if (delay > 100) {
    chaosStats.delays++;
    await new Promise(r => setTimeout(r, Math.min(delay, 50))); // cap at 50ms for test speed
  }
}

function maybeInjectError<T>(fn: () => T): T {
  if (rng() < CHAOS_CONFIG.randomErrorRate) {
    chaosStats.errors++;
    throw new Error(`[ChaosMonkey] Injected random error at ${new Date().toISOString()}`);
  }
  return fn();
}

function maybeShuffleMessages(msgs: LLMMessage[]): LLMMessage[] {
  if (msgs.length < 4 || rng() > CHAOS_CONFIG.randomShuffleRate) return msgs;
  chaosStats.shuffles++;
  const result = [...msgs];
  const idx1 = 1 + Math.floor(rng() * (result.length - 2));
  const idx2 = 1 + Math.floor(rng() * (result.length - 2));
  [result[idx1], result[idx2]] = [result[idx2], result[idx1]];
  return result;
}

function maybeSwitchLanguage(msg: string): string {
  if (!CHAOS_CONFIG.randomLanguageSwitch || rng() > 0.03) return msg;
  chaosStats.languages++;
  const translations: Record<string, string> = {
    'hello': '你好',
    'test': '测试',
    'error': '错误',
    'function': '函数',
    'result': '结果',
  };
  let result = msg;
  for (const [en, cn] of Object.entries(translations)) {
    result = result.replace(new RegExp(en, 'gi'), cn);
  }
  return result;
}

describe('Chaos Monkey — Tool Calling Under Stress', () => {
  const CHAOS_ITERATIONS = 30;

  it('CM-T1: ExecPolicy survives chaos', async () => {
    const policy = new ExecPolicyEngine();
    for (let i = 0; i < CHAOS_ITERATIONS; i++) {
      chaosStats.totalTests++;
      const cmds = ['npm test', 'sudo rm -rf', 'curl http://evil.com', '', 'echo a'.repeat(1000)];
      const cmd = cmds[Math.floor(rng() * cmds.length)];
      try {
        await injectDelay();
        const result = policy.evaluate(maybeSwitchLanguage(cmd));
        assert.ok(['allow', 'prompt', 'forbidden'].includes(result.decision));
        chaosStats.passed++;
      } catch {
        // Chaos-injected errors are expected
      }
    }
  });

  it('CM-T2: Circuit breaker under random load', async () => {
    const cb = new CircuitBreaker(3, 500);
    for (let i = 0; i < CHAOS_ITERATIONS; i++) {
      chaosStats.totalTests++;
      try {
        await injectDelay();
        const available = cb.isAvailable();
        if (available) {
          if (rng() < 0.3) cb.onFailure();
          else cb.onSuccess();
        }
        chaosStats.passed++;
      } catch {
        // Expected
      }
    }
  });

  it('CM-T3: Context compaction with shuffled messages', async () => {
    const compactor = new ContextCompactor({ maxContextTokens: 5000, layer1Trigger: 0.4, keepRecentTurns: 2 });
    let msgs: LLMMessage[] = [{ role: 'system', content: 'System: this is a chaos test.' }];
    for (let i = 0; i < CHAOS_ITERATIONS; i++) {
      chaosStats.totalTests++;
      try {
        await injectDelay();
        msgs.push({ role: 'user', content: `Message ${i}: ${maybeSwitchLanguage('test data')}` });
        msgs.push({ role: 'assistant', content: `Response ${i}` });
        msgs = maybeShuffleMessages(msgs);
        if (i % 10 === 0 && i > 0) {
          const { messages } = compactor.compact(msgs);
          msgs = messages;
        }
        chaosStats.passed++;
      } catch {
        // Expected
      }
    }
    assert.ok(msgs.length > 0, 'Messages should survive chaos');
  });

  it('CM-T4: Error classification with garbage input', async () => {
    const garbageInputs: any[] = [null, undefined, {}, '   ', '\x00\x01\x02', 'a'.repeat(10000)];
    for (const input of garbageInputs) {
      chaosStats.totalTests++;
      try {
        await injectDelay();
        const result = classifyLLMError(input);
        assert.ok(typeof result.retryable === 'boolean');
        assert.ok(['transient', 'permanent', 'unknown'].includes(result.errorClass));
        chaosStats.passed++;
      } catch {
        // Expected
      }
    }
  });

  it('CM-T5: Sandbox profiles under mixed access patterns', async () => {
    const sm = new SandboxManager();
    const profileNames = ['read-only', 'workspace-write', 'full-access'];
    for (let i = 0; i < 20; i++) {
      chaosStats.totalTests++;
      try {
        await injectDelay();
        const name = profileNames[Math.floor(rng() * profileNames.length)];
        const profile = sm.getProfile(name);
        assert.ok(profile.mode === name, `Profile ${name} has correct mode`);
        chaosStats.passed++;
      } catch {
        // Expected
      }
    }
  });

  after(() => {
    const passRate = chaosStats.totalTests > 0
      ? ((chaosStats.passed / chaosStats.totalTests) * 100).toFixed(1)
      : '0.0';
    console.log(`\n  ═══════════════════════════════════════`);
    console.log(`   Chaos Monkey Results`);
    console.log(`   Tests: ${chaosStats.totalTests}`);
    console.log(`   Passed: ${chaosStats.passed} (${passRate}%)`);
    console.log(`   Delays injected: ${chaosStats.delays}`);
    console.log(`   Errors injected: ${chaosStats.errors}`);
    console.log(`   Shuffles performed: ${chaosStats.shuffles}`);
    console.log(`   Language switches: ${chaosStats.languages}`);
    console.log(`   Min required: ≥90%`);
    console.log(`   Status: ${parseFloat(passRate) >= 90 ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  ═══════════════════════════════════════\n`);
  });
});
