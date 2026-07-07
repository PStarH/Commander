/**
 * Standalone smoke test for the SAML 2.0 auth plugin.
 *
 * This script runs outside vitest so it is not affected by the tenant-context
 * setup issue in the current test harness. It exercises the full SAML flow:
 * SP-initiated redirect URL generation, signed SAMLResponse validation,
 * failure cases, and environment-variable initialization.
 */

import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';

// Use dynamic import so we can set the tenant context before loading modules
// that touch tenant-aware singletons.
const { runWithTenant } = await import('../src/runtime/tenantContext.ts');

await runWithTenant(undefined, async () => {
  const { SAMLAuthPlugin, createSAMLPluginFromEnv } = await import(
    '../src/runtime/samlAuthPlugin.ts'
  );

  function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const certificate = publicKey.export({ type: 'spki', format: 'pem' });
    return { publicKey, privateKey, certificate };
  }

  function approximateC14n(xml) {
    return xml
      .replace(/>\s+</g, '><')
      .replace(/\s+/g, ' ')
      .replace(/\s*\/\s*>/g, '/>')
      .replace(/<(\/?)([\w:]+)([^>]*)>/g, (_full, slash, name, attrs) => {
        const trimmed = attrs.trim();
        if (!trimmed) return `<${slash}${name}>`;
        const attrList = trimmed
          .split(/(\w+(?::\w+)?="[^"]*")/g)
          .filter((s) => s.trim() && s.includes('='))
          .map((s) => s.trim());
        const unique = Array.from(new Set(attrList));
        unique.sort((a, b) => {
          const nameA = a.split('=')[0].toLowerCase();
          const nameB = b.split('=')[0].toLowerCase();
          return nameA.localeCompare(nameB);
        });
        return `<${slash}${name} ${unique.join(' ')}>`;
      });
  }

  function createSignedSamlResponse(config, keys, options = {}) {
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
    const roleAttributeXml = roleValues.map((r) => `<saml:AttributeValue>${r}</saml:AttributeValue>`).join('');

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
      `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
      `<saml:Attribute Name="role">${roleAttributeXml}</saml:Attribute>` +
      (options.tenantId
        ? `<saml:Attribute Name="tenant_id"><saml:AttributeValue>${options.tenantId}</saml:AttributeValue></saml:Attribute>`
        : '') +
      `</saml:AttributeStatement>` +
      `</saml:Assertion>`;

    const objectWithoutSignature = assertionXml;
    const canonicalizedObject = approximateC14n(objectWithoutSignature);
    const digestValue = crypto.createHash('sha256').update(canonicalizedObject, 'utf-8').digest('base64');

    const signedInfo =
      `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
      `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
      `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
      `<ds:Reference URI="#${assertionId}">` +
      `<ds:Transforms>` +
      `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
      `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
      `</ds:Transforms>` +
      `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
      `<ds:DigestValue>${digestValue}</ds:DigestValue>` +
      `</ds:Reference>` +
      `</ds:SignedInfo>`;

    const canonicalizedSignedInfo = approximateC14n(signedInfo);
    const signatureValue = crypto
      .sign('sha256', Buffer.from(canonicalizedSignedInfo, 'utf-8'), keys.privateKey)
      .toString('base64');

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

    assertionXml = assertionXml.replace('</saml:Issuer>', `</saml:Issuer>${signatureXml}`);

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

  function baseConfig(certificate) {
    return {
      idpSsoUrl: 'https://idp.example.com/saml/sso',
      idpEntityId: 'https://idp.example.com/saml/metadata',
      spEntityId: 'commander',
      spAcsUrl: 'http://localhost:3001/api/v1/auth/saml/acs',
      idpCertificate: certificate,
    };
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  const keys = generateKeyPair();
  const config = baseConfig(keys.certificate);
  const plugin = new SAMLAuthPlugin(config);

  // 1. Valid signed response
  const response = createSignedSamlResponse(config, keys, { roles: 'admin' });
  const result = await plugin.authenticate(response);
  assert(result !== null, 'valid response should authenticate');
  assert(result.userId === 'alice@example.com', 'userId matches');
  assert(result.username === 'alice@example.com', 'username matches');
  assert(result.role === 'admin', 'role mapped to admin');

  // 2. Wrong issuer rejected
  const wrongIssuer = createSignedSamlResponse(config, keys, { issuer: 'https://evil.com' });
  assert((await plugin.authenticate(wrongIssuer)) === null, 'wrong issuer rejected');

  // 3. Expired response rejected
  const expired = createSignedSamlResponse(config, keys, {
    notOnOrAfter: new Date(Date.now() - 3_600_000).toISOString(),
  });
  assert((await plugin.authenticate(expired)) === null, 'expired response rejected');

  // 4. Tampered digest rejected
  const tamperedDigest = createSignedSamlResponse(config, keys);
  const tamperedXml = Buffer.from(tamperedDigest, 'base64')
    .toString('utf-8')
    .replace('<saml:Attribute Name="role">', '<saml:Attribute Name="role">');
  // Real tampering: modify a role value after signing.
  const forgedXml = tamperedXml.replace('<saml:AttributeValue>operator</saml:AttributeValue>', '<saml:AttributeValue>admin</saml:AttributeValue>');
  const forgedResponse = Buffer.from(forgedXml).toString('base64');
  assert((await plugin.authenticate(forgedResponse)) === null, 'tampered response rejected');

  // 5. SP-initiated login redirect
  const redirectUrl = plugin.createLoginRedirectUrl('session-123');
  assert(redirectUrl.startsWith(config.idpSsoUrl), 'redirect URL points to IdP');
  const parsed = new URL(redirectUrl);
  const deflated = Buffer.from(parsed.searchParams.get('SAMLRequest'), 'base64');
  const xml = zlib.inflateRawSync(deflated).toString('utf-8');
  assert(xml.includes('AuthnRequest'), 'redirect contains AuthnRequest');
  assert(parsed.searchParams.get('RelayState') === 'session-123', 'RelayState preserved');

  // 6. Environment variable initialization
  process.env.SAML_IDP_SSO_URL = 'https://env-idp.example.com/saml/sso';
  process.env.SAML_IDP_ENTITY_ID = 'https://env-idp.example.com/saml/metadata';
  process.env.SAML_IDP_CERTIFICATE = keys.certificate;
  process.env.SAML_SP_ENTITY_ID = 'env-commander';
  process.env.SAML_SP_ACS_URL = 'http://localhost:3001/api/v1/auth/saml/acs';
  process.env.SAML_ROLE_ATTRIBUTE = 'groups';
  process.env.SAML_ADMIN_ROLES = 'super-admin';
  process.env.SAML_OPERATOR_ROLES = 'dev';
  const envPlugin = createSAMLPluginFromEnv();
  assert(envPlugin !== null, 'env plugin created');
  assert(envPlugin.config.roleAttribute === 'groups', 'env role attribute');

  console.log('SAML smoke tests passed');
});
