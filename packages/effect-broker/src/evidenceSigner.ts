import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type JsonWebKeyInput,
  type KeyObject,
} from 'node:crypto';
import type { EvidenceSignature, EvidenceSigner } from './evidenceBundle.js';

export interface EvidenceJwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface EvidenceJwks {
  keys: EvidenceJwk[];
}

export interface ConfiguredEvidenceSigner extends EvidenceSigner {
  readonly jwks: EvidenceJwks;
}

function invalidKey(): never {
  throw new Error('EVIDENCE_SIGNING_KEY_INVALID');
}

export function createEvidenceSigner(config: {
  privateKeyPem: string;
  keyId: string;
}): ConfiguredEvidenceSigner {
  const privateKeyPem = config.privateKeyPem.trim();
  const keyId = config.keyId.trim();
  if (!privateKeyPem || !keyId) throw new Error('EVIDENCE_SIGNING_KEY_REQUIRED');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    invalidKey();
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') invalidKey();
  const publicKey = createPublicKey(privateKeyPem);
  const jwk = publicKey.export({ format: 'jwk' }) as EvidenceJwk;
  const jwks: EvidenceJwks = {
    keys: [{ ...jwk, kid: keyId, alg: 'EdDSA', use: 'sig' }],
  };
  return {
    jwks,
    async sign(canonicalBody) {
      return {
        algorithm: 'Ed25519',
        keyId,
        signedAt: new Date().toISOString(),
        value: signBytes(null, Buffer.from(canonicalBody, 'utf8'), privateKey).toString(
          'base64url',
        ),
      };
    },
    verify(canonicalBody, signature) {
      if (signature.algorithm !== 'Ed25519' || signature.keyId !== keyId) return false;
      try {
        return verifyBytes(
          null,
          Buffer.from(canonicalBody, 'utf8'),
          publicKey,
          Buffer.from(signature.value, 'base64url'),
        );
      } catch {
        return false;
      }
    },
  };
}

export function verifyEvidenceSignature(
  canonicalBody: string,
  signature: EvidenceSignature,
  jwks: EvidenceJwks,
): boolean {
  if (signature.algorithm !== 'Ed25519') return false;
  const jwk = jwks.keys.find((candidate) => candidate.kid === signature.keyId);
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return false;
  try {
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' } as JsonWebKeyInput);
    return verifyBytes(
      null,
      Buffer.from(canonicalBody, 'utf8'),
      publicKey,
      Buffer.from(signature.value, 'base64url'),
    );
  } catch {
    return false;
  }
}
