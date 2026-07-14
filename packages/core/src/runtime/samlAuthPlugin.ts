/**
 * SAML 2.0 Service Provider Authentication Plugin.
 *
 * Provides enterprise SSO for Commander using the SAML 2.0 Web Browser SSO
 * profile. Works alongside API key auth and OIDC: the HTTP server tries API
 * keys first, then delegates to registered auth plugins.
 *
 * Features:
 * - SP-initiated login via redirect binding (deflate + base64 + URL encode).
 * - Assertion Consumer Service (ACS) validation of SAMLResponse POSTs.
 * - Bearer-style authentication: `Authorization: Bearer <base64 SAMLResponse>`.
 * - RSA-SHA1 / RSA-SHA256 XML signature verification using the IdP certificate.
 * - Conditions validation (NotBefore, NotOnOrAfter, AudienceRestriction).
 * - Role mapping from SAML attributes to Commander roles.
 *
 * Limitations (zero-dependency implementation):
 * - Encrypted assertions are not supported.
 * - Only enveloped signatures on the Assertion are verified.
 * - Canonicalization is a best-effort EXC-C14N approximation; exotic IdP
 *   formatting may require pre-normalization of whitespace.
 *
 * Environment variables:
 *   SAML_IDP_SSO_URL=https://idp.example.com/saml/sso
 *   SAML_IDP_ENTITY_ID=https://idp.example.com/saml/metadata
 *   SAML_IDP_CERTIFICATE=-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----
 *   SAML_SP_ENTITY_ID=commander
 *   SAML_SP_ACS_URL=http://localhost:3001/api/v1/auth/saml/acs
 *   SAML_ROLE_ATTRIBUTE=role
 *   SAML_ADMIN_ROLES=admin,commander-admin
 *   SAML_OPERATOR_ROLES=operator,developer
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from '../security/securityAuditLogger';
import type { AuthPlugin, AuthPluginResult } from './authPlugin';
import type { AuthRole } from './authManager';

// ============================================================================
// Types
// ============================================================================

export interface SAMLPluginConfig {
  /** IdP single sign-on URL (redirect binding). */
  idpSsoUrl: string;
  /** IdP entity ID (issuer). */
  idpEntityId: string;
  /** Service Provider entity ID. */
  spEntityId: string;
  /** SP Assertion Consumer Service URL. */
  spAcsUrl: string;
  /** IdP X.509 certificate in PEM or single-line base64 form. */
  idpCertificate: string;
  /** SAML attribute containing role information (default: 'role'). */
  roleAttribute?: string;
  /** Attribute values that map to admin role (default: ['admin']). */
  adminRoles?: string[];
  /** Attribute values that map to operator role (default: ['operator', 'developer']). */
  operatorRoles?: string[];
  /** Max clock skew in seconds for condition validation (default: 60). */
  clockSkewSeconds?: number;
  /** Require the Assertion to carry a valid XML signature (default: true). */
  wantAssertionsSigned?: boolean;
  /** Expected XML signature algorithm (default: rsa-sha256). */
  signatureAlgorithm?: 'rsa-sha1' | 'rsa-sha256';
}

export interface SAMLAuthnRequest {
  /** URL to redirect the user agent to. */
  redirectUrl: string;
  /** RelayState value that should be returned by the IdP. */
  relayState?: string;
}

export interface SAMLValidationOptions {
  /** Expected InResponseTo value (from the original AuthnRequest ID). */
  inResponseTo?: string;
  /** Allow responses without InResponseTo (IdP-initiated). Default false. */
  allowIdpInitiated?: boolean;
}

interface ParsedAssertion {
  /** The Assertion's own ID attribute — the signature must reference exactly this. */
  id: string;
  nameId: string;
  attributes: Record<string, string | string[]>;
  issuer: string;
  notBefore?: string;
  notOnOrAfter?: string;
  audiences: string[];
  inResponseTo?: string;
  recipient?: string;
  signatureXml?: string;
  assertionXml: string;
}

// ============================================================================
// SAML Auth Plugin
// ============================================================================

/**
 * Zero-dependency SAML 2.0 Service Provider.
 */
