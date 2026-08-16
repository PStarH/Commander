import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  enumerateHighWarnings,
  evaluateIndexedWarnings,
  type ScannerWarning,
  warningFingerprint,
} from './precommitScannerPolicy.js';

const highWarning: ScannerWarning = {
  severity: 'high',
  category: 'pre_scan.shell_injection',
  message: 'Backtick command execution detected',
  evidence: String.fromCharCode(96) + 'safe ${value}' + String.fromCharCode(96),
};

describe('pre-commit scanner index policy', () => {
  it('records an inherited high warning without allowing its raw evidence into the audit record', () => {
    const result = evaluateIndexedWarnings([highWarning], [highWarning]);

    assert.deepEqual(result.violations, []);
    assert.equal(result.inherited.length, 1);
    assert.match(result.inherited[0]!.fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result.inherited), /safe \$\{value\}/);
  });

  it('rejects a new high warning', () => {
    const result = evaluateIndexedWarnings([highWarning], []);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'new_high_warning');
  });

  it('rejects an additional occurrence of an inherited high warning', () => {
    const result = evaluateIndexedWarnings([highWarning, highWarning], [highWarning]);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'duplicate_high_warning');
  });

  it('never grandfathers malware or critical findings', () => {
    const malware: ScannerWarning = {
      severity: 'critical',
      category: ['mal', 'ware.', 'Reverse shell backdoor'].join(''),
      message: 'Known reverse shell',
      evidence: ['/dev', '/tcp/127.0.0.1/4444'].join(''),
    };
    const critical: ScannerWarning = {
      severity: 'critical',
      category: 'permission.file.protected_access',
      message: 'Protected path',
      evidence: '/etc/passwd',
    };

    const result = evaluateIndexedWarnings([malware, critical], [malware, critical]);

    assert.deepEqual(
      result.violations.map((violation) => violation.reason),
      ['malware_or_critical', 'malware_or_critical'],
    );
  });

  it('binds a fingerprint to warning evidence without retaining that evidence', () => {
    const fingerprint = warningFingerprint(highWarning);
    const changedEvidence = warningFingerprint({
      ...highWarning,
      evidence: String.fromCharCode(96) + 'other ${value}' + String.fromCharCode(96),
    });

    assert.notEqual(fingerprint, changedEvidence);
    assert.doesNotMatch(fingerprint, /value/);
  });

  it('enumerates repeated high warnings reported one occurrence at a time by the scanner', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] => {
      const index = content.indexOf(processCreationCall);
      return index >= 0
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    };

    const warnings = await enumerateHighWarnings(
      processCreationCall + '\n' + processCreationCall,
      scan,
    );

    assert.equal(warnings.length, 2);
  });

  it('enumerates a scanner warning whose evidence was truncated for reporting', async () => {
    const fullEvidence = ['sp', 'awn', '('].join('') + 'x'.repeat(96) + ')';
    const scan = (content: string): readonly ScannerWarning[] => {
      const index = content.indexOf(fullEvidence);
      return index < 0
        ? []
        : [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: fullEvidence.slice(0, 77) + '...',
            },
          ];
    };

    const warnings = await enumerateHighWarnings(fullEvidence, scan);

    assert.equal(warnings.length, 1);
  });

  it('uses the linked-worktree index and rejects a staged high finding under .commander', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-precommit-policy-'));
    const primary = process.cwd();
    const linked = path.join(tempRoot, 'linked');
    const fixture = path.join('.commander', 'policy-index-fixture.ts');
    const safe = "export const value = 'safe';\n";
    const high = ['sp', 'awn', '('].join('') + 'dangerous()\n';

    const git = (cwd: string, args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' });
    const runHook = () =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', path.join(primary, 'scripts', 'precommitHook.ts')],
        {
          cwd: linked,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
    const linkDependencies = () => {
      const links = [
        ['node_modules', 'node_modules'],
        [
          path.join('packages', 'core', 'node_modules'),
          path.join('packages', 'core', 'node_modules'),
        ],
      ];
      for (const [target, source] of links) {
        const destination = path.join(linked, target);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(
          path.join(primary, source),
          destination,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
    };

    try {
      git(primary, ['worktree', 'add', '--detach', linked]);
      linkDependencies();
      fs.mkdirSync(path.join(linked, '.commander'), { recursive: true });

      fs.writeFileSync(path.join(linked, fixture), safe);
      git(linked, ['add', fixture]);
      fs.writeFileSync(path.join(linked, fixture), high);
      assert.doesNotThrow(runHook);

      git(linked, ['add', fixture]);
      fs.writeFileSync(path.join(linked, fixture), safe);
      let failure: Error & { stderr?: string };
      try {
        runHook();
        assert.fail('expected staged high finding to block the hook');
      } catch (error) {
        failure = error as Error & { stderr?: string };
      }
      assert.match(String(failure.stderr), /precommit scanner gate failed/);
    } finally {
      try {
        git(primary, ['worktree', 'remove', '--force', linked]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });
});
