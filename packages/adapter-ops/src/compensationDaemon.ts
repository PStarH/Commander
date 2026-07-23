import type { KernelRepository } from '@commander/kernel';
import {
  consumeCompensationBatch,
  KERNEL_COMPENSATION_TOPIC,
  type CompensationTokenProvider,
} from '@commander/kernel';
import type { EffectBroker } from '@commander/effect-broker';
import type { ActionAdapterRegistry } from '@commander/action-adapters';

export interface CompensationDaemonOptions {
  repository: KernelRepository;
  broker: EffectBroker;
  registry: ActionAdapterRegistry;
  tokenProvider: CompensationTokenProvider;
  pollIntervalMs: number;
  batchSize?: number;
  workerId?: string;
  /** Durable registry generation — must match broker localWorkerGeneration. */
  workerGeneration?: number;
  /** Register-time claim secret for worker LOGIN outbox DEFINER RPC. */
  claimSecret?: string;
  audit?: {
    append(event: {
      type: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      tenantId: string;
      runId: string;
      stepId: string;
      at: string;
      details: Record<string, unknown>;
    }): Promise<void>;
  };
}

export class CompensationDaemon {
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;

  constructor(private readonly options: CompensationDaemonOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error('[compensation-daemon] tick failed:', err);
      });
    }, this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isHealthy(now = Date.now()): boolean {
    return now - this.lastTickAt < this.options.pollIntervalMs * 3;
  }

  async tick(): Promise<{ consumed: number; succeeded: number; failed: number }> {
    this.lastTickAt = Date.now();
    try {
      const result = await consumeCompensationBatch(
        this.options.repository,
        {
          admit: (input) => this.options.broker.admit(input),
          executeAdmitted: (input) => this.options.broker.executeAdmitted(input),
        },
        this.options.tokenProvider,
        {
          topic: KERNEL_COMPENSATION_TOPIC,
          limit: this.options.batchSize ?? 50,
          workerId: this.options.workerId ?? 'compensation-daemon',
          workerGeneration: this.options.workerGeneration ?? 1,
          claimSecret: this.options.claimSecret,
          registry: this.options.registry,
          onAdapterUnregistered: this.options.audit
            ? async (info) => {
                await this.options.audit!.append({
                  type: 'compensation.adapter_unregistered',
                  severity: 'high',
                  tenantId: info.tenantId,
                  runId: info.runId,
                  stepId: info.stepId,
                  at: new Date().toISOString(),
                  details: { compensationAction: info.compensationAction, messageId: info.messageId },
                });
              }
            : undefined,
        },
      );
      return { consumed: result.consumed, succeeded: result.succeeded, failed: result.failed };
    } catch (err) {
      console.error('[compensation-daemon] tick failed:', err);
      return { consumed: 0, succeeded: 0, failed: 0 };
    }
  }
}

export function reverseCompensationEffectIds(effectIds: string[]): string[] {
  return [...effectIds].reverse();
}
