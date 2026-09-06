import { describe, expect, it } from 'vitest';
import { isSupportedNodeVersion } from '../../src/cli/nodeSupport';

describe('isSupportedNodeVersion', () => {
  it.each([
    ['v21.9.0', false],
    ['v22.0.0', true],
    ['v22.99.0', true],
    ['v23.0.0', false],
    ['v26.7.0', false],
  ])('classifies %s against the Node 22 runtime contract', (version, supported) => {
    expect(isSupportedNodeVersion(version)).toBe(supported);
  });
});
