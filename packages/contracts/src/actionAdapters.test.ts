import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  commanderActionMarker,
  compensationIdempotencyKey,
  evaluateManifestGatewayEffect,
  findAdapterManifest,
  FIXED_ACTION_ADAPTER_MANIFESTS,
  githubPrBodyMarker,
  GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
  KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
  servicenowCorrelationId,
  SERVICENOW_INCIDENT_CREATE_DESCRIPTOR,
} from './actionAdapters.js';

describe('actionAdapters contracts', () => {
  it('exposes the fixed production manifests', () => {
    assert.equal(FIXED_ACTION_ADAPTER_MANIFESTS.length, 3);
    assert.equal(FIXED_ACTION_ADAPTER_MANIFESTS[0]?.adapterId, 'github.pull-request.create');
    assert.equal(FIXED_ACTION_ADAPTER_MANIFESTS[1]?.adapterId, 'servicenow.incident.create');
    assert.equal(FIXED_ACTION_ADAPTER_MANIFESTS[2]?.adapterId, 'kubernetes.deployment.rollback');
  });

  it('findAdapterManifest matches registered GitHub destination', () => {
    const manifest = findAdapterManifest({
      effectType: 'connector.github.pull-request.create',
      toolName: 'github.pull-request.create',
      destination: 'github://octo/repo/pulls',
    });
    assert.equal(manifest, GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR);
  });

  it('findAdapterManifest matches registered ServiceNow destination', () => {
    const manifest = findAdapterManifest({
      effectType: 'connector.servicenow.incident.create',
      toolName: 'servicenow.incident.create',
      destination: 'servicenow://dev12345/incident',
    });
    assert.equal(manifest, SERVICENOW_INCIDENT_CREATE_DESCRIPTOR);
  });

  it('findAdapterManifest returns null for unregistered effect', () => {
    assert.equal(
      findAdapterManifest({
        effectType: 'demo.ticket.create',
        toolName: 'ticket.create',
        destination: 'ticket://local',
      }),
      null,
    );
  });

  it('findAdapterManifest returns null for destination mismatch', () => {
    assert.equal(
      findAdapterManifest({
        effectType: 'connector.github.pull-request.create',
        toolName: 'github.pull-request.create',
        destination: 'github://octo/repo/issues',
      }),
      null,
    );
  });

  it('findAdapterManifest matches the Kubernetes rollback destination', () => {
    const manifest = findAdapterManifest({
      effectType: 'mutate.kubernetes.deployment.rollback',
      toolName: 'kubernetes.deployment.rollback',
      destination: 'k8s://kind/commander/deployments/api',
    });
    assert.equal(manifest, KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR);
    assert.equal(
      evaluateManifestGatewayEffect(
        KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
        'k8s://kind/commander/deployments/api',
      ),
      'require_approval',
    );
  });

  it('fails closed for Kubernetes effect and destination shape mismatches', () => {
    const cases = [
      {
        effectType: 'connector.kubernetes.deployment.rollback',
        toolName: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/commander/deployments/api',
      },
      {
        effectType: 'mutate.kubernetes.deployment.rollback',
        toolName: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/other%2Ftenant/deployments/api',
      },
      {
        effectType: 'mutate.kubernetes.deployment.rollback',
        toolName: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/commander/services/api',
      },
      {
        effectType: 'mutate.kubernetes.deployment.rollback',
        toolName: 'kubernetes.deployment.rollback',
        destination: 'k8s://kind/commander/deployments/api/extra',
      },
    ] as const;
    for (const input of cases) assert.equal(findAdapterManifest(input), null);
  });

  it('findAdapterManifest rejects malicious ServiceNow placeholder values', () => {
    assert.equal(
      findAdapterManifest({
        effectType: 'connector.servicenow.incident.create',
        toolName: 'servicenow.incident.create',
        destination: 'servicenow://evil.com@attacker/incident',
      }),
      null,
    );
  });

  it('findAdapterManifest rejects GitHub owner/repo outside opaque charset', () => {
    assert.equal(
      findAdapterManifest({
        effectType: 'connector.github.pull-request.create',
        toolName: 'github.pull-request.create',
        destination: 'github://octo/repo with space/pulls',
      }),
      null,
    );
  });

  it('evaluateManifestGatewayEffect denies destination mismatch', () => {
    assert.equal(
      evaluateManifestGatewayEffect(
        GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
        'github://octo/repo/issues',
      ),
      'deny',
    );
  });

  it('evaluateManifestGatewayEffect returns manifest default for matching destination', () => {
    assert.equal(
      evaluateManifestGatewayEffect(
        GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
        'github://octo/repo/pulls',
      ),
      'require_approval',
    );
  });

  it('commanderActionMarker is stable sha256 of tenant and idempotency key', () => {
    const expected = createHash('sha256').update('tenant-a\0idem-1').digest('hex');
    assert.equal(commanderActionMarker('tenant-a', 'idem-1'), expected);
  });

  it('githubPrBodyMarker wraps commander marker in HTML comment', () => {
    const marker = commanderActionMarker('tenant-a', 'idem-1');
    assert.equal(githubPrBodyMarker('tenant-a', 'idem-1'), `<!-- commander-action:${marker} -->`);
  });

  it('servicenowCorrelationId prefixes commander marker', () => {
    const marker = commanderActionMarker('tenant-a', 'idem-1');
    assert.equal(servicenowCorrelationId('tenant-a', 'idem-1'), `commander:${marker}`);
  });

  it('compensationIdempotencyKey follows cmp:effect:version format', () => {
    assert.equal(compensationIdempotencyKey('eff-1', '1.0.0'), 'cmp:eff-1:1.0.0');
  });
});