export class SAMLAuthPlugin implements AuthPlugin {
  readonly name = 'saml';
  private config: Required<
    Pick<
      SAMLPluginConfig,
      | 'roleAttribute'
      | 'adminRoles'
      | 'operatorRoles'
      | 'clockSkewSeconds'
      | 'wantAssertionsSigned'
      | 'signatureAlgorithm'
    >
  > &
    Omit<
      SAMLPluginConfig,
      | 'roleAttribute'
      | 'adminRoles'
      | 'operatorRoles'
      | 'clockSkewSeconds'
      | 'wantAssertionsSigned'
      | 'signatureAlgorithm'
    >;

  constructor(config: SAMLPluginConfig) {
    this.config = {
      roleAttribute: 'role',
      adminRoles: ['admin'],
      operatorRoles: ['operator', 'developer'],
      clockSkewSeconds: 60,
      wantAssertionsSigned: true,
      signatureAlgorithm: 'rsa-sha256',
      ...config,
    };
  }

  /**
   * Authenticate a base64-encoded SAMLResponse passed as a Bearer token.
   * This allows API callers to reuse a SAMLResponse acquired via browser SSO.
   */
  async authenticate(bearerToken: string): Promise<AuthPluginResult | null> {
    const result = await this.validateSamlResponse(bearerToken, { allowIdpInitiated: true });
    if (!result) return null;
    return {
      userId: result.userId,
      username: result.username,
      role: result.role,
      tenantId: result.tenantId,
      claims: result.claims,
    };
  }

