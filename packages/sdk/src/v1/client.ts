/** HTTP client for the Architecture V2 Gateway. It never imports the local runtime. */
export interface GatewayRun {
  id: string;
  status: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  policySnapshotId: string;
}
export interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export type ActionEffect = 'allow' | 'deny' | 'require_approval';

export interface ActionDecision {
  effect: ActionEffect;
  decisionId: string;
  reason: string;
  policySnapshotId: string;
}

export interface ActionSimulation extends ActionDecision {
  simulationId: string;
  actionDigest: string;
}

export interface GovernedAction {
  runId: string;
  stepId: string;
  effectId: string;
  state: string;
  decision: ActionDecision;
  simulation: ActionSimulation;
  actionDigest: string;
  policySnapshotId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeActionInput {
  source: string;
  package: string;
  model: string;
  tool: string;
  destination: string;
  effectType: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ActionApprovalInput {
  actionDigest: string;
  simulationId: string;
  policySnapshotId: string;
}

export interface ActionEvidenceBundle {
  bundle: Record<string, unknown>;
  verification: Record<string, unknown>;
}

export class CommanderGatewayClient {
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: GatewayClientOptions) {
    this.request = options.fetch ?? globalThis.fetch;
    if (!this.request) throw new Error('A fetch implementation is required');
  }
  async submitRun(input: {
    goal: string;
    policySnapshotId: string;
    steps?: Array<{
      id?: string;
      kind: string;
      input?: Record<string, unknown>;
      dependencies?: string[];
      priority?: number;
      maxAttempts?: number;
    }>;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ run: GatewayRun; idempotentReplay: boolean; accepted: boolean }> {
    const response = await this.call('/v1/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(input),
    });
    const body = await this.body(response);
    return {
      run: body.run,
      idempotentReplay: body.idempotentReplay,
      accepted: response.status === 202,
    };
  }
  async getRun(runId: string): Promise<GatewayRun> {
    const response = await this.call(`/v1/runs/${encodeURIComponent(runId)}`);
    return (await this.body(response)).run;
  }
  async listRunEvents(runId: string): Promise<Array<Record<string, unknown>>> {
    const response = await this.call(`/v1/runs/${encodeURIComponent(runId)}/events`);
    return (await this.body(response)).events;
  }
  async simulateAction(input: ProposeActionInput): Promise<{ simulation: ActionSimulation }> {
    const response = await this.call('/v1/actions/simulate', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return this.body(response);
  }
  async proposeAction(
    input: ProposeActionInput,
  ): Promise<{ action: GovernedAction; idempotentReplay: boolean; accepted: boolean }> {
    const response = await this.call('/v1/actions', {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(input),
    });
    const body = await this.body(response);
    return {
      action: body.action,
      idempotentReplay: body.idempotentReplay,
      accepted: response.status === 202,
    };
  }
  async getAction(runId: string): Promise<GovernedAction> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}`);
    return (await this.body(response)).action;
  }
  async approveAction(runId: string, input: ActionApprovalInput): Promise<GovernedAction> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/approve`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return (await this.body(response)).action;
  }
  async rejectAction(runId: string, input: { reason?: string } = {}): Promise<GovernedAction> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/reject`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return (await this.body(response)).action;
  }
  async reconcileAction(runId: string): Promise<Record<string, unknown>> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/reconcile`, {
      method: 'POST',
    });
    return this.body(response);
  }
  async getActionEvidence(runId: string): Promise<ActionEvidenceBundle> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/evidence`);
    return this.body(response);
  }
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    if (this.options.apiKey) headers.set('x-api-key', this.options.apiKey);
    const response = await this.request(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new CommanderGatewayError(response.status, body);
    }
    return response;
  }
  private async body(response: Response): Promise<any> {
    return response.json();
  }
}
export class CommanderGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Gateway request failed (${status})`);
    this.name = 'CommanderGatewayError';
  }
}
