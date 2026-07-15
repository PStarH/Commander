const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');

/**
 * Pre-allocate a free TCP port on 127.0.0.1 via node:net.
 *
 * We cannot simply pass `PORT=0` to the spawned server because
 * `apps/api/src/index.ts` prints `API listening on http://localhost:${port}`
 * with the env-derived value, so the banner would advertise `localhost:0`,
 * masking the OS-assigned bound port. Instead we ask the kernel for a free
 * port here, then pass it explicitly — same isolation semantics, observable
 * port for `/health` polling.
 *
 * The `close()`/`spawn()` TOCTOU window is mitigated by the surrounding
 * retry loop in `startServer`; this function just returns whatever port the
 * kernel currently reports free.
 */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr.port !== 'number') {
        srv.close();
        reject(new Error('Failed to allocate a free port'));
        return;
      }
      const { port: freePort } = addr;
      srv.close((err) => (err ? reject(err) : resolve(freePort)));
    });
    srv.on('error', reject);
  });
}

const STARTUP_TIMEOUT_MS = 10000;
const HEALTH_POLL_MS = 150;
const SPAWN_RETRY_ATTEMPTS = 4;
const STOP_CLOSE_TIMEOUT_MS = 2000;
const STDERR_HEAD_CHARS = 1500;
const STDERR_TAIL_CHARS = 1500;
// `formatStderrSnippet` falls back to returning the entire trimmed buffer when
// the captured length is at or below this threshold. Derived from `STDERR_*_CHARS`
// so the two tune together.
const STDERR_USE_FULL_THRESHOLD_CHARS = STDERR_HEAD_CHARS + STDERR_TAIL_CHARS;

/**
 * Spawn the API server in an isolated workspace.
 *
 * - `cwd` points at a fresh tmp dir so every `process.cwd()`-relative file
 *   path inside the server (notably `.commander_traces` in observability and
 *   `.commander/sagas` in sagaEndpoints) is unique to this launcher.
 * - argv uses the absolute path to `dist/index.js` so the entry point still
 *   loads even though cwd is no longer the apps/api project root.
 * - PORT is pre-allocated to a free port (see `getFreePort`).
 *
 * Retries on `EADDRINUSE` (kernel handed out a port that another racing launch
 * took back before our `spawn`) and on early child exit before `/health`
 * responds, up to SPAWN_RETRY_ATTEMPTS times. Per-attempt stderr is captured
 * and included in the final error message when all attempts fail.
 *
 * IMPORTANT: stores constructed at apps/api startup (WarRoomStore in store.ts:81,
 * ProjectMemoryStore in memoryStore.ts:27, AgentStateStore in agentStateStore.ts:18,
 * ActionRationaleStore in
 * actionRationale.ts:91, MemoryIndexManager in memoryIndexManager.ts:54) all
 * default their storage paths via `__dirname`-relative constants, NOT cwd.
 * Each spawned server writes to the SAME `apps/api/{data,memory,../}/...` files
 * regardless of our tmp cwd. Today this is fine because only
 * `run-context.test.js` writes through those stores during its spawned-server
 * tests, and Node's test runner gives each *file* its own process — there is
 * only one run-context file in the suite. If you add another spawner that also
 * writes through WarRoomStore in parallel, you must inject per-launcher
 * overrides via a new env var (e.g. `COMMANDER_WARROOM_FILE`), or the two
 * will corrupt each other's state. The current 50-test suite is unaffected.
 */