  /**
   * Build the SP-initiated login redirect URL.
   *
   * The returned URL points at the IdP and contains a deflated + base64 +
   * URL-encoded SAMLRequest. Optionally include a RelayState.
   */
  createLoginRedirectUrl(relayState?: string): string {
    const authnRequestId = `_${crypto.randomUUID()}`;
    const issueInstant = new Date().toISOString();
    const samlRequest =
      `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${authnRequestId}" ` +
      `Version="2.0" ` +
      `IssueInstant="${issueInstant}" ` +
      `Destination="${this.escapeXml(this.config.idpSsoUrl)}" ` +
      `AssertionConsumerServiceURL="${this.escapeXml(this.config.spAcsUrl)}">` +
      `<saml:Issuer>${this.escapeXml(this.config.spEntityId)}</saml:Issuer>` +
      `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>` +
      `</samlp:AuthnRequest>`;

    const deflated = zlib.deflateRawSync(Buffer.from(samlRequest, 'utf-8'));
    const encoded = deflated.toString('base64');
    const params = new URLSearchParams();
    params.set('SAMLRequest', encoded);
    if (relayState) params.set('RelayState', relayState);
    params.set('SigAlg', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
    return `${this.config.idpSsoUrl}${this.config.idpSsoUrl.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  /**
   * Validate a base64-encoded SAMLResponse (from POST ACS or Bearer token).
   * Returns normalized AuthPluginResult on success, null on failure.
   */
  async validateSamlResponse(
    base64Response: string,
    options: SAMLValidationOptions = {},
  ): Promise<AuthPluginResult | null> {
    const audit = getSecurityAuditLogger();

    let xml: string;
    try {
      xml = Buffer.from(base64Response, 'base64').toString('utf-8');
      if (!xml.startsWith('<')) {
        // Could be URL-encoded base64; try decoding again.
        xml = Buffer.from(decodeURIComponent(base64Response), 'base64').toString('utf-8');
      }
    } catch (err) {
      reportSilentFailure(err, 'samlAuthPlugin:decode');
      audit.logAuthFailure('SAMLAuthPlugin', 'Failed to decode SAMLResponse', {});
      return null;
    }

    if (!xml.includes('Response') || !xml.includes('<')) {
      audit.logAuthFailure('SAMLAuthPlugin', 'Decoded bytes are not valid SAML XML', {});
      return null;
    }

    // Parse response-level metadata.
    const responseId = extractAttribute(xml, 'Response', 'ID') ?? 'unknown';
    const responseInResponseTo = extractAttribute(xml, 'Response', 'InResponseTo');
    const responseDestination = extractAttribute(xml, 'Response', 'Destination');

    if (responseDestination && responseDestination !== this.config.spAcsUrl) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML Response Destination mismatch', {
        expected: this.config.spAcsUrl,
        actual: responseDestination,
      });
      return null;
    }

    if (
      responseInResponseTo &&
      options.inResponseTo &&
      responseInResponseTo !== options.inResponseTo
    ) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML InResponseTo mismatch', {
        expected: options.inResponseTo,
        actual: responseInResponseTo,
      });
      return null;
    }

    if (!responseInResponseTo && !options.allowIdpInitiated) {
      audit.logAuthFailure('SAMLAuthPlugin', 'IdP-initiated SAML Response rejected', {});
      return null;
    }

    // Extract and validate assertion.
    const assertion = this.extractAssertion(xml);
    if (!assertion) {
      audit.logAuthFailure('SAMLAuthPlugin', 'No usable Assertion found in SAMLResponse', {
        responseId,
      });
      return null;
    }

    // XSW (signature-wrapping) defense: a legitimate SAML Response carries exactly
    // one Assertion. An attacker forges a second (unsigned) Assertion and relies on
    // the verifier signing element A while reading attributes from element B. Reject
    // any response that does not contain exactly one Assertion, and require the
    // consumed Assertion to carry a document-unique ID that the signature can bind to.
    const assertionCount = (xml.match(/<(?:saml:)?Assertion\b/g) ?? []).length;
    if (assertionCount !== 1) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML response must contain exactly one Assertion', {
        responseId,
        assertionCount,
      });
      return null;
    }
    if (!assertion.id) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML Assertion is missing an ID', { responseId });
      return null;
    }
    const idOccurrences = (
      xml.match(new RegExp(`\\bID=(?:"|')${escapeRegex(assertion.id)}(?:"|')`, 'g')) ?? []
    ).length;
    if (idOccurrences !== 1) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML Assertion ID is not unique (possible XSW)', {
        responseId,
        assertionId: assertion.id,
        idOccurrences,
      });
      return null;
    }

    if (assertion.issuer !== this.config.idpEntityId) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML Assertion issuer mismatch', {
        expected: this.config.idpEntityId,
        actual: assertion.issuer,
      });
      return null;
    }

    if (assertion.recipient && assertion.recipient !== this.config.spAcsUrl) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML SubjectConfirmation Recipient mismatch', {
        expected: this.config.spAcsUrl,
        actual: assertion.recipient,
      });
      return null;
    }

    if (!this.validateConditions(assertion)) {
      return null;
    }

    if (this.config.wantAssertionsSigned) {
      if (!assertion.signatureXml) {
        audit.logAuthFailure('SAMLAuthPlugin', 'Assertion signature required but missing', {
          responseId,
        });
        return null;
      }
      const valid = this.verifyAssertionSignature(assertion);
      if (!valid) {
        audit.logAuthFailure('SAMLAuthPlugin', 'Assertion signature verification failed', {
          responseId,
        });
        return null;
      }
    }

    // Map roles from attributes.
    const rawRole = assertion.attributes[this.config.roleAttribute];
    const roleValues: string[] = rawRole ? (Array.isArray(rawRole) ? rawRole : [rawRole]) : [];
    let role: AuthRole = 'viewer';
    if (roleValues.some((r) => this.config.adminRoles.includes(r))) {
      role = 'admin';
    } else if (roleValues.some((r) => this.config.operatorRoles.includes(r))) {
      role = 'operator';
    }

    const username =
      (assertion.attributes['email'] as string | undefined) ||
      (assertion.attributes['emailAddress'] as string | undefined) ||
      assertion.nameId;

    const tenantId =
      (assertion.attributes['tenant_id'] as string | undefined) ||
      (assertion.attributes['tenantId'] as string | undefined);

    audit.logAuthSuccess('SAMLAuthPlugin', `SAML user authenticated: ${assertion.nameId}`, {
      nameId: assertion.nameId,
      issuer: assertion.issuer,
      role,
      tenantId,
    });

    return {
      userId: assertion.nameId,
      username,
      role,
      tenantId,
      claims: { ...assertion.attributes, issuer: assertion.issuer },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private extractAssertion(xml: string): ParsedAssertion | null {
    // Match the first <Assertion ...>...</Assertion> (default namespace or saml:).
    const assertionMatch = xml.match(/<(saml:|)Assertion\b[^>]*?>([\s\S]*?)<\/\1Assertion>/);
    if (!assertionMatch) return null;

    const assertionXml = assertionMatch[0];
    const inner = assertionMatch[2];

    // The Assertion's own ID — the XML signature must reference exactly this
    // element (XSW defense). Read only from the opening tag.
    const openTag = assertionXml.slice(0, assertionXml.indexOf('>') + 1);
    const assertionId = extractAttributeFromOpenTag(openTag, 'ID') ?? '';

    const issuer = extractText(inner, 'Issuer') ?? '';
    const nameId = extractText(inner, 'NameID') ?? extractText(inner, 'NameIdentifier') ?? '';

    const attributes: Record<string, string | string[]> = {};
    const attrRegex = /<(saml:|)Attribute\b[^>]*?Name="([^"]+)"[^>]*>([\s\S]*?)<\/\1Attribute>/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(inner)) !== null) {
      const attrName = attrMatch[2];
      const attrBody = attrMatch[3];
      const values: string[] = [];
      const valueRegex = /<(saml:|)AttributeValue\b[^>]*>([\s\S]*?)<\/\1AttributeValue>/g;
      let valueMatch: RegExpExecArray | null;
      while ((valueMatch = valueRegex.exec(attrBody)) !== null) {
        const raw = valueMatch[2].trim();
        // Strip optional nested XML tags (e.g. <xs:type> wrappers).
        const text = raw.replace(/<[^>]+>/g, '').trim();
        values.push(unescapeXml(text));
      }
      if (values.length > 0) {
        attributes[attrName] = values.length === 1 ? values[0] : values;
      }
    }

    const conditions = inner.match(/<(saml:|)Conditions\b([^>]*)>([\s\S]*?)<\/\1Conditions>/);
    const notBefore = conditions
      ? extractAttributeFromOpenTag(conditions[2], 'NotBefore')
      : undefined;
    const notOnOrAfter = conditions
      ? extractAttributeFromOpenTag(conditions[2], 'NotOnOrAfter')
      : undefined;
    const audienceXml = conditions ? conditions[3] : '';
    const audiences: string[] = [];
    const audRegex = /<(saml:|)Audience>([^<]+)<\/\1Audience>/g;
    let audMatch: RegExpExecArray | null;
    while ((audMatch = audRegex.exec(audienceXml)) !== null) {
      audiences.push(unescapeXml(audMatch[2].trim()));
    }

    const subjectConfirmation = inner.match(
      /<(saml:|)SubjectConfirmation\b([^>]*)>([\s\S]*?)<\/\1SubjectConfirmation>/,
    );
    const recipient = subjectConfirmation
      ? extractAttribute(subjectConfirmation[3], 'SubjectConfirmationData', 'Recipient')
      : undefined;
    const inResponseTo = subjectConfirmation
      ? extractAttribute(subjectConfirmation[3], 'SubjectConfirmationData', 'InResponseTo')
      : undefined;

    const signatureXml = extractSignatureElement(assertionXml);

    return {
      id: assertionId.trim(),
      nameId: unescapeXml(nameId.trim()),
      attributes,
      issuer: unescapeXml(issuer.trim()),
      notBefore,
      notOnOrAfter,
      audiences,
      inResponseTo,
      recipient,
      signatureXml,
      assertionXml,
    };
  }

  private validateConditions(assertion: ParsedAssertion): boolean {
    const audit = getSecurityAuditLogger();
    const skewMs = this.config.clockSkewSeconds * 1000;
    const now = Date.now();

    if (assertion.notBefore) {
      const notBefore = Date.parse(assertion.notBefore);
      if (!isNaN(notBefore) && now < notBefore - skewMs) {
        audit.logAuthFailure('SAMLAuthPlugin', 'SAML Assertion not yet valid', {
          notBefore: assertion.notBefore,
          now: new Date(now).toISOString(),
        });
        return false;
      }
    }

    if (assertion.notOnOrAfter) {
      const notOnOrAfter = Date.parse(assertion.notOnOrAfter);
      if (!isNaN(notOnOrAfter) && now > notOnOrAfter + skewMs) {
        audit.logAuthFailure('SAMLAuthPlugin', 'SAML Assertion expired', {
          notOnOrAfter: assertion.notOnOrAfter,
          now: new Date(now).toISOString(),
        });
        return false;
      }
    }

    if (assertion.audiences.length > 0 && !assertion.audiences.includes(this.config.spEntityId)) {
      audit.logAuthFailure('SAMLAuthPlugin', 'SAML AudienceRestriction mismatch', {
        expected: this.config.spEntityId,
        actual: assertion.audiences,
      });
      return false;
    }

    return true;
  }

  private verifyAssertionSignature(assertion: ParsedAssertion): boolean {
    if (!assertion.signatureXml) return false;

    try {
      const certPem = normalizeCertificate(this.config.idpCertificate);
      const publicKey = crypto.createPublicKey(certPem);
      const signedInfo = extractElement(assertion.signatureXml, 'SignedInfo');
      const signatureValue = extractText(assertion.signatureXml, 'SignatureValue')?.trim();
      if (!signedInfo || !signatureValue) return false;

      const sigAlg = extractSignatureAlgorithm(signedInfo);
      const digestAlg = extractDigestAlgorithm(signedInfo);
      const referenceUri = extractReferenceUri(signedInfo);

      if (!sigAlg || !digestAlg) return false;

      // XSW defense: the signature MUST reference the consumed Assertion by its
      // own unique ID. Reject an empty, mismatched, or non-fragment reference —
      // there is deliberately no whole-document fallback, which is the classic
      // signature-wrapping bypass.
      if (!assertion.id) return false;
      if (!referenceUri || referenceUri !== `#${assertion.id}`) {
        getGlobalLogger().warn(
          'SAMLAuthPlugin',
          'SAML signature Reference does not bind to the consumed Assertion (possible XSW)',
          { referenceUri, assertionId: assertion.id },
        );
        return false;
      }

      // 1. Verify the reference digest over the signed object (the Assertion itself).
      const signedObject = extractById(assertion.assertionXml, assertion.id);
      if (!signedObject) return false;

      // Strip the signature from the signed object and approximate C14N.
      const objectWithoutSignature = removeSignatureElement(signedObject);
      const canonicalizedObject = approximateC14n(objectWithoutSignature);
      const expectedDigest = crypto
        .createHash(digestAlg)
        .update(canonicalizedObject, 'utf-8')
        .digest('base64');
      const digestValue = extractText(signedInfo, 'DigestValue')?.trim();
      if (!digestValue || digestValue !== expectedDigest) {
        getGlobalLogger().debug('SAMLAuthPlugin', 'SAML digest mismatch', {
          expected: expectedDigest,
          actual: digestValue,
        });
        return false;
      }

      // 2. Verify the signature over the canonicalized SignedInfo.
      const canonicalizedSignedInfo = approximateC14n(signedInfo);
      const signatureBuf = Buffer.from(signatureValue, 'base64');
      return crypto.verify(
        sigAlg,
        Buffer.from(canonicalizedSignedInfo, 'utf-8'),
        publicKey,
        signatureBuf,
      );
    } catch (err) {
      reportSilentFailure(err, 'samlAuthPlugin:verifySignature');
      return false;
    }
  }
}

