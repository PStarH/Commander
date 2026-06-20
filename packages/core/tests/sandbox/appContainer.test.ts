/**
 * AppContainerSB Tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AppContainerSB } from '../../src/sandbox/appContainer';

describe('AppContainerSB', () => {
  let sb: AppContainerSB;

  beforeEach(() => {
    sb = new AppContainerSB();
  });

  it('has name appcontainer', () => {
    expect(sb.name).toBe('appcontainer');
  });

  it('reports availability (false on non-Windows)', () => {
    // On macOS/Linux, AppContainer is never available
    expect(typeof sb.available).toBe('boolean');
    // On non-Windows, it should be false
    if (process.platform !== 'win32') {
      expect(sb.available).toBe(false);
    }
  });

  it('returns a result even when unavailable', async () => {
    // execute should not throw, even when unavailable
    const result = await sb.execute('echo test', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });
    expect(result).toBeDefined();
    expect(typeof result.exitCode).toBe('number');
    expect(result.sandboxMechanism).toBe('appcontainer');
  });

  it('handles empty commands gracefully', async () => {
    const result = await sb.execute('', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: [],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });
    expect(result).toBeDefined();
  });
});