async function startServer(apiDir) {
  let lastError;
  for (let attempt = 1; attempt <= SPAWN_RETRY_ATTEMPTS; attempt++) {
    const tmpDir = path.join(
      os.tmpdir(),
      `commander-test-${crypto.randomBytes(8).toString('hex')}-a${attempt}`,
    );
    fs.mkdirSync(path.join(tmpDir, '.commander_traces'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.commander', 'sagas'), { recursive: true });

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    let serverProcess;
    try {
      serverProcess = spawn(process.execPath, [path.join(apiDir, 'dist', 'index.js')], {
        cwd: tmpDir,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (syncErr) {
      // Synchronous spawn failure. ENOENT/EACCES on the binary cannot recover
      // by retrying — surface the real cause immediately to the test runner
      // so operators see "spawn failure: cannot launch server binary..." rather
      // than the misleading "API server did not start after N attempts" wrapper.
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      if (syncErr.code === 'ENOENT' || syncErr.code === 'EACCES') {
        throw new Error(
          `spawn failure: cannot launch server binary (code=${syncErr.code}): ${truncateSyncErrMessage(syncErr.message)}`,
        );
      }
      lastError = `synchronous spawn failure: ${syncErr.message}`;
      continue;
    }

    // Capture stderr so failures surface diagnostic information. We take a HEAD
    // slice (`STDERR_HEAD_CHARS`) AND a TAIL slice (`STDERR_TAIL_CHARS`) so an
    // early module-load TypeError isn't hidden by a later successful banner —
    // the HEAD captures the root cause, the TAIL captures the final state.
    let stderrBuf = '';
    serverProcess.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf-8');
    });
    serverProcess.stdout.on('data', () => {});

    const exited = new Promise((resolve) => {
      serverProcess.once('exit', (code, signal) =>
        resolve({ reason: `exit code=${code} signal=${signal}` }),
      );
      // ChildProcess 'error' fires for IPC / send failures — rare but we handle.
      serverProcess.once('error', (err) =>
        resolve({ reason: `child error event: ${err.message}` }),
      );
    });

    let healthyOrExit;
    try {
      healthyOrExit = await Promise.race([waitHealthy(baseUrl), exited]);
    } catch (pollErr) {
      healthyOrExit = pollErr;
    }

    if (healthyOrExit === 'healthy') {
      return { baseUrl, serverProcess, tmpDir, port };
    }

    // Attempt failed — annotate the error with the stderr we captured so
    // repeated runs that all fail point at a single readable reason.
    const reason =
      healthyOrExit && healthyOrExit.reason
        ? healthyOrExit.reason
        : healthyOrExit instanceof Error
          ? healthyOrExit.message
          : String(healthyOrExit);
    const stderrSnippet = formatStderrSnippet(stderrBuf);
    lastError = stderrSnippet ? `${reason}\n-- child stderr --\n${stderrSnippet}` : reason;

    if (!serverProcess.killed) {
      try {
        serverProcess.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
    await new Promise((resolve) => serverProcess.once('close', resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  throw new Error(`API server did not start after ${SPAWN_RETRY_ATTEMPTS} attempts: ${lastError}`);
}

/**
 * Build a stderr snippet that always includes BOTH the start and the end of
 * the captured output. Captures a `STDERR_HEAD_CHARS` slice so early
 * module-load TypeErrors aren't hidden by a later successful banner, AND a
 * `STDERR_TAIL_CHARS` slice so the most recent error context is still visible.
 * Returns an empty string when there's nothing meaningful.
 */
function formatStderrSnippet(buf) {
  const trimmed = buf.trim();
  if (!trimmed) return '';
  if (trimmed.length <= STDERR_USE_FULL_THRESHOLD_CHARS) return trimmed;
  const elided = trimmed.length - STDERR_USE_FULL_THRESHOLD_CHARS;
  return `${trimmed.slice(0, STDERR_HEAD_CHARS)}\n... [${elided} chars elided] ...\n${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

const SYNC_ERR_MESSAGE_MAX_CHARS = 500;

/**
 * Cap synchronous-spawn `Error.message` text. Node's ENOENT messages can carry
 * a long nested `code` chain (e.g. multiple symlink hops). We only want the
 * first 500 chars for the throw surface — verbose stack traces belong in
 * stderr, not on the awaited rejection.
 */
function truncateSyncErrMessage(msg) {
  if (typeof msg !== 'string' || msg.length <= SYNC_ERR_MESSAGE_MAX_CHARS) return msg;
  return `${msg.slice(0, SYNC_ERR_MESSAGE_MAX_CHARS)}... [${msg.length - SYNC_ERR_MESSAGE_MAX_CHARS} chars elided]`;
}

async function waitHealthy(baseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return 'healthy';
    } catch {
      /* not yet listening */
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`health timeout after ${STARTUP_TIMEOUT_MS}ms`);
}

/**
 * Tear down the server: SIGKILL + await child close + remove tmp cwd.
 *
 * SIGKILL (not SIGTERM) is intentional: apps/api's `gracefulShutdown` waits
 * for in-flight `fetch` keep-alive sockets to drain, which can hang the
 * process for ~10 s. We don't need a clean shutdown for tests because
 * the tmp workspace is throwaway.
 *
 * Defensive ordering: the close-event listener is attached BEFORE any kill so
 * we cannot lose the event when the child exits very quickly (e.g. if it
 * crashed during a test). A `STOP_CLOSE_TIMEOUT_MS` safety timer guarantees
 * `stopServer` always resolves even in pathological cases — and we log to
 * stderr so a real `'close'`-never-fires bug surfaces loudly during CI
 * investigations rather than getting silently masked.
 */
async function stopServer(context) {
  if (context && context.serverProcess) {
    const child = context.serverProcess;
    await new Promise((resolve) => {
      let settled = false;
      const finish = (viaTimer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (viaTimer) {
          // Surface this loudly during CI triage — port + pid help correlate
          // the timeout to the specific launcher that failed to drain stdio.
          // eslint-disable-next-line no-console
          console.error(
            `[spawnServer] stopServer: child 'close' event did not fire within ${STOP_CLOSE_TIMEOUT_MS}ms, forcing cleanup (port=${context.port ?? 'unknown'} pid=${child.pid ?? 'unknown'})`,
          );
        }
        resolve();
      };
      child.once('close', () => finish(false));
      const timer = setTimeout(() => finish(true), STOP_CLOSE_TIMEOUT_MS);
      timer.unref();
      if (!child.killed && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          finish(false);
        }
      } else {
        finish(false);
      }
    });
  }
  if (context && context.tmpDir) {
    try {
      fs.rmSync(context.tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

module.exports = { startServer, stopServer };
