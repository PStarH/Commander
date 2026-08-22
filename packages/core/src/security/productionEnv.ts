/**
 * AUDIT-CORE1: shared production detection for cryptographic key resolvers.
 *
 * Four key resolvers (capabilityToken, auditChainLedger, federatedIdentity,
 * encryptedSecretsVault) gated their dev-key fallback on
 * `NODE_ENV === 'production'` alone, while IntegrityLayer also honoured
 * COMMANDER_ENV. A deployment that set only COMMANDER_ENV=prod got
 * public-constant HMAC keys for capability tokens, audit chain, and
 * federation trusts — forgeable authorization credentials — with a warning
 * at most. All resolvers now share this broader check so the gates cannot
 * drift apart again.
 */

export function isProductionCryptoEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === 'production' ||
    env.COMMANDER_ENV === 'production' ||
    env.COMMANDER_ENV === 'prod'
  );
}