// ============================================================================
// Static helpers
// ============================================================================

function normalizeCertificate(cert: string): string {
  const trimmed = cert.trim();
  if (trimmed.includes('-----BEGIN CERTIFICATE-----')) {
    const stripped = trimmed
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    return `-----BEGIN CERTIFICATE-----\n${stripped}\n-----END CERTIFICATE-----\n`;
  }
  // Accept a raw SPKI/PKCS#1 public key directly.
  return trimmed;
}

function extractAttribute(xml: string, elementName: string, attrName: string): string | undefined {
  const regex = new RegExp(`<([\\w:]+)?${elementName}\\b([^>]*)>`, 'i');
  const match = xml.match(regex);
  if (!match) return undefined;
  return extractAttributeFromOpenTag(match[2], attrName);
}

function extractAttributeFromOpenTag(openTag: string, attrName: string): string | undefined {
  const regex = new RegExp(`\\b${attrName}="([^"]*)"`, 'i');
  const match = openTag.match(regex);
  return match ? match[1] : undefined;
}

function extractText(xml: string, elementName: string): string | undefined {
  const regex = new RegExp(
    `<([\\w:]+)?${elementName}\\b(?:[^>]*)>([^<]*)</\\1?${elementName}>`,
    'i',
  );
  const match = xml.match(regex);
  return match ? match[2] : undefined;
}

