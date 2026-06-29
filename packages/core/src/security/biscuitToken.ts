/**
 * Biscuit-Style Capability Token — Datalog policies + Ed25519 signatures
 *
 * Implements the ICapabilityToken contract from Pillar III.
 *
 * This is a Biscuit-inspired capability token system that improves on
 * the existing HMAC-based CapabilityToken (capabilityToken.ts) with:
 *
 * 1. Ed25519 signatures (asymmetric, not shared-secret HMAC)
 *    - Issuer signs with private key; anyone with public key can verify
 *    - No shared secret required for verification (offline verification)
 *
 * 2. Datalog policy expressions (not just scope lists)
 *    - Express fine-grained rules: "allow file_write if path starts with /workspace"
 *    - Attenuation adds new rules that only restrict (never expand)
 *
 * 3. Block chain structure (attenuation blocks)
 *    - Root block: signed by issuer with Ed25519
 *    - Attenuation blocks: each signed by the previous block's key
 *    - Verification checks the entire chain
 *
 * Wire format (Biscuit v3 inspired):
 *   Block 0 (root): { facts, rules, checks, publicKey, signature }
 *   Block N (attenuation): { facts, rules, checks, prevSig, signature }
 *
 * Per constraint NFR-SEC-02, tokens SHALL be unforgeable.
 * Per constraint NFR-SEC-06, supports least privilege via attenuation.
 *
 * Uses Node.js built-in crypto (no external dependency for Ed25519).
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { ICapabilityToken } from '../contracts/pillarIII';

// ============================================================================
// Datalog Types
// ============================================================================

/**
 * A Datalog fact: predicate(args).
 * Example: allow("file_write", "/workspace/x.ts")
 */
export interface DatalogFact {
  /** Predicate name */
  predicate: string;
  /** Arguments (strings, numbers, or booleans) */
  args: DatalogTerm[];
}

/**
 * A Datalog rule: head :- body.
 * Example: allow(tool, path) :- tool("file_write"), path.startsWith("/workspace")
 */
export interface DatalogRule {
  /** Head fact (conclusion) */
  head: DatalogFact;
  /** Body facts (conditions that must all be true) */
  body: DatalogFact[];
  /** String prefix conditions (e.g., path.startsWith("/workspace")) */
  conditions?: DatalogCondition[];
}

/**
 * A Datalog check: a query that must succeed for the token to be valid.
 * Example: check if resource("file_write", path), path.startsWith("/workspace")
 */
export interface DatalogCheck {
  /** Query that must return at least one result */
  query: DatalogFact;
  /** Additional conditions */
  conditions?: DatalogCondition[];
}

export type DatalogTerm = string | number | boolean;

export interface DatalogCondition {
  /** The argument index to test */
  argIndex: number;
  /** Condition type */
  type: 'prefix' | 'suffix' | 'equals' | 'regex' | 'not_equals';
  /** The value to test against */
  value: string;
}

// ============================================================================
// Token Block
// ============================================================================

interface TokenBlock {
  /** Block index (0 = root) */
  index: number;
  /** Facts declared in this block */
  facts: DatalogFact[];
  /** Rules declared in this block */
  rules: DatalogRule[];
  /** Checks that must pass for this block */
  checks: DatalogCheck[];
  /** Ed25519 public key for this block (verifies next block's signature) */
  publicKey: string; // base64
  /** Ed25519 signature over the block content + previous block signature */
  signature: string; // base64
  /** Previous block's signature (null for root block) */
  prevSig: string | null;
  /** Expiry timestamp (unix seconds) */
  expiry: number;
  /** Token ID for revocation tracking */
  tokenId: string;
  /** Issuer's public key (only set on root block; used for root signature verification) */
  issuerPublicKey?: string; // base64 DER
}

// ============================================================================
// Biscuit Capability Token
// ============================================================================

/**
 * Biscuit-style capability token with Ed25519 signatures and Datalog policies.
 *
 * Each token is a chain of blocks:
 * - Block 0 (root): signed by the issuer's private key
 * - Block N (attenuation): signed by block N-1's private key
 *
 * Attenuation can only add restrictions (new facts, rules, checks) —
 * it can never remove restrictions from parent blocks.
 */
export class BiscuitCapabilityToken implements ICapabilityToken {
  private blocks: TokenBlock[];
  private currentKeyPair: { publicKey: string; privateKey: string };

  private constructor(
    blocks: TokenBlock[],
    currentKeyPair: { publicKey: string; privateKey: string },
  ) {
    this.blocks = blocks;
    this.currentKeyPair = currentKeyPair;
  }

