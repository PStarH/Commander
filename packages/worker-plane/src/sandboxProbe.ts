/**
 * WS7 §4.1 — Worker boot sandbox capability probe.
 *
 * Production workers must not claim or execute work until sandbox capability
 * has been verified. This module is called from `createWorkerService()` before
 * the worker registers with the kernel.
 *
 * Fail-closed: any probe failure throws and the worker refuses to start.
 * No Noop fallback, no in-process fallback, no auto-degradation.
 */

/**
 * Result of a sandbox capability probe.
 */
export interface SandboxProbeResult {
  ok: boolean;
  isolation: string;
  mechanism: string | null;
  reason?: string;
}

/**
 * WS7 §4.1 — Run the sandbox capability probe.
 *
 * In production, this constructs a SandboxManager (via dynamic import to keep
 * the worker-plane's static dependency surface clean) and verifies that a real
 * sandbox backend is available. If COMMANDER_SANDBOX_ISOLATION is set, the
 * probe verifies that the requested isolation family has a matching backend.
 *
 * In non-production with COMMANDER_ALLOW_NO_SANDBOX=true, the probe is skipped
 * (dev/test escape hatch).
 *
 * @throws Error if the probe fails in production — the worker must not start.
 */
export async function probeSandboxCapability(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandboxProbeResult> {
  const isProduction = env.NODE_ENV === 'production';
  const isolation = env.COMMANDER_SANDBOX_ISOLATION?.toLowerCase().trim();

  // Non-production escape hatch: skip probe if explicitly allowed.
  if (!isProduction) {
    const allowNoSandbox = env.COMMANDER_ALLOW_NO_SANDBOX?.toLowerCase();
    if (allowNoSandbox === '1' || allowNoSandbox === 'true' || allowNoSandbox === 'yes') {
      return {
        ok: true,
        isolation: isolation ?? 'none (dev bypass)',
        mechanism: null,
        reason: 'COMMANDER_ALLOW_NO_SANDBOX set in non-production — probe skipped',
      };
    }
  }

  // WS7 §3: In production, COMMANDER_ALLOW_NO_SANDBOX is a prohibited bypass.
  // We do NOT read it — the SandboxManager enforces this internally.

  // Dynamic import to avoid a static @commander/core dependency edge from
  // bootstrap.ts. The worker-plane package depends on core at runtime.
  const { SandboxManager, SandboxInitializationError } =
    (await import('@commander/core')) as typeof import('@commander/core');

  // WS7 §4.1 step 3-5: constructor throws SandboxInitializationError if no
  // sandbox backend is available (production) — the throw propagates up and
  // the worker refuses to start.
  const manager = new SandboxManager();

  // WS7 §4.1 step 3: verify the selected isolation level's backend is present.
  // hasSandbox() only checks "any sandbox available"; getSandbox() verifies
  // the isolation-match (e.g. gvisor isolation with only docker available
  // must fail-closed, not silently degrade).
  if (!manager.hasSandbox()) {
    if (isProduction) {
      throw new SandboxInitializationError(
        'WS7 §4.1: Production worker cannot start without a sandbox backend. ' +
          'Install Docker, gVisor, or a platform sandbox (seatbelt/bwrap).',
      );
    }
    return {
      ok: false,
      isolation: isolation ?? 'none',
      mechanism: null,
      reason: 'No sandbox backend available',
    };
  }

  // WS7 §4.1 step 3 (isolation-match): getSandbox() throws if the configured
  // isolation level has no matching backend (e.g. gvisor requested but only
  // docker discovered). This is the gvisor-no-degrade gate — the throw
  // propagates up and the worker refuses to start.
  const selected = manager.getSandbox().name;

  return {
    ok: true,
    isolation: isolation ?? (isProduction ? 'docker (default)' : 'auto'),
    mechanism: selected,
  };
}
