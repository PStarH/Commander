import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scanPublicClaims } from './claim-honesty-gate.js';

describe('claim honesty gate', () => {
  it('finds no unqualified production or customer claims in public surfaces', () => {
    const violations = scanPublicClaims(process.cwd());
    assert.deepEqual(violations, []);
  });

  it('reports the source location for a forbidden claim', () => {
    const violations = scanPublicClaims(process.cwd(), {
      files: ['README.md'],
      contents: {
        'README.md': 'Security: tamper-proof audit chain\n',
      },
    });

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.file, 'README.md');
    assert.equal(violations[0]?.line, 1);
    assert.match(violations[0]?.reason ?? '', /tamper-proof/i);
  });

  it('rejects unsupported numeric outcomes in illustrative POC cards', () => {
    const violations = scanPublicClaims(process.cwd(), {
      files: ['apps/web/src/pages/POCPage.tsx'],
      contents: {
        'apps/web/src/pages/POCPage.tsx': "value: '99.97%'\n",
      },
    });

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.line, 1);
    assert.match(violations[0]?.reason ?? '', /numeric outcomes/i);
  });

  it('rejects pilot labelling for illustrative POC copy', () => {
    const violations = scanPublicClaims(process.cwd(), {
      files: ['apps/web/src/i18n.ts'],
      contents: {
        'apps/web/src/i18n.ts': "'poc.sectionLabel': 'Enterprise Pilots'\n",
      },
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0]?.reason ?? '', /real enterprise pilots/i);
  });

  it('rejects stale localized README claims', () => {
    const violations = scanPublicClaims(process.cwd(), {
      files: ['README-zh.md', 'README-ja.md'],
      contents: {
        'README-zh.md': '这不是模拟\n',
        'README-ja.md': 'これはモックアップではありません\n',
      },
    });

    assert.equal(violations.length, 2);
    assert.deepEqual(
      violations.map((violation) => violation.file),
      ['README-zh.md', 'README-ja.md'],
    );
  });

  it('rejects invalidated benchmark scores in release history', () => {
    const violations = scanPublicClaims(process.cwd(), {
      files: ['CHANGELOG.md'],
      contents: {
        'CHANGELOG.md': '- PinchBench 97.7% (42/43)\n',
      },
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0]?.reason ?? '', /archival benchmark scores/i);
  });

  it('rejects compliance-certification wording in the SDK posture surface', () => {
    const violations = scanPublicClaims(process.cwd(), {
      files: ['packages/python-sdk/src/commander/_client.py'],
      contents: {
        'packages/python-sdk/src/commander/_client.py':
          '"""Get the latest full compliance report."""\n',
      },
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0]?.reason ?? '', /self-assessed control coverage/i);
  });
});
