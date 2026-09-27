import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SupplyChainScanner } from '../../src/security/supplyChainScanner';

function scanSource(content: string) {
  return new SupplyChainScanner({ auditAllScans: false }).scan({
    name: 'source-file.ts',
    content,
    tools: [],
    skipPreScanHeuristics: true,
  });
}

describe('SupplyChainScanner source-file mode', () => {
  it('ignores skill-content heuristics that are normal TypeScript syntax', () => {
    const source = [
      'const rendered = `value: ${input}`;',
      "spawn('node', ['../../scripts/worker.js']);",
      "const shellSyntaxFixture = '$(placeholder)';",
    ].join('\n');

    const result = scanSource(source);

    expect(result.warnings.filter((warning) => warning.category.startsWith('pre_scan.'))).toEqual(
      [],
    );
    expect(result.recommendation).toBe('allow');
  });

  it('continues to block malware signatures in source-file mode', () => {
    const minerSignature = Buffer.from('786d726967', 'hex').toString('utf8');

    const result = scanSource(`const executable = ${JSON.stringify(minerSignature)};`);

    expect(result.warnings.some((warning) => warning.category.startsWith('malware.'))).toBe(true);
    expect(result.recommendation).toBe('block');
  });

  it('does not match the encoded malware-signature definition file against itself', () => {
    const definitions = readFileSync(
      join(process.cwd(), 'src/security/malwareSignatures.ts'),
      'utf8',
    );

    const result = scanSource(definitions);

    expect(result.warnings.filter((warning) => warning.category.startsWith('malware.'))).toEqual(
      [],
    );
  });
});
