#!/usr/bin/env npx tsx
/**
 * Commander Viral Demo — "The Unbreakable Fleet"
 *
 * 85-second terminal simulation showing Commander's production reliability.
 * Fully self-contained — no API keys, no network calls, no LLM dependency.
 *
 * Run:  npm run demo
 * Record: vhs docs/viral-demo.tape
 */

if (typeof process === 'undefined') {
  throw new Error('This demo must run with Node.js');
}

// Fast-demo mode for CI/burn-in: set FAST_DEMO=1 to compress all sleeps.
const SPEED = process.env.FAST_DEMO === '1' ? 0.1 : 1;

// ── Helpers ──────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms * SPEED))));

const $ = {
  r: '\x1b[0m',
  B: '\x1b[1m',
  d: '\x1b[2m',
  red: '\x1b[31m',
  grn: '\x1b[32m',
  yel: '\x1b[33m',
  blu: '\x1b[34m',
  mag: '\x1b[35m',
  cyn: '\x1b[36m',
};

function clear() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function box(lines: string[], color = $.cyn) {
  const w = Math.max(...lines.map((l) => l.length));
  process.stdout.write(`${color}┌${'─'.repeat(w + 2)}┐${$.r}\n`);
  for (const l of lines)
    process.stdout.write(`${color}│${$.r} ${l}${' '.repeat(w - l.length + 1)}${color}│${$.r}\n`);
  process.stdout.write(`${color}└${'─'.repeat(w + 2)}┘${$.r}\n`);
}

// Prints text then waits `ms` milliseconds
async function out(t: string, ms = 0) {
  process.stdout.write(t);
  if (ms > 0) await sleep(ms);
}

