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

export interface EnvAdapterCredentialProviderOptions {
  cellTenantId: string;
  githubTokenEnv?: string;
  serviceNowInstanceEnv?: string;
  serviceNowUsernameEnv?: string;
  serviceNowPasswordEnv?: string;
}

export class EnvAdapterCredentialProvider implements AdapterCredentialProvider {
  private readonly cellTenantId: string;
  private readonly githubTokenEnv: string;
  private readonly serviceNowInstanceEnv: string;
  private readonly serviceNowUsernameEnv: string;
  private readonly serviceNowPasswordEnv: string;

  constructor(options: EnvAdapterCredentialProviderOptions) {
    if (!options.cellTenantId) {
      throw new Error('COMMANDER_CELL_TENANT_ID is required for EnvAdapterCredentialProvider');
    }
    this.cellTenantId = options.cellTenantId;
    this.githubTokenEnv = options.githubTokenEnv ?? 'GITHUB_TOKEN';
    this.serviceNowInstanceEnv = options.serviceNowInstanceEnv ?? 'SERVICENOW_INSTANCE';
    this.serviceNowUsernameEnv = options.serviceNowUsernameEnv ?? 'SERVICENOW_USERNAME';
    this.serviceNowPasswordEnv = options.serviceNowPasswordEnv ?? 'SERVICENOW_PASSWORD';
  }

  static fromProcessEnv(): EnvAdapterCredentialProvider {
    const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID;
    if (!cellTenantId) {
      throw new Error('COMMANDER_CELL_TENANT_ID is required');
    }
    return new EnvAdapterCredentialProvider({ cellTenantId });
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
}

export interface AdapterEvidenceSummary {
  remoteId?: string;
  status?: string;
  httpStatus?: number;
  errorCode?: string;
}

const GITHUB_DEST_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function toEvidenceSummary(
  descriptor: ActionAdapterDescriptorV1,
  response: Record<string, unknown>,
): AdapterEvidenceSummary {
  const summary: AdapterEvidenceSummary = {};
  for (const key of descriptor.evidenceResponseSummaryKeys) {
    if (key in response) {
      const value = response[key];
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        (summary as Record<string, unknown>)[key] = value;
      }
    }
  }
  return summary;
}
