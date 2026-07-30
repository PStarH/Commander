import type { EffectRemoteOutcome } from '@commander/effect-broker';
import type { ActionAdapterDescriptorV1 } from '@commander/contracts';

export interface AdapterExecuteInput {
  tenantId: string;
  effectId: string;
  idempotencyKey: string;
  destination: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AdapterQueryInput {
  tenantId: string;
  effectId: string;
  idempotencyKey: string;
  destination: string;
  request: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AdapterCompensateInput {
  tenantId: string;
  effectId: string;
  originalEffectId: string;
  idempotencyKey: string;
  destination: string;
  forwardResponse: Record<string, unknown>;
  compensationPatch: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ActionAdapter {
  readonly descriptor: ActionAdapterDescriptorV1;
  execute(input: AdapterExecuteInput): Promise<Record<string, unknown>>;
  queryOutcome(input: AdapterQueryInput): Promise<EffectRemoteOutcome>;
  compensate(input: AdapterCompensateInput): Promise<Record<string, unknown>>;
  queryCompensationOutcome(
    input: AdapterQueryInput & { compensationResponse?: Record<string, unknown> },
  ): Promise<EffectRemoteOutcome>;
}

export interface AdapterCredentialProvider {
  getGitHubToken(tenantId: string, destination: string): Promise<string>;
  getServiceNowCredentials(
    tenantId: string,
    destination: string,
  ): Promise<{ instance: string; username: string; password: string }>;
}

export interface KubernetesCredentialProvider {
  getToken(tenantId: string, cluster: string, namespace: string): Promise<string>;
  getServer(tenantId: string, cluster: string, namespace: string): URL;
}

export interface KubernetesClusterCredentialConfig {
  server: string | URL;
  tokenEnv: string;
  namespaces?: readonly string[];
}

export interface EnvAdapterCredentialProviderOptions {
  cellTenantId: string;
  githubTokenEnv?: string;
  serviceNowInstanceEnv?: string;
  serviceNowUsernameEnv?: string;
  serviceNowPasswordEnv?: string;
  kubernetesClusters?: Readonly<Record<string, KubernetesClusterCredentialConfig>>;
}

export class EnvAdapterCredentialProvider
  implements AdapterCredentialProvider, KubernetesCredentialProvider
{
  private readonly cellTenantId: string;
  private readonly githubTokenEnv: string;
  private readonly serviceNowInstanceEnv: string;
  private readonly serviceNowUsernameEnv: string;
  private readonly serviceNowPasswordEnv: string;
  private readonly kubernetesClusters: ReadonlyMap<
    string,
    { server: URL; tokenEnv: string; namespaces: ReadonlySet<string> }
  >;

  constructor(options: EnvAdapterCredentialProviderOptions) {
    if (!options.cellTenantId) {
      throw new Error('COMMANDER_CELL_TENANT_ID is required for EnvAdapterCredentialProvider');
    }
    this.cellTenantId = options.cellTenantId;
    this.githubTokenEnv = options.githubTokenEnv ?? 'GITHUB_TOKEN';
    this.serviceNowInstanceEnv = options.serviceNowInstanceEnv ?? 'SERVICENOW_INSTANCE';
    this.serviceNowUsernameEnv = options.serviceNowUsernameEnv ?? 'SERVICENOW_USERNAME';
    this.serviceNowPasswordEnv = options.serviceNowPasswordEnv ?? 'SERVICENOW_PASSWORD';
    this.kubernetesClusters = new Map(
      Object.entries(options.kubernetesClusters ?? {}).map(([cluster, config]) => {
        const configuredNamespaces =
          config.namespaces ?? process.env.COMMANDER_KUBERNETES_NAMESPACES?.split(',') ?? [];
        if (!isDnsSubdomain(cluster) || !config.tokenEnv || configuredNamespaces.length === 0) {
          throw new Error(`Invalid Kubernetes cluster credential registration: ${cluster}`);
        }
        const namespaces = new Set(configuredNamespaces);
        if (
          namespaces.size !== configuredNamespaces.length ||
          [...namespaces].some((value) => !isDnsLabel(value))
        ) {
          throw new Error(`Invalid Kubernetes namespace credential registration: ${cluster}`);
        }
        const server = new URL(config.server);
        if (
          server.protocol !== 'https:' ||
          server.username ||
          server.password ||
          server.search ||
          server.hash
        ) {
          throw new Error(`Invalid Kubernetes API server registration: ${cluster}`);
        }
        return [cluster, { server, tokenEnv: config.tokenEnv, namespaces }] as const;
      }),
    );
  }

  static fromProcessEnv(): EnvAdapterCredentialProvider {
    const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID;
    if (!cellTenantId) {
      throw new Error('COMMANDER_CELL_TENANT_ID is required');
    }
    const cluster = process.env.COMMANDER_KUBERNETES_CLUSTER;
    const server = process.env.COMMANDER_KUBERNETES_SERVER;
    const tokenEnv = process.env.COMMANDER_KUBERNETES_TOKEN_ENV;
    const namespaces = process.env.COMMANDER_KUBERNETES_NAMESPACES;
    if (
      (cluster || server || tokenEnv || namespaces) &&
      !(cluster && server && tokenEnv && namespaces)
    ) {
      throw new Error(
        'COMMANDER_KUBERNETES_CLUSTER, COMMANDER_KUBERNETES_SERVER, COMMANDER_KUBERNETES_TOKEN_ENV, and COMMANDER_KUBERNETES_NAMESPACES must be configured together',
      );
    }
    return new EnvAdapterCredentialProvider({
      cellTenantId,
      kubernetesClusters:
        cluster && server && tokenEnv && namespaces
          ? { [cluster]: { server, tokenEnv, namespaces: namespaces.split(',') } }
          : undefined,
    });
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.cellTenantId) {
      throw new Error('Tenant credential isolation violation');
    }
  }

  async getGitHubToken(tenantId: string, _destination: string): Promise<string> {
    this.assertTenant(tenantId);
    const token =
      process.env[this.githubTokenEnv] ??
      (this.githubTokenEnv === 'GITHUB_TOKEN' ? process.env.GITHUB_PAT : undefined);
    if (!token) {
      throw new Error('GitHub credentials are not configured');
    }
    return token;
  }

  async getServiceNowCredentials(
    tenantId: string,
    destination: string,
  ): Promise<{ instance: string; username: string; password: string }> {
    this.assertTenant(tenantId);
    const instance = process.env[this.serviceNowInstanceEnv];
    const username = process.env[this.serviceNowUsernameEnv];
    const password = process.env[this.serviceNowPasswordEnv];
    if (!instance || !username || !password) {
      throw new Error('ServiceNow credentials are not configured');
    }
    const parsed = parseServiceNowDestination(destination);
    if (parsed.instance !== instance) {
      throw new Error('ServiceNow instance mismatch');
    }
    return { instance, username, password };
  }

  private kubernetesRegistration(tenantId: string, cluster: string, namespace: string) {
    this.assertTenant(tenantId);
    const registration = this.kubernetesClusters.get(cluster);
    if (!registration) {
      throw new Error(`Kubernetes cluster is not registered: ${cluster}`);
    }
    if (!registration.namespaces.has(namespace)) {
      throw new Error(`Kubernetes namespace is not authorized: ${cluster}/${namespace}`);
    }
    return registration;
  }

  async getToken(tenantId: string, cluster: string, namespace: string): Promise<string> {
    const registration = this.kubernetesRegistration(tenantId, cluster, namespace);
    const token = process.env[registration.tokenEnv];
    if (!token) {
      throw new Error(`Kubernetes credentials are not configured for cluster: ${cluster}`);
    }
    return token;
  }

  getServer(tenantId: string, cluster: string, namespace: string): URL {
    const registration = this.kubernetesRegistration(tenantId, cluster, namespace);
    return new URL(registration.server.href);
  }
}

export interface AdapterEvidenceSummary {
  remoteId?: string;
  status?: string;
  httpStatus?: number;
  errorCode?: string;
}

const GITHUB_DEST_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DNS_SAFE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isDnsLabel(value: string): boolean {
  return value.length <= 63 && DNS_SAFE_LABEL.test(value);
}

function isDnsSubdomain(value: string): boolean {
  return value.length <= 253 && value.split('.').every((label) => DNS_SAFE_LABEL.test(label));
}

export function parseGitHubDestination(destination: string): { owner: string; repo: string } {
  const match = /^github:\/\/([^/]+)\/([^/]+)\/pulls$/.exec(destination);
  if (!match) {
    throw new Error(`Invalid GitHub destination: ${destination}`);
  }
  const owner = match[1]!;
  const repo = match[2]!;
  // Align with findAdapterManifest placeholder charset (fail-closed).
  if (!GITHUB_DEST_SEGMENT.test(owner) || !GITHUB_DEST_SEGMENT.test(repo)) {
    throw new Error(`Invalid GitHub destination: ${destination}`);
  }
  return { owner, repo };
}

export function parseServiceNowDestination(destination: string): { instance: string } {
  const match = /^servicenow:\/\/([^/]+)\/incident$/.exec(destination);
  if (!match) {
    throw new Error(`Invalid ServiceNow destination: ${destination}`);
  }
  const instance = match[1]!;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(instance)) {
    throw new Error(`Invalid ServiceNow instance name: ${instance}`);
  }
  return { instance };
}

export function parseKubernetesDeploymentDestination(destination: string): {
  cluster: string;
  namespace: string;
  name: string;
} {
  const match = /^k8s:\/\/([^/]+)\/([^/]+)\/deployments\/([^/]+)$/.exec(destination);
  if (!match) {
    throw new Error(`Invalid Kubernetes deployment destination: ${destination}`);
  }
  const cluster = match[1]!;
  const namespace = match[2]!;
  const name = match[3]!;
  if (!isDnsSubdomain(cluster) || !isDnsLabel(namespace) || !isDnsLabel(name)) {
    throw new Error(`Invalid Kubernetes deployment destination: ${destination}`);
  }
  return { cluster, namespace, name };
}

export function toEvidenceSummary(
  descriptor: ActionAdapterDescriptorV1,
  response: Record<string, unknown>,
): AdapterEvidenceSummary {
  const summary: AdapterEvidenceSummary = {};
  for (const key of descriptor.evidenceResponseSummaryKeys) {
    if (key in response) {
      const value = response[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        (summary as Record<string, unknown>)[key] = value;
      }
    }
  }
  return summary;
}
