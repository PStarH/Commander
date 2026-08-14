import { FIXED_ACTION_ADAPTER_MANIFESTS } from '@commander/contracts';
import { AdapterExecutionError } from '@commander/effect-broker';
import type { EffectRemoteOutcome } from '@commander/effect-broker';
import { adapterFetch, assertOkResponse, readJsonResponse, type FetchFn } from '../http.js';
import type {
  ActionAdapter,
  AdapterCompensateInput,
  AdapterCredentialProvider,
  AdapterExecuteInput,
  AdapterQueryInput,
} from '../types.js';

const descriptor = FIXED_ACTION_ADAPTER_MANIFESTS.find(
  (manifest) => manifest.adapterId === 'kubernetes.deployment.rollback',
)!;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface KubernetesCredentials {
  cluster: string;
  server: string;
  token: string;
  caData?: string;
}

export interface KubernetesDeploymentRollbackAdapterOptions {
  credentials: AdapterCredentialProvider;
  fetch?: FetchFn;
  /**
   * Narrow post-commit hook used by the governed fault-control boundary.
   * It runs only after this adapter receives a successful Deployment PATCH.
   */
  afterPatchResponse?: (input: {
    tenantId: string;
    effectId: string;
    idempotencyKey: string;
    destination: string;
  }) => Promise<void>;
}

interface Destination {
  cluster: string;
  namespace: string;
  name: string;
}

function parseDestination(destination: string): Destination {
  const match = /^k8s:\/\/([^/]+)\/([^/]+)\/deployments\/([^/]+)$/.exec(destination);
  if (!match || !match[1] || !match[2] || !match[3]) {
    throw new AdapterExecutionError('Invalid Kubernetes destination', {
      code: 'KUBERNETES_DESTINATION_INVALID',
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
    });
  }
  const [cluster, namespace, name] = [match[1], match[2], match[3]];
  if (![cluster, namespace, name].every((value) => SEGMENT.test(value))) {
    throw new AdapterExecutionError('Invalid Kubernetes destination', {
      code: 'KUBERNETES_DESTINATION_INVALID',
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
    });
  }
  return { cluster, namespace, name };
}

function apiUrl(creds: KubernetesCredentials, destination: Destination): string {
  let base: URL;
  try {
    base = new URL(creds.server);
  } catch {
    throw new AdapterExecutionError('Invalid Kubernetes API server', {
      code: 'KUBERNETES_SERVER_INVALID',
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
    });
  }
  if (base.protocol !== 'https:') {
    throw new AdapterExecutionError('Kubernetes API server must use HTTPS', {
      code: 'KUBERNETES_SERVER_INSECURE',
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
    });
  }
  return `${base.toString().replace(/\/$/, '')}/apis/apps/v1/namespaces/${encodeURIComponent(destination.namespace)}/deployments/${encodeURIComponent(destination.name)}`;
}

function namespaceApiUrl(
  creds: KubernetesCredentials,
  destination: Destination,
  resource: string,
): string {
  return apiUrl(creds, destination).replace(
    `/deployments/${encodeURIComponent(destination.name)}`,
    `/${resource}`,
  );
}

function credentialsFor(
  provider: AdapterCredentialProvider,
  input: { tenantId: string; destination: string },
  destination: Destination,
): Promise<KubernetesCredentials> {
  if (!provider.getKubernetesCredentials) {
    throw new AdapterExecutionError('Kubernetes credentials are not configured', {
      code: 'KUBERNETES_CREDENTIALS_MISSING',
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
    });
  }
  return provider
    .getKubernetesCredentials(input.tenantId, input.destination)
    .then((credentials) => {
      if (
        !credentials?.cluster ||
        credentials.cluster !== destination.cluster ||
        !credentials.server ||
        !credentials.token
      ) {
        throw new AdapterExecutionError('Kubernetes cluster credential mismatch', {
          code: 'KUBERNETES_CREDENTIALS_MISMATCH',
          commitState: 'NOT_COMMITTED',
          retryMode: 'NEVER',
        });
      }
      return credentials;
    });
}

