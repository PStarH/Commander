import { describe, it, expect } from 'vitest';
import {
  BiscuitCapabilityAdapter,
  BiscuitCapabilityVerifier,
} from '../../src/security/biscuitCapabilityAdapter';
import { BiscuitTokenVerifier, BiscuitCapabilityToken } from '../../src/security/biscuitToken';

/**
 * Biscuit capability token — signature-trust regression tests.
 *
 * The critical property: verification trust must be anchored in the issuer's
 * public key held by the verifier, NOT in a key embedded in the token. A token
 * signed by a different (attacker) issuer must be rejected.
 */
describe('BiscuitCapabilityAdapter — issuer trust', () => {
  function verifierFor(adapter: BiscuitCapabilityAdapter, aud: string): BiscuitCapabilityVerifier {
    return new BiscuitCapabilityVerifier(
      new BiscuitTokenVerifier(adapter.getIssuerPublicKey()),
      aud,
    );
  }

  it('accepts a token from the trusted issuer for an in-scope tool', () => {
    const adapter = new BiscuitCapabilityAdapter();
    const token = adapter.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_read'] });
    const verifier = verifierFor(adapter, 'acme');
    const result = verifier.verify(token, { tool: 'file_read' });
    expect(result.ok).toBe(true);
  });

  it('rejects an out-of-scope tool (least privilege)', () => {
    const adapter = new BiscuitCapabilityAdapter();
    const token = adapter.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_read'] });
    const verifier = verifierFor(adapter, 'acme');
    const result = verifier.verify(token, { tool: 'file_write' });
    expect(result.ok).toBe(false);
  });

  it('rejects a token forged by a different issuer (no embedded-key trust)', () => {
    const trusted = new BiscuitCapabilityAdapter();
    const attacker = new BiscuitCapabilityAdapter(); // different Ed25519 keypair
    // Attacker mints a self-signed token embedding THEIR public key.
    const forged = attacker.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_write'] });
    // Verified against the TRUSTED issuer's key — must fail on the signature.
    const verifier = verifierFor(trusted, 'acme');
    const result = verifier.verify(forged, { tool: 'file_write' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('token.verify() with no trusted key fails closed', () => {
    // Directly exercise the token: without an external issuer key, root trust
    // must fail closed rather than trust the embedded key.
    const adapter = new BiscuitCapabilityAdapter();
    const encoded = adapter.issue({ sub: 'agent-1', aud: 'acme', tools: ['file_read'] });
    const bytes = new Uint8Array(Buffer.from(encoded.replace(/^bsc_/, ''), 'base64'));
    const token = BiscuitCapabilityToken.deserialize(bytes);
    expect(token.verify()).toBe(false); // no key → fail closed
    expect(token.verify(adapter.getIssuerPublicKey())).toBe(true); // trusted key → ok
  });
});