function extractElement(xml: string, elementName: string): string | undefined {
  const regex = new RegExp(
    `<([\\w:]+)?${elementName}\\b[^>]*>([\\s\\S]*?)</\\1?${elementName}>`,
    'i',
  );
  const match = xml.match(regex);
  return match ? match[0] : undefined;
}

function extractById(xml: string, id: string): string | undefined {
  const regex = new RegExp(
    `<([\\w:]+)?([\\w]+)\\b[^>]*\\bID="${escapeRegex(id)}"[^>]*>([\\s\\S]*?)</\\1?\\2>`,
    'i',
  );
  const match = xml.match(regex);
  return match ? match[0] : undefined;
}

function extractSignatureElement(xml: string): string | undefined {
  // Match ds:Signature or Signature with optional namespace prefix.
  const match = xml.match(/<(ds:|)Signature\b[^>]*>([\s\S]*?)<\/\1Signature>/);
  return match ? match[0] : undefined;
}

function removeSignatureElement(xml: string): string {
  return xml.replace(/<(ds:|)Signature\b[^>]*>[\s\S]*?<\/\1Signature>/, '');
}

function extractReferenceUri(signedInfo: string): string | undefined {
  const match = signedInfo.match(/<([\w:]+)?Reference\b[^>]*\sURI="([^"]*)"/);
  return match ? match[2] : undefined;
}