function headers(credentials: KubernetesCredentials): HeadersInit {
  return {
    Authorization: `Bearer ${credentials.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/merge-patch+json',
  };
}

function templatePatch(
  template: Record<string, unknown>,
  idempotencyKey: string,
  targetRevision: string,
  reason: string,
): Record<string, unknown> {
  const metadata = (template.metadata ?? {}) as Record<string, unknown>;
  const annotations = (metadata.annotations ?? {}) as Record<string, unknown>;
  return {
    spec: {
      template: {
        ...template,
        metadata: {
          ...metadata,
          annotations: {
            ...annotations,
            'commander.io/idempotency-key': idempotencyKey,
            'commander.io/target-revision': targetRevision,
            'commander.io/reason': reason,
          },
        },
      },
    },
  };
}

export function createKubernetesDeploymentRollbackAdapter(
  options: KubernetesDeploymentRollbackAdapterOptions,
): ActionAdapter {
  const rawFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) =>
    adapterFetch(rawFetch, url, init);

  async function read(
    input: AdapterQueryInput,
    destination: Destination,
    credentials: KubernetesCredentials,
  ): Promise<Record<string, unknown>> {
    const response = await fetchImpl(apiUrl(credentials, destination), {
      headers: headers(credentials),
      signal: input.signal,
    });
    if (response.status === 404) return {};
    await assertOkResponse(response, 'Kubernetes deployment query');
    return readJsonResponse<Record<string, unknown>>(response);
  }

  async function outcome(
    input: AdapterQueryInput,
    compensation = false,
  ): Promise<EffectRemoteOutcome> {
    const destination = parseDestination(input.destination);
    const credentials = await credentialsFor(options.credentials, input, destination);
    const deployment = await read(input, destination, credentials);
    const metadata = (deployment.metadata ?? {}) as Record<string, unknown>;
    const annotations = (
      (deployment.spec as Record<string, unknown> | undefined)?.template as
        Record<string, unknown> | undefined
    )?.metadata as Record<string, unknown> | undefined;
    const values = (annotations?.annotations ?? {}) as Record<string, unknown>;
    const target = String(input.request.targetRevision ?? input.request.expectedState ?? '');
    const key = String(input.request.idempotencyKey ?? input.idempotencyKey);
    if (
      !deployment.metadata ||
      values['commander.io/idempotency-key'] !== key ||
      (target && values['commander.io/target-revision'] !== target)
    )
      return { status: 'UNKNOWN' };
    return {
      status: 'COMPLETED',
      response: {
        deployment: destination.name,
        namespace: destination.namespace,
        revision: values['commander.io/target-revision'],
        status: compensation ? 'COMPENSATED' : 'ROLLED_BACK',
      },
    };
  }

  async function execute(input: AdapterExecuteInput): Promise<Record<string, unknown>> {
    const destination = parseDestination(input.destination);
    const targetRevision =
      typeof input.args.targetRevision === 'string' && input.args.targetRevision.trim()
        ? input.args.targetRevision
        : '';
    const reason =
      typeof input.args.reason === 'string' && input.args.reason.trim() ? input.args.reason : '';
    if (
      !targetRevision ||
      !reason ||
      Object.keys(input.args).some((key) => !['targetRevision', 'reason'].includes(key))
    ) {
      throw new AdapterExecutionError('Invalid Kubernetes rollback arguments', {
        code: 'KUBERNETES_ROLLBACK_ARGS_INVALID',
        commitState: 'NOT_COMMITTED',
        retryMode: 'NEVER',
      });
    }
    const credentials = await credentialsFor(options.credentials, input, destination);
    const existing = await outcome({
      ...input,
      request: { idempotencyKey: input.idempotencyKey, targetRevision },
    });
    if (existing.status === 'COMPLETED') return existing.response;
    const current = await read({ ...input, request: {} }, destination, credentials);
    const metadata = (current.metadata ?? {}) as Record<string, unknown>;
    const selector = (
      (current.spec as Record<string, unknown> | undefined)?.selector as
        Record<string, unknown> | undefined
    )?.matchLabels;
    if (
      !metadata.uid ||
      !selector ||
      typeof selector !== 'object' ||
      Object.keys(selector as Record<string, unknown>).length === 0
    ) {
      throw new AdapterExecutionError('Kubernetes deployment cannot be safely rolled back', {
        code: 'KUBERNETES_DEPLOYMENT_INVALID',
        commitState: 'NOT_COMMITTED',
        retryMode: 'NEVER',
      });
    }
    const labelSelector = new URLSearchParams({
      labelSelector: Object.entries(selector as Record<string, string>)
        .map(([key, value]) => `${key}=${value}`)
        .join(','),
    }).toString();
    const replicasResponse = await fetchImpl(
      `${namespaceApiUrl(credentials, destination, 'replicasets')}?${labelSelector}`,
      { headers: headers(credentials), signal: input.signal },
    );
    await assertOkResponse(replicasResponse, 'Kubernetes ReplicaSet query');
    const replicas = await readJsonResponse<{ items?: Array<Record<string, unknown>> }>(
      replicasResponse,
    );
    const replica = (replicas.items ?? []).find((item) => {
      const replicaMetadata = (item.metadata ?? {}) as Record<string, unknown>;
      const annotations = (replicaMetadata.annotations ?? {}) as Record<string, unknown>;
      const owners = Array.isArray(replicaMetadata.ownerReferences)
        ? replicaMetadata.ownerReferences
        : [];
      return (
        annotations['deployment.kubernetes.io/revision'] === targetRevision &&
        owners.some((owner) => (owner as Record<string, unknown>).uid === metadata.uid)
      );
    });
    const template = (replica?.spec as Record<string, unknown> | undefined)?.template;
    if (!template || typeof template !== 'object') {
      throw new AdapterExecutionError('Kubernetes deployment revision not found', {
        code: 'KUBERNETES_ROLLBACK_REVISION_NOT_FOUND',
        commitState: 'NOT_COMMITTED',
        retryMode: 'NEVER',
      });
    }
    const response = await fetchImpl(apiUrl(credentials, destination), {
      method: 'PATCH',
      headers: headers(credentials),
      body: JSON.stringify(
        templatePatch(
          template as Record<string, unknown>,
          input.idempotencyKey,
          targetRevision,
          reason,
        ),
      ),
      signal: input.signal,
    });
    await assertOkResponse(response, 'Kubernetes deployment rollback');
    await options.afterPatchResponse?.({
      tenantId: input.tenantId,
      effectId: input.effectId,
      idempotencyKey: input.idempotencyKey,
      destination: input.destination,
    });
    const deployment = await readJsonResponse<Record<string, unknown>>(response);
    return {
      deployment: destination.name,
      namespace: destination.namespace,
      revision: targetRevision,
      status: 'ROLLBACK_REQUESTED',
      resourceVersion: (deployment.metadata as Record<string, unknown> | undefined)
        ?.resourceVersion,
    };
  }

  return {
    descriptor,
    execute,
    queryOutcome: (input) => outcome(input),
    async compensate(input: AdapterCompensateInput): Promise<Record<string, unknown>> {
      const targetRevision = input.compensationPatch.targetRevision;
      const reason = input.compensationPatch.reason;
      return execute({ ...input, args: { targetRevision, reason } });
    },
    queryCompensationOutcome: (input) => outcome(input, true),
  };
}
