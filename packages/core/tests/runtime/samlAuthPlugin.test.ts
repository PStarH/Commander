/**
 * Tests for SAML 2.0 Authentication Plugin
 *
 * Covers:
 * - SAMLResponse parsing and role mapping
 * - XML signature verification (RSA-SHA256)
 * - Conditions validation (NotBefore, NotOnOrAfter, Audience)
 * - IdP-initiated vs SP-initiated InResponseTo handling
 * - createLoginRedirectUrl SAMLRequest generation
 * - createSAMLPluginFromEnv helper
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
  SAMLAuthPlugin,
  createSAMLPluginFromEnv,
  type SAMLPluginConfig,
} from '../../src/runtime/samlAuthPlugin';

// ============================================================================
// Helpers
// ============================================================================

function generateKeyPair(): {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  certificate: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  // Use the SPKI public key as the "certificate" for tests. The plugin also
  // accepts a real X.509 certificate, but SPKI avoids Node 22+ APIs and keeps
  // tests portable across Node 18/20/22+.
  return {
    publicKey,
    privateKey,
    certificate: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

function approximateC14n(xml: string): string {
  return xml
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*>/g, '/>')
    .replace(/<(\/?)([\w:]+)([^>]*)>/g, (_full, slash, name, attrs) => {
      const trimmed = attrs.trim();
      if (!trimmed) return `<${slash}${name}>`;
      const attrList = trimmed
        .split(/(\w+(?::\w+)?="[^"]*")/g)
        .filter((s: string) => s.trim() && s.includes('='))
        .map((s: string) => s.trim());
      const unique = Array.from(new Set(attrList));
      unique.sort((a, b) => {
        const nameA = a.split('=')[0].toLowerCase();
        const nameB = b.split('=')[0].toLowerCase();
        return nameA.localeCompare(nameB);
      });
      return `<${slash}${name} ${unique.join(' ')}>`;
    });
}

interface SamlResponseOptions {
  nameId?: string;
  email?: string;
  roles?: string | string[];
  tenantId?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  audience?: string;
  inResponseTo?: string;
  recipient?: string;
  issuer?: string;
  wantSigned?: boolean;
  tamperDigest?: boolean;
  tamperSignature?: boolean;
}

function createSignedSamlResponse(
  config: SAMLPluginConfig,
  keys: { privateKey: crypto.KeyObject; certificate: string },
  options: SamlResponseOptions = {},
): string {
  const now = new Date();
  const issueInstant = now.toISOString();
  const notBefore = options.notBefore ?? new Date(now.getTime() - 60_000).toISOString();
  const notOnOrAfter = options.notOnOrAfter ?? new Date(now.getTime() + 3_600_000).toISOString();
  const nameId = options.nameId ?? 'alice@example.com';
  const email = options.email ?? nameId;
  const roles = options.roles ?? 'operator';
  const audience = options.audience ?? config.spEntityId;
  const issuer = options.issuer ?? config.idpEntityId;
  const recipient = options.recipient ?? config.spAcsUrl;
  const assertionId = `_assertion_${crypto.randomUUID()}`;
  const responseId = `_response_${crypto.randomUUID()}`;
  const inResponseTo = options.inResponseTo;

  const roleValues = Array.isArray(roles) ? roles : [roles];
  const roleAttributeXml = roleValues
    .map((r) => `<saml:AttributeValue>${r}</saml:AttributeValue>`)
    .join('');

  const subjectConfirmationData = inResponseTo
    ? `<saml:SubjectConfirmationData Recipient="${recipient}" InResponseTo="${inResponseTo}" NotOnOrAfter="${notOnOrAfter}"/>`
    : `<saml:SubjectConfirmationData Recipient="${recipient}" NotOnOrAfter="${notOnOrAfter}"/>`;

  let assertionXml =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">${subjectConfirmationData}</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction>` +
    `<saml:Audience>${audience}</saml:Audience>` +
    `</saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email">` +
    `<saml:AttributeValue>${email}</saml:AttributeValue>` +
    `</saml:Attribute>` +
    `<saml:Attribute Name="role">${roleAttributeXml}</saml:Attribute>` +
    (options.tenantId
      ? `<saml:Attribute Name="tenant_id"><saml:AttributeValue>${options.tenantId}</saml:AttributeValue></saml:Attribute>`
      : '') +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`;

  if (options.wantSigned !== false) {
    const objectWithoutSignature = assertionXml;
    const canonicalizedObject = approximateC14n(objectWithoutSignature);
    const digestValue = crypto
      .createHash('sha256')
      .update(canonicalizedObject, 'utf-8')
      .digest('base64');

    const signatureMethod = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    const digestMethod = 'http://www.w3.org/2001/04/xmlenc#sha256';

    const signedInfo =
      `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
      `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
      `<ds:SignatureMethod Algorithm="${signatureMethod}"/>` +
      `<ds:Reference URI="#${assertionId}">` +
      `<ds:Transforms>` +
      `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
      `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
      `</ds:Transforms>` +
      `<ds:DigestMethod Algorithm="${digestMethod}"/>` +
      `<ds:DigestValue>${options.tamperDigest ? 'invalid' : digestValue}</ds:DigestValue>` +
      `</ds:Reference>` +
      `</ds:SignedInfo>`;

    const canonicalizedSignedInfo = approximateC14n(signedInfo);
    let signatureValue = crypto
      .sign('sha256', Buffer.from(canonicalizedSignedInfo, 'utf-8'), keys.privateKey)
      .toString('base64');

    if (options.tamperSignature) {
      signatureValue = Buffer.from('not-a-valid-signature').toString('base64');
    }

    const signatureXml =
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
      signedInfo +
      `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
      `<ds:KeyInfo>` +
      `<ds:X509Data>` +
      `<ds:X509Certificate>${keys.certificate.replace(/-----BEGIN [A-Z ]+-----|-----END [A-Z ]+-----|\s+/g, '')}</ds:X509Certificate>` +
      `</ds:X509Data>` +
      `</ds:KeyInfo>` +
      `</ds:Signature>`;

    // Insert signature right after <saml:Issuer>.
    assertionXml = assertionXml.replace('</saml:Issuer>', `</saml:Issuer>${signatureXml}`);
  }

  const responseInResponseTo = inResponseTo ? ` InResponseTo="${inResponseTo}"` : '';
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
    `Destination="${config.spAcsUrl}" ID="${responseId}" IssueInstant="${issueInstant}"` +
    `${responseInResponseTo} Version="2.0">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertionXml +
    `</samlp:Response>`;

  return Buffer.from(response).toString('base64');
}

function baseConfig(idpCertificate: string): SAMLPluginConfig {
  return {
    idpSsoUrl: 'https://idp.example.com/saml/sso',
    idpEntityId: 'https://idp.example.com/saml/metadata',
    spEntityId: 'commander',
    spAcsUrl: 'http://localhost:3001/api/v1/auth/saml/acs',
    idpCertificate,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SAMLAuthPlugin', () => {
  let keys: ReturnType<typeof generateKeyPair>;
  let plugin: SAMLAuthPlugin;
  let config: SAMLPluginConfig;

  beforeEach(() => {
    keys = generateKeyPair();
    config = baseConfig(keys.certificate);
    plugin = new SAMLAuthPlugin(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('successful authentication', () => {
    it('returns AuthPluginResult for a valid signed SAMLResponse', async () => {
      const response = createSignedSamlResponse(config, keys);
      const result = await plugin.authenticate(response);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe('alice@example.com');
      expect(result!.username).toBe('alice@example.com');
      expect(result!.role).toBe('operator');
    });

    it('maps admin role correctly', async () => {
      const response = createSignedSamlResponse(config, keys, { roles: 'admin' });
      const result = await plugin.authenticate(response);
      expect(result).not.toBeNull();
      expect(result!.role).toBe('admin');
    });

    it('maps viewer role when no matching role attribute found', async () => {
      const response = createSignedSamlResponse(config, keys, { roles: 'guest' });
      const result = await plugin.authenticate(response);
      expect(result).not.toBeNull();
      expect(result!.role).toBe('viewer');
    });

    it('supports multiple role values', async () => {
      const response = createSignedSamlResponse(config, keys, { roles: ['viewer', 'operator'] });
      const result = await plugin.authenticate(response);
      expect(result).not.toBeNull();
      expect(result!.role).toBe('operator');
    });

    it('extracts tenant_id attribute', async () => {
      const response = createSignedSamlResponse(config, keys, { tenantId: 'acme-corp' });
      const result = await plugin.authenticate(response);
      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe('acme-corp');
    });

    it('uses email attribute as username when present', async () => {
      const response = createSignedSamlResponse(config, keys, {
        nameId: 'alice',
        email: 'alice.smith@example.com',
      });
      const result = await plugin.authenticate(response);
      expect(result).not.toBeNull();
      expect(result!.username).toBe('alice.smith@example.com');
      expect(result!.userId).toBe('alice');
    });
  });

  describe('SAMLResponse validation', () => {
    it('rejects non-base64 input', async () => {
      const result = await plugin.authenticate('not-valid-base64!!!');
      expect(result).toBeNull();
    });

    it('rejects unsigned assertion when signature is required', async () => {
      const response = createSignedSamlResponse(config, keys, { wantSigned: false });
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects assertion with wrong issuer', async () => {
      const response = createSignedSamlResponse(config, keys, { issuer: 'https://evil.com' });
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects assertion with wrong audience', async () => {
      const response = createSignedSamlResponse(config, keys, { audience: 'wrong-sp' });
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects expired assertion', async () => {
      const past = new Date(Date.now() - 3_600_000).toISOString();
      const response = createSignedSamlResponse(config, keys, { notOnOrAfter: past });
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects future-dated assertion', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const response = createSignedSamlResponse(config, keys, { notBefore: future });
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects tampered digest', async () => {
      const response = createSignedSamlResponse(config, keys, { tamperDigest: true });
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects tampered signature value', async () => {
      const response = createSignedSamlResponse(config, keys, { tamperSignature: true });
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects assertion signed with a different key', async () => {
      const otherKeys = generateKeyPair();
      const response = createSignedSamlResponse(config, otherKeys);
      const result = await plugin.authenticate(response);
      expect(result).toBeNull();
    });

    it('rejects a signature-wrapping (XSW) payload with an injected second assertion', async () => {
      // Start from a valid, signed response, then inject a forged UNSIGNED
      // assertion (attacker-controlled admin role) ahead of the legit one.
      const valid = createSignedSamlResponse(config, keys, { roles: 'guest' });
      const xml = Buffer.from(valid, 'base64').toString('utf-8');
      const forged =
        `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_forged" Version="2.0">` +
        `<saml:Issuer>https://idp.example.com/saml/metadata</saml:Issuer>` +
        `<saml:Subject><saml:NameID>attacker@evil.com</saml:NameID></saml:Subject>` +
        `<saml:AttributeStatement>` +
        `<saml:Attribute Name="roles"><saml:AttributeValue>admin</saml:AttributeValue></saml:Attribute>` +
        `</saml:AttributeStatement>` +
        `</saml:Assertion>`;
      // Place the forged assertion first, before the genuine signed one.
      const wrapped = xml.replace('<saml:Assertion', `${forged}<saml:Assertion`);
      const result = await plugin.authenticate(Buffer.from(wrapped).toString('base64'));
      expect(result).toBeNull();
    });

    it('rejects a duplicated-ID wrapped assertion', async () => {
      const valid = createSignedSamlResponse(config, keys);
      const xml = Buffer.from(valid, 'base64').toString('utf-8');
      // Duplicate the whole assertion element (same ID) — non-unique ID must fail.
      const m = xml.match(/<saml:Assertion[\s\S]*?<\/saml:Assertion>/);
      const wrapped = m ? xml.replace(m[0], m[0] + m[0]) : xml;
      const result = await plugin.authenticate(Buffer.from(wrapped).toString('base64'));
      expect(result).toBeNull();
    });

    it('rejects wrong InResponseTo when expected', async () => {
      const response = createSignedSamlResponse(config, keys, { inResponseTo: 'expected-id' });
      const result = await plugin.validateSamlResponse(response, {
        inResponseTo: 'different-id',
      });
      expect(result).toBeNull();
    });

    it('accepts matching InResponseTo', async () => {
      const response = createSignedSamlResponse(config, keys, { inResponseTo: 'expected-id' });
      const result = await plugin.validateSamlResponse(response, {
        inResponseTo: 'expected-id',
      });
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('alice@example.com');
    });

    it('rejects IdP-initiated response when not allowed', async () => {
      const response = createSignedSamlResponse(config, keys);
      const result = await plugin.validateSamlResponse(response, {
        allowIdpInitiated: false,
      });
      expect(result).toBeNull();
    });
  });

  describe('SP-initiated login redirect', () => {
    it('generates a valid AuthnRequest URL', () => {
      const url = plugin.createLoginRedirectUrl('session-123');
      expect(url.startsWith(config.idpSsoUrl)).toBe(true);
      const parsed = new URL(url);
      expect(parsed.searchParams.has('SAMLRequest')).toBe(true);
      expect(parsed.searchParams.get('RelayState')).toBe('session-123');

      const deflated = Buffer.from(parsed.searchParams.get('SAMLRequest')!, 'base64');
      const xml = zlib.inflateRawSync(deflated).toString('utf-8');
      expect(xml).toContain('AuthnRequest');
      expect(xml).toContain(`AssertionConsumerServiceURL="${config.spAcsUrl}"`);
      expect(xml).toContain(config.spEntityId);
    });
  });

  describe('createSAMLPluginFromEnv', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      vi.stubEnv('SAML_IDP_SSO_URL', 'https://env-idp.example.com/saml/sso');
      vi.stubEnv('SAML_IDP_ENTITY_ID', 'https://env-idp.example.com/saml/metadata');
      vi.stubEnv('SAML_IDP_CERTIFICATE', keys.certificate);
      vi.stubEnv('SAML_SP_ENTITY_ID', 'env-commander');
      vi.stubEnv('SAML_SP_ACS_URL', 'http://localhost:3001/api/v1/auth/saml/acs');
      vi.stubEnv('SAML_ROLE_ATTRIBUTE', 'groups');
      vi.stubEnv('SAML_ADMIN_ROLES', 'super-admin,root');
      vi.stubEnv('SAML_OPERATOR_ROLES', 'dev,ops');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('creates plugin from environment variables', () => {
      const plugin = createSAMLPluginFromEnv();
      expect(plugin).not.toBeNull();
      const cfg = (plugin as any).config;
      expect(cfg.idpSsoUrl).toBe('https://env-idp.example.com/saml/sso');
      expect(cfg.idpEntityId).toBe('https://env-idp.example.com/saml/metadata');
      expect(cfg.spEntityId).toBe('env-commander');
      expect(cfg.roleAttribute).toBe('groups');
      expect(cfg.adminRoles).toEqual(['super-admin', 'root']);
      expect(cfg.operatorRoles).toEqual(['dev', 'ops']);
    });

    it('returns null when SAML_IDP_SSO_URL is missing', () => {
      vi.stubEnv('SAML_IDP_SSO_URL', '');
      const plugin = createSAMLPluginFromEnv();
      expect(plugin).toBeNull();
    });

    it('returns null when SAML_SP_ACS_URL is missing', () => {
      vi.stubEnv('SAML_SP_ACS_URL', '');
      const plugin = createSAMLPluginFromEnv();
      expect(plugin).toBeNull();
    });

    it('uses defaults when optional env vars are undefined', () => {
      vi.stubEnv('SAML_ROLE_ATTRIBUTE', undefined);
      vi.stubEnv('SAML_ADMIN_ROLES', undefined);
      vi.stubEnv('SAML_OPERATOR_ROLES', undefined);
      const plugin = createSAMLPluginFromEnv();
      expect(plugin).not.toBeNull();
      const cfg = (plugin as any).config;
      expect(cfg.roleAttribute).toBe('role');
      expect(cfg.adminRoles).toEqual(['admin']);
      expect(cfg.operatorRoles).toEqual(['operator', 'developer']);
    });
  });
});
