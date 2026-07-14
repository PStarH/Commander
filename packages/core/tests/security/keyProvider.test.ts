import { describe, it, expect } from 'vitest';
import { LocalJwksKeyProvider } from '../../src/security/keyProvider';

describe('LocalJwksKeyProvider', () => {
  it('is always simulated', async () => {
    const kp = new LocalJwksKeyProvider({ path: ':memory:', simulated: true });
    expect(kp.keySource).toBe('simulated');
    await kp.initialize();
    const signing = await kp.currentSigningKey();
    expect(signing.algorithm).toBe('HS256');
    expect(signing.key).toBeInstanceOf(Buffer);
    expect(signing.key.length).toBe(32);
  });

  it('rotation creates a new active key and demotes the old one to retiring', async () => {
    const kp = new LocalJwksKeyProvider({ path: ':memory:', simulated: true });
    await kp.initialize();

    const first = await kp.currentSigningKey();
    expect(first.status).toBe('active');

    const rotated = await kp.rotate();
    expect(rotated.status).toBe('active');
    expect(rotated.kid).not.toBe(first.kid);

    const stillActive = await kp.currentSigningKey();
    expect(stillActive.kid).toBe(rotated.kid);

    const verify = await kp.verificationKeys();
    const kids = verify.map((k) => k.kid);
    expect(kids).toContain(first.kid);
    expect(kids).toContain(rotated.kid);

    const firstAfterRotate = verify.find((k) => k.kid === first.kid);
    expect(firstAfterRotate?.status).toBe('retiring');
  });

  it('old key remains verifiable within the grace window', async () => {
    const kp = new LocalJwksKeyProvider({ path: ':memory:', simulated: true, graceSeconds: 300 });
    await kp.initialize();

    const first = await kp.currentSigningKey();
    await kp.rotate();

    const verify = await kp.verificationKeys();
    expect(verify.map((k) => k.kid)).toContain(first.kid);
  });

  it('revoked key is rejected after the grace window', async () => {
    const kp = new LocalJwksKeyProvider({ path: ':memory:', simulated: true, graceSeconds: 0 });
    await kp.initialize();

    const old = await kp.currentSigningKey();
    await kp.rotate();
    await kp.revoke(old.kid);

    const verify = await kp.verificationKeys();
    expect(verify.map((k) => k.kid)).not.toContain(old.kid);
  });

  it('throws when revoking an unknown kid', async () => {
    const kp = new LocalJwksKeyProvider({ path: ':memory:', simulated: true });
    await kp.initialize();
    await expect(kp.revoke('unknown-kid')).rejects.toThrow('Unknown kid: unknown-kid');
  });

  it('expires retiring keys automatically once the grace window passes', async () => {
    const kp = new LocalJwksKeyProvider({ path: ':memory:', simulated: true, graceSeconds: 0 });
    await kp.initialize();

    const first = await kp.currentSigningKey();
    await kp.rotate();

    // With graceSeconds=0 the retiring key has already expired.
    const verify = await kp.verificationKeys();
    expect(verify.map((k) => k.kid)).not.toContain(first.kid);
  });
});
