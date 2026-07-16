/**
 * P2: SSH backend must enforce ExecPolicy; prompt/forbidden both deny auto-exec.
 */
import { describe, it, expect } from 'vitest';
import { SSHBackend } from '../../src/sandbox/backends/sshBackend';

describe('SSHBackend ExecPolicy gate', () => {
  const backend = new SSHBackend({
    host: '192.0.2.1',
    user: 'nobody',
    connectTimeoutMs: 1000,
  });

  it('rejects forbidden commands without spawning ssh', async () => {
    const result = await backend.execute('rm -rf /', undefined, 2);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Rejected by ExecPolicy/);
    expect(result.stderr).toMatch(/forbidden/i);
    expect(result.durationMs).toBeLessThan(500);
  });

  it('rejects prompt decisions (SSH has no interactive approval path)', async () => {
    const result = await backend.execute('curl http://example.com', undefined, 2);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Rejected by ExecPolicy \(prompt\)/);
    expect(result.durationMs).toBeLessThan(500);
  });

  it('rejects command substitution classified as prompt', async () => {
    const result = await backend.execute('echo $(whoami)', undefined, 2);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Rejected/);
  });

  it('rejects pipes even when ExecPolicy allow-matches a safe prefix', async () => {
    const result = await backend.execute('echo hi | bash', undefined, 2);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/shell metacharacters/);
    expect(result.durationMs).toBeLessThan(500);
  });
});
