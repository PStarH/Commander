import { execSync } from 'child_process';

const SERVICE = 'commander-agnes-api';

export function getAgnesApiKey(): string | null {
  try {
    return execSync(`security find-generic-password -s "${SERVICE}" -a "agnes" -w`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function setAgnesApiKey(key: string): void {
  execSync(`security add-generic-password -s "${SERVICE}" -a "agnes" -w "${key}" -U`, {
    stdio: 'pipe',
  });
}

export function deleteAgnesApiKey(): void {
  try {
    execSync(`security delete-generic-password -s "${SERVICE}" -a "agnes"`, { stdio: 'pipe' });
  } catch {
    /* ignore if not found */
  }
}
