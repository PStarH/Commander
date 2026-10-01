import { getCapabilityTokenIssuer } from '../src/security/capabilityToken';

/** Wildcard HMAC token for unit tests that must pass the execute capability gate. */
export function testCapabilityToken(aud = '*'): string {
  return getCapabilityTokenIssuer().issue({
    sub: 'test',
    aud,
    tools: ['*'],
    ttlSeconds: 300,
  });
}
