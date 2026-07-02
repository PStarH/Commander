// packages/core/src/chaos/l1LlmLayer.ts

export interface L1FaultConfig {
  faultType: string;
  triggerAtCalls: number[];
}

export interface LlmProviderLike {
  call(req: unknown): Promise<unknown>;
}

const FAULT_MESSAGES: Record<string, string> = {
  rate_limit_429: '429 Too Many Requests',
  bad_gateway_502: '502 Bad Gateway',
  service_unavailable_503: '503 Service Unavailable',
  timeout_504: '504 Gateway Timeout',
  internal_error_500: '500 Internal Server Error',
  slow_response: 'Response time exceeded threshold',
  malformed_json: 'Failed to parse response: Unexpected token',
  empty_response: 'Empty response from provider',
};

export class L1LlmLayer {
  private faults: L1FaultConfig[] = [];
  private callCount = 0;
  private armed = false;

  arm(fault: L1FaultConfig): void {
    this.faults.push(fault);
    this.armed = true;
  }

  disarm(): void {
    this.faults = [];
    this.armed = false;
    this.callCount = 0;
  }

  getActiveFaults(): string[] {
    return this.faults.map((f) => f.faultType);
  }

  async intercept(provider: LlmProviderLike, req: unknown): Promise<unknown> {
    this.callCount++;
    if (this.armed) {
      for (const fault of this.faults) {
        if (fault.triggerAtCalls.includes(this.callCount)) {
          const msg = FAULT_MESSAGES[fault.faultType] ?? `LLM fault: ${fault.faultType}`;
          throw new Error(msg);
        }
      }
    }
    return provider.call(req);
  }
}
