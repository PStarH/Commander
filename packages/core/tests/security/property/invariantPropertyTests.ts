import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { combineTaint, canFlow } from '../../../src/security/taintTracker';
import { preCheckSandboxEscape } from '../../../src/security/sandboxEscapeDetector';
import type { SandboxProfile } from '../../../src/sandbox/types';
import { assertNamespaced } from '../../../src/memory/namespaceGuard';

const NUM_RUNS = Number(process.env.COMMANDER_PROPERTY_TEST_NUM_RUNS) || 100;

// Minimal profile for the detector — preCheckSandboxEscape only reads a subset
// of fields. Tightened to a real object literal once exact required fields
// are verified at implementation time.
const FIXED_PROFILE = {
  networkMode: 'none',
  filesystem: 'readonly',
} as unknown as SandboxProfile;

describe('Security invariant property tests', () => {
  // ── Taint Algebra (live — exercises existing taintTracker.ts) ──

  it('combineTaint is commutative', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('trusted', 'untrusted', 'external'),
        fc.constantFrom('trusted', 'untrusted', 'external'),
        (a, b) => combineTaint(a, b) === combineTaint(b, a),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('combineTaint is associative', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('trusted', 'untrusted', 'external'),
        fc.constantFrom('trusted', 'untrusted', 'external'),
        fc.constantFrom('trusted', 'untrusted', 'external'),
        (a, b, c) => combineTaint(a, combineTaint(b, c)) === combineTaint(combineTaint(a, b), c),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('combineTaint: most restrictive wins', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('trusted', 'untrusted', 'external'),
        fc.constantFrom('trusted', 'untrusted', 'external'),
        (a, b) => {
          const r = combineTaint(a, b);
          const order = { trusted: 0, untrusted: 1, external: 2 };
          return order[r] === Math.max(order[a], order[b]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('combineTaint: trusted is identity', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('trusted', 'untrusted', 'external'),
        (a) => combineTaint(a, 'trusted') === a,
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // ── SANDBOX-001 (live — exercises existing sandboxEscapeDetector.ts) ──

  it('SANDBOX-001: escape patterns are blocked', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'nsenter --target 1',
          'nsenter --mount=proc',
          'setns 1234',
          'insmod evil.ko',
          'modprobe evil',
          'capsh --cap=CAP_SYS_ADMIN',
          'dd if=/dev/mem',
          'docker run --privileged',
          'docker run -v /:/host',
          '/proc/1/root',
          '/var/run/docker.sock',
        ),
        (cmd) => {
          const result = preCheckSandboxEscape(cmd, FIXED_PROFILE);
          return result.blocked === true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // ── MEMORY-001 (live — exercises assertNamespaced, G10) ──

  it('MEMORY-001: cross-namespace writes are rejected unless ACL grants them', () => {
    fc.assert(
      fc.property(
        fc.record({
          writerId: fc.string({ minLength: 1 }).filter((s) => !s.includes('/')),
          targetPath: fc.string({ minLength: 1 }),
          aclNamespaces: fc.array(fc.string()),
        }),
        ({ writerId, targetPath, aclNamespaces }) => {
          const writerNs = `agents/${writerId}`;
          const inOwnNs = targetPath.startsWith(writerNs);
          const aclGrants = aclNamespaces.some((ns) => targetPath.startsWith(ns));
          const aclGrantsTasks = aclNamespaces.includes('tasks') && targetPath.startsWith('tasks/');
          const shouldAllow = inOwnNs || aclGrants || aclGrantsTasks;

          try {
            assertNamespaced(writerId, targetPath, { role: 'test', namespaces: aclNamespaces });
            return shouldAllow;
          } catch {
            return !shouldAllow;
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // ── FLOW-001 (live — exercises canFlow() from taintTracker.ts, G2) ──

  it('FLOW-001: untrusted data cannot flow to system_prompt', () => {
    // Exercises the existing canFlow() from taintTracker.ts — this property
    // holds regardless of whether the taint plugin is enabled.
    fc.assert(
      fc.property(fc.constantFrom('trusted', 'untrusted', 'external'), (taint) => {
        const result = canFlow(taint, 'system_prompt');
        if (taint === 'trusted') return result.allowed === true;
        return result.allowed === false;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
