import { reportSilentFailure } from '../silentFailureReporter';
import { execFileSync } from 'child_process';

const SERVICE = 'commander-agnes-api';

export function getAgnesApiKey(): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', 'agnes', '-w'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    reportSilentFailure(err, 'keychain:12');
    return null;
  }
}

export function setAgnesApiKey(key: string): void {
  execFileSync(
    'security',
    ['add-generic-password', '-s', SERVICE, '-a', 'agnes', '-w', key, '-U'],
    { stdio: 'pipe' },
  );
}

export function deleteAgnesApiKey(): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', 'agnes'], {
      stdio: 'pipe',
    });
  } catch (err) {
    reportSilentFailure(err, 'keychain:31');
    /* ignore if not found */
  }
}
