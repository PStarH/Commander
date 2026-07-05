/**
 * PostQuantumCrypto Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PostQuantumCrypto,
  getPostQuantumCrypto,
  resetPostQuantumCrypto,
  pqHash,
  pqVerifyMac,
} from '../../src/security/postQuantumCrypto';
import type { PqKeyPair } from '../../src/security/postQuantumCrypto';

describe('PostQuantumCrypto', () => {
  let pq: PostQuantumCrypto;

  beforeEach(() => {
    resetPostQuantumCrypto();
    pq = new PostQuantumCrypto();
  });

  afterEach(() => {
    resetPostQuantumCrypto();
  });

  describe('initialization', () => {
    it('is ready on modern Node.js', () => {
      expect(pq.isReady()).toBe(true);
    });

    it('configures default algorithm', () => {
      const custom = new PostQuantumCrypto({ defaultAlgorithm: 'sha-512-pq' });
      expect(custom.isReady()).toBe(true);
    });
  });

  describe('hash', () => {
    it('hashes a string synchronously', () => {
      const result = pq.hashSync('Hello, quantum world!');
      expect(result.hash).toBeTruthy();
      expect(result.hash.length).toBeGreaterThanOrEqual(32);
      expect(result.algorithm).toBe('sha-512-pq');
      expect(result.inputLength).toBeGreaterThan(0);
    });

    it('hashes a string asynchronously', async () => {
      const result = await pq.hash('Hello, quantum world!');
      expect(result.hash).toBeTruthy();
      expect(result.hash.length).toBeGreaterThanOrEqual(32);
    });

    it('produces different hashes for different inputs', () => {
      const a = pq.hashSync('hello');
      const b = pq.hashSync('world');
      expect(a.hash).not.toBe(b.hash);
    });

    it('respects outputLength option', () => {
      const r1 = pq.hashSync('test', { outputLength: 32 });
      const r2 = pq.hashSync('test', { outputLength: 64 });
      expect(r1.hash.length).toBe(64); // hex = 2x bytes
      expect(r2.hash.length).toBe(128);
    });

    it('hashes a Buffer', async () => {
      const buf = Buffer.from('binary data');
      const result = await pq.hash(buf);
      expect(result.hash).toBeTruthy();
    });
  });

  describe('key generation', () => {
    it('generates a valid key pair', () => {
      const kp = pq.generateKeyPair();
      expect(kp.publicKey).toBeTruthy();
      expect(kp.privateKey).toBeTruthy();
      expect(kp.strengthBits).toBe(256);
      expect(kp.algorithm).toBeTruthy();
      expect(kp.createdAt).toBeTruthy();
    });

    it('generates unique key pairs', () => {
      const kp1 = pq.generateKeyPair();
      const kp2 = pq.generateKeyPair();
      expect(kp1.privateKey).not.toBe(kp2.privateKey);
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
    });

    it('accepts algorithm option', () => {
      const kp = pq.generateKeyPair({ algorithm: 'sha-512-pq' });
      expect(kp.algorithm).toBe('sha-512-pq');
    });
  });

  describe('createMac & verifyMac', () => {
    let keyPair: PqKeyPair;

    beforeEach(() => {
      keyPair = pq.generateKeyPair();
    });

    it('creates a MAC for a message', () => {
      const mac = pq.createMac('Hello, World!', keyPair);
      expect(mac.mac).toBeTruthy();
      expect(mac.algorithm).toBe(keyPair.algorithm);
      expect(mac.publicKey).toBe(keyPair.publicKey);
      expect(mac.messageHash).toBeTruthy();
      expect(mac.createdAt).toBeTruthy();
    });

    it('verifies a valid MAC', () => {
      const message = 'Integrity check';
      const mac = pq.createMac(message, keyPair);
      expect(pq.verifyMac(message, mac, keyPair)).toBe(true);
    });

    it('rejects an invalid MAC', () => {
      const mac = pq.createMac('Original message', keyPair);
      expect(pq.verifyMac('Tampered message', mac, keyPair)).toBe(false);
    });

    it('rejects a MAC with wrong key', () => {
      const mac = pq.createMac('Message', keyPair);
      const wrongKey = pq.generateKeyPair();
      expect(pq.verifyMac('Message', mac, wrongKey)).toBe(false);
    });

    it('MACs and verifies Buffer messages', () => {
      const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const mac = pq.createMac(buf, keyPair);
      expect(pq.verifyMac(buf, mac, keyPair)).toBe(true);
    });
  });

  describe('random bytes', () => {
    it('generates secure random bytes', () => {
      const bytes = pq.randomBytes(32);
      expect(bytes.length).toBe(32);
      expect(bytes).toBeInstanceOf(Buffer);
    });

    it('generates unique bytes', () => {
      const a = pq.randomBytes(16);
      const b = pq.randomBytes(16);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('shared secret', () => {
    it('throws a not-implemented error', () => {
      const kp = pq.generateKeyPair();
      expect(() => pq.generateSharedSecret(kp.publicKey, kp)).toThrow(
        'ML-KEM-768 shared secret generation is not yet implemented',
      );
    });
  });

  describe('convenience functions', () => {
    it('pqHash returns hex string', async () => {
      const hash = await pqHash('convenience test');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });

    it('pqVerifyMac works with generated key pairs', () => {
      const kp = pq.generateKeyPair();
      const mac = pq.createMac('verify me', kp);
      expect(pqVerifyMac('verify me', mac, kp)).toBe(true);
    });
  });

  describe('reset', () => {
    it('creates a new instance after reset', () => {
      const a = getPostQuantumCrypto();
      resetPostQuantumCrypto();
      const b = getPostQuantumCrypto();
      expect(a).not.toBe(b);
    });
  });
});