// ═══════════════════════════════════════════════════════════════════
async function main() {
  // ── SCENE 1·2 [0:00-0:16] THE PAIN — Claude Code fails ──────────
  clear();
  console.log();
  box([' We all love AI agents...', '', ' until they fail at step 32 of 50.'], $.red);
  await sleep(2500);

  clear();
  await out(`\n${$.d}$ claude "migrate 50 endpoints to v2 API SDK"${$.r}\n\n`, 800);

  for (let i = 0; i < 31; i++) {
    await out(
      `  ${$.grn}✓${$.r} endpoint_${String(i + 1).padStart(2, '0')}.ts ${$.d}migrated${$.r}\n`,
      30,
    );
  }

  await out(
    `\n  ${$.red}✗${$.r} endpoint_32.ts ${$.B}${$.red}ERROR: hallucinated method 'v2.nonExistentAPI'${$.r}\n`,
    600,
  );
  for (let i = 32; i < 50; i++) {
    await out(
      `  ${$.d}?${$.r} endpoint_${String(i + 1).padStart(2, '0')}.ts ${$.d}skipped — upstream failure${$.r}\n`,
      10,
    );
  }

  console.log();
  await sleep(800);
  await out(`  ${$.d}$ npm test${$.r}\n`, 300);
  await out(`  ${$.red}FAIL  src/endpoints/endpoint_32.test.ts${$.r}\n`, 80);
  await out(`  ${$.red}FAIL  src/endpoints/endpoint_33.test.ts${$.r}\n`, 80);
  await out(`  ${$.red}... 598 more failures${$.r}\n`, 500);
  await sleep(1000);

  box([' 31/50 migrated. 19 failed.', '', ' git reset --hard', ' Start over from zero.'], $.red);
  await sleep(3000);

  // ── SCENE 3 [0:17-0:24] COMMANDER LAUNCH ─────────────────────────
  clear();
  console.log();
  box(
    [' Same task. Different infrastructure.', '', ' Commander: durable execution for AI.'],
    $.grn,
  );
  await sleep(2500);

  clear();
  await out(
    `\n${$.B}${$.grn}$ commander swarm "${$.r}${$.B}migrate 50 endpoints to v2 SDK${$.grn}" --stream${$.r}\n\n`,
    500,
  );
  await sleep(600);

  await out(
    `  ${$.cyn}══════════════════════════════════════════════════════════════${$.r}\n`,
    200,
  );
  await out(`  ${$.B}COMMANDER FLEET DEPLOYED${$.r}\n`, 200);
  await out(`  ${$.d}Topology: HIERARCHICAL  ·  Agents: 5  ·  Mode: PARALLEL${$.r}\n`, 200);
  await out(
    `  ${$.cyn}══════════════════════════════════════════════════════════════${$.r}\n\n`,
    400,
  );
  await sleep(800);

  // ── SCENE 4 [0:25-0:40] PARALLEL EXECUTION ───────────────────────
  await out(`  ${$.d}Launching 5 agents in PARALLEL topology...${$.r}\n`, 600);
  await out(`  ${$.d}Files 1-31 executing concurrently.${$.r}\n\n`, 800);

  // Batch display: show groups of 5 for dramatic pacing
  for (let batch = 0; batch < 7; batch++) {
    const start = batch * 5;
    const end = Math.min(start + 5, 31);
    for (let i = start; i < end; i++) {
      await out(`  ${$.grn}✓${$.r} endpoint_${String(i + 1).padStart(2, '0')}.ts\n`, 80);
    }
    if (batch < 6) {
      const progress = Math.round((end / 50) * 100);
      await out(`  ${$.d}  ── ${end}/50 migrated (${progress}%) ──${$.r}\n`, 400);
    }
  }
  await sleep(800);

  // ── Scene transition pause ──
  await sleep(1500);

  // ── SCENE 5 [0:41-0:62] THE FAILURE & RECOVERY ───────────────────
  await out(`\n  ${$.B}${$.red}━━━━ FILE 32 FAILED ━━━━${$.r}\n`, 1000);
  await sleep(600);
  await out(`  ${$.red}🔴 [AST VERIFICATION] endpoint_32.ts${$.r}\n`, 500);
  await out(`  ${$.red}    Hallucinated method 'nonExistentAPI' detected.${$.r}\n`, 1000);
  await sleep(1200);

  // SAGA
  await out(`\n  ${$.yel}🟡 [SAGA] Localized failure. Isolating file 32...${$.r}\n`, 700);
  await sleep(500);
  await out(`  ${$.yel}🟡 [COMPENSATION] Rolling back endpoint_32.ts to clean state${$.r}\n`, 800);
  await sleep(300);
  await out(`  ${$.grn}🟢 [ROLLBACK] endpoint_32.ts → RESTORED ✓${$.r}\n`, 800);

  await sleep(600);

  // CIRCUIT BREAKER
  await out(`\n  ${$.red}🔴 [CIRCUIT BREAKER] OPEN${$.r}\n`, 500);
  await out(`  ${$.red}    2 consecutive hallucinations from OpenAI detected.${$.r}\n`, 600);
  await sleep(400);
  await out(`  ${$.blu}🔵 [FAILOVER] Switching provider... OpenAI → Anthropic Claude${$.r}\n`, 800);

  await sleep(600);

  // DLQ
  await out(`\n  ${$.d}📋 [DEAD LETTER QUEUE] Task parked — dlq_32${$.r}\n`, 500);
  await out(`  ${$.d}    Reason:  hallucinated_method_detected${$.r}\n`, 300);
  await out(`  ${$.d}    File:    endpoint_32.ts${$.r}\n`, 300);
  await out(`  ${$.d}    Status:  Other 49 agents → CONTINUING UNAFFECTED${$.r}\n`, 800);

  await sleep(800);

  // ── SCENE 6 [0:63-0:72] COMPLETION ───────────────────────────────
  await out(`\n  ${$.grn}─── Files 33-50 (provider: Claude) ───${$.r}\n`, 500);
  for (let i = 32; i < 50; i++) {
    await out(
      `  ${$.grn}✓${$.r} endpoint_${String(i + 1).padStart(2, '0')}.ts${i === 49 ? '' : '\n'}`,
      45,
    );
  }
  console.log();
  await sleep(600);

  await out(
    `\n  ${$.B}${$.cyn}══════════════════════════════════════════════════════════════${$.r}\n`,
    300,
  );
  await out(`  ${$.B}${$.grn}🏁 FLEET COMPLETE${$.r}\n`, 500);
  await out(
    `  ${$.cyn}══════════════════════════════════════════════════════════════${$.r}\n`,
    300,
  );
  console.log();
  await out(`  ${$.grn}✅ 49/50 migrated${$.r}\n`, 300);
  await out(`  ${$.yel}📋 1 in Dead Letter Queue (dlq_32)${$.r}\n`, 300);
  await out(`  ${$.grn}🔁 1 failure cleanly recovered (Saga rollback)${$.r}\n`, 300);
  await out(`  ${$.blu}🔵 Provider auto-switched: OpenAI → Anthropic${$.r}\n`, 300);
  await out(`  ${$.grn}📦 0 files corrupted${$.r}\n`, 300);
  await out(`  ${$.grn}⏱  Total time: 4m 12s${$.r}\n`, 1000);

  await sleep(3000);

  // ── Scene transition pause ──
  await sleep(2000);

  // ── SCENE 7 [0:73-0:83] RESUME ───────────────────────────────────
  clear();
  console.log();
  box(
    [
      ' Engineer fixes the prompt.',
      '',
      ' 30 seconds. Clicks REPLAY.',
      '',
      ' Commander resumes from checkpoint #32.',
      ' 31 files never re-executed.',
    ],
    $.blu,
  );
  await sleep(4000);

  clear();
  await out(`\n${$.B}${$.grn}$ commander replay dlq_32 --stream${$.r}\n\n`, 500);
  await sleep(600);

  await out(`  ${$.d}[CHECKPOINT] Loading state...${$.r}\n`, 500);
  await out(`  ${$.grn}[RESUME] Picking up exactly from file 32${$.r}\n`, 600);
  await out(`  ${$.d}[SKIP] Files 1-31: already completed ✓${$.r}\n`, 700);
  await sleep(600);

  await out(`\n  ${$.grn}🔁 Retrying endpoint_32.ts (corrected prompt)...${$.r}\n`, 800);
  await out(`  ${$.grn}✓ endpoint_32.ts migrated${$.r}\n`, 500);
  await out(`  ${$.grn}✓ AST verification passed${$.r}\n`, 400);
  await out(`  ${$.grn}✓ Quality gates: 5/5${$.r}\n`, 600);

  await sleep(500);
  await out(`\n  ${$.B}${$.grn}🏁 50/50 COMPLETE${$.r}\n`, 300);
  await out(`  ${$.grn}   Total operations: 1 (not 32)${$.r}\n`, 400);
  await out(`  ${$.grn}   Data loss: 0 files${$.r}\n`, 400);

  await sleep(3000);

  // ── SCENE 8 [0:83-0:88] BEFORE / AFTER ───────────────────────────
  clear();
  console.log();

  const left = [
    `${$.red}${$.B}  WITHOUT COMMANDER${$.r}`,
    `${$.d}┌──────────────────────────┐${$.r}`,
    `${$.d}│${$.r} 50-step AI operation   ${$.d}│${$.r}`,
    `${$.d}│${$.r}      ↓                  ${$.d}│${$.r}`,
    `${$.d}│${$.r} ${$.red}Step 32 fails${$.r}           ${$.d}│${$.r}`,
    `${$.d}│${$.r}      ↓                  ${$.d}│${$.r}`,
    `${$.d}│${$.r} ${$.red}State corrupted${$.r}        ${$.d}│${$.r}`,
    `${$.d}│${$.r}      ↓                  ${$.d}│${$.r}`,
    `${$.d}│${$.r} ${$.yel}Manual git reset${$.r}       ${$.d}│${$.r}`,
    `${$.d}│${$.r}      ↓                  ${$.d}│${$.r}`,
    `${$.d}│${$.r} ${$.yel}Start from zero${$.r}        ${$.d}│${$.r}`,
    `${$.d}│${$.r}      ↓                  ${$.d}│${$.r}`,
    `${$.d}│${$.r} ${$.red}❌ 31/50 complete${$.r}       ${$.d}│${$.r}`,
    `${$.d}└──────────────────────────┘${$.r}`,
  ];

  const right = [
    `${$.grn}${$.B}  WITH COMMANDER${$.r}`,
    `${$.grn}┌──────────────────────────┐${$.r}`,
    `│ 50-step AI operation   │`,
    `│      ↓                  │`,
    `│ Step 32 fails           │`,
    `│      ↓                  │`,
    `│ ${$.grn}Saga rolls back 32${$.r}     │`,
    `│      ↓                  │`,
    `│ ${$.grn}Auto-failover LLM${$.r}       │`,
    `│      ↓                  │`,
    `│ ${$.grn}Resume from 33${$.r}          │`,
    `│      ↓                  │`,
    `│ ${$.grn}✅ 50/50 complete${$.r}       │`,
    `${$.grn}└──────────────────────────┘${$.r}`,
  ];

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    process.stdout.write(`${l}    ${r}\n`);
    await sleep(120);
  }

  await sleep(3000);

  // ── Scene transition pause ──
  await sleep(1500);

  // ── SCENE 9 [0:88-0:91] OUTRO ────────────────────────────────────
  clear();
  console.log();
  console.log();

  // Centered title
  const title = `  ${$.B}AI agents that survive their own mistakes.${$.r}`;
  process.stdout.write(`\n\n\n${' '.repeat(15)}${title}\n\n`);
  await sleep(600);
  process.stdout.write(`${' '.repeat(25)}${$.d}commander.dev${$.r}\n\n`);
  await sleep(600);
  process.stdout.write(`${' '.repeat(15)}${$.d}github.com/PStarH/Commander${$.r}\n`);

  // Hold outro for clean recording finish — vhs captures until process exits
  await sleep(8000);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
