import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOIDCAuthorizationUrl,
  discoverOIDCAuthorizationEndpoint,
} from '../src/api.ts';

test('rejects a non-https issuer and a javascript authorization endpoint', async () => {
  await assert.rejects(() => discoverOIDCAuthorizationEndpoint('javascript:alert(1)'));
  await assert.rejects(() => discoverOIDCAuthorizationEndpoint('http://idp.example/'));
});

test('rejects a discovered authorization endpoint on another origin', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ authorization_endpoint: 'https://evil.example/authorize' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => discoverOIDCAuthorizationEndpoint('https://idp.example'),
      /origin does not match/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('builds an https authorization url and rejects a foreign redirect', () => {
  const url = buildOIDCAuthorizationUrl(
    'https://idp.example/oauth2/authorize',
    'client',
    'https://app.example/login',
  );
  assert.equal(new URL(url).origin, 'https://idp.example');
  assert.equal(new URL(url).searchParams.get('redirect_uri'), 'https://app.example/login');
  assert.throws(() =>
    buildOIDCAuthorizationUrl(
      'https://idp.example/oauth2/authorize',
      'client',
      'https://evil.example/steal',
    ),
  );
});