function extractSignatureAlgorithm(signedInfo: string): string | undefined {
  const match = signedInfo.match(/<([\w:]+)?SignatureMethod\b[^>]*\sAlgorithm="([^"]+)"/);
  const uri = match ? match[2] : undefined;
  if (!uri) return undefined;
  if (uri.includes('rsa-sha256') || uri.includes('sha256')) return 'sha256';
  if (uri.includes('rsa-sha1') || uri.includes('sha1')) return 'sha1';
  return undefined;
}

function extractDigestAlgorithm(signedInfo: string): string | undefined {
  const match = signedInfo.match(/<([\w:]+)?DigestMethod\b[^>]*\sAlgorithm="([^"]+)"/);
  const uri = match ? match[2] : undefined;
  if (!uri) return undefined;
  if (uri.includes('sha256')) return 'sha256';
  if (uri.includes('sha1')) return 'sha1';
  return undefined;
}

/**
 * Best-effort exclusive C14N approximation.
 *
 * Real EXC-C14N is complex. This implementation normalizes the most common
 * sources of mismatch for self-contained signed XML: whitespace, attribute
 * quoting, and empty tags. It is sufficient for tests and many IdPs that emit
 * pretty-printed but otherwise predictable XML.
 */
function approximateC14n(xml: string): string {
  // Sort attributes alphabetically within each opening tag.
  return xml
    .replace(/>(\s+)</g, '><')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*>/g, '/>')
    .replace(/<(\/?)([\w:]+)([^>]*)>/g, (_full, slash, name, attrs) => {
      const trimmed = attrs.trim();
      if (!trimmed) return `<${slash}${name}>`;
      const attrList = trimmed
        .split(/(\w+(?::\w+)?="[^"]*")/g)
        .filter((s: string) => s.trim() && s.includes('='))
        .map((s: string) => s.trim());
      const unique = Array.from(new Set<string>(attrList));
      unique.sort((a: string, b: string) => {
        const nameA = a.split('=')[0].toLowerCase();
        const nameB = b.split('=')[0].toLowerCase();
        return nameA.localeCompare(nameB);
      });
      return `<${slash}${name} ${unique.join(' ')}>`;
    });
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Helper: create from env vars
// ============================================================================

/**
 * Create SAMLAuthPlugin from environment variables.
 * Returns null if required SAML_* variables are not set.
 */
export function createSAMLPluginFromEnv(): SAMLAuthPlugin | null {
  const idpSsoUrl = process.env.SAML_IDP_SSO_URL;
  const idpEntityId = process.env.SAML_IDP_ENTITY_ID;
  const idpCertificate = process.env.SAML_IDP_CERTIFICATE;
  const spEntityId = process.env.SAML_SP_ENTITY_ID;
  const spAcsUrl = process.env.SAML_SP_ACS_URL;

  if (!idpSsoUrl || !idpEntityId || !idpCertificate || !spEntityId || !spAcsUrl) {
    return null;
  }

  return new SAMLAuthPlugin({
    idpSsoUrl,
    idpEntityId,
    idpCertificate,
    spEntityId,
    spAcsUrl,
    roleAttribute: process.env.SAML_ROLE_ATTRIBUTE ?? 'role',
    adminRoles: (process.env.SAML_ADMIN_ROLES?.split(',') ?? ['admin']).map((s) => s.trim()),
    operatorRoles: (process.env.SAML_OPERATOR_ROLES?.split(',') ?? ['operator', 'developer']).map(
      (s) => s.trim(),
    ),
    wantAssertionsSigned: process.env.SAML_WANT_ASSERTIONS_SIGNED !== 'false',
    signatureAlgorithm:
      process.env.SAML_SIGNATURE_ALGORITHM === 'rsa-sha1' ? 'rsa-sha1' : 'rsa-sha256',
  });
}