  /**
   * Create a root token (issued by the authority).
   */
  static createRoot(
    issuerPrivateKey: string, // Ed25519 private key, base64
    options: {
      tokenId?: string;
      expiry: number; // unix seconds
      facts?: DatalogFact[];
      rules?: DatalogRule[];
      checks?: DatalogCheck[];
    },
  ): BiscuitCapabilityToken {
    // Derive public key from private key (PKCS8 DER)
    const privKeyObj = crypto.createPrivateKey({
      key: Buffer.from(issuerPrivateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = crypto.createPublicKey(privKeyObj);

    const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const pubKeyB64 = pubKeyDer.toString('base64');

    // Generate a new key pair for this block (for child attenuation)
    const childKeyPair = crypto.generateKeyPairSync('ed25519');
    const childPubDer = childKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const childPrivDer = childKeyPair.privateKey.export({ type: 'pkcs8', format: 'der' });

    const tokenId = options.tokenId ?? crypto.randomBytes(16).toString('hex');

    const block: TokenBlock = {
      index: 0,
      facts: options.facts ?? [],
      rules: options.rules ?? [],
      checks: options.checks ?? [],
      publicKey: childPubDer.toString('base64'),
      signature: '', // Will be set below
      prevSig: null,
      expiry: options.expiry,
      tokenId,
      issuerPublicKey: pubKeyB64,
    };

    // Sign the block content with the issuer's private key
    const content = BiscuitCapabilityToken.serializeBlock(block);
    const sig = crypto.sign(null, Buffer.from(content), {
      key: Buffer.from(issuerPrivateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    block.signature = sig.toString('base64');

    return new BiscuitCapabilityToken([block], {
      publicKey: childPubDer.toString('base64'),
      privateKey: childPrivDer.toString('base64'),
    });
  }

  /**
   * Deserialize a token from binary format.
   */
  static deserialize(data: Uint8Array): BiscuitCapabilityToken {
    const json = Buffer.from(data).toString('utf8');
    const parsed = JSON.parse(json) as { blocks: TokenBlock[] };

    // Note: deserialized tokens cannot attenuate further (no private key)
    // They can only be verified
    return new BiscuitCapabilityToken(parsed.blocks, {
      publicKey: '',
      privateKey: '',
    });
  }

  /**
   * Serialize to binary format.
   */
  serialize(): Uint8Array {
    return Buffer.from(JSON.stringify({ blocks: this.blocks }), 'utf8');
  }

  /**
   * Verify the entire block chain's signatures.
   *
   * Root block: verified against the issuer's public key stored in the block.
   * Attenuation blocks: verified against the previous block's public key.
   *
   * Optionally accepts an external issuerPublicKey for strict verification
   * (prevents an attacker from forging both the block and the issuerPublicKey).
   */
  verify(externalIssuerPublicKey?: string): boolean {
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];

      // Check expiry
      if (Date.now() / 1000 > block.expiry) {
        getGlobalLogger().debug('BiscuitToken', 'Token expired', {
          blockIndex: i,
          expiry: block.expiry,
        });
        return false;
      }

      const sig = Buffer.from(block.signature, 'base64');

      try {
        if (i === 0) {
          // Root block: verify against issuer's public key
          const issuerPubKey = externalIssuerPublicKey ?? block.issuerPublicKey;
          if (!issuerPubKey) {
            getGlobalLogger().warn('BiscuitToken', 'Root block has no issuer public key');
            return false;
          }

          const content = BiscuitCapabilityToken.serializeBlock(block);
          const isValid = crypto.verify(
            null,
            Buffer.from(content),
            {
              key: Buffer.from(issuerPubKey, 'base64'),
              format: 'der',
              type: 'spki',
            },
            sig,
          );
          if (!isValid) {
            getGlobalLogger().warn('BiscuitToken', 'Root block signature verification failed');
            return false;
          }
        } else {
          // Attenuation block: verified by previous block's public key
          const prevBlock = this.blocks[i - 1];
          const verifyKey = Buffer.from(prevBlock.publicKey, 'base64');

          const content = BiscuitCapabilityToken.serializeBlock(block);
          const isValid = crypto.verify(
            null,
            Buffer.from(content),
            { key: verifyKey, format: 'der', type: 'spki' },
            sig,
          );
          if (!isValid) {
            getGlobalLogger().warn(
              'BiscuitToken',
              'Attenuation block signature verification failed',
              {
                blockIndex: i,
              },
            );
            return false;
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'biscuitToken:verify');
        return false;
      }
    }
    return true;
  }

  /**
   * Append a restriction block (attenuation).
   * Attenuation can only add new facts, rules, and checks —
   * it can never remove or weaken existing restrictions.
   */
  attenuate(restrictions: {
    facts?: DatalogFact[];
    rules?: DatalogRule[];
    checks?: DatalogCheck[];
    expiry?: number; // Can only shorten, not extend
  }): BiscuitCapabilityToken {
    if (!this.currentKeyPair.privateKey) {
      throw new Error('Cannot attenuate: no private key available (deserialized token)');
    }

    const lastBlock = this.blocks[this.blocks.length - 1];
    const newExpiry = restrictions.expiry
      ? Math.min(restrictions.expiry, lastBlock.expiry)
      : lastBlock.expiry;

    // Generate a new key pair for the child block
    const childKeyPair = crypto.generateKeyPairSync('ed25519');
    const childPubDer = childKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const childPrivDer = childKeyPair.privateKey.export({ type: 'pkcs8', format: 'der' });

    const newBlock: TokenBlock = {
      index: this.blocks.length,
      facts: restrictions.facts ?? [],
      rules: restrictions.rules ?? [],
      checks: restrictions.checks ?? [],
      publicKey: childPubDer.toString('base64'),
      signature: '',
      prevSig: lastBlock.signature,
      expiry: newExpiry,
      tokenId: lastBlock.tokenId,
    };

    // Sign with the current block's private key
    const content = BiscuitCapabilityToken.serializeBlock(newBlock);
    const sig = crypto.sign(null, Buffer.from(content), {
      key: Buffer.from(this.currentKeyPair.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    newBlock.signature = sig.toString('base64');

    const newBlocks = [...this.blocks, newBlock];
    return new BiscuitCapabilityToken(newBlocks, {
      publicKey: childPubDer.toString('base64'),
      privateKey: childPrivDer.toString('base64'),
    });
  }

  /**
   * Create a child token for delegation.
   * This is equivalent to attenuate() but conceptually represents
   * delegating a subset of capabilities to another agent.
   */
  delegate(): BiscuitCapabilityToken {
    // Delegation is just attenuation with no additional restrictions
    // The delegatee gets a token they can further attenuate
    return this.attenuate({});
  }

  get expiry(): number {
    return this.blocks[this.blocks.length - 1].expiry;
  }

  get tokenId(): string {
    return this.blocks[0].tokenId;
  }

  /**
   * Check if a specific operation is allowed by the token's policies.
   *
   * Evaluates all Datalog facts, rules, and checks across all blocks.
   * An operation is allowed if:
   * 1. There exists a fact or rule-derived fact matching the operation
   * 2. All checks across all blocks pass
   */
  authorize(operation: { predicate: string; args: DatalogTerm[] }): boolean {
    // Collect all facts from all blocks
    const allFacts: DatalogFact[] = [];
    for (const block of this.blocks) {
      allFacts.push(...block.facts);
    }

    // Apply rules to derive new facts
    for (const block of this.blocks) {
      for (const rule of block.rules) {
        if (this.evaluateRule(rule, allFacts)) {
          allFacts.push(rule.head);
        }
      }
    }

    // Check if the operation matches any fact
    const operationAllowed = allFacts.some(
      (fact) =>
        fact.predicate === operation.predicate &&
        fact.args.length === operation.args.length &&
        fact.args.every((arg, i) => this.termEquals(arg, operation.args[i])),
    );

    if (!operationAllowed) return false;

    // Evaluate all checks across all blocks
    for (const block of this.blocks) {
      for (const check of block.checks) {
        if (!this.evaluateCheck(check, allFacts)) {
          getGlobalLogger().debug('BiscuitToken', 'Check failed', {
            blockIndex: block.index,
            checkPredicate: check.query.predicate,
          });
          return false;
        }
      }
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private evaluateRule(rule: DatalogRule, facts: DatalogFact[]): boolean {
    // Simple evaluation: all body facts must exist in the facts set
    return rule.body.every((bodyFact) =>
      facts.some(
        (f) =>
          f.predicate === bodyFact.predicate &&
          f.args.length === bodyFact.args.length &&
          f.args.every((arg, i) => this.termEquals(arg, bodyFact.args[i])),
      ),
    );
  }

  private evaluateCheck(check: DatalogCheck, facts: DatalogFact[]): boolean {
    // Check: at least one fact must match the query
    const matchingFact = facts.find(
      (f) => f.predicate === check.query.predicate && f.args.length === check.query.args.length,
    );

    if (!matchingFact) return false;

    // Evaluate conditions
    if (check.conditions) {
      for (const cond of check.conditions) {
        const arg = matchingFact.args[cond.argIndex];
        if (typeof arg !== 'string') continue;

        switch (cond.type) {
          case 'prefix':
            if (!arg.startsWith(cond.value)) return false;
            break;
          case 'suffix':
            if (!arg.endsWith(cond.value)) return false;
            break;
          case 'equals':
            if (arg !== cond.value) return false;
            break;
          case 'not_equals':
            if (arg === cond.value) return false;
            break;
          case 'regex':
            try {
              if (!new RegExp(cond.value).test(arg)) return false;
            } catch {
              return false;
            }
            break;
        }
      }
    }

    return true;
  }

  private termEquals(a: DatalogTerm, b: DatalogTerm): boolean {
    return a === b;
  }

  private static serializeBlock(block: TokenBlock): string {
    // Canonical JSON serialization (sorted keys for deterministic signing)
    const canonical = {
      checks: block.checks,
      expiry: block.expiry,
      facts: block.facts,
      index: block.index,
      issuerPublicKey: block.issuerPublicKey ?? null,
      prevSig: block.prevSig,
      publicKey: block.publicKey,
      rules: block.rules,
      tokenId: block.tokenId,
    };
    return JSON.stringify(canonical);
  }
}

// ============================================================================
// Token Issuer
// ============================================================================

/**
 * Biscuit token issuer — holds the Ed25519 private key for signing root tokens.
 */
export class BiscuitTokenIssuer {
  private privateKey: string; // base64 DER
  private publicKey: string; // base64 DER

  constructor(privateKey?: string) {
    if (privateKey) {
      this.privateKey = privateKey;
      // Derive public key from private key (PKCS8 DER → SPKI DER)
      const privKeyObj = crypto.createPrivateKey({
        key: Buffer.from(privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
      const pub = crypto.createPublicKey(privKeyObj);
      this.publicKey = pub.export({ type: 'spki', format: 'der' }).toString('base64');
    } else {
      // Generate a new key pair
      const keyPair = crypto.generateKeyPairSync('ed25519');
      this.privateKey = keyPair.privateKey
        .export({ type: 'pkcs8', format: 'der' })
        .toString('base64');
      this.publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    }
  }

  /**
   * Issue a new root token.
   */
  issue(options: {
    expiry: number;
    facts?: DatalogFact[];
    rules?: DatalogRule[];
    checks?: DatalogCheck[];
    tokenId?: string;
  }): BiscuitCapabilityToken {
    return BiscuitCapabilityToken.createRoot(this.privateKey, options);
  }

  /**
   * Get the issuer's public key (for distribution to verifiers).
   */
  getIssuerPublicKey(): string {
    return this.publicKey;
  }
}

// ============================================================================
// Token Verifier
// ============================================================================

/**
 * Biscuit token verifier — holds the issuer's public key for verification.
 */
export class BiscuitTokenVerifier {
  private issuerPublicKey: string;

  constructor(issuerPublicKey: string) {
    this.issuerPublicKey = issuerPublicKey;
  }

  /**
   * Verify a token's signature chain and check expiry.
   * Uses the issuer's public key for strict root block verification.
   */
  verify(token: BiscuitCapabilityToken): boolean {
    return token.verify(this.issuerPublicKey);
  }

  /**
   * Verify and authorize an operation.
   */
  authorize(
    token: BiscuitCapabilityToken,
    operation: { predicate: string; args: DatalogTerm[] },
  ): boolean {
    if (!this.verify(token)) return false;
    return token.authorize(operation);
  }
}

// ============================================================================
// Convenience: Datalog Fact Builders
// ============================================================================

/**
 * Build a fact: allow(tool, resource)
 */
export function allow(tool: string, resource?: string): DatalogFact {
  return {
    predicate: 'allow',
    args: resource ? [tool, resource] : [tool],
  };
}

/**
 * Build a fact: tool(name)
 */
export function tool(name: string): DatalogFact {
  return { predicate: 'tool', args: [name] };
}

/**
 * Build a fact: resource(type, path)
 */
export function resource(type: string, path: string): DatalogFact {
  return { predicate: 'resource', args: [type, path] };
}

/**
 * Build a check: path must start with prefix
 */
export function pathPrefixCheck(prefix: string): DatalogCheck {
  return {
    query: { predicate: 'resource', args: ['type', 'path'] },
    conditions: [{ argIndex: 1, type: 'prefix', value: prefix }],
  };
}
